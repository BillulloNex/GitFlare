/**
 * Git LFS shared helpers (pure — no bindings), used by src/api/lfs.ts,
 * src/api/lfs-api.ts and src/lib/artifact-reader.ts.
 *
 *   - pointer file parsing (the ~130-byte text blob git stores in place of
 *     the real content, https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md)
 *   - oid validation and the R2 key layout
 *   - batch API request/response types + validation
 *   - .gitattributes → tracked patterns
 */

// ─── Constants ──────────────────────────────────────────────────

export const LFS_CONTENT_TYPE = 'application/vnd.git-lfs+json';
export const LFS_POINTER_VERSION = 'https://git-lfs.github.com/spec/v1';
/** The spec caps pointer files at 1024 bytes. */
export const LFS_POINTER_MAX_BYTES = 1024;
/** Artifacts rejects any single git blob over this (developers.cloudflare.com/artifacts/platform/limits). */
export const ARTIFACTS_MAX_BLOB_BYTES = 32 * 1024 * 1024;
/** Largest single PUT R2 accepts (multipart is not part of the LFS basic transfer). */
export const R2_MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024;
/**
 * Worker request-body limit when bytes are proxied through the Worker. 100 MB
 * on Free/Pro zones, 200 MB Business, 500 MB Enterprise. The proxy transfer
 * mode cannot accept more than the zone allows no matter what this says.
 */
export const PROXY_MAX_OBJECT_BYTES = 100 * 1024 * 1024;
/** Objects per batch request we accept; git-lfs sends 100 by default. */
export const LFS_MAX_BATCH_OBJECTS = 1000;
/** D1 binds at most 100 parameters per statement; keep IN (...) lists well under. */
export const LFS_D1_CHUNK = 50;

const OID_RE = /^[a-f0-9]{64}$/;

export function isValidOid(oid: unknown): oid is string {
	return typeof oid === 'string' && OID_RE.test(oid);
}

export function isValidSize(size: unknown): size is number {
	return typeof size === 'number' && Number.isInteger(size) && size >= 0 && size <= R2_MAX_SINGLE_PUT_BYTES;
}

/** R2 object key. One prefix per repo so a repo delete is a prefix delete. */
export function lfsObjectKey(repoId: string, oid: string): string {
	return `lfs/${repoId}/${oid}`;
}

export function lfsRepoPrefix(repoId: string): string {
	return `lfs/${repoId}/`;
}

// ─── Pointer files ──────────────────────────────────────────────

export interface LfsPointer {
	oid: string;
	size: number;
}

/**
 * Parse a Git LFS pointer file. Returns null for anything that is not one.
 *
 * A pointer is a short text file of `key value` lines, sorted, with exactly
 * these required keys:
 *
 *   version https://git-lfs.github.com/spec/v1
 *   oid sha256:<64 hex>
 *   size <bytes>
 *
 * `version` must be first; any other keys are extensions and ignored.
 */
export function parseLfsPointer(content: string | Uint8Array): LfsPointer | null {
	let text: string;
	if (typeof content === 'string') {
		text = content;
	} else {
		if (content.length > LFS_POINTER_MAX_BYTES || content.includes(0)) return null;
		try {
			text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(content);
		} catch {
			return null;
		}
	}
	if (text.length > LFS_POINTER_MAX_BYTES) return null;
	if (!text.startsWith('version ')) return null;

	const lines = text.split('\n');
	if (lines[lines.length - 1] === '') lines.pop();
	if (lines.length < 3) return null;

	let version: string | undefined;
	let oid: string | undefined;
	let size: number | undefined;
	for (const line of lines) {
		const sp = line.indexOf(' ');
		if (sp <= 0) return null;
		const key = line.slice(0, sp);
		const value = line.slice(sp + 1);
		if (key === 'version') {
			if (version !== undefined) return null;
			version = value;
		} else if (key === 'oid') {
			if (oid !== undefined || !value.startsWith('sha256:')) return null;
			const hex = value.slice('sha256:'.length);
			if (!isValidOid(hex)) return null;
			oid = hex;
		} else if (key === 'size') {
			if (size !== undefined || !/^\d+$/.test(value)) return null;
			size = Number(value);
			if (!Number.isSafeInteger(size)) return null;
		}
	}
	if (version !== LFS_POINTER_VERSION || oid === undefined || size === undefined) return null;
	return { oid, size };
}

export function buildLfsPointer(oid: string, size: number): string {
	return `version ${LFS_POINTER_VERSION}\noid sha256:${oid}\nsize ${size}\n`;
}

// ─── .gitattributes ─────────────────────────────────────────────

/**
 * Patterns tracked by LFS in a .gitattributes file: every line whose
 * attributes include `filter=lfs`. Quoted patterns (paths with spaces) are
 * unquoted. Comments and blank lines are skipped.
 */
