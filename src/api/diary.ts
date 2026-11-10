import { Hono, type Context } from 'hono';
import type { Env } from '../env.ts';
import { auditContext, hasRepoLevel, type RepoVariables } from '../middleware/repo-access.ts';
import { audit } from '../lib/audit.ts';
import { readJsonObject } from '../lib/request.ts';
import { mediaHeaders, parseByteRange } from '../lib/media.ts';
import {
	decodeCursor,
	encodeCursor,
	MEDIA_EXTENSIONS,
	MEDIA_MAX_BYTES,
	MEDIA_PER_ENTRY_MAX,
	mediaKey,
	mediaType,
	newDiaryId,
	PART_SIZE,
	partCount,
	partLength,
	parseFilename,
	parseHappenedAt,
	parseLimit,
	parseMediaIds,
	parseParts,
	parseSize,
	parseText,
	TEXT_MAX,
	type MediaKind,
} from '../lib/diary.ts';

// All routes run behind repoAccess (src/index.ts): `repoRecord` is set, GET
// needs read, other methods need write. Every lookup is scoped to the repo.
// Editing or deleting an entry additionally needs to be its author or a repo admin.
type DiaryEnv = { Bindings: Env; Variables: RepoVariables };
const app = new Hono<DiaryEnv>();

type EntryRow = {
	id: string;
	repo_id: string;
	body: string;
	happened_at: string;
	author: string;
	author_id: string | null;
	created_at: string;
	updated_at: string;
	capture_session_id?: string | null;
	capture_batch?: number | null;
};

type MediaRow = {
	id: string;
	repo_id: string;
	entry_id: string | null;
	position: number;
	r2_key: string;
	upload_id: string | null;
	filename: string;
	content_type: string;
	kind: MediaKind;
	size: number;
	status: 'pending' | 'ready';
	created_by_id: string | null;
	created_at: string;
};

const TEXT_ERROR = `text must be a string (max ${TEXT_MAX} characters)`;
const HAPPENED_ERROR = 'happened_at must be an ISO-8601 date-time with a time zone (e.g. 2026-10-03T03:26:00-04:00), not in the future';
const MEDIA_IDS_ERROR = `media_ids must be an array of up to ${MEDIA_PER_ENTRY_MAX} media ids`;

function author(c: Context<DiaryEnv>): { name: string; id: string | null } {
	const user = c.get('user');
	if (user) return { name: user.name || user.email, id: user.id };
	const key = c.get('apiKey');
	if (key) return { name: key.name || 'API key', id: key.id };
	return { name: 'system', id: null };
}

/** Media as the API returns it: no storage internals, plus the URL that serves the bytes. */
function publicMedia(c: Context<DiaryEnv>, m: MediaRow) {
	return {
		id: m.id,
		kind: m.kind,
		filename: m.filename,
		content_type: m.content_type,
		size: m.size,
		status: m.status,
		url: `/api/repos/${encodeURIComponent(c.get('repoRecord').name)}/diary/media/${m.id}/file`,
	};
}

async function withMedia(c: Context<DiaryEnv>, entries: EntryRow[]) {
	const byEntry = new Map<string, MediaRow[]>();
	if (entries.length) {
		const placeholders = entries.map(() => '?').join(',');
		const { results } = await c.env.DB.prepare(
			`SELECT * FROM diary_media WHERE entry_id IN (${placeholders}) AND status = 'ready' ORDER BY position ASC, created_at ASC`
		)
			.bind(...entries.map((e) => e.id))
			.all<MediaRow>();
		for (const m of results ?? []) {
			const list = byEntry.get(m.entry_id!) ?? [];
			list.push(m);
			byEntry.set(m.entry_id!, list);
		}
	}
	return entries.map((e) => ({
		id: e.id,
		text: e.body,
		happened_at: e.happened_at,
		author: e.author,
		author_id: e.author_id,
		created_at: e.created_at,
		updated_at: e.updated_at,
		...(e.capture_session_id ? { capture_session_id: e.capture_session_id, capture_batch: e.capture_batch } : {}),
		media: (byEntry.get(e.id) ?? []).map((m) => publicMedia(c, m)),
	}));
}

function loadEntry(c: Context<DiaryEnv>, id: string): Promise<EntryRow | null> {
	return c.env.DB.prepare('SELECT * FROM diary_entries WHERE id = ? AND repo_id = ?').bind(id, c.get('repoRecord').id).first<EntryRow>();
}

