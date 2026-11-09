/**
 * Repository data tables: one CSV file per table under `tables/` on a branch.
 *
 * Git is the version control. Every save from the dashboard, the REST API or
 * MCP is one commit, written by the Worker (no runner) with the same objects
 * and push lock as the Onshape sync. Tables pushed with plain git show up too:
 * any `tables/*.csv` file is a table.
 *
 *   tables/BOM.csv
 *   tables/Potential collaborators.csv
 *
 * Saves are optimistic: the client sends the blob id it loaded (`base_blob`);
 * if the file changed on the branch since, the save is refused (409) instead
 * of overwriting someone else's edit. Edits to other files never conflict.
 */
import type { ArtifactRepo, Env, RepoRecord } from '../env.ts';
import { getArtifactsRemoteUrl } from './artifacts-url.ts';
import { audit } from './audit.ts';
import { parseCsv, serializeCsv, type TableData } from './csv.ts';
import {
	applyTreeChanges,
	makeBlob,
	makeCommit,
	MODE_TREE,
	buildReceivePackRequest,
	type GitObject,
	type TreeChanges,
	type TreeEntry,
} from './git-objects.ts';
import { parseInfoRefs, parseReceivePackResponse } from './git-protocol.ts';
import { triggerGitHubMirror } from './github-mirror.ts';
import { branchIsProtected } from './onshape-sync.ts';
import { acquirePushLock, releasePushLock } from './push-lock.ts';
import { mintToken } from './runner-client.ts';

export const TABLES_DIR = 'tables';
export const TABLE_EXT = '.csv';

export const MAX_TABLE_NAME = 80;
export const MAX_COLUMNS = 200;
export const MAX_COLUMN_NAME = 200;
export const MAX_ROWS = 50_000;
export const MAX_CELL = 20_000;
/** Largest CSV a table may serialize to. Larger data belongs in LFS, not a table. */
export const MAX_TABLE_BYTES = 5 * 1024 * 1024;
/** Commits walked for table history (first-parent chain from the branch tip). */
export const HISTORY_DEPTH = 200;

const COMMITTER = { name: 'GitFlare Tables', email: 'tables@gitflare.invalid' };

/** An error with the HTTP status the API should answer with. */
export class TableError extends Error {
	constructor(
		public status: 400 | 404 | 409 | 413 | 502,
		message: string,
		public extra: Record<string, unknown> = {}
	) {
		super(message);
	}
}

// ─── Names and paths ────────────────────────────────────────────

/**
 * A table name as typed → the canonical name, or null if invalid. Names are
 * file names: letters, digits, spaces and `._()&+-`, starting with a letter or
 * digit, at most 80 characters. A trailing `.csv` is dropped.
 */
export function normalizeTableName(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	let name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
	if (name.toLowerCase().endsWith(TABLE_EXT)) name = name.slice(0, -TABLE_EXT.length).trim();
	if (!name || name.length > MAX_TABLE_NAME) return null;
	if (!/^[\p{L}\p{N}][\p{L}\p{N} ._()&+-]*$/u.test(name)) return null;
	if (name.endsWith('.')) return null;
	return name;
}

export function tablePath(name: string): string {
	return `${TABLES_DIR}/${name}${TABLE_EXT}`;
}

/** `tables/<name>.csv` tree entry name → table name, or null for anything else. */
export function tableNameFromEntry(entryName: string): string | null {
	if (!entryName.toLowerCase().endsWith(TABLE_EXT)) return null;
	const name = entryName.slice(0, -TABLE_EXT.length);
	return name ? name : null;
}

// ─── Table content ──────────────────────────────────────────────

const normalizeCell = (v: string) => v.replace(/\r\n?/g, '\n');

/**
 * Validate a table body from the API: either `{ csv }` or `{ columns, rows }`.
 * All cells are text. Rows shorter than the header are padded; longer rows
 * are refused. Returns the table and its CSV serialization.
 */
