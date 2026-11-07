/**
 * Git LFS server — the endpoints a stock `git lfs` client talks to.
 *
 * Mounted on the /git app (src/api/git.ts) so that a repo cloned from
 * https://host/git/<repo>.git discovers https://host/git/<repo>.git/info/lfs
 * automatically, behind the same Basic-Auth middleware. Routes:
 *
 *   POST /:repo/info/lfs/objects/batch    batch API (download | upload)
 *   PUT  /:repo/info/lfs/objects/:oid     proxy-mode upload (streams into R2, sha256-checked)
 *   GET  /:repo/info/lfs/objects/:oid     proxy-mode download (streams from R2)
 *   POST /:repo/info/lfs/objects/verify   post-upload verification (both modes)
 *   *    /:repo/info/lfs/locks*           404 — locks are not supported
 *
 * Storage: R2 (STORAGE binding) at lfs/<repoId>/<oid>; index in D1
 * `lfs_objects`. Transfer mode (lib/r2-presign.ts): "presigned" when R2 S3
 * credentials are configured, "proxy" otherwise. Batch responses carry a
 * short-lived LFS bearer token (lib/lfs-token.ts) on proxy/verify actions,
 * so the client never re-sends its API key to the transfer URLs.
 */
import { Hono } from 'hono';
import type { Env } from '../env.ts';
import {
	LFS_CONTENT_TYPE,
	LFS_D1_CHUNK,
	PROXY_MAX_OBJECT_BYTES,
	R2_MAX_SINGLE_PUT_BYTES,
	formatBytes,
	isValidOid,
	isValidSize,
	lfsObjectKey,
	validateBatchRequest,
	type LfsAction,
	type LfsBatchObject,
	type LfsBatchResponse,
} from '../lib/lfs.ts';
import { mintLfsToken, scopeAllows, type LfsScope } from '../lib/lfs-token.ts';
import { presignConfig, presignDownload, presignUpload, type PresignConfig } from '../lib/r2-presign.ts';
import { denyGitAccess, findGitRepo, repoNameParam, unauthorized, type GitAuthVariables, type GitRepoRow } from './git-shared.ts';

const app = new Hono<{ Bindings: Env; Variables: GitAuthVariables }>();

export type LfsTransferMode = 'presigned' | 'proxy';

// ─── Policy helpers (also used by lfs-api.ts) ───────────────────

export function lfsTransferMode(env: Env): LfsTransferMode {
	return presignConfig(env) ? 'presigned' : 'proxy';
}

export function lfsUrlTtlSeconds(env: Env): number {
	const n = Number(env.LFS_URL_TTL_SECONDS);
	return Number.isFinite(n) && n >= 60 ? Math.floor(n) : 900;
}

/** Effective per-object cap for a repo: the repo override can only lower the global cap. */
export function lfsMaxObjectBytes(env: Env, repo: { lfs_max_object_bytes?: number | null }): number {
	const mode = lfsTransferMode(env);
	const modeDefault = mode === 'presigned' ? R2_MAX_SINGLE_PUT_BYTES : PROXY_MAX_OBJECT_BYTES;
	const configured = Number(env.LFS_MAX_OBJECT_BYTES);
	let global = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : modeDefault;
	if (global > R2_MAX_SINGLE_PUT_BYTES) global = R2_MAX_SINGLE_PUT_BYTES;
	const repoCap = repo.lfs_max_object_bytes;
	return repoCap && repoCap > 0 ? Math.min(repoCap, global) : global;
}

// ─── Responses ──────────────────────────────────────────────────

function lfsJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': LFS_CONTENT_TYPE, 'Cache-Control': 'no-store', ...extra },
	});
}

function lfsError(status: number, message: string, docsUrl?: string): Response {
	return lfsJson({ message, ...(docsUrl ? { documentation_url: docsUrl } : {}) }, status);
}

/**
 * Public origin for URLs handed to clients. APP_URL is authoritative: in
 * `wrangler dev` the request URL carries the custom-domain route's host, not
 * localhost, so it cannot be trusted; the request origin is only a fallback.
 */
export function publicOrigin(env: Env, requestUrl: string): string {
	return (env.APP_URL || new URL(requestUrl).origin).replace(/\/+$/, '');
}

export function lfsDocsUrl(env: Env, origin: string): string {
	return `${origin}/docs/lfs`;
}

// ─── Auth ───────────────────────────────────────────────────────

type AuthResult = { ok: true; repo: GitRepoRow; actor: string } | { ok: false; response: Response };