function loadMedia(c: Context<DiaryEnv>, id: string): Promise<MediaRow | null> {
	return c.env.DB.prepare('SELECT * FROM diary_media WHERE id = ? AND repo_id = ?').bind(id, c.get('repoRecord').id).first<MediaRow>();
}

/** Authors can change their own entries; repo admins can change any. */
async function canModify(c: Context<DiaryEnv>, entry: EntryRow): Promise<boolean> {
	const who = author(c);
	if (who.id && entry.author_id === who.id) return true;
	return hasRepoLevel(c, 'admin');
}

/**
 * Resolve `ids` to the caller's ready, unattached uploads in this repo (or
 * media already on `entryId`). Returns an error message when any id doesn't qualify.
 */
async function claimableMedia(c: Context<DiaryEnv>, ids: string[], entryId: string | null): Promise<MediaRow[] | string> {
	if (!ids.length) return [];
	const placeholders = ids.map(() => '?').join(',');
	const { results } = await c.env.DB.prepare(`SELECT * FROM diary_media WHERE repo_id = ? AND id IN (${placeholders})`)
		.bind(c.get('repoRecord').id, ...ids)
		.all<MediaRow>();
	const rows = new Map((results ?? []).map((m) => [m.id, m]));
	const who = author(c);
	for (const id of ids) {
		const m = rows.get(id);
		if (!m) return `media ${id} not found`;
		if (m.status !== 'ready') return `media ${id} has not finished uploading`;
		if (m.entry_id && m.entry_id !== entryId) return `media ${id} belongs to another entry`;
		if (!m.entry_id && m.created_by_id !== who.id) return `media ${id} was uploaded by someone else`;
	}
	return ids.map((id) => rows.get(id)!);
}

/** Delete media bytes (finished objects and unfinished multipart uploads). Best effort. */
async function purgeMediaObjects(env: Env, media: MediaRow[]): Promise<void> {
	const ready = media.filter((m) => m.status === 'ready').map((m) => m.r2_key);
	for (let i = 0; i < ready.length; i += 1000) {
		await env.STORAGE.delete(ready.slice(i, i + 1000)).catch((e) => console.warn('diary: R2 delete failed', e));
	}
	for (const m of media) {
		if (m.status === 'pending' && m.upload_id) {
			await env.STORAGE.resumeMultipartUpload(m.r2_key, m.upload_id)
				.abort()
				.catch(() => undefined);
		}
	}
}

async function auditDiary(c: Context<DiaryEnv>, action: string, details: Record<string, unknown>): Promise<void> {
	const { actor, ipAddress } = auditContext(c);
	await audit(c.env.DB, { repoId: c.get('repoRecord').id, actor, action, details, ipAddress });
}

// ─── GET /api/repos/:repo/diary?order=desc|asc&limit=&cursor= ───
app.get('/:repo/diary', async (c) => {
	const order = c.req.query('order') === 'asc' ? 'asc' : 'desc';
	const limit = parseLimit(c.req.query('limit'));
	if (limit === null) return c.json({ error: 'limit must be an integer from 1 to 100' }, 400);
	const rawCursor = c.req.query('cursor');
	const cursor = rawCursor ? decodeCursor(rawCursor) : null;
	if (rawCursor && !cursor) return c.json({ error: 'Invalid cursor' }, 400);

	const repoId = c.get('repoRecord').id;
	const cmp = order === 'asc' ? '>' : '<';
	const dir = order === 'asc' ? 'ASC' : 'DESC';
	const where = cursor ? `repo_id = ? AND (happened_at ${cmp} ? OR (happened_at = ? AND id ${cmp} ?))` : 'repo_id = ?';
	const params = cursor ? [repoId, cursor.happenedAt, cursor.happenedAt, cursor.id] : [repoId];
	const [{ results }, total] = await Promise.all([
		c.env.DB.prepare(`SELECT * FROM diary_entries WHERE ${where} ORDER BY happened_at ${dir}, id ${dir} LIMIT ?`)
			.bind(...params, limit + 1)
			.all<EntryRow>(),
		c.env.DB.prepare('SELECT COUNT(*) AS n FROM diary_entries WHERE repo_id = ?').bind(repoId).first<{ n: number }>(),
	]);
	const rows = results ?? [];
	const page = rows.slice(0, limit);
	const last = page[page.length - 1];
	return c.json({
		data: await withMedia(c, page),
		next_cursor: rows.length > limit && last ? encodeCursor(last.happened_at, last.id) : null,
		total: total?.n ?? 0,
	});
});