export function parseTableInput(body: { csv?: unknown; columns?: unknown; rows?: unknown }): { table: TableData; csv: string } {
	let table: TableData;
	if (body.csv !== undefined) {
		if (typeof body.csv !== 'string') throw new TableError(400, 'csv must be a string');
		table = parseCsv(body.csv);
	} else {
		if (!Array.isArray(body.columns)) throw new TableError(400, 'columns must be an array of column names (or send csv)');
		const rows = body.rows ?? [];
		if (!Array.isArray(rows)) throw new TableError(400, 'rows must be an array of arrays of strings');
		table = {
			columns: body.columns.map((c) => {
				if (typeof c !== 'string') throw new TableError(400, 'every column name must be a string');
				return c;
			}),
			rows: rows.map((r, i) => {
				if (!Array.isArray(r)) throw new TableError(400, `row ${i + 1} must be an array of strings`);
				return r.map((v) => {
					if (v === null || v === undefined) return '';
					if (typeof v === 'number' || typeof v === 'boolean') return String(v);
					if (typeof v !== 'string') throw new TableError(400, `row ${i + 1} has a cell that is not text`);
					return v;
				});
			}),
		};
	}

	const columns = table.columns.map((c) => normalizeCell(c).replace(/\n/g, ' ').trim());
	if (columns.length === 0) throw new TableError(400, 'a table needs at least one column');
	if (columns.length > MAX_COLUMNS) throw new TableError(400, `a table has at most ${MAX_COLUMNS} columns`);
	const seen = new Set<string>();
	for (const c of columns) {
		if (!c) throw new TableError(400, 'column names cannot be empty');
		if (c.length > MAX_COLUMN_NAME) throw new TableError(400, `column names are at most ${MAX_COLUMN_NAME} characters`);
		if (seen.has(c)) throw new TableError(400, `duplicate column name "${c}"`);
		seen.add(c);
	}
	if (table.rows.length > MAX_ROWS) throw new TableError(400, `a table has at most ${MAX_ROWS} rows`);
	const rows = table.rows.map((r, i) => {
		if (r.length > columns.length) throw new TableError(400, `row ${i + 1} has ${r.length} cells but the table has ${columns.length} columns`);
		const row = r.map((v) => {
			const cell = normalizeCell(v);
			if (cell.length > MAX_CELL) throw new TableError(400, `row ${i + 1} has a cell over ${MAX_CELL} characters`);
			return cell;
		});
		while (row.length < columns.length) row.push('');
		return row;
	});

	const csv = serializeCsv({ columns, rows });
	if (new TextEncoder().encode(csv).length > MAX_TABLE_BYTES) {
		throw new TableError(413, `table is over ${MAX_TABLE_BYTES / 1024 / 1024} MB as CSV; store large data as a file in the repository instead`);
	}
	return { table: { columns, rows }, csv };
}

// ─── Reading ────────────────────────────────────────────────────

export interface TableFile {
	name: string;
	path: string;
	/** Git blob id of the CSV — the `base_blob` for the next save. */
	blob: string;
}

async function openRepo(env: Env, repoName: string): Promise<ArtifactRepo> {
	const repo = await env.REPOS.get(repoName).catch((err: any) => {
		if (err?.code === 'NOT_FOUND') return null;
		throw err;
	});
	if (!repo) throw new TableError(404, 'Repository storage not found');
	return repo;
}

/** The `tables` subtree id of a root tree, or null when there is none. */
async function tablesTreeOf(repo: ArtifactRepo, rootTree: string): Promise<string | null> {
	const entries = await repo.readTree(rootTree);
	return entries?.find((e) => e.name === TABLES_DIR && e.type === 'tree')?.hash ?? null;
}

