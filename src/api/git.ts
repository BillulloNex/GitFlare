import { Hono } from 'hono';
import type { Env, ApiKey } from '../env.ts';
import { parseCIConfig, shouldTrigger } from '../lib/ci-parser.ts';
import {
	parseReceivePackRequest,
	parseReceivePackResponse,
	buildReportStatus,
	buildSidebandError,
	frameReportForClient,
	adaptReceivePackResponse,
	negotiatedSideband,
	hexDump,
	PktLineError,
	type ReceivePackParsed,
	type RefUpdate,
} from '../lib/git-protocol.ts';
import { matchesBranchFilter } from '../lib/branch-pattern.ts';
import { isValidRefName } from '../lib/repo-validation.ts';
import { triggerGitHubMirror } from '../lib/github-mirror.ts';
import { getArtifactsRemoteUrl } from '../lib/artifacts-url.ts';
import { getArtifactFileContent, CI_CONFIG_PATH } from '../lib/artifact-reader.ts';
import { hashKey } from '../lib/crypto.ts';
import { checkRepoAccess, isValidPermission, type AccessLevel } from '../lib/access.ts';
import { principalFrom } from '../middleware/auth.ts';

const app = new Hono<{ Bindings: Env; Variables: { apiKey: ApiKey } }>();

/**
 * Artifacts write-token lifetime for a push. The RepoCoordinator push lock
 * uses the same lifetime (PUSH_LOCK_TTL_MS in src/do/repo-coordinator.ts).
 */
const PUSH_TOKEN_TTL_SECONDS = 300;

type GitRepoRow = { id: string; name: string; is_private: number; default_branch: string | null };

/** `/:repo` param minus one trailing `.git` ("foo.git" → "foo", "a.github" unchanged). */
function repoNameParam(raw: string): string {
	return raw.replace(/\.git$/, '');
}

function findRepo(db: D1Database, name: string): Promise<GitRepoRow | null> {
	return db.prepare('SELECT id, name, is_private, default_branch FROM repositories WHERE name = ?').bind(name).first<GitRepoRow>();
}

/** Headers from the git client that must reach Artifacts unchanged. */
function forwardedGitHeaders(req: Request): Record<string, string> {
	const headers: Record<string, string> = {};
	const gitProtocol = req.headers.get('Git-Protocol');
	if (gitProtocol) headers['Git-Protocol'] = gitProtocol;
	return headers;
}

function isGitDebug(env: Env): boolean {
	const flag = (env.GIT_PROTOCOL_DEBUG || '').toLowerCase();
	return flag === '1' || flag === 'true' || flag === 'yes';
}

function unauthorized(): Response {
	return new Response('Unauthorized', {
		status: 401,
		headers: { 'WWW-Authenticate': 'Basic realm="GitFlare"' },
	});
}

// ─── Git-specific Basic Auth ────────────────────────────────────
app.use('*', async (c, next) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader || !authHeader.startsWith('Basic ')) {
		return unauthorized();
	}

	// Malformed base64 must be a 401, not a 500.
	let credentials: string;
	try {
		credentials = atob(authHeader.slice(6));
	} catch {
		return unauthorized();
	}
	const sep = credentials.indexOf(':');
	const password = sep >= 0 ? credentials.slice(sep + 1) : '';
	if (!password) {
		return unauthorized();
	}

	// Hash the key and look up by hash
	const keyHash = await hashKey(password);
	const apiKey = await c.env.DB.prepare(
		'SELECT * FROM api_keys WHERE key_hash = ? AND (expires_at IS NULL OR expires_at > ?)'
	).bind(keyHash, new Date().toISOString()).first<ApiKey>();

	if (!apiKey) {
		return unauthorized();
	}

	if (!isValidPermission(apiKey.permissions)) {
		return new Response('Forbidden: API key has an invalid permission level', { status: 403 });
	}

	c.set('apiKey', apiKey);
	await next();
});

/**
 * Check the authenticated key may perform `level` on the repo, via the shared
 * checkRepoAccess (permission level, key scope, is_private, repo_members).
 * Callers who can't even read the repo get a 404 so private names don't leak;
 * readers lacking `level` get a 403. Returns null when allowed.
 */