// ─── POST /api/repos/:repo/diary ────────────────────────────────
// { text?, happened_at?, media_ids? } — at least text or one media item.
app.post('/:repo/diary', async (c) => {
	const body = await readJsonObject<{ text: unknown; happened_at: unknown; media_ids: unknown; capture_session_id: unknown; capture_batch: unknown }>(c);
	if (!body) return c.json({ error: 'Expected a JSON object' }, 400);
	const text = parseText(body.text);
	if (text === null) return c.json({ error: TEXT_ERROR }, 400);
	const happenedAt = parseHappenedAt(body.happened_at);
	if (!happenedAt) return c.json({ error: HAPPENED_ERROR }, 400);
	const mediaIds = parseMediaIds(body.media_ids);
	if (mediaIds === null) return c.json({ error: MEDIA_IDS_ERROR }, 400);
	if (!text && !mediaIds?.length) return c.json({ error: 'An entry needs text or at least one photo/video' }, 400);
	const isCapture = body.capture_session_id !== undefined || body.capture_batch !== undefined;
	if (isCapture && (c.get('authType') !== 'station' || typeof body.capture_session_id !== 'string'
		|| !/^[a-f0-9-]{36}$/.test(body.capture_session_id)
		|| !Number.isInteger(body.capture_batch) || (body.capture_batch as number) < 0 || (body.capture_batch as number) > 999)) {
		return c.json({ error: 'Invalid capture session' }, 400);
	}
	if (isCapture) {
		const existing = await c.env.DB.prepare('SELECT * FROM diary_entries WHERE repo_id = ? AND capture_session_id = ? AND capture_batch = ?')
			.bind(c.get('repoRecord').id, body.capture_session_id, body.capture_batch).first<EntryRow>();
		if (existing) {
			if (existing.author_id !== author(c).id) return c.json({ error: 'Capture session belongs to another station' }, 409);
			return c.json({ data: (await withMedia(c, [existing]))[0] });
		}
	}

	const media = await claimableMedia(c, mediaIds ?? [], null);
	if (typeof media === 'string') return c.json({ error: media }, 400);

	const who = author(c);
	const now = new Date().toISOString();
	const entry: EntryRow = {
		id: newDiaryId(),
		repo_id: c.get('repoRecord').id,
		body: text,
		happened_at: happenedAt,
		author: who.name,
		author_id: who.id,
		created_at: now,
		updated_at: now,
		capture_session_id: isCapture ? body.capture_session_id as string : null,
		capture_batch: isCapture ? body.capture_batch as number : null,
	};
	try { await c.env.DB.batch([
		c.env.DB.prepare(
			`INSERT INTO diary_entries (id, repo_id, body, happened_at, author, author_id, created_at, updated_at, capture_session_id, capture_batch)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).bind(entry.id, entry.repo_id, entry.body, entry.happened_at, entry.author, entry.author_id, entry.created_at, entry.updated_at, entry.capture_session_id, entry.capture_batch),
		...media.map((m, i) =>
			c.env.DB.prepare('UPDATE diary_media SET entry_id = ?, position = ? WHERE id = ? AND entry_id IS NULL').bind(entry.id, i, m.id)
		),
	]); } catch (error) {
		if (isCapture) {
			const existing = await c.env.DB.prepare('SELECT * FROM diary_entries WHERE repo_id = ? AND capture_session_id = ? AND capture_batch = ?')
				.bind(c.get('repoRecord').id, body.capture_session_id, body.capture_batch).first<EntryRow>();
			if (existing && existing.author_id === author(c).id) return c.json({ data: (await withMedia(c, [existing]))[0] });
		}
		throw error;
	}
	await auditDiary(c, 'diary.create', { entry_id: entry.id, media: media.length });
	const [shaped] = await withMedia(c, [entry]);
	return c.json({ data: shaped }, 201);
});

// ─── GET /api/repos/:repo/diary/:id ─────────────────────────────
app.get('/:repo/diary/:id', async (c) => {
	const entry = await loadEntry(c, c.req.param('id'));
	if (!entry) return c.json({ error: 'Entry not found' }, 404);
	const [shaped] = await withMedia(c, [entry]);
	return c.json({ data: shaped });
});

// ─── PATCH /api/repos/:repo/diary/:id ───────────────────────────
// { text?, happened_at?, media_ids? }. media_ids is the full new list: it
// reorders, adds the caller's new uploads, and deletes media left out.
app.patch('/:repo/diary/:id', async (c) => {
	const entry = await loadEntry(c, c.req.param('id'));
	if (!entry) return c.json({ error: 'Entry not found' }, 404);
	if (!(await canModify(c, entry))) return c.json({ error: 'Only the author or a repo admin can edit this entry' }, 403);
	const body = await readJsonObject<{ text: unknown; happened_at: unknown; media_ids: unknown }>(c);
	if (!body) return c.json({ error: 'Expected a JSON object' }, 400);

	const next = { ...entry };
	if (body.text !== undefined) {
		const text = parseText(body.text);
		if (text === null) return c.json({ error: TEXT_ERROR }, 400);
		next.body = text;
	}
	if (body.happened_at !== undefined) {
		const happenedAt = parseHappenedAt(body.happened_at);
		if (!happenedAt || body.happened_at === null || body.happened_at === '') return c.json({ error: HAPPENED_ERROR }, 400);
		next.happened_at = happenedAt;
	}
	const mediaIds = parseMediaIds(body.media_ids);
	if (mediaIds === null) return c.json({ error: MEDIA_IDS_ERROR }, 400);

	const { results: current } = await c.env.DB.prepare('SELECT * FROM diary_media WHERE entry_id = ?').bind(entry.id).all<MediaRow>();
	let keep: MediaRow[] = [];
	let removed: MediaRow[] = [];
	if (mediaIds) {
		const claimed = await claimableMedia(c, mediaIds, entry.id);
		if (typeof claimed === 'string') return c.json({ error: claimed }, 400);
		keep = claimed;
		removed = (current ?? []).filter((m) => !mediaIds.includes(m.id));
	}
	const mediaCount = mediaIds ? keep.length : (current ?? []).length;
	if (!next.body && !mediaCount) return c.json({ error: 'An entry needs text or at least one photo/video' }, 400);

	next.updated_at = new Date().toISOString();
	await c.env.DB.batch([
		c.env.DB.prepare('UPDATE diary_entries SET body = ?, happened_at = ?, updated_at = ? WHERE id = ? AND repo_id = ?').bind(
			next.body,
			next.happened_at,
			next.updated_at,
			entry.id,
			entry.repo_id
		),
		...keep.map((m, i) => c.env.DB.prepare('UPDATE diary_media SET entry_id = ?, position = ? WHERE id = ?').bind(entry.id, i, m.id)),
		...removed.map((m) => c.env.DB.prepare('DELETE FROM diary_media WHERE id = ?').bind(m.id)),
	]);
	if (removed.length) c.executionCtx.waitUntil(purgeMediaObjects(c.env, removed));
	await auditDiary(c, 'diary.update', { entry_id: entry.id, removed_media: removed.length });
	const [shaped] = await withMedia(c, [next]);
	return c.json({ data: shaped });
});

// ─── DELETE /api/repos/:repo/diary/:id ──────────────────────────
app.delete('/:repo/diary/:id', async (c) => {
	const entry = await loadEntry(c, c.req.param('id'));
	if (!entry) return c.json({ error: 'Entry not found' }, 404);
	if (!(await canModify(c, entry))) return c.json({ error: 'Only the author or a repo admin can delete this entry' }, 403);
	const { results: media } = await c.env.DB.prepare('SELECT * FROM diary_media WHERE entry_id = ?').bind(entry.id).all<MediaRow>();
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM diary_media WHERE entry_id = ?').bind(entry.id),
		c.env.DB.prepare('DELETE FROM diary_entries WHERE id = ? AND repo_id = ?').bind(entry.id, entry.repo_id),
	]);
	c.executionCtx.waitUntil(purgeMediaObjects(c.env, media ?? []));
	await auditDiary(c, 'diary.delete', { entry_id: entry.id, media: (media ?? []).length });
	return c.json({ data: { id: entry.id, deleted: true } });
});

// ─── Media uploads ──────────────────────────────────────────────
// 1. POST   /diary/media                      { filename, size } → { id, part_size, part_count }
// 2. PUT    /diary/media/:id/parts/:n         raw bytes of part n (1-based) → { part_number, etag }
// 3. POST   /diary/media/:id/complete         { parts: [{ part_number, etag }] } → media
// 4. POST   /diary { media_ids: [id, …] } attaches it to an entry.
// Every part except the last is exactly part_size bytes.

app.post('/:repo/diary/media', async (c) => {
	const body = await readJsonObject<{ filename: unknown; size: unknown }>(c);
	if (!body) return c.json({ error: 'Expected a JSON object' }, 400);
	const filename = parseFilename(body.filename);
	if (!filename) return c.json({ error: 'filename is required' }, 400);
	const type = mediaType(filename);
	if (!type) return c.json({ error: `Unsupported file type. Allowed: ${MEDIA_EXTENSIONS.join(', ')}` }, 400);
	const size = parseSize(body.size);
	if (!size) return c.json({ error: `size must be a byte count from 1 to ${MEDIA_MAX_BYTES}` }, 400);

	const repoId = c.get('repoRecord').id;
	const id = newDiaryId();
	const key = mediaKey(repoId, id, filename);
	const upload = await c.env.STORAGE.createMultipartUpload(key, {
		httpMetadata: { contentType: type.type },
		customMetadata: { repo_id: repoId, media_id: id },
	});
	const now = new Date().toISOString();
	await c.env.DB.prepare(
		`INSERT INTO diary_media (id, repo_id, entry_id, position, r2_key, upload_id, filename, content_type, kind, size, status, created_by_id, created_at)
		 VALUES (?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
	)
		.bind(id, repoId, key, upload.uploadId, filename, type.type, type.kind, size, author(c).id, now)
		.run();
	return c.json({ data: { id, kind: type.kind, content_type: type.type, size, part_size: PART_SIZE, part_count: partCount(size) } }, 201);
});

/** A pending upload the caller started, or an error response. */
async function ownPendingUpload(c: Context<DiaryEnv>): Promise<MediaRow | Response> {
	const media = await loadMedia(c, c.req.param('id') ?? '');
	if (!media) return c.json({ error: 'Upload not found' }, 404);
	if (media.created_by_id !== author(c).id) return c.json({ error: 'This upload was started by someone else' }, 403);
	if (media.status !== 'pending' || !media.upload_id) return c.json({ error: 'This upload is already complete' }, 409);
	return media;
}

app.put('/:repo/diary/media/:id/parts/:n', async (c) => {
	const media = await ownPendingUpload(c);
	if (media instanceof Response) return media;
	const n = Number(c.req.param('n'));
	const expected = partLength(media.size, n);
	if (expected === null) return c.json({ error: `part number must be from 1 to ${partCount(media.size)}` }, 400);
	// Browsers always send Content-Length; in-process MCP calls may not. FixedLengthStream enforces it either way.
	const declared = c.req.header('Content-Length');
	if (declared !== undefined && Number(declared) !== expected) return c.json({ error: `part ${n} must be exactly ${expected} bytes, got ${declared}` }, 400);
	const body = c.req.raw.body;
	if (!body) return c.json({ error: 'Missing part body' }, 400);

	// R2 needs a stream of known length; FixedLengthStream also rejects a short or long body.
	const sized = new FixedLengthStream(expected);
	const piping = body.pipeTo(sized.writable);
	const upload = c.env.STORAGE.resumeMultipartUpload(media.r2_key, media.upload_id!);
	try {
		const [part] = await Promise.all([upload.uploadPart(n, sized.readable), piping]);
		return c.json({ data: { part_number: part.partNumber, etag: part.etag } });
	} catch (e) {
		console.warn(`diary: part ${n} of ${media.id} failed`, e);
		return c.json({ error: `Part ${n} failed to upload (it must be exactly ${expected} bytes); retry it` }, 502);
	}
});

app.post('/:repo/diary/media/:id/complete', async (c) => {
	const existing = await loadMedia(c, c.req.param('id'));
	if (existing?.status === 'ready' && existing.created_by_id === author(c).id) {
		return c.json({ data: publicMedia(c, existing) });
	}
	const media = await ownPendingUpload(c);
	if (media instanceof Response) return media;
	const body = await readJsonObject<{ parts: unknown }>(c);
	if (!body) return c.json({ error: 'Expected a JSON object' }, 400);
	const parts = parseParts(body.parts, media.size);
	if (!parts) return c.json({ error: `parts must list part_number 1..${partCount(media.size)} once each, with the etag each upload returned` }, 400);

	const upload = c.env.STORAGE.resumeMultipartUpload(media.r2_key, media.upload_id!);
	let object: R2Object;
	try {
		object = await upload.complete(parts);
	} catch (e) {
		console.warn(`diary: complete ${media.id} failed`, e);
		return c.json({ error: 'Could not assemble the upload; check every part uploaded and retry' }, 400);
	}
	if (object.size !== media.size) {
		await c.env.STORAGE.delete(media.r2_key);
		await c.env.DB.prepare('DELETE FROM diary_media WHERE id = ?').bind(media.id).run();
		return c.json({ error: `Upload is ${object.size} bytes, expected ${media.size}; start again` }, 400);
	}
	await c.env.DB.prepare("UPDATE diary_media SET status = 'ready', upload_id = NULL WHERE id = ?").bind(media.id).run();
	return c.json({ data: publicMedia(c, { ...media, status: 'ready', upload_id: null }) });
});

// Discard an upload that hasn't been attached to an entry (removed from the composer).
app.delete('/:repo/diary/media/:id', async (c) => {
	const media = await loadMedia(c, c.req.param('id'));
	if (!media) return c.json({ error: 'Upload not found' }, 404);
	if (media.entry_id) return c.json({ error: 'This media belongs to an entry; edit the entry to remove it' }, 409);
	if (media.created_by_id !== author(c).id) return c.json({ error: 'This upload was started by someone else' }, 403);
	await c.env.DB.prepare('DELETE FROM diary_media WHERE id = ?').bind(media.id).run();
	c.executionCtx.waitUntil(purgeMediaObjects(c.env, [media]));
	return c.json({ data: { id: media.id, deleted: true } });
});

// ─── GET /api/repos/:repo/diary/media/:id/file ──────────────────
// The bytes, with Range support (Safari won't play video without it).
// Objects never change, so the browser may cache them for good.
app.get('/:repo/diary/media/:id/file', async (c) => {
	const media = await loadMedia(c, c.req.param('id'));
	if (!media || media.status !== 'ready') return c.json({ error: 'Media not found' }, 404);
	const headers = mediaHeaders({
		contentType: media.content_type,
		filename: media.filename,
		disposition: c.req.query('download') ? 'attachment' : 'inline',
		cacheControl: 'private, max-age=31536000, immutable',
		sandbox: true,
	});

	const range = parseByteRange(c.req.header('Range'), media.size);
	if (range === 'invalid') {
		headers.set('Content-Range', `bytes */${media.size}`);
		return new Response(null, { status: 416, headers });
	}
	const object = await c.env.STORAGE.get(media.r2_key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
	if (!object) return c.json({ error: 'Media not found' }, 404);
	if (!range) {
		headers.set('Content-Length', String(object.size));
		return new Response(object.body, { status: 200, headers });
	}
	headers.set('Content-Length', String(range.end - range.start + 1));
	headers.set('Content-Range', `bytes ${range.start}-${range.end}/${media.size}`);
	return new Response(object.body, { status: 206, headers });
});

export default app;

// ─── Maintenance ────────────────────────────────────────────────

/** D1 binds at most 100 parameters per query, hence the batch of 90. */
/** Uploads never attached to an entry (abandoned composer, failed post) older than `olderThanMs` → bytes and rows deleted. */
export async function purgeOrphanDiaryMedia(env: Env, olderThanMs: number): Promise<number> {
	const cutoff = new Date(Date.now() - olderThanMs).toISOString();
	const { results } = await env.DB.prepare(
		'SELECT * FROM diary_media WHERE entry_id IS NULL AND julianday(created_at) < julianday(?) LIMIT 90'
	)
		.bind(cutoff)
		.all<MediaRow>();
	const rows = results ?? [];
	if (!rows.length) return 0;
	await purgeMediaObjects(env, rows);
	const placeholders = rows.map(() => '?').join(',');
	await env.DB.prepare(`DELETE FROM diary_media WHERE entry_id IS NULL AND id IN (${placeholders})`)
		.bind(...rows.map((m) => m.id))
		.run();
	return rows.length;
}
