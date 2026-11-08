/**
 * Onshape link for a repo (lib/onshape-sync.ts does the syncing).
 *
 *   GET    /api/repos/:repo/onshape                         link config (no secrets) + recent versions
 *   PUT    /api/repos/:repo/onshape                         create / update (admin); checks the keys and documents
 *                                                          access_secret_id / secret_key_secret_id copy saved secrets; save_access_as / save_secret_as store pasted keys on the user
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
import {
	MAX_SAVED_SECRETS,
	encryptTextSecret,
	onshapeHint,
	parseSecretName,
	secretField,
	secretHint,
	type SavedSecretRow,
} from '../lib/saved-secrets.ts';
import { readJsonObject } from '../lib/request.ts';
import { isValidRefName } from '../lib/repo-validation.ts';
import {
	EXPORT_FORMATS,
	OnshapeClient,
	OnshapeError,
	bytesToBase64,
	normalizeBaseUrl,
	parseDocumentRef,
	thumbnailFor,
	type ExportFormat,
	type OnshapeDocumentSummary,
} from '../lib/onshape.ts';
import { assignFolders, branchIsProtected, runOnshapeSync, type LinkedDocument } from '../lib/onshape-sync.ts';

const app = new Hono<{ Bindings: Env; Variables: RepoVariables }>();

const SAFE_THUMBNAIL_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/** Only allow image/* content types we render as an `<img src>`; anything else falls back to png. */
function safeThumbnailType(value: string | null | undefined): string | null {
	if (!value) return null;
	const type = value.split(';')[0].trim().toLowerCase();
	return SAFE_THUMBNAIL_TYPES.has(type) ? type : null;
}

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
	saved_secret_id: string | null;
	secret_key_secret_id: string | null;
	created_at: string;
	updated_at: string;
}

