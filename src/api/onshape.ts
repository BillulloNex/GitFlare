/**
 * Onshape link for a repo (lib/onshape-sync.ts does the syncing).
 *
 *   GET    /api/repos/:repo/onshape                         link config (no secrets) + recent versions
 *   PUT    /api/repos/:repo/onshape                         create / update (admin); checks the keys and documents
 *   DELETE /api/repos/:repo/onshape                         remove the link (admin); commits already made stay
 *   POST   /api/repos/:repo/onshape/sync                    check for new versions now (write)
 *   POST   /api/repos/:repo/onshape/versions/:id/retry      re-export a failed version (write)
 *
 * All routes run behind repoAccess (src/index.ts): GET needs read, other
 * methods need write.
 */
import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { auditContext, requireRepoLevel, type RepoVariables } from '../middleware/repo-access.ts';
import { audit } from '../lib/audit.ts';
import { decryptSecret, encryptSecret } from '../lib/crypto.ts';
import { readJsonObject } from '../lib/request.ts';
import { isValidRefName } from '../lib/repo-validation.ts';
import {
	EXPORT_FORMATS,
	OnshapeClient,
	OnshapeError,
	normalizeBaseUrl,
	parseDocumentRef,
	type ExportFormat,
} from '../lib/onshape.ts';
import { assignFolders, branchIsProtected, runOnshapeSync, type LinkedDocument } from '../lib/onshape-sync.ts';

const app = new Hono<{ Bindings: Env; Variables: RepoVariables }>();

const MIN_INTERVAL_MINUTES = 60;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MAX_DOCUMENTS = 10;
/** "Sync now" won't start another discovery inside this window. */
const SYNC_COOLDOWN_MS = 60_000;

interface LinkRow {
	id: string;
	base_url: string;
	access_key_encrypted: string;
	secret_key_encrypted: string;
	access_key_hint: string;
	documents: string;
	branch: string;
	formats: string;
	interval_minutes: number;
	backfill: 'latest' | 'all';
	is_enabled: number;
	next_check_at: string | null;
	last_check_at: string | null;
	last_status: string | null;
	last_error: string | null;
	api_calls: number;
	created_at: string;
	updated_at: string;
}