async function denyGitAccess(
	db: D1Database,
	apiKey: ApiKey,
	repo: { id: string; is_private: boolean | number },
	level: AccessLevel
): Promise<Response | null> {
	const principal = principalFrom(null, apiKey);
	if (!principal) {
		return new Response('Forbidden: API key has an invalid permission level', { status: 403 });
	}
	if (!(await checkRepoAccess(principal, repo.id, repo.is_private, 'read', db))) {
		return new Response('Repository not found', { status: 404 });
	}
	if (level !== 'read' && !(await checkRepoAccess(principal, repo.id, repo.is_private, level, db))) {
		return new Response(`Forbidden: ${level} access to this repository required`, { status: 403 });
	}
	return null;
}

/**
 * Helper: get a scoped Artifacts token. Remote URLs come from
 * getArtifactsRemoteUrl (lib/artifacts-url.ts).
 */
async function getRepoToken(
	env: Env,
	repoName: string,
	permission: 'read' | 'write',
	ttlSeconds: number
): Promise<string> {
	const artifactRepo = await env.REPOS.get(repoName);
	if (!artifactRepo) {
		throw new Error('Repository storage not found');
	}

	// createToken returns either a string or { plaintext: string }
	const tokenResult = await artifactRepo.createToken(permission, ttlSeconds);
	if (typeof tokenResult === 'string') return tokenResult;
	if (tokenResult && typeof tokenResult === 'object' && 'plaintext' in (tokenResult as any)) {
		return (tokenResult as any).plaintext;
	}
	return String(tokenResult);
}

/**
 * GET /git/:repo/info/refs
 * Clone/fetch discovery or push discovery
 */
app.get('/:repo/info/refs', async (c) => {
	const service = c.req.query('service');
	if (!service || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
		return c.text('Invalid service', 400);
	}

	const repoName = repoNameParam(c.req.param('repo'));

	const { DB } = c.env;
	const repoRecord = await findRepo(DB, repoName);
	if (!repoRecord) {
		return c.text('Repository not found', 404);
	}

	const permission = service === 'git-receive-pack' ? 'write' : 'read';
	const denied = await denyGitAccess(DB, c.get('apiKey'), repoRecord, permission);
	if (denied) return denied;

	try {
		const token = await getRepoToken(c.env, repoRecord.name, permission, 60);

		const targetUrl = `${getArtifactsRemoteUrl(c.env, repoRecord.name)}/info/refs?service=${service}`;

		const response = await fetch(targetUrl, {
			headers: {
				'Authorization': `Bearer ${token}`,
				...forwardedGitHeaders(c.req.raw),
			}
		});

		if (!response.ok) {
			const body = await response.text();
			console.error(`Artifacts proxy error: ${response.status} ${body}`);
			return new Response(`Artifacts error: ${response.status}`, { status: response.status });
		}

		return new Response(response.body, {
			status: response.status,
			headers: {
				'Content-Type': `application/x-${service}-advertisement`,
				'Cache-Control': 'no-cache',
			}
		});
	} catch (err: any) {
		console.error(`Git info/refs error for ${repoName}:`, err.message, err.stack);
		return c.json({ error: 'Git protocol error' }, 500);
	}
});

/**
 * POST /git/:repo/git-upload-pack
 * Clone/fetch packfile transfer
 */
app.post('/:repo/git-upload-pack', async (c) => {
	const repoName = repoNameParam(c.req.param('repo'));

	const { DB } = c.env;
	const repoRecord = await findRepo(DB, repoName);
	if (!repoRecord) {
		return c.text('Repository not found', 404);
	}

	const denied = await denyGitAccess(DB, c.get('apiKey'), repoRecord, 'read');
	if (denied) return denied;

	try {
		const token = await getRepoToken(c.env, repoRecord.name, 'read', 300);

		// git gzips upload-pack requests over 1 KiB — the body is streamed
		// through untouched, so its Content-Encoding must go with it.
		const headers: Record<string, string> = {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/x-git-upload-pack-request',
			...forwardedGitHeaders(c.req.raw),
		};
		const contentEncoding = c.req.header('Content-Encoding');
		if (contentEncoding) headers['Content-Encoding'] = contentEncoding;

		const response = await fetch(`${getArtifactsRemoteUrl(c.env, repoRecord.name)}/git-upload-pack`, {
			method: 'POST',
			headers,
			body: c.req.raw.body,
			// @ts-ignore — needed for streaming request body
			duplex: 'half'
		});

		return new Response(response.body, {
			status: response.status,
			headers: {
				'Content-Type': 'application/x-git-upload-pack-result',
				'Cache-Control': 'no-cache',
			}
		});
	} catch (err: any) {
		console.error(`Git upload-pack error for ${repoName}:`, err.message);
		return c.json({ error: 'Git protocol error' }, 500);
	}
});