export function lfsTrackedPatterns(gitattributes: string): string[] {
	const patterns: string[] = [];
	for (const raw of gitattributes.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		let pattern: string;
		let rest: string;
		if (line.startsWith('"')) {
			const end = line.indexOf('"', 1);
			if (end < 0) continue;
			pattern = line.slice(1, end);
			rest = line.slice(end + 1);
		} else {
			const sp = line.search(/\s/);
			if (sp < 0) continue;
			pattern = line.slice(0, sp);
			rest = line.slice(sp);
		}
		const attrs = rest.trim().split(/\s+/);
		if (attrs.includes('filter=lfs')) patterns.push(pattern);
	}
	return patterns;
}

// ─── Batch API ──────────────────────────────────────────────────

export type LfsOperation = 'download' | 'upload';

export interface LfsBatchRequest {
	operation: LfsOperation;
	transfers?: string[];
	ref?: { name?: string };
	objects: { oid: string; size: number }[];
	hash_algo?: string;
}

export interface LfsAction {
	href: string;
	header?: Record<string, string>;
	expires_in?: number;
	expires_at?: string;
}

export interface LfsBatchObject {
	oid: string;
	size: number;
	authenticated?: boolean;
	actions?: Partial<Record<'download' | 'upload' | 'verify', LfsAction>>;
	error?: { code: number; message: string };
}

export interface LfsBatchResponse {
	transfer: 'basic';
	objects: LfsBatchObject[];
	hash_algo?: 'sha256';
}

export type LfsBatchValidation =
	| { ok: true; request: LfsBatchRequest }
	| { ok: false; status: number; message: string };

/** Validate a parsed batch request body. Per-object oid/size problems are reported per object by the caller. */
export function validateBatchRequest(body: unknown): LfsBatchValidation {
	if (!body || typeof body !== 'object') return { ok: false, status: 400, message: 'Batch request must be a JSON object' };
	const b = body as Record<string, unknown>;
	if (b.operation !== 'download' && b.operation !== 'upload') {
		return { ok: false, status: 400, message: 'operation must be "download" or "upload"' };
	}
	if (b.transfers !== undefined) {
		if (!Array.isArray(b.transfers) || !b.transfers.every((t) => typeof t === 'string')) {
			return { ok: false, status: 400, message: 'transfers must be an array of strings' };
		}
		if (b.transfers.length > 0 && !b.transfers.includes('basic')) {
			return { ok: false, status: 422, message: 'Only the "basic" transfer adapter is supported' };
		}
	}
	if (b.hash_algo !== undefined && b.hash_algo !== 'sha256') {
		return { ok: false, status: 422, message: 'Only the sha256 hash algorithm is supported' };
	}
	if (!Array.isArray(b.objects)) return { ok: false, status: 400, message: 'objects must be an array' };
	if (b.objects.length > LFS_MAX_BATCH_OBJECTS) {
		return { ok: false, status: 422, message: `At most ${LFS_MAX_BATCH_OBJECTS} objects per batch` };
	}
	const objects: { oid: string; size: number }[] = [];
	for (const o of b.objects) {
		if (!o || typeof o !== 'object') return { ok: false, status: 400, message: 'each object must be { oid, size }' };
		const { oid, size } = o as Record<string, unknown>;
		objects.push({ oid: typeof oid === 'string' ? oid : '', size: typeof size === 'number' ? size : -1 });
	}
	const ref = b.ref && typeof b.ref === 'object' ? (b.ref as { name?: unknown }) : undefined;
	return {
		ok: true,
		request: {
			operation: b.operation,
			transfers: b.transfers as string[] | undefined,
			objects,
			ref: ref && typeof ref.name === 'string' ? { name: ref.name } : undefined,
			hash_algo: 'sha256',
		},
	};
}

/** Human-readable byte count for messages ("184.3 MB"). */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/**
 * The recipe shown to a pusher whose pack contains a blob over the Artifacts
 * limit. Written to be executed verbatim by a human or an agent. The pack
 * does not say which path the blob has, so the pattern is a placeholder.
 */
export function lfsFixRecipe(opts: { docsUrl: string; sizes: number[]; reason?: string }): string {
	const biggest = opts.sizes.reduce((m, s) => (s > m ? s : m), 0);
	const lines = [
		opts.reason ??
			`a file in this push is ${formatBytes(biggest)}; GitFlare stores blobs over ${formatBytes(ARTIFACTS_MAX_BLOB_BYTES)} in Git LFS.`,
		'To fix (replace *.bin with the large file\'s extension or path):',
		'  git lfs install',
		'  git lfs track "*.bin"',
		'  git add .gitattributes',
		'  git commit --amend --no-edit     # if the file was added in the last commit',
		'  git push',
		'If the file is in an earlier commit of this push, rewrite the pushed history instead:',
		'  git lfs migrate import --include="*.bin" --everything',
		'  git push --force-with-lease',
		`Docs: ${opts.docsUrl}`,
	];
	return lines.join('\n');
}

/** True if a storage error message is about a size limit (Artifacts' wording is not documented). */
export function looksLikeSizeLimitError(text: string): boolean {
	return /\b(too (large|big)|size limit|exceed|max(imum)? (blob|object|file|repo)|32 ?MiB|32 ?MB|1 ?GiB|1 ?GB)\b/i.test(text);
}