function publicLink(row: LinkRow) {
	return {
		id: row.id,
		base_url: row.base_url,
		access_key_hint: row.access_key_hint,
		// `folder`: where the document's files live in the repo.
		documents: assignFolders(JSON.parse(row.documents) as LinkedDocument[]),
		branch: row.branch,
		formats: JSON.parse(row.formats) as ExportFormat[],
		interval_minutes: row.interval_minutes,
		backfill: row.backfill,
		is_enabled: row.is_enabled === 1,
		next_check_at: row.next_check_at,
		last_check_at: row.last_check_at,
		last_status: row.last_status,
		last_error: row.last_error,
		api_calls: row.api_calls,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

/** Rough Onshape API calls per year for discovery alone (exports come on top, per version). */
function estimateCallsPerYear(intervalMinutes: number, documentCount: number): number {
	return Math.round(((365 * 24 * 60) / intervalMinutes) * documentCount);
}

app.get('/:repo/onshape', async (c) => {
	const repo = c.get('repoRecord');
	const row = await c.env.DB.prepare('SELECT * FROM onshape_links WHERE repo_id = ?').bind(repo.id).first<LinkRow>();
	if (!row) return c.json({ link: null, versions: [] });

	const { results } = await c.env.DB.prepare(
		`SELECT id, document_id, version_id, version_name, version_created_at, creator_name, status, commit_sha, error, exports, updated_at
		 FROM onshape_versions WHERE link_id = ? AND status != 'skipped'
		 ORDER BY version_created_at DESC LIMIT 30`
	)
		.bind(row.id)
		.all<Record<string, unknown> & { exports: string | null }>();
	const counts = await c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM onshape_versions WHERE link_id = ? GROUP BY status')
		.bind(row.id)
		.all<{ status: string; n: number }>();

	const link = publicLink(row);
	return c.json({
		link: { ...link, discovery_calls_per_year: estimateCallsPerYear(link.interval_minutes, link.documents.length) },
		counts: Object.fromEntries((counts.results ?? []).map((r) => [r.status, r.n])),
		versions: (results ?? []).map(({ exports, ...v }) => {
			const tasks = (exports ? (JSON.parse(exports) as { tasks?: { state: string }[] }).tasks : null) ?? [];
			return {
				...v,
				exports_total: tasks.length,
				exports_done: tasks.filter((t) => t.state === 'done').length,
				exports_failed: tasks.filter((t) => t.state === 'failed').length,
			};
		}),
	});
});

app.put('/:repo/onshape', requireRepoLevel('admin'), async (c) => {
	const body = await readJsonObject<{
		access_key: string;
		secret_key: string;
		documents: string[];
		base_url: string;
		branch: string;
		formats: string[];
		interval_minutes: number;
		backfill: string;
		is_enabled: boolean;
	}>(c);
	if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

	const repo = c.get('repoRecord');
	const { DB } = c.env;
	const existing = await DB.prepare('SELECT * FROM onshape_links WHERE repo_id = ?').bind(repo.id).first<LinkRow>();

	// ── Validate ──
	if (body.access_key !== undefined && (typeof body.access_key !== 'string' || !body.access_key.trim())) return c.json({ error: 'access_key must be a non-empty string' }, 400);
	if (body.secret_key !== undefined && (typeof body.secret_key !== 'string' || !body.secret_key.trim())) return c.json({ error: 'secret_key must be a non-empty string' }, 400);
	if (!existing && (!body.access_key || !body.secret_key)) return c.json({ error: 'access_key and secret_key are required' }, 400);

	let documentRefs: string[] | undefined;
	if (body.documents !== undefined) {
		if (!Array.isArray(body.documents) || !body.documents.every((d) => typeof d === 'string')) return c.json({ error: 'documents must be an array of Onshape document URLs or ids' }, 400);
		documentRefs = body.documents.map((d) => d.trim()).filter(Boolean);
		if (documentRefs.length === 0) return c.json({ error: 'Add at least one Onshape document' }, 400);
		if (documentRefs.length > MAX_DOCUMENTS) return c.json({ error: `At most ${MAX_DOCUMENTS} documents per repository` }, 400);
	} else if (!existing) {
		return c.json({ error: 'documents is required' }, 400);
	}

	const parsedDocs = (documentRefs ?? []).map((ref) => ({ ref, parsed: parseDocumentRef(ref) }));
	const badDoc = parsedDocs.find((d) => !d.parsed);
	if (badDoc) return c.json({ error: `Not an Onshape document URL or id: ${badDoc.ref}` }, 400);

	let baseUrl = existing?.base_url ?? null;
	if (body.base_url !== undefined) {
		baseUrl = typeof body.base_url === 'string' ? normalizeBaseUrl(body.base_url) : null;
		if (!baseUrl) return c.json({ error: 'base_url must be https://cad.onshape.com or your https://<company>.onshape.com' }, 400);
	} else if (!baseUrl) {
		baseUrl = parsedDocs.find((d) => d.parsed?.baseUrl)?.parsed?.baseUrl ?? normalizeBaseUrl(null)!;
	}

	let formats: ExportFormat[] | undefined;
	if (body.formats !== undefined) {
		if (!Array.isArray(body.formats) || body.formats.length === 0 || !body.formats.every((f) => (EXPORT_FORMATS as readonly string[]).includes(f))) {
			return c.json({ error: `formats must be a non-empty subset of ${EXPORT_FORMATS.join(', ')}` }, 400);
		}
		formats = EXPORT_FORMATS.filter((f) => body.formats!.includes(f));
	}

	if (body.interval_minutes !== undefined) {
		const n = body.interval_minutes;
		if (typeof n !== 'number' || !Number.isInteger(n) || n < MIN_INTERVAL_MINUTES || n > MAX_INTERVAL_MINUTES) {
			return c.json({ error: `interval_minutes must be a whole number from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}` }, 400);
		}
	}
	if (body.backfill !== undefined && body.backfill !== 'latest' && body.backfill !== 'all') return c.json({ error: "backfill must be 'latest' or 'all'" }, 400);
	if (body.is_enabled !== undefined && typeof body.is_enabled !== 'boolean') return c.json({ error: 'is_enabled must be a boolean' }, 400);

	let branch = existing?.branch;
	if (body.branch !== undefined) {
		if (typeof body.branch !== 'string' || !isValidRefName(`refs/heads/${body.branch.trim()}`) || !body.branch.trim()) return c.json({ error: 'branch is not a valid branch name' }, 400);
		branch = body.branch.trim();
	}
	if (!branch) branch = await defaultSyncBranch(c.env, repo.id, repo.name, repo.default_branch || 'main');
	// Ongoing sync cannot use a merge-queue branch: only the first commit would land.
	if (await branchIsProtected(DB, repo.id, branch, { isCreate: false, defaultBranch: repo.default_branch || 'main' })) {
		return c.json(
			{ error: `Branch "${branch}" is protected by the merge queue. Use another branch (the usual choice is "onshape"), or remove that protection rule.` },
			400
		);
	}

	// ── Check the keys and documents against Onshape ──
	let accessKey: string;
	let secretKey: string;
	try {
		accessKey = body.access_key?.trim() ?? (await decryptSecret(existing!.access_key_encrypted, c.env.ENCRYPTION_KEY, c.env.SESSION_SECRET));
		secretKey = body.secret_key?.trim() ?? (await decryptSecret(existing!.secret_key_encrypted, c.env.ENCRYPTION_KEY, c.env.SESSION_SECRET));
	} catch {
		return c.json({ error: 'The stored Onshape keys could not be decrypted — enter them again' }, 400);
	}
	const client = new OnshapeClient({ baseUrl, accessKey, secretKey });
	let documents: LinkedDocument[] = existing ? (JSON.parse(existing.documents) as LinkedDocument[]) : [];
	const keysChanged = body.access_key !== undefined || body.secret_key !== undefined || body.base_url !== undefined;
	try {
		if (documentRefs) {
			const previous = new Map(documents.map((d) => [d.id, d]));
			const adding = parsedDocs.some(({ parsed }) => parsed && !previous.has(parsed.documentId));
			// Stored keys belong to whoever connected the repo. Adding a document re-checks
			// them, so another admin cannot point the sync at a document only those keys can see.
			if (existing && adding && (!body.access_key?.trim() || !body.secret_key?.trim())) {
				return c.json({ error: 'Enter the Onshape access key and secret key again to add a document' }, 400);
			}
			const resolved: LinkedDocument[] = [];
			for (const { parsed } of parsedDocs) {
				const id = parsed!.documentId;
				if (resolved.some((d) => d.id === id)) continue;
				const known = previous.get(id);
				if (known && !keysChanged) {
					resolved.push(known);
					continue;
				}
				const info = await client.document(id);
				// Keep the stored folder: that is where this document's history already lives.
				resolved.push({ id, name: info.name || known?.name || id, folder: known?.folder });
			}
			documents = assignFolders(resolved);
		} else if (keysChanged) {
			await client.sessionInfo();
		}
	} catch (err) {
		const message = err instanceof OnshapeError ? err.message : `Could not reach Onshape: ${err instanceof Error ? err.message : String(err)}`;
		return c.json({ error: 'Onshape check failed', details: message }, 400);
	}

	// ── Save ──
	const now = new Date().toISOString();
	const accessEnc = body.access_key ? await encryptSecret(accessKey, c.env.ENCRYPTION_KEY) : existing!.access_key_encrypted;
	const secretEnc = body.secret_key ? await encryptSecret(secretKey, c.env.ENCRYPTION_KEY) : existing!.secret_key_encrypted;
	const hint = body.access_key ? accessKey.slice(-4) : existing!.access_key_hint;
	const values = {
		base_url: baseUrl,
		access_key_encrypted: accessEnc,
		secret_key_encrypted: secretEnc,
		access_key_hint: hint,
		documents: JSON.stringify(documents),
		branch,
		formats: JSON.stringify(formats ?? (existing ? JSON.parse(existing.formats) : ['glb', 'step'])),
		interval_minutes: body.interval_minutes ?? existing?.interval_minutes ?? 1440,
		backfill: body.backfill ?? existing?.backfill ?? 'latest',
		is_enabled: body.is_enabled === undefined ? (existing?.is_enabled ?? 1) : body.is_enabled ? 1 : 0,
	};

	let id: string;
	if (existing) {
		id = existing.id;
		await DB.prepare(
			`UPDATE onshape_links SET base_url = ?, access_key_encrypted = ?, secret_key_encrypted = ?, access_key_hint = ?, documents = ?,
			   branch = ?, formats = ?, interval_minutes = ?, backfill = ?, is_enabled = ?, next_check_at = NULL, retry_after = NULL, last_error = NULL, updated_at = ?
			 WHERE id = ?`
		)
			.bind(values.base_url, values.access_key_encrypted, values.secret_key_encrypted, values.access_key_hint, values.documents, values.branch, values.formats, values.interval_minutes, values.backfill, values.is_enabled, now, id)
			.run();
	} else {
		id = crypto.randomUUID();
		await DB.prepare(
			`INSERT INTO onshape_links (id, repo_id, base_url, access_key_encrypted, secret_key_encrypted, access_key_hint, documents, branch,
			   formats, interval_minutes, backfill, is_enabled, created_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(id, repo.id, values.base_url, values.access_key_encrypted, values.secret_key_encrypted, values.access_key_hint, values.documents, values.branch, values.formats, values.interval_minutes, values.backfill, values.is_enabled, auditContext(c).actor, now, now)
			.run();
	}

	// Documents removed from the link: drop their unfinished versions (committed history stays).
	if (existing && documentRefs) {
		const keep = documents.map((d) => d.id);
		await DB.prepare(
			`DELETE FROM onshape_versions WHERE link_id = ? AND status IN ('pending', 'exporting')
			 AND document_id NOT IN (${keep.map(() => '?').join(', ')})`
		)
			.bind(id, ...keep)
			.run();
	}

	await audit(DB, {
		repoId: repo.id,
		...auditContext(c),
		action: existing ? 'onshape.update' : 'onshape.create',
		details: { documents: documents.map((d) => d.id), branch: values.branch, formats: values.formats, interval_minutes: values.interval_minutes },
	});

	// First check right away (short budget; the cron carries on from there).
	if (values.is_enabled) c.executionCtx.waitUntil(runOnshapeSync(c.env, { linkId: id }));

	const row = await DB.prepare('SELECT * FROM onshape_links WHERE id = ?').bind(id).first<LinkRow>();
	return c.json({ link: publicLink(row!), onshape_calls_used: client.calls }, existing ? 200 : 201);
});

app.delete('/:repo/onshape', requireRepoLevel('admin'), async (c) => {
	const repo = c.get('repoRecord');
	const row = await c.env.DB.prepare('SELECT id FROM onshape_links WHERE repo_id = ?').bind(repo.id).first<{ id: string }>();
	if (!row) return c.json({ error: 'No Onshape link configured' }, 404);
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM onshape_versions WHERE link_id = ?').bind(row.id),
		c.env.DB.prepare('DELETE FROM onshape_links WHERE id = ?').bind(row.id),
	]);
	await audit(c.env.DB, { repoId: repo.id, ...auditContext(c), action: 'onshape.delete' });
	return c.json({ deleted: true });
});

app.post('/:repo/onshape/sync', async (c) => {
	const repo = c.get('repoRecord');
	const row = await c.env.DB.prepare('SELECT id, is_enabled, last_check_at, last_error, retry_after, lease_until FROM onshape_links WHERE repo_id = ?')
		.bind(repo.id)
		.first<{ id: string; is_enabled: number; last_check_at: string | null; last_error: string | null; retry_after: string | null; lease_until: string | null }>();
	if (!row) return c.json({ error: 'No Onshape link configured' }, 404);
	if (!row.is_enabled) return c.json({ error: 'The Onshape link is paused' }, 409);
	if (row.retry_after && Date.parse(row.retry_after) > Date.now()) {
		return c.json({ error: row.last_error || 'Onshape sync is paused. Save the Onshape settings to try again.' }, 409);
	}
	if (row.lease_until && row.lease_until > new Date().toISOString()) {
		return c.json({ queued: true, message: 'A sync is already running.' }, 202);
	}
	if (row.last_check_at && Date.now() - Date.parse(row.last_check_at) < SYNC_COOLDOWN_MS) {
		return c.json({ error: 'Checked Onshape less than a minute ago. Wait a minute before checking again.' }, 429);
	}
	await c.env.DB.prepare('UPDATE onshape_links SET next_check_at = NULL WHERE id = ?').bind(row.id).run();
	c.executionCtx.waitUntil(runOnshapeSync(c.env, { linkId: row.id }));
	return c.json({ queued: true, message: 'Checking Onshape for new versions. Exports finish over the next few minutes.' }, 202);
});

app.post('/:repo/onshape/versions/:id/retry', async (c) => {
	const repo = c.get('repoRecord');
	const version = await c.env.DB.prepare(
		'SELECT id, link_id, document_id, version_created_at, status FROM onshape_versions WHERE id = ? AND repo_id = ?'
	)
		.bind(c.req.param('id'), repo.id)
		.first<{ id: string; link_id: string; document_id: string; version_created_at: string; status: string }>();
	if (!version || version.status !== 'failed') return c.json({ error: 'No failed version with that id' }, 404);
	// Committing an older version on top of a newer one would roll the files back.
	const newer = await c.env.DB.prepare(
		`SELECT version_name FROM onshape_versions
		 WHERE link_id = ? AND document_id = ? AND status = 'committed' AND version_created_at > ? LIMIT 1`
	)
		.bind(version.link_id, version.document_id, version.version_created_at)
		.first<{ version_name: string }>();
	if (newer) {
		return c.json({ error: `A newer version "${newer.version_name}" is already in the repository, so this one cannot be retried.` }, 409);
	}
	await c.env.DB.prepare(
		`UPDATE onshape_versions SET status = 'pending', attempts = 0, error = NULL, exports = NULL, updated_at = ? WHERE id = ?`
	)
		.bind(new Date().toISOString(), version.id)
		.run();
	c.executionCtx.waitUntil(runOnshapeSync(c.env, { linkId: version.link_id }));
	return c.json({ retrying: true });
});

/**
 * Where the commits go by default. A protected branch (main, on every repo)
 * cannot take the sync: only its first commit would land. An Artifacts error
 * also stays off the default branch, so a blip never points a code repo at main.
 */
async function defaultSyncBranch(env: Env, repoId: string, repoName: string, defaultBranch: string): Promise<string> {
	if (await branchIsProtected(env.DB, repoId, defaultBranch, { isCreate: false, defaultBranch })) return 'onshape';
	try {
		const artifact = await env.REPOS.get(repoName);
		const log = await artifact?.log({ ref: defaultBranch, limit: 1 });
		return log && log.length > 0 ? 'onshape' : defaultBranch;
	} catch {
		return 'onshape';
	}
}

export default app;