// ─── Push helpers ───────────────────────────────────────────────

const RECEIVE_PACK_RESULT_HEADERS = {
	'Content-Type': 'application/x-git-receive-pack-result',
	'Cache-Control': 'no-cache',
};

/**
 * Buffer the receive-pack request body. git does not normally gzip push
 * requests, but if it arrives gzip-encoded (and the runtime hasn't already
 * inflated it — checked via the gzip magic bytes) decompress it here; the
 * decompressed bytes are what gets parsed and forwarded.
 */
async function readReceivePackBody(req: Request): Promise<Uint8Array> {
	const raw = new Uint8Array(await req.arrayBuffer());
	const encoding = (req.headers.get('Content-Encoding') || '').trim().toLowerCase();
	const looksGzipped = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
	if ((encoding === 'gzip' || encoding === 'x-gzip') && looksGzipped) {
		const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	}
	return raw;
}

/**
 * Fatal push error before anything reached Artifacts. With sideband the client
 * prints "remote error: <message>"; without it, an HTTP 400 is all we can do.
 */
function gitFatal(capabilities: string[] | undefined, message: string): Response {
	const sideband = negotiatedSideband(capabilities);
	if (sideband) {
		return new Response(buildSidebandError(message, sideband), { status: 200, headers: RECEIVE_PACK_RESULT_HEADERS });
	}
	return new Response(`${message}\n`, { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/**
 * Reject the whole push. The request carries one packfile for every ref, so
 * refs can't be forwarded selectively: refs in `reasons` get their own
 * message, every other ref is reported as rejected alongside them.
 */
function rejectPush(parsed: ReceivePackParsed, reasons: Map<string, string>, othersReason: string): Response {
	const report = buildReportStatus('ok', parsed.refs.map(ref => ({
		refName: ref.refName,
		error: reasons.get(ref.refName) ?? othersReason,
	})));
	return new Response(frameReportForClient(report, negotiatedSideband(parsed.capabilities)), {
		status: 200, // git protocol uses 200 even for rejections
		headers: RECEIVE_PACK_RESULT_HEADERS,
	});
}

// ─── Branch protection ──────────────────────────────────────────

interface ProtectionRule {
	branch_pattern: string;
	enforce_merge_queue: number;
	allow_force_push: number;
	allow_deletion: number;
	bypass_actors: string | null;
}

/** bypass_actors is a JSON array of API key IDs. Malformed JSON grants no bypass. */
function canBypass(rule: ProtectionRule, pusherId: string): boolean {
	if (!rule.bypass_actors) return false;
	try {
		const list: unknown = JSON.parse(rule.bypass_actors);
		return Array.isArray(list) && list.includes(pusherId);
	} catch {
		return false;
	}
}

/**
 * Map of refName → rejection reason for refs that violate a protection rule.
 * Throws if the rules can't be read — callers must reject the push (fail closed).
 *
 * Per matching rule (patterns via matchesBranchFilter, which escapes regex
 * metacharacters; only refs/heads/* is protected):
 *  - deletion is blocked unless `allow_deletion`
 *  - with `enforce_merge_queue`, every other direct update is blocked, except
 *    creating the repo's default branch when it doesn't exist yet (the first
 *    push into an empty repo — the merge queue needs a base branch to exist).
 *    Artifacts only accepts a create if the ref is truly absent.
 *  - `allow_force_push` is read but NOT enforced: detecting a force push needs
 *    an ancestry walk, which is deferred. When `enforce_merge_queue` is on,
 *    force pushes are blocked anyway because all direct updates are.
 */
async function findProtectionViolations(
	db: D1Database,
	repo: GitRepoRow,
	refs: RefUpdate[],
	pusherId: string
): Promise<Map<string, string>> {
	const { results: rules } = await db.prepare(
		'SELECT branch_pattern, enforce_merge_queue, allow_force_push, allow_deletion, bypass_actors FROM protected_branches WHERE repo_id = ?'
	).bind(repo.id).all<ProtectionRule>();

	const violations = new Map<string, string>();
	if (!rules || rules.length === 0) return violations;

	for (const ref of refs) {
		if (ref.kind !== 'branch') continue;
		for (const rule of rules) {
			if (!matchesBranchFilter([rule.branch_pattern], ref.shortName)) continue;
			if (canBypass(rule, pusherId)) continue;

			if (ref.isDelete) {
				if (!rule.allow_deletion) {
					violations.set(ref.refName, 'protected branch — deletion not allowed');
					break;
				}
				continue;
			}

			if (rule.enforce_merge_queue) {
				const initialDefaultBranch = ref.isCreate && ref.shortName === (repo.default_branch || 'main');
				if (initialDefaultBranch) continue;
				violations.set(ref.refName, `protected branch — use the merge queue (POST /api/repos/${repo.name}/tickets)`);
				break;
			}
		}
	}

	return violations;
}

// ─── Push lock (RepoCoordinator DO) ─────────────────────────────

async function acquirePushLock(
	env: Env,
	repoId: string,
	pusher: string,
	refNames: string[]
): Promise<{ lockId: string } | { error: string }> {
	try {
		const coordinator = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repoId));
		const res = await coordinator.fetch(new Request('https://do/lock', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ pusher, refs: refNames }),
		}));
		if (res.status === 409) {
			return { error: 'another push is in progress for this ref — try again shortly' };
		}
		if (!res.ok) {
			console.error(`[git-push] lock request failed: ${res.status} ${await res.text()}`);
			return { error: 'could not acquire push lock — try again shortly' };
		}
		const data = await res.json() as { lock_id?: string };
		if (!data.lock_id) return { error: 'could not acquire push lock — try again shortly' };
		return { lockId: data.lock_id };
	} catch (err: any) {
		console.error('[git-push] failed to acquire lock:', err.message);
		return { error: 'could not acquire push lock — try again shortly' };
	}
}

