/**
 * Diary: a per-repo build log of short posts (text + photos/videos + a
 * timestamp). Pure validation and shaping, so it can be unit tested without
 * D1 or R2. Routes live in src/api/diary.ts.
 *
 * Media bytes go to R2 as multipart uploads streamed through the Worker in
 * fixed-size parts, so phone videos of any size (up to MEDIA_MAX_BYTES) get
 * past the zone's per-request body limit without presigned URLs or bucket
 * CORS rules.
 */

export const TEXT_MAX = 20_000;
export const MEDIA_PER_ENTRY_MAX = 40;
/** R2 multipart parts must all be the same size except the last; R2's minimum is 5 MiB. */
export const PART_SIZE = 10 * 1024 * 1024;
export const MEDIA_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const FILENAME_MAX = 200;
export const PAGE_DEFAULT = 30;
export const PAGE_MAX = 100;

export type MediaKind = 'image' | 'video';

/**
 * Extension allowlist. The served Content-Type comes from here, never from
 * the uploader, and nothing script-capable (SVG, HTML) is on it.
 */
const MEDIA_TYPES: Record<string, { type: string; kind: MediaKind }> = {
	jpg: { type: 'image/jpeg', kind: 'image' },
	jpeg: { type: 'image/jpeg', kind: 'image' },
	png: { type: 'image/png', kind: 'image' },
	gif: { type: 'image/gif', kind: 'image' },
	webp: { type: 'image/webp', kind: 'image' },
	avif: { type: 'image/avif', kind: 'image' },
	heic: { type: 'image/heic', kind: 'image' },
	heif: { type: 'image/heif', kind: 'image' },
	mp4: { type: 'video/mp4', kind: 'video' },
	m4v: { type: 'video/mp4', kind: 'video' },
	mov: { type: 'video/quicktime', kind: 'video' },
	webm: { type: 'video/webm', kind: 'video' },
};

export const MEDIA_EXTENSIONS = Object.keys(MEDIA_TYPES);

export function mediaType(filename: string): { type: string; kind: MediaKind } | null {
	const dot = filename.lastIndexOf('.');
	if (dot <= 0) return null;
	return MEDIA_TYPES[filename.slice(dot + 1).toLowerCase()] ?? null;
}

/** Last path segment, control characters and slashes removed, trimmed to FILENAME_MAX. Null if nothing usable. */
export function parseFilename(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const base = value.split(/[\\/]/).pop() ?? '';
	const clean = base.replace(/[\x00-\x1f\x7f]/g, '').trim();
	if (!clean || clean === '.' || clean === '..') return null;
	if (clean.length <= FILENAME_MAX) return clean;
	const dot = clean.lastIndexOf('.');
	const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : '';
	return clean.slice(0, FILENAME_MAX - ext.length) + ext;
}

export function parseSize(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MEDIA_MAX_BYTES ? value : null;
}

/** Entry text (may be empty — a post can be media only), or null when not a string or too long. */
export function parseText(value: unknown): string | null {
	if (value === undefined || value === null) return '';
	if (typeof value !== 'string') return null;
	const text = value.replace(/\r\n?/g, '\n').trim();
	return text.length <= TEXT_MAX ? text : null;
}

/**
 * When the moment happened, as a canonical ISO string. Defaults to `now`.
 * Accepts anything Date.parse understands that carries a time zone; refuses
 * dates more than a day in the future (clock skew) or before 1970.
 */
export function parseHappenedAt(value: unknown, now = new Date()): string | null {
	if (value === undefined || value === null || value === '') return now.toISOString();
	if (typeof value !== 'string' || value.length > 40) return null;
	// A bare "2026-10-03T03:26" has no zone and would be read in the Worker's UTC.
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value.trim())) return null;
	const t = Date.parse(value);
	if (Number.isNaN(t) || t < 0 || t > now.getTime() + 24 * 60 * 60 * 1000) return null;
	return new Date(t).toISOString();
}

/** A list of media ids: unique, short strings, at most MEDIA_PER_ENTRY_MAX. Undefined when absent, null when invalid. */
export function parseMediaIds(value: unknown): string[] | null | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.length > MEDIA_PER_ENTRY_MAX) return null;
	const ids: string[] = [];
	for (const v of value) {
		if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) return null;
		if (!ids.includes(v)) ids.push(v);
	}
	return ids;
}

export function partCount(size: number): number {
	return Math.max(1, Math.ceil(size / PART_SIZE));
}

/** Expected byte length of 1-based part `n` of a `size`-byte upload, or null when n is out of range. */
export function partLength(size: number, n: number): number | null {
	const count = partCount(size);
	if (!Number.isInteger(n) || n < 1 || n > count) return null;
	return n < count ? PART_SIZE : size - PART_SIZE * (count - 1);
}

export interface UploadedPart {
	partNumber: number;
	etag: string;
}

/** The client's list of uploaded parts: exactly 1..count, each once, with an etag. */
export function parseParts(value: unknown, size: number): UploadedPart[] | null {
	const count = partCount(size);
	if (!Array.isArray(value) || value.length !== count) return null;
	const parts: UploadedPart[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') return null;
		const { part_number, etag } = raw as Record<string, unknown>;
		if (typeof part_number !== 'number' || partLength(size, part_number) === null) return null;
		if (typeof etag !== 'string' || !etag || etag.length > 200) return null;
		parts.push({ partNumber: part_number, etag });
	}
	parts.sort((a, b) => a.partNumber - b.partNumber);
	return parts.every((p, i) => p.partNumber === i + 1) ? parts : null;
}

/** R2 key for a media object. Grouped per repo so a repo's diary can be purged by prefix. */
export function mediaKey(repoId: string, mediaId: string, filename: string): string {
	const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100) || 'file';
	return `diary/${repoId}/${mediaId}/${safe}`;
}

/** Short, URL-friendly id: 12 chars of base36. */
export function newDiaryId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

/** Pagination cursor: `<happened_at>|<id>` of the last entry on the previous page. */
export function encodeCursor(happenedAt: string, id: string): string {
	return `${happenedAt}|${id}`;
}

export function decodeCursor(value: unknown): { happenedAt: string; id: string } | null {
	if (typeof value !== 'string') return null;
	const bar = value.lastIndexOf('|');
	if (bar <= 0) return null;
	const happenedAt = value.slice(0, bar);
	const id = value.slice(bar + 1);
	if (Number.isNaN(Date.parse(happenedAt)) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
	return { happenedAt, id };
}

export function parseLimit(value: unknown): number | null {
	if (value === undefined || value === null || value === '') return PAGE_DEFAULT;
	const n = Number(value);
	return Number.isInteger(n) && n >= 1 && n <= PAGE_MAX ? n : null;
}