/**
 * Resolve the repo and check the caller may perform `level` on it. Accepts an
 * API key (Basic) through the shared git access rules, or a minted LFS token
 * (Bearer) bound to this repo with a sufficient scope. Unknown repos and
 * unreadable private repos are 404s so names don't leak.
 */
async function authorize(c: { env: Env; get: (k: 'apiKey' | 'lfsToken') => any; req: { param: (k: string) => string } }, level: LfsScope): Promise<AuthResult> {
	const repoName = repoNameParam(c.req.param('repo'));
	const repo = await findGitRepo(c.env.DB, repoName);
	if (!repo) return { ok: false, response: lfsError(404, 'Repository not found') };

	const token = c.get('lfsToken');
	if (token) {
		if (token.repoId !== repo.id) return { ok: false, response: lfsError(404, 'Repository not found') };
		if (!scopeAllows(token.scope, level)) return { ok: false, response: lfsError(403, `This LFS token does not allow ${level}`) };
		return { ok: true, repo, actor: `lfs-token:${token.scope}` };
	}
	const apiKey = c.get('apiKey');
	if (!apiKey) return { ok: false, response: unauthorized() };
	const denied = await denyGitAccess(c.env.DB, apiKey, repo, level);
	if (denied) {
		const text = await denied.text();
		return { ok: false, response: lfsError(denied.status, text || 'Forbidden') };
	}
	return { ok: true, repo, actor: apiKey.id };
}

// ─── D1 index ───────────────────────────────────────────────────

type ObjectRow = { oid: string; size: number; state: 'pending' | 'ready' };

async function loadRows(db: D1Database, repoId: string, oids: string[]): Promise<Map<string, ObjectRow>> {
	const rows = new Map<string, ObjectRow>();
	for (let i = 0; i < oids.length; i += LFS_D1_CHUNK) {
		const chunk = oids.slice(i, i + LFS_D1_CHUNK);
		const placeholders = chunk.map(() => '?').join(',');
		const { results } = await db
			.prepare(`SELECT oid, size, state FROM lfs_objects WHERE repo_id = ? AND oid IN (${placeholders})`)
			.bind(repoId, ...chunk)
			.all<ObjectRow>();
		for (const r of results) rows.set(r.oid, r);
	}
	return rows;
}

function markReady(db: D1Database, repoId: string, oid: string, size: number) {
	return db
		.prepare(
			`INSERT INTO lfs_objects (repo_id, oid, size, state) VALUES (?, ?, ?, 'ready')
			 ON CONFLICT(repo_id, oid) DO UPDATE SET size = excluded.size, state = 'ready'`
		)
		.bind(repoId, oid, size)
		.run();
}

function markPending(db: D1Database, repoId: string, oid: string, size: number) {
	return db
		.prepare(
			`INSERT INTO lfs_objects (repo_id, oid, size, state) VALUES (?, ?, ?, 'pending')
			 ON CONFLICT(repo_id, oid) DO UPDATE SET size = excluded.size WHERE lfs_objects.state = 'pending'`
		)
		.bind(repoId, oid, size)
		.run();
}

/**
 * An object recorded as pending may in fact be in R2 (presigned upload whose
 * verify never arrived). Check once and promote it. Returns the R2 size or null.
 */
async function promoteIfStored(env: Env, repoId: string, oid: string): Promise<number | null> {
	const head = await env.STORAGE.head(lfsObjectKey(repoId, oid));
	if (!head) return null;
	await markReady(env.DB, repoId, oid, head.size);
	return head.size;
}

// ─── Batch ──────────────────────────────────────────────────────

