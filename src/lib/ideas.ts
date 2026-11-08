/**
 * Ideas: validation and shaping. Pure functions, so they can be unit tested
 * without D1. Routes live in src/api/ideas.ts.
 */

export const IDEA_STATUSES = ['created', 'in_progress', 'done', 'abandoned'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

export const IDEA_STATUS_LABELS: Record<IdeaStatus, string> = {
	created: 'Created',
	in_progress: 'In progress',
	done: 'Done',
	abandoned: 'Abandoned',
};

export const STATUS_ERROR = 'status must be one of created, in_progress, done, abandoned';

export const TITLE_MAX = 200;
export const BODY_MAX = 20_000;
export const LOG_TEXT_MAX = 20_000;
const REFS_COMMITS_MAX = 50;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const BRANCH_MAX = 255;
const RUN_ID_MAX = 100;

export interface IdeaRefs {
	commits?: string[];
	branch?: string;
	ci_run_id?: string;
}

export function isIdeaStatus(value: unknown): value is IdeaStatus {
	return typeof value === 'string' && (IDEA_STATUSES as readonly string[]).includes(value);
}

/** Trimmed, single-line title, or null when empty, too long or not a string. */
export function parseTitle(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const title = value.replace(/\s+/g, ' ').trim();
	return title && title.length <= TITLE_MAX ? title : null;
}

/** Markdown body (may be empty), or null when too long or not a string. */
export function parseBody(value: unknown): string | null {
	if (value === undefined || value === null) return '';
	if (typeof value !== 'string') return null;
	const body = value.trim();
	return body.length <= BODY_MAX ? body : null;
}

/** Log entry text: non-empty, or null. */
export function parseLogText(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const text = value.trim();
	return text && text.length <= LOG_TEXT_MAX ? text : null;
}

/**
 * Optional references on a log entry. Returns `undefined` when absent,
 * `null` when present but invalid. Commit SHAs are lower-cased and deduped.
 */
export function parseRefs(value: unknown): IdeaRefs | null | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const refs: IdeaRefs = {};

	if (raw.commits !== undefined) {
		if (!Array.isArray(raw.commits) || raw.commits.length > REFS_COMMITS_MAX) return null;
		const commits: string[] = [];
		for (const c of raw.commits) {
			if (typeof c !== 'string') return null;
			const sha = c.trim().toLowerCase();
			if (!SHA_RE.test(sha)) return null;
			if (!commits.includes(sha)) commits.push(sha);
		}
		if (commits.length) refs.commits = commits;
	}
	if (raw.branch !== undefined) {
		if (typeof raw.branch !== 'string') return null;
		const branch = raw.branch.trim();
		if (!branch || branch.length > BRANCH_MAX || /[\s\x00-\x1f]/.test(branch)) return null;
		refs.branch = branch;
	}
	if (raw.ci_run_id !== undefined) {
		if (typeof raw.ci_run_id !== 'string') return null;
		const id = raw.ci_run_id.trim();
		if (!id || id.length > RUN_ID_MAX) return null;
		refs.ci_run_id = id;
	}
	return Object.keys(refs).length ? refs : undefined;
}

/** Stored JSON → refs object (never throws). */
export function readRefs(stored: string | null): IdeaRefs | null {
	if (!stored) return null;
	try {
		const parsed = parseRefs(JSON.parse(stored));
		return parsed ?? null;
	} catch {
		return null;
	}
}

/** Short, URL-friendly id: 8 chars of base36. Collisions are retried by the caller's PK. */
export function newIdeaId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

/** Text for the automatic log entry written on a status change. */
export function statusChangeText(from: IdeaStatus, to: IdeaStatus, note?: string | null): string {
	const line = `Status: ${IDEA_STATUS_LABELS[from]} → ${IDEA_STATUS_LABELS[to]}`;
	return note ? `${line}\n\n${note}` : line;
}