function publicLink(row: LinkRow, accessSecretName: string | null, secretKeySecretName: string | null) {
	return {
		id: row.id,
		base_url: row.base_url,
		access_key_hint: row.access_key_hint,
		access_secret_id: row.saved_secret_id,
		access_secret_name: accessSecretName,
		secret_key_secret_id: row.secret_key_secret_id,
		secret_key_secret_name: secretKeySecretName,
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

async function savedSecretName(db: Env['DB'], id: string | null): Promise<string | null> {
	if (!id) return null;
	const saved = await db.prepare('SELECT name FROM saved_secrets WHERE id = ?').bind(id).first<{ name: string }>();
	return saved?.name ?? null;
}

async function ownedSecret(db: Env['DB'], userId: string, id: string): Promise<SavedSecretRow> {
	const row = await db.prepare('SELECT * FROM saved_secrets WHERE id = ? AND user_id = ?').bind(id, userId).first<SavedSecretRow>();
	if (!row) throw new Error('Saved secret not found');
	return row;
}

async function insertTextSecret(
	db: Env['DB'],
	encryptionKey: string,
	userId: string,
	name: string,
	value: string,
	now: string,
	auditInfo: { actor: string; ipAddress?: string }
): Promise<string> {
	const id = crypto.randomUUID();
	await db
		.prepare(
			`INSERT INTO saved_secrets (id, user_id, name, kind, payload_encrypted, hint, created_at, updated_at)
			 VALUES (?, ?, ?, 'text', ?, ?, ?, ?)`
		)
		.bind(id, userId, name, await encryptTextSecret(value, encryptionKey), secretHint(value), now, now)
		.run();
	await audit(db, { ...auditInfo, action: 'secret.create', details: { id, kind: 'text', name } });
	return id;
}

async function withSavedSecret(db: Env['DB'], row: LinkRow) {
	const [accessName, secretName] = await Promise.all([
		savedSecretName(db, row.saved_secret_id),
		savedSecretName(db, row.secret_key_secret_id ?? null),
	]);
	return publicLink(row, accessName, secretName);
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

	const link = await withSavedSecret(c.env.DB, row);
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

/**
 * List documents (and their thumbnails) the supplied keys can see, so the
 * connect wizard can offer a picker instead of making the user paste URLs.
 * Thumbnails are inlined as data URIs: the keys never reach the browser as a
 * reusable thumbnail URL and no temporary credential store is needed.
 */
app.post('/:repo/onshape/documents/preview', requireRepoLevel('admin'), async (c) => {
	const body = await readJsonObject<{
		access_key: string;
		secret_key: string;
		access_secret_id: string;
		secret_key_secret_id: string;
		base_url: string;
		offset: number;
		limit: number;
		thumbnails: boolean;
	}>(c);
	if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

	const accessSecretPick = typeof body.access_secret_id === 'string' ? body.access_secret_id.trim() : '';
	const secretKeyPick = typeof body.secret_key_secret_id === 'string' ? body.secret_key_secret_id.trim() : '';
	if (accessSecretPick && body.access_key !== undefined) return c.json({ error: 'Send a saved secret or an access key, not both' }, 400);
	if (secretKeyPick && body.secret_key !== undefined) return c.json({ error: 'Send a saved secret or a secret key, not both' }, 400);

	let baseUrl: string | null = null;
	if (body.base_url !== undefined) {
		baseUrl = typeof body.base_url === 'string' ? normalizeBaseUrl(body.base_url) : null;
		if (!baseUrl) return c.json({ error: 'base_url must be an https://*.onshape.com origin' }, 400);
	}
	baseUrl ??= normalizeBaseUrl(null)!;

	const userId = c.get('principal').userId;
	let accessKey = '';
	let secretKey = '';
	try {
		if (accessSecretPick) {
			if (!userId) return c.json({ error: 'Saved secrets belong to a signed-in user. Paste the keys instead.' }, 400);
			accessKey = await secretField(await ownedSecret(c.env.DB, userId, accessSecretPick), 'access', c.env.ENCRYPTION_KEY, c.env.SESSION_SECRET);
		} else if (typeof body.access_key === 'string') {
			accessKey = body.access_key.trim();
		}
		if (secretKeyPick) {
			if (!userId) return c.json({ error: 'Saved secrets belong to a signed-in user. Paste the keys instead.' }, 400);
			secretKey = await secretField(await ownedSecret(c.env.DB, userId, secretKeyPick), 'secret', c.env.ENCRYPTION_KEY, c.env.SESSION_SECRET);
		} else if (typeof body.secret_key === 'string') {
			secretKey = body.secret_key.trim();
		}
	} catch (err) {
		if (err instanceof Error && err.message === 'Saved secret not found') return c.json({ error: 'Saved secret not found' }, 404);
		return c.json({ error: 'That saved secret could not be read — replace it' }, 400);
	}
	if (!accessKey || !secretKey) return c.json({ error: 'Enter the Onshape access key and secret key' }, 400);

	const offset = typeof body.offset === 'number' && Number.isInteger(body.offset) && body.offset >= 0 ? body.offset : 0;
	const rawLimit = typeof body.limit === 'number' ? body.limit : 20;
	const limit = Math.max(1, Math.min(20, Math.floor(rawLimit)));
	const withThumbnails = body.thumbnails !== false;

	const client = new OnshapeClient({ baseUrl, accessKey, secretKey });
	let page: { items: OnshapeDocumentSummary[]; next?: string | null } | OnshapeDocumentSummary[];
	try {
		page = await client.documents(offset, limit);
	} catch (err) {
		const details = err instanceof OnshapeError ? err.message : `Could not reach Onshape: ${err instanceof Error ? err.message : String(err)}`;
		return c.json({ error: 'Onshape check failed', details }, 400);
	}
	const items = Array.isArray(page) ? page : (page.items ?? []);
	const hasMore = items.length >= limit;

	const documents = await Promise.all(
		items.map(async (doc): Promise<{ id: string; name: string; owner: string | null; modified_at: string | null; thumbnail: string | null }> => {
			const summary = { id: doc.id, name: doc.name || doc.id, owner: doc.owner?.name || null, modified_at: doc.modifiedAt || doc.createdAt || null, thumbnail: null as string | null };
			if (!withThumbnails) return summary;
			const thumb = thumbnailFor(doc, 300);
			if (!thumb) return summary;
			try {
				const res = await client.thumbnail(thumb.href);
				if (!res.ok) return summary;
				const bytes = new Uint8Array(await res.arrayBuffer());
				if (!bytes.length || bytes.length > 256 * 1024) return summary;
				const type = safeThumbnailType(res.headers.get('content-type')) ?? safeThumbnailType(thumb.mediaType) ?? 'image/png';
				summary.thumbnail = `data:${type};base64,${bytesToBase64(bytes)}`;
			} catch {
				// Thumbnails are best-effort: a missing preview never blocks picking.
			}
			return summary;
		})
	);

	return c.json({ documents, offset, has_more: hasMore, calls_used: client.calls, base_url: baseUrl });
});

app.put('/:repo/onshape', requireRepoLevel('admin'), async (c) => {
	const body = await readJsonObject<{
		access_key: string;
		secret_key: string;
		access_secret_id: string;
		secret_key_secret_id: string;
		save_access_as: string;
		save_secret_as: string;
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
	if (body.access_secret_id !== undefined && typeof body.access_secret_id !== 'string') return c.json({ error: 'access_secret_id must be a string' }, 400);
	if (body.secret_key_secret_id !== undefined && typeof body.secret_key_secret_id !== 'string') return c.json({ error: 'secret_key_secret_id must be a string' }, 400);
	if (body.save_access_as !== undefined && typeof body.save_access_as !== 'string') return c.json({ error: 'save_access_as must be a string' }, 400);
	if (body.save_secret_as !== undefined && typeof body.save_secret_as !== 'string') return c.json({ error: 'save_secret_as must be a string' }, 400);
	const accessSecretPick = typeof body.access_secret_id === 'string' ? body.access_secret_id.trim() : '';
	const secretKeyPick = typeof body.secret_key_secret_id === 'string' ? body.secret_key_secret_id.trim() : '';
	const saveAccessAs = body.save_access_as === undefined ? undefined : parseSecretName(body.save_access_as);
	const saveSecretAs = body.save_secret_as === undefined ? undefined : parseSecretName(body.save_secret_as);
	if (body.save_access_as !== undefined && !saveAccessAs) return c.json({ error: 'save_access_as must be 1–80 characters' }, 400);
	if (body.save_secret_as !== undefined && !saveSecretAs) return c.json({ error: 'save_secret_as must be 1–80 characters' }, 400);
	if (accessSecretPick && (body.access_key !== undefined || saveAccessAs)) return c.json({ error: 'Send a saved secret or an access key, not both' }, 400);
	if (secretKeyPick && (body.secret_key !== undefined || saveSecretAs)) return c.json({ error: 'Send a saved secret or a secret key, not both' }, 400);
	if (saveAccessAs && !body.access_key) return c.json({ error: 'Enter the access key to save it' }, 400);
	if (saveSecretAs && !body.secret_key) return c.json({ error: 'Enter the secret key to save it' }, 400);
	if (saveAccessAs && saveSecretAs && saveAccessAs === saveSecretAs) return c.json({ error: 'Give the two saved secrets different names' }, 400);
	if (!existing && !accessSecretPick && !body.access_key) return c.json({ error: 'access_key is required' }, 400);
	if (!existing && !secretKeyPick && !body.secret_key) return c.json({ error: 'secret_key is required' }, 400);

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

	// ── Resolve keys: saved secrets, pasted keys, or the keys already stored on the link ──
	const userId = c.get('principal').userId;
	const saving = [saveAccessAs, saveSecretAs].filter((name): name is string => Boolean(name));
	if ((accessSecretPick || secretKeyPick || saving.length) && !userId) {
		return c.json({ error: 'Saved secrets belong to a signed-in user. Paste the keys instead.' }, 400);
	}
	if (saving.length) {
		for (const name of saving) {
			const taken = await DB.prepare('SELECT id FROM saved_secrets WHERE user_id = ? AND name = ?').bind(userId, name).first();
			if (taken) return c.json({ error: `You already have a saved secret named "${name}"` }, 409);
		}
		const count = await DB.prepare('SELECT COUNT(*) AS n FROM saved_secrets WHERE user_id = ?').bind(userId).first<{ n: number }>();
		if ((count?.n ?? 0) + saving.length > MAX_SAVED_SECRETS) return c.json({ error: `At most ${MAX_SAVED_SECRETS} saved secrets` }, 400);
	}

	const replacingAccess = Boolean(accessSecretPick) || body.access_key !== undefined;
	const replacingSecret = Boolean(secretKeyPick) || body.secret_key !== undefined;
	let accessSecretId: string | null = replacingAccess ? accessSecretPick || null : (existing?.saved_secret_id ?? null);
	let secretKeySecretId: string | null = replacingSecret ? secretKeyPick || null : (existing?.secret_key_secret_id ?? null);

	let accessKey = '';
	let secretKey = '';
	try {
		if (accessSecretPick) accessKey = await secretField(await ownedSecret(DB, userId!, accessSecretPick), 'access', c.env.ENCRYPTION_KEY, c.env.SESSION_SECRET);
		else if (body.access_key !== undefined) accessKey = body.access_key.trim();
		else if (existing) accessKey = await decryptSecret(existing.access_key_encrypted, c.env.ENCRYPTION_KEY, c.env.SESSION_SECRET);

		if (secretKeyPick) secretKey = await secretField(await ownedSecret(DB, userId!, secretKeyPick), 'secret', c.env.ENCRYPTION_KEY, c.env.SESSION_SECRET);
		else if (body.secret_key !== undefined) secretKey = body.secret_key.trim();
		else if (existing) secretKey = await decryptSecret(existing.secret_key_encrypted, c.env.ENCRYPTION_KEY, c.env.SESSION_SECRET);
	} catch (err) {
		if (err instanceof Error && err.message === 'Saved secret not found') return c.json({ error: 'Saved secret not found' }, 404);
		const picked = Boolean(accessSecretPick || secretKeyPick);
		return c.json({ error: picked ? 'That saved secret could not be read — replace it' : 'The stored Onshape keys could not be decrypted — enter them again' }, 400);
	}
	if (!accessKey || !secretKey) return c.json({ error: 'access_key and secret_key are required' }, 400);
	const client = new OnshapeClient({ baseUrl, accessKey, secretKey });
	let documents: LinkedDocument[] = existing ? (JSON.parse(existing.documents) as LinkedDocument[]) : [];
	const replacingKeys = replacingAccess || replacingSecret;
	const keysChanged = replacingKeys || body.base_url !== undefined;
	try {
		if (documentRefs) {
			const previous = new Map(documents.map((d) => [d.id, d]));
			const adding = parsedDocs.some(({ parsed }) => parsed && !previous.has(parsed.documentId));
			// Stored keys belong to whoever connected the repo. Adding a document re-checks
			// them, so another admin cannot point the sync at a document only those keys can see.
			const suppliedAccess = Boolean(accessSecretPick) || Boolean(body.access_key?.trim());
			const suppliedSecret = Boolean(secretKeyPick) || Boolean(body.secret_key?.trim());
			if (existing && adding && (!suppliedAccess || !suppliedSecret)) {
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
	const hint = replacingKeys ? onshapeHint(accessKey) : existing!.access_key_hint;
	if (saveAccessAs) accessSecretId = await insertTextSecret(DB, c.env.ENCRYPTION_KEY, userId!, saveAccessAs, accessKey, now, auditContext(c));
	if (saveSecretAs) secretKeySecretId = await insertTextSecret(DB, c.env.ENCRYPTION_KEY, userId!, saveSecretAs, secretKey, now, auditContext(c));
	const accessEnc = replacingKeys ? await encryptSecret(accessKey, c.env.ENCRYPTION_KEY) : existing!.access_key_encrypted;
	const secretEnc = replacingKeys ? await encryptSecret(secretKey, c.env.ENCRYPTION_KEY) : existing!.secret_key_encrypted;
	const values = {
		base_url: baseUrl,
		access_key_encrypted: accessEnc,
		secret_key_encrypted: secretEnc,
		access_key_hint: hint,
		saved_secret_id: accessSecretId,
		secret_key_secret_id: secretKeySecretId,
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
			`UPDATE onshape_links SET base_url = ?, access_key_encrypted = ?, secret_key_encrypted = ?, access_key_hint = ?, saved_secret_id = ?, secret_key_secret_id = ?, documents = ?,
			   branch = ?, formats = ?, interval_minutes = ?, backfill = ?, is_enabled = ?, next_check_at = NULL, retry_after = NULL, last_error = NULL, updated_at = ?
			 WHERE id = ?`
		)
			.bind(values.base_url, values.access_key_encrypted, values.secret_key_encrypted, values.access_key_hint, values.saved_secret_id, values.secret_key_secret_id, values.documents, values.branch, values.formats, values.interval_minutes, values.backfill, values.is_enabled, now, id)
			.run();
	} else {
		id = crypto.randomUUID();
		await DB.prepare(
			`INSERT INTO onshape_links (id, repo_id, base_url, access_key_encrypted, secret_key_encrypted, access_key_hint, saved_secret_id, secret_key_secret_id, documents, branch,
			   formats, interval_minutes, backfill, is_enabled, created_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(id, repo.id, values.base_url, values.access_key_encrypted, values.secret_key_encrypted, values.access_key_hint, values.saved_secret_id, values.secret_key_secret_id, values.documents, values.branch, values.formats, values.interval_minutes, values.backfill, values.is_enabled, auditContext(c).actor, now, now)
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
	return c.json({ link: await withSavedSecret(DB, row!), onshape_calls_used: client.calls }, existing ? 200 : 201);
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