app.post('/:repo/info/lfs/objects/batch', async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return lfsError(400, 'Batch request body must be JSON');
	}
	const validated = validateBatchRequest(body);
	if (!validated.ok) return lfsError(validated.status, validated.message);
	const request = validated.request;
	const level: LfsScope = request.operation === 'upload' ? 'write' : 'read';

	const auth = await authorize(c, level);
	if (!auth.ok) return auth.response;
	const { repo } = auth;
	const env = c.env;
	const origin = publicOrigin(env, c.req.url);
	const docsUrl = lfsDocsUrl(env, origin);

	if (request.operation === 'upload' && repo.lfs_enabled === 0) {
		return lfsError(403, 'Git LFS uploads are disabled for this repository (repo settings → Allow LFS uploads)', docsUrl);
	}

	const mode = lfsTransferMode(env);
	const presign: PresignConfig | null = mode === 'presigned' ? presignConfig(env) : null;
	const ttl = lfsUrlTtlSeconds(env);
	const maxBytes = lfsMaxObjectBytes(env, repo);
	const transferBase = `${origin}/git/${encodeURIComponent(repo.name)}.git/info/lfs/objects`;

	// One bearer token per batch, scoped to what this batch is allowed to do.
	const token = await mintLfsToken(env.ENCRYPTION_KEY, { repoId: repo.id, scope: level, ttlSeconds: ttl });
	const bearer = { Authorization: `Bearer ${token}` };

	const valid = request.objects.filter((o) => isValidOid(o.oid) && isValidSize(o.size));
	const rows = await loadRows(env.DB, repo.id, valid.map((o) => o.oid));

	const objects: LfsBatchObject[] = [];
	const pendingWrites: Promise<unknown>[] = [];

	for (const o of request.objects) {
		if (!isValidOid(o.oid)) {
			objects.push({ oid: String(o.oid), size: o.size, error: { code: 422, message: 'oid must be a lowercase hex sha256' } });
			continue;
		}
		if (!isValidSize(o.size)) {
			objects.push({ oid: o.oid, size: o.size, error: { code: 422, message: 'size must be a non-negative integer' } });
			continue;
		}
		const row = rows.get(o.oid);
		const key = lfsObjectKey(repo.id, o.oid);

		if (request.operation === 'download') {
			let size = row?.state === 'ready' ? row.size : null;
			if (size === null) {
				// Not known ready: a presigned upload may have landed without a verify.
				const stored = await promoteIfStored(env, repo.id, o.oid);
				if (stored !== null) size = stored;
			}
			if (size === null) {
				objects.push({ oid: o.oid, size: o.size, error: { code: 404, message: 'Object does not exist' } });
				continue;
			}
			const download: LfsAction = presign
				? { href: await presignDownload(presign, key, ttl), expires_in: ttl }
				: { href: `${transferBase}/${o.oid}`, header: bearer, expires_in: ttl };
			objects.push({ oid: o.oid, size, authenticated: true, actions: { download } });
			continue;
		}

		// upload
		if (row?.state === 'ready') {
			objects.push({ oid: o.oid, size: o.size, authenticated: true }); // already have it: no actions → client skips
			continue;
		}
		if (o.size > maxBytes) {
			objects.push({
				oid: o.oid,
				size: o.size,
				error: {
					code: 422,
					message:
						`Object is ${formatBytes(o.size)}; this repository accepts LFS objects up to ${formatBytes(maxBytes)}` +
						(mode === 'proxy' ? ' (proxy transfer mode — configure R2 API credentials for larger objects)' : ''),
				},
			});
			continue;
		}
		pendingWrites.push(markPending(env.DB, repo.id, o.oid, o.size));
		const verify: LfsAction = { href: `${transferBase}/verify`, header: bearer, expires_in: ttl };
		let upload: LfsAction;
		if (presign) {
			const signed = await presignUpload(presign, key, o.oid, o.size, ttl);
			upload = { href: signed.url, header: signed.headers, expires_in: ttl };
		} else {
			upload = { href: `${transferBase}/${o.oid}`, header: { ...bearer, 'Content-Type': 'application/octet-stream' }, expires_in: ttl };
		}
		objects.push({ oid: o.oid, size: o.size, authenticated: true, actions: { upload, verify } });
	}

	await Promise.all(pendingWrites);
	const response: LfsBatchResponse = { transfer: 'basic', objects, hash_algo: 'sha256' };
	return lfsJson(response);
});

// ─── Proxy transfer ─────────────────────────────────────────────

app.put('/:repo/info/lfs/objects/:oid', async (c) => {
	const oid = c.req.param('oid');
	if (!isValidOid(oid)) return lfsError(422, 'oid must be a lowercase hex sha256');
	const auth = await authorize(c, 'write');
	if (!auth.ok) return auth.response;
	const { repo } = auth;
	const env = c.env;

	if (repo.lfs_enabled === 0) return lfsError(403, 'Git LFS uploads are disabled for this repository');
	const lengthHeader = c.req.header('content-length');
	const length = lengthHeader === undefined ? NaN : Number(lengthHeader);
	if (!Number.isInteger(length) || length < 0) return lfsError(411, 'Content-Length is required for LFS uploads');
	const maxBytes = lfsMaxObjectBytes(env, repo);
	if (length > maxBytes) return lfsError(413, `Object is ${formatBytes(length)}; this repository accepts LFS objects up to ${formatBytes(maxBytes)}`);

	const key = lfsObjectKey(repo.id, oid);
	const source = c.req.raw.body;
	let value: ReadableStream | ArrayBuffer;
	let pump: Promise<void> | null = null;
	if (length === 0 || !source) {
		value = new ArrayBuffer(0);
	} else {
		// R2 needs a known length; FixedLengthStream also rejects a short/long body.
		const fixed = new FixedLengthStream(length);
		pump = source.pipeTo(fixed.writable);
		pump.catch(() => {}); // surfaced through put() / the await below
		value = fixed.readable;
	}

	let stored: R2Object;
	try {
		stored = await env.STORAGE.put(key, value, { sha256: oid, httpMetadata: { contentType: 'application/octet-stream' } });
		if (pump) await pump;
	} catch (err: any) {
		const msg = String(err?.message ?? err);
		console.warn(`[lfs] upload of ${oid} to ${repo.name} failed: ${msg}`);
		if (/sha256|checksum|digest|hash/i.test(msg)) {
			return lfsError(422, 'Uploaded bytes do not hash to the declared oid');
		}
		if (/length|stream/i.test(msg)) {
			return lfsError(400, 'Upload body did not match Content-Length');
		}
		return lfsError(500, 'Could not store object');
	}
	await markReady(env.DB, repo.id, oid, stored.size);
	return new Response(null, { status: 200 });
});