function releasePushLock(env: Env, repoId: string, lockId: string): Promise<unknown> {
	const coordinator = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repoId));
	return coordinator.fetch(new Request('https://do/unlock', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ lock_id: lockId }),
	})).catch((err: any) => console.error('[git-push] failed to release lock:', err.message));
}

// ─── Post-push hooks ────────────────────────────────────────────

/**
 * Audit, CI and mirror for refs Artifacts confirmed.
 * Deletions are audited but never trigger CI or mirroring.
 * Tags are audited with their full ref name; CI and mirroring are
 * branch-only.
 */
function runPostPushHooks(
	env: Env,
	ctx: { waitUntil(promise: Promise<unknown>): void },
	repo: GitRepoRow,
	pusher: string,
	updated: RefUpdate[]
): void {
	const { DB, CI_QUEUE } = env;
	const branchUpdates = updated.filter(r => r.kind === 'branch' && !r.isDelete);

	ctx.waitUntil(
		DB.prepare('INSERT INTO audit_log (id, action, repo_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
			.bind(
				crypto.randomUUID(), 'git.push', repo.id, pusher,
				JSON.stringify({
					repoName: repo.name,
					branches: branchUpdates.map(r => r.shortName),
					commits: Object.fromEntries(branchUpdates.map(r => [r.shortName, r.newSha])),
					refs: updated.map(r => ({
						ref: r.refName,
						old: r.oldSha,
						new: r.newSha,
						change: r.isDelete ? 'delete' : r.isCreate ? 'create' : 'update',
					})),
				}),
				new Date().toISOString()
			).run()
	);

	if (branchUpdates.length === 0) return;

	// CI for each updated branch, filtered by the config's `on.push` block
	ctx.waitUntil((async () => {
		for (const ref of branchUpdates) {
			const branch = ref.shortName;
			try {
				const yamlContent = await getArtifactFileContent(env, repo.name, CI_CONFIG_PATH, branch);
				if (!yamlContent) {
					console.log(`No CI config (${CI_CONFIG_PATH}) found for ${repo.name}@${branch} — skipping CI`);
					continue;
				}
				await env.CACHE.put(`ci-config:${repo.name}`, yamlContent);

				const config = parseCIConfig(yamlContent);
				if (!shouldTrigger(config, { type: 'push', branch })) {
					console.log(`Skipping CI for ${repo.name}@${branch} — not matched by on.push`);
					continue;
				}

				const runId = crypto.randomUUID();
				await DB.prepare('INSERT INTO ci_runs (id, repo_id, branch, commit_sha, status, trigger, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
					.bind(runId, repo.id, branch, ref.newSha, 'queued', 'push', new Date().toISOString())
					.run();

				await CI_QUEUE.send({
					runId,
					repoId: repo.id,
					repoName: repo.name,
					branch,
					commitSha: ref.newSha,
					config,
					trigger: 'push'
				});
				console.log(`CI triggered: run=${runId} repo=${repo.name} branch=${branch} sha=${ref.newSha.slice(0, 7)}`);
			} catch (e: any) {
				console.error(`Failed to trigger CI for ${repo.name}@${branch}:`, e.message);
			}
		}
	})());

	// Mirror to GitHub (async, non-blocking)
	ctx.waitUntil(
		triggerGitHubMirror(
			env, repo.id, repo.name,
			branchUpdates.map(r => r.shortName),
			new Map(branchUpdates.map(r => [r.shortName, r.newSha]))
		)
	);
}

/**
 * POST /git/:repo/git-receive-pack
 * Push packfile transfer
 *
 * 1. Buffer the request and parse ref update commands — fail closed if unparseable
 * 2. Validate ref names and check branch protection — fail closed on error
 * 3. Acquire the RepoCoordinator push lock — reject the push if it can't be taken
 * 4. Proxy the push to Artifacts
 * 5. Parse report-status — only refs Artifacts reported `ok` count as updated
 * 6. Post-push hooks (audit, CI, mirror) for updated refs only
 * 7. Release the lock
 */
app.post('/:repo/git-receive-pack', async (c) => {
	const repoName = repoNameParam(c.req.param('repo'));
	const debug = isGitDebug(c.env);

	const { DB } = c.env;
	const repoRecord = await findRepo(DB, repoName);
	if (!repoRecord) {
		return c.text('Repository not found', 404);
	}

	const apiKey = c.get('apiKey');
	const denied = await denyGitAccess(DB, apiKey, repoRecord, 'write');
	if (denied) return denied;
	const pusher = apiKey.id;

	const auditRejection = (details: Record<string, unknown>) => c.executionCtx.waitUntil(
		DB.prepare('INSERT INTO audit_log (id, action, repo_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
			.bind(crypto.randomUUID(), 'git.push.rejected', repoRecord.id, pusher, JSON.stringify(details), new Date().toISOString())
			.run()
	);

	// ── Step 1: Buffer and parse request (fail closed) ──────────
	let requestBody: Uint8Array;
	try {
		requestBody = await readReceivePackBody(c.req.raw);
	} catch (err: any) {
		console.error(`[git-push] could not read request body for ${repoName}:`, err.message);
		return gitFatal(undefined, 'GitFlare could not read the push request');
	}

	let parsed: ReceivePackParsed;
	try {
		parsed = parseReceivePackRequest(requestBody);
	} catch (err: any) {
		console.error(
			`[git-push] rejecting push to ${repoName}: unparseable receive-pack request (${err.message}); ` +
			`${requestBody.length} bytes, Content-Encoding=${c.req.header('Content-Encoding') ?? 'none'}` +
			(debug ? `\n${hexDump(requestBody, 512)}` : ' — set GIT_PROTOCOL_DEBUG=1 for a hex dump')
		);
		auditRejection({ reason: 'unparseable_request', error: err.message });
		const caps = err instanceof PktLineError ? err.capabilities : undefined;
		return gitFatal(caps, `GitFlare could not parse the push request (${err.message}); push rejected`);
	}

	if (debug) {
		console.log(`[git-push] request command section for ${repoName} (${requestBody.length} bytes total):\n${hexDump(requestBody.subarray(0, parsed.commandSectionLength), 4096)}`);
	}

	// git's auth probe ("0000") before a large chunked push: no commands, no
	// hooks, no lock — just forward so the client gets Artifacts' answer.
	if (parsed.isProbe) {
		try {
			const token = await getRepoToken(c.env, repoRecord.name, 'write', 60);
			const probe = await fetch(`${getArtifactsRemoteUrl(c.env, repoRecord.name)}/git-receive-pack`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${token}`,
					'Content-Type': 'application/x-git-receive-pack-request',
					...forwardedGitHeaders(c.req.raw),
				},
				body: requestBody,
			});
			return new Response(probe.body, { status: probe.status, headers: RECEIVE_PACK_RESULT_HEADERS });
		} catch (err: any) {
			console.error(`Git receive-pack probe error for ${repoName}:`, err.message);
			return c.json({ error: 'Git protocol error' }, 500);
		}
	}

	console.log(`Push to ${repoName}: ${parsed.refs.map(r => `${r.refName}(${r.isDelete ? 'delete' : r.newSha.slice(0, 7)})`).join(', ')}`);

	// ── Step 2: Ref names + branch protection (fail closed) ─────
	const invalidRefs = new Map<string, string>();
	for (const ref of parsed.refs) {
		if (!isValidRefName(ref.refName) || !ref.refName.startsWith('refs/')) {
			invalidRefs.set(ref.refName, 'invalid ref name');
		}
	}
	if (invalidRefs.size > 0) {
		auditRejection({ reason: 'invalid_ref_name', refs: [...invalidRefs.keys()] });
		return rejectPush(parsed, invalidRefs, 'push rejected — another ref in this push has an invalid name');
	}

	let violations: Map<string, string>;
	try {
		violations = await findProtectionViolations(DB, repoRecord, parsed.refs, pusher);
	} catch (err: any) {
		console.error(`[git-push] branch protection check failed for ${repoName} — rejecting push:`, err.message);
		auditRejection({ reason: 'branch_protection_error', error: err.message });
		return rejectPush(parsed, new Map(), 'branch protection check failed — try again');
	}
	if (violations.size > 0) {
		const refs = [...violations.keys()];
		console.log(`Rejected push to protected ref(s) ${refs.join(', ')} on ${repoName}`);
		auditRejection({ reason: 'branch_protection', refs, details: Object.fromEntries(violations) });
		return rejectPush(parsed, violations, 'push rejected — another ref in this push is protected');
	}

	// ── Step 3: Acquire push lock (reject if unavailable) ───────
	const lock = await acquirePushLock(c.env, repoRecord.id, pusher, parsed.refs.map(r => r.refName));
	if ('error' in lock) {
		return rejectPush(parsed, new Map(), lock.error);
	}

	let updated: RefUpdate[] = [];
	try {
		// ── Step 4: Proxy push to Artifacts ─────────────────────
		const token = await getRepoToken(c.env, repoRecord.name, 'write', PUSH_TOKEN_TTL_SECONDS);

		const response = await fetch(`${getArtifactsRemoteUrl(c.env, repoRecord.name)}/git-receive-pack`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/x-git-receive-pack-request',
				...forwardedGitHeaders(c.req.raw),
			},
			body: requestBody,
		});

		const responseBody = new Uint8Array(await response.arrayBuffer());
		if (debug) {
			console.log(`[git-push] Artifacts response for ${repoName}: HTTP ${response.status}, ${responseBody.length} bytes, Content-Type=${response.headers.get('Content-Type')}\n${hexDump(responseBody, 4096)}`);
		}

		if (!response.ok) {
			console.error(`[git-push] Artifacts rejected push to ${repoName}: HTTP ${response.status}`);
			return new Response(responseBody, { status: response.status, headers: RECEIVE_PACK_RESULT_HEADERS });
		}

		// ── Step 5: Only refs reported `ok` count as updated ────
		// No report-status, or unpack failure → nothing was updated: no CI,
		// no mirror, no audit. There is deliberately no fallback here.
		const report = parseReceivePackResponse(responseBody);
		if (!report) {
			console.error(
				`[git-push] no report-status in Artifacts response for ${repoName} (${responseBody.length} bytes) — treating push as failed for hooks` +
				(debug ? '' : '; set GIT_PROTOCOL_DEBUG=1 for a hex dump')
			);
		} else if (!report.unpackOk) {
			console.error(`[git-push] unpack failed for ${repoName}: ${report.unpackError}`);
		} else {
			for (const result of report.refResults) {
				if (!result.success) {
					console.log(`[git-push] ${repoName} ${result.refName} rejected by Artifacts: ${result.error}`);
					continue;
				}
				const ref = parsed.refs.find(r => r.refName === result.refName);
				if (ref) updated.push(ref);
				else console.warn(`[git-push] ${repoName}: Artifacts reported ok for ${result.refName}, which was not in the request — ignoring`);
			}
			console.log(`Push result for ${repoName}: ${report.refResults.length} refs reported, ${updated.length} updated`);
		}

		// ── Step 6: Post-push hooks ─────────────────────────────
		if (updated.length > 0) {
			runPostPushHooks(c.env, c.executionCtx, repoRecord, pusher, updated);
		}

		return new Response(adaptReceivePackResponse(responseBody, negotiatedSideband(parsed.capabilities)), {
			status: response.status,
			headers: RECEIVE_PACK_RESULT_HEADERS,
		});
	} catch (err: any) {
		console.error(`Git receive-pack error for ${repoName}:`, err.message);
		return c.json({ error: 'Git protocol error' }, 500);
	} finally {
		// ── Step 7: Release lock ────────────────────────────────
		c.executionCtx.waitUntil(releasePushLock(c.env, repoRecord.id, lock.lockId));
	}
});

export default app;