async function tableFilesIn(repo: ArtifactRepo, tablesTree: string | null): Promise<TableFile[]> {
	if (!tablesTree) return [];
	const entries = (await repo.readTree(tablesTree)) ?? [];
	const files: TableFile[] = [];
	for (const e of entries) {
		if (e.type !== 'blob' && e.type !== 'exec') continue;
		const name = tableNameFromEntry(e.name);
		if (name) files.push({ name, path: `${TABLES_DIR}/${e.name}`, blob: e.hash });
	}
	return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

/** Resolve a branch, tag or commit id to its commit. Null when the ref has no commits. */
export async function resolveRef(env: Env, repoName: string, ref: string) {
	const repo = await openRepo(env, repoName);
	const [commit] = await repo.log({ ref, limit: 1 });
	return { repo, commit: commit ?? null };
}

export async function listTables(env: Env, repoName: string, ref: string): Promise<{ commit: string | null; tables: TableFile[] }> {
	const { repo, commit } = await resolveRef(env, repoName, ref);
	if (!commit) return { commit: null, tables: [] };
	return { commit: commit.hash, tables: await tableFilesIn(repo, await tablesTreeOf(repo, commit.treeHash)) };
}

export async function readTable(
	env: Env,
	repoName: string,
	name: string,
	ref: string
): Promise<{ commit: string; file: TableFile; table: TableData; truncated?: boolean } | null> {
	const { repo, commit } = await resolveRef(env, repoName, ref);
	if (!commit) return null;
	const files = await tableFilesIn(repo, await tablesTreeOf(repo, commit.treeHash));
	const file = files.find((f) => f.name === name);
	if (!file) return null;
	const blob = await repo.readBlob(file.blob);
	if (!blob) return null;
	const bytes = new Uint8Array(await blob.arrayBuffer());
	if (bytes.length > MAX_TABLE_BYTES * 2) {
		throw new TableError(413, `${file.path} is too large to open as a table (${Math.round(bytes.length / 1024 / 1024)} MB)`);
	}
	const text = new TextDecoder('utf-8').decode(bytes);
	return { commit: commit.hash, file, table: parseCsv(text) };
}

// ─── History ────────────────────────────────────────────────────

export type TableChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface TableChange {
	table: string;
	kind: TableChangeKind;
	/** For `renamed`: the previous name. */
	from?: string;
	/** Blob after the change (null when deleted). */
	blob: string | null;
}

export interface TableCommit {
	sha: string;
	/** First parent, for diffing against the previous version. Null for a root commit. */
	parent: string | null;
	message: string;
	author: { name: string; email: string };
	date: string;
	changes: TableChange[];
}

export interface TablesHistory {
	head: string | null;
	/** True when older commits exist beyond HISTORY_DEPTH. */
	truncated: boolean;
	commits: TableCommit[];
}

/** Compare two `tables/` listings (name → blob). Pure; exported for tests. */
export function diffTableListings(before: Map<string, string>, after: Map<string, string>): TableChange[] {
	const added: TableChange[] = [];
	const deleted: TableChange[] = [];
	const changes: TableChange[] = [];
	for (const [name, blob] of after) {
		const prev = before.get(name);
		if (prev === undefined) added.push({ table: name, kind: 'added', blob });
		else if (prev !== blob) changes.push({ table: name, kind: 'modified', blob });
	}
	for (const [name] of before) if (!after.has(name)) deleted.push({ table: name, kind: 'deleted', blob: null });
	// A table that disappeared while one with identical content appeared was renamed.
	for (const a of added) {
		const i = deleted.findIndex((d) => before.get(d.table) === a.blob);
		if (i >= 0) {
			changes.push({ table: a.table, kind: 'renamed', from: deleted[i].table, blob: a.blob });
			deleted.splice(i, 1);
		} else changes.push(a);
	}
	changes.push(...deleted);
	return changes.sort((x, y) => x.table.localeCompare(y.table));
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
	return out;
}

/**
 * Every commit on the first-parent chain of `ref` (up to HISTORY_DEPTH) that
 * changed a table, newest first. Cached per tip commit: a commit's history
 * never changes, so a new push is the only thing that triggers a new walk.
 */
export async function tablesHistory(env: Env, repoRecord: Pick<RepoRecord, 'id' | 'name'>, ref: string): Promise<TablesHistory> {
	const repo = await openRepo(env, repoRecord.name);
	const commits = await repo.log({ ref, limit: HISTORY_DEPTH + 1 });
	if (commits.length === 0) return { head: null, truncated: false, commits: [] };
	const head = commits[0].hash;

	const cacheKey = `tables-history:v1:${repoRecord.id}:${head}`;
	const cached = await env.CACHE.get(cacheKey, 'json').catch(() => null);
	if (cached) return cached as TablesHistory;

	const truncated = commits.length > HISTORY_DEPTH;
	// The extra commit (if any) is only the parent of the oldest one we report.
	const tablesTrees = await inBatches(commits, 10, (c) => tablesTreeOf(repo, c.treeHash));
	const listingCache = new Map<string, Promise<Map<string, string>>>();
	const listing = (tree: string | null): Promise<Map<string, string>> => {
		if (!tree) return Promise.resolve(new Map());
		let p = listingCache.get(tree);
		if (!p) {
			p = tableFilesIn(repo, tree).then((files) => new Map(files.map((f) => [f.name, f.blob])));
			listingCache.set(tree, p);
		}
		return p;
	};

	const reported = commits.slice(0, HISTORY_DEPTH);
	const results = await inBatches(reported.map((c, i) => ({ c, i })), 10, async ({ c, i }): Promise<TableCommit | null> => {
		const after = tablesTrees[i];
		const before = i + 1 < commits.length ? tablesTrees[i + 1] : null;
		if (after === before) return null;
		const changes = diffTableListings(await listing(before), await listing(after));
		if (changes.length === 0) return null;
		return {
			sha: c.hash,
			parent: c.parents[0] ?? null,
			message: c.message.trimEnd(),
			author: c.author,
			date: new Date(c.committedAt * 1000).toISOString(),
			changes,
		};
	});

	const history: TablesHistory = { head, truncated, commits: results.filter((r): r is TableCommit => r !== null) };
	await env.CACHE.put(cacheKey, JSON.stringify(history), { expirationTtl: 7 * 24 * 3600 }).catch(() => {});
	return history;
}

/** The history of one table, following renames back to its earlier names. */
export function historyForTable(history: TablesHistory, name: string): TableCommit[] {
	const out: TableCommit[] = [];
	let current = name;
	for (const commit of history.commits) {
		const change = commit.changes.find((ch) => ch.table === current);
		if (!change) continue;
		out.push({ ...commit, changes: [change] });
		if (change.kind === 'renamed' && change.from) current = change.from;
		if (change.kind === 'added') break;
	}
	return out;
}

// ─── Writing ────────────────────────────────────────────────────

export interface CommitAuthor {
	name: string;
	email: string;
}

export interface TableWriteContext {
	/** Tables on the branch tip, read while holding the push lock. */
	files: TableFile[];
}

export interface TableWrite {
	/** table path → new CSV text, or null to delete. */
	changes: Map<string, string | null>;
	message: string;
}

/**
 * Commit a change to the tables on `branch`, holding the repo's push lock so
 * it never interleaves with a git push. `build` sees the current tables and
 * returns the change (or throws a TableError, e.g. on a conflict).
 */
export async function commitTables(
	env: Env,
	repoRecord: RepoRecord,
	branch: string,
	author: CommitAuthor,
	build: (ctx: TableWriteContext) => TableWrite | Promise<TableWrite>
): Promise<{ commit: string; unchanged: boolean; files: TableFile[] }> {
	const refName = `refs/heads/${branch}`;
	const defaultBranch = repoRecord.default_branch || 'main';
	const lock = await acquirePushLock(env, repoRecord.id, `tables:${author.name}`, [refName]);
	if ('error' in lock) throw new TableError(409, `Could not save: ${lock.error}. Try again in a moment.`);

	try {
		const repo = await openRepo(env, repoRecord.name);
		const remote = getArtifactsRemoteUrl(env, repoRecord.name);
		const token = await mintToken(env, repoRecord.name, 'write', 300);

		const refsRes = await fetch(`${remote}/info/refs?service=git-receive-pack`, { headers: { Authorization: `Bearer ${token}` } });
		if (!refsRes.ok) throw new TableError(502, `Storage refused to list branches (HTTP ${refsRes.status})`);
		const head = parseInfoRefs(await refsRes.arrayBuffer()).refs.get(refName) ?? null;
		if (!head && branch !== defaultBranch) throw new TableError(404, `Branch "${branch}" does not exist`);

		if (await branchIsProtected(env.DB, repoRecord.id, branch, { isCreate: !head, defaultBranch })) {
			throw new TableError(409, `Branch "${branch}" is protected and only accepts changes through the merge queue. Edit tables on another branch.`);
		}

		const headCommit = head ? await repo.readCommit(head) : null;
		if (head && !headCommit) throw new TableError(502, `Could not read commit ${head}`);
		const rootTree = headCommit?.treeHash ?? null;
		const files = rootTree ? await tableFilesIn(repo, await tablesTreeOf(repo, rootTree)) : [];

		const write = await build({ files });
		const objects: GitObject[] = [];
		const changes: TreeChanges = new Map();
		for (const [path, content] of write.changes) {
			const existing = files.find((f) => f.path === path);
			if (content === null) {
				if (existing) changes.set(path, null);
				continue;
			}
			const blob = await makeBlob(content);
			if (existing?.blob === blob.sha) continue;
			objects.push(blob);
			changes.set(path, { sha: blob.sha });
		}
		if (changes.size === 0) return { commit: head ?? '', unchanged: true, files };

		const readTree = async (sha: string): Promise<TreeEntry[]> =>
			((await repo.readTree(sha)) ?? []).map((e) => ({ name: e.name, sha: e.hash, mode: e.type === 'tree' ? MODE_TREE : gitMode(e.mode, e.type) }));
		let tree: Awaited<ReturnType<typeof applyTreeChanges>>;
		try {
			tree = await applyTreeChanges(readTree, rootTree, changes);
		} catch (err) {
			throw new TableError(409, `Could not write tables: ${err instanceof Error ? err.message : String(err)}`);
		}
		objects.push(...tree.objects);

		const now = Date.now();
		const commit = await makeCommit({
			tree: tree.sha,
			parents: head ? [head] : [],
			author: { ...author, when: now },
			committer: { ...COMMITTER, when: now },
			message: write.message,
		});
		objects.push(commit);

		const body = await buildReceivePackRequest({ refName, oldSha: head, newSha: commit.sha, objects });
		const pushRes = await fetch(`${remote}/git-receive-pack`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/x-git-receive-pack-request',
				Accept: 'application/x-git-receive-pack-result',
			},
			body,
		});
		const report = parseReceivePackResponse(new Uint8Array(await pushRes.arrayBuffer()));
		if (!pushRes.ok) throw new TableError(502, `Storage refused the commit (HTTP ${pushRes.status})`);
		if (!report?.unpackOk) throw new TableError(502, `Storage could not unpack the commit: ${report?.unpackError ?? 'no report'}`);
		const result = report.refResults.find((r) => r.refName === refName);
		if (!result?.success) throw new TableError(409, `Storage rejected the update to ${branch}: ${result?.error ?? 'unknown'}. Reload and try again.`);

		await audit(env.DB, {
			repoId: repoRecord.id,
			actor: author.name,
			action: 'tables.commit',
			details: { branch, commit: commit.sha, paths: [...changes.keys()] },
		}).catch(() => {});
		await triggerGitHubMirror(env, repoRecord.id, repoRecord.name, [branch]);

		const after = new Map(files.map((f) => [f.path, f]));
		for (const [path, change] of changes) {
			if (change === null) after.delete(path);
			else after.set(path, { name: tableNameFromEntry(path.slice(TABLES_DIR.length + 1))!, path, blob: change.sha });
		}
		return { commit: commit.sha, unchanged: false, files: [...after.values()] };
	} finally {
		await releasePushLock(env, repoRecord.id, lock.lockId);
	}
}

function gitMode(mode: string, type: string): string {
	const m = String(mode).replace(/^0+/, '');
	if (/^1[0-7]{5}$/.test(m) || m === '160000') return m;
	if (type === 'exec') return '100755';
	if (type === 'symlink') return '120000';
	if (type === 'gitlink') return '160000';
	return '100644';
}

/** Default commit message for a save. */
export function defaultMessage(kind: 'create' | 'update' | 'rename' | 'delete', name: string, from?: string): string {
	if (kind === 'create') return `Create table ${name}`;
	if (kind === 'rename') return `Rename table ${from} to ${name}`;
	if (kind === 'delete') return `Delete table ${name}`;
	return `Update table ${name}`;
}