app.get('/:repo/info/lfs/objects/:oid', async (c) => {
	const oid = c.req.param('oid');
	if (!isValidOid(oid)) return lfsError(422, 'oid must be a lowercase hex sha256');
	const auth = await authorize(c, 'read');
	if (!auth.ok) return auth.response;
	const { repo } = auth;

	const object = await c.env.STORAGE.get(lfsObjectKey(repo.id, oid));
	if (!object) return lfsError(404, 'Object does not exist');
	const headers = new Headers({
		'Content-Type': 'application/octet-stream',
		'Content-Length': String(object.size),
		'Cache-Control': 'private, no-transform',
		'X-Content-Type-Options': 'nosniff',
	});
	headers.set('ETag', object.httpEtag);
	return new Response(object.body, { status: 200, headers });
});

// ─── Verify ─────────────────────────────────────────────────────

/** R2 reports checksums as ArrayBuffers. */
function bufferToHex(buf: ArrayBuffer): string {
	return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Called by the client after each upload. Confirms the object is in R2 with
 * the declared size and that its content hashes to the oid: R2's recorded
 * sha256 when it has one (proxy uploads and checksum-signed presigned
 * uploads), otherwise a streaming hash of the object. Mismatches delete the
 * object so a wrong body can never be served under that oid.
 */
app.post('/:repo/info/lfs/objects/verify', async (c) => {
	let body: { oid?: unknown; size?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return lfsError(400, 'Verify request body must be JSON');
	}
	const { oid, size } = body;
	if (!isValidOid(oid)) return lfsError(422, 'oid must be a lowercase hex sha256');
	if (!isValidSize(size)) return lfsError(422, 'size must be a non-negative integer');
	const auth = await authorize(c, 'write');
	if (!auth.ok) return auth.response;
	const { repo } = auth;
	const env = c.env;
	const key = lfsObjectKey(repo.id, oid);

	const head = await env.STORAGE.head(key);
	if (!head) return lfsError(404, 'Object has not been uploaded');
	if (head.size !== size) {
		await env.STORAGE.delete(key);
		return lfsError(422, `Uploaded object is ${head.size} bytes, expected ${size}`);
	}

	let hashHex: string | null = head.checksums?.sha256 ? bufferToHex(head.checksums.sha256) : null;
	if (!hashHex) {
		const row = await env.DB.prepare('SELECT state FROM lfs_objects WHERE repo_id = ? AND oid = ?').bind(repo.id, oid).first<{ state: string }>();
		if (row?.state === 'ready') return new Response(null, { status: 200 }); // proxy upload: R2 already checked sha256 on put
		const object = await env.STORAGE.get(key);
		if (!object) return lfsError(404, 'Object has not been uploaded');
		const digest = new crypto.DigestStream('SHA-256');
		await object.body.pipeTo(digest);
		hashHex = bufferToHex(await digest.digest);
	}
	if (hashHex !== oid) {
		await env.STORAGE.delete(key);
		console.warn(`[lfs] verify of ${oid} in ${repo.name} failed: content hashed to ${hashHex}`);
		return lfsError(422, 'Uploaded bytes do not hash to the declared oid');
	}
	await markReady(env.DB, repo.id, oid, head.size);
	return new Response(null, { status: 200 });
});

// ─── Locks (unsupported) ────────────────────────────────────────

app.all('/:repo/info/lfs/locks', (c) => lfsError(404, 'File locking is not supported by GitFlare', lfsDocsUrl(c.env, publicOrigin(c.env, c.req.url))));
app.all('/:repo/info/lfs/locks/*', (c) => lfsError(404, 'File locking is not supported by GitFlare', lfsDocsUrl(c.env, publicOrigin(c.env, c.req.url))));

export default app;
