/**
 * Data tables: /api/repos/:repo/tables/*
 *
 * Each table is `tables/<name>.csv` on a branch, every save is a git commit
 * (see src/lib/tables.ts). Reads take `?ref=` (branch, tag or commit id), so
 * any past version of a table can be opened; writes take `branch`.
 *
 *   GET    /:repo/tables                 list tables (+ the commit that last changed each)
 *   GET    /:repo/tables/:name           read a table: columns, rows, blob, commit
 *   GET    /:repo/tables/:name/history   commits that changed this table
 *   PUT    /:repo/tables/:name           create / update / rename (one commit)
 *   DELETE /:repo/tables/:name           delete (one commit)
 */
import { Hono, type Context } from 'hono';
import type { Env } from '../env.ts';
import type { RepoVariables } from '../middleware/repo-access.ts';
import {
	commitTables,
	defaultMessage,
	historyForTable,
	listTables,
	normalizeTableName,
	parseTableInput,
	readTable,
	TableError,
	tablePath,
	tablesHistory,
	type CommitAuthor,
	type TableFile,
} from '../lib/tables.ts';

type TablesEnv = { Bindings: Env; Variables: RepoVariables };
const app = new Hono<TablesEnv>();

const MESSAGE_MAX = 2000;

function author(c: Context<TablesEnv>): CommitAuthor {
	const user = c.get('user');
	if (user) return { name: user.name || user.email, email: user.email };
	const key = c.get('apiKey');
	if (key) return { name: key.name || 'API key', email: 'api-key@gitflare.invalid' };
	return { name: 'GitFlare', email: 'system@gitflare.invalid' };
}

function fail(c: Context<TablesEnv>, err: unknown) {
	if (err instanceof TableError) return c.json({ error: err.message, ...err.extra }, err.status);
	throw err;
}

function nameParam(c: Context<TablesEnv>): string {
	const name = normalizeTableName(c.req.param('name'));
	if (!name) throw new TableError(400, 'Invalid table name');
	return name;
}

function commitMessage(raw: unknown, fallback: string): string {
	if (raw === undefined || raw === null || raw === '') return fallback;
	if (typeof raw !== 'string') throw new TableError(400, 'message must be a string');
	const message = raw.replace(/\r\n?/g, '\n').trim();
	if (message.length > MESSAGE_MAX) throw new TableError(400, `message is at most ${MESSAGE_MAX} characters`);
	return message || fallback;
}

function branchOf(c: Context<TablesEnv>, raw: unknown): string {
	if (raw === undefined || raw === null || raw === '') return c.get('repoRecord').default_branch || 'main';
	if (typeof raw !== 'string' || !/^[\w./-]{1,200}$/.test(raw) || raw.includes('..') || raw.startsWith('/') || raw.endsWith('/')) {
		throw new TableError(400, 'Invalid branch name');
	}
	return raw;
}

/** Case-insensitive clash: `BOM` and `bom` would be one file on macOS and Windows checkouts. */
function clash(files: TableFile[], name: string, except?: string): TableFile | undefined {
	const lower = name.toLowerCase();
	return files.find((f) => f.name !== except && f.name.toLowerCase() === lower);
}

app.get('/:repo/tables', async (c) => {
	const repo = c.get('repoRecord');
	const ref = c.req.query('ref') || repo.default_branch || 'main';
	try {
		const { commit, tables } = await listTables(c.env, repo.name, ref);
		// Last change per table, from the (cached) history walk. Best effort.
		const last = new Map<string, { sha: string; message: string; author: string; date: string }>();
		if (commit) {
			try {
				const history = await tablesHistory(c.env, repo, commit);
				for (const h of history.commits) {
					for (const ch of h.changes) {
						if (ch.blob !== null && !last.has(ch.table)) {
							last.set(ch.table, { sha: h.sha, message: h.message.split('\n')[0], author: h.author.name, date: h.date });
						}
					}
				}
			} catch (err) {
				console.warn(`[tables] history for ${repo.name}@${ref} failed:`, err instanceof Error ? err.message : err);
			}
		}
		return c.json({
			data: {
				ref,
				commit,
				tables: tables.map((t) => ({ ...t, last_change: last.get(t.name) ?? null })),
			},
		});
	} catch (err) {
		return fail(c, err);
	}
});

app.get('/:repo/tables/:name/history', async (c) => {
	const repo = c.get('repoRecord');
	const ref = c.req.query('ref') || repo.default_branch || 'main';
	try {
		const name = nameParam(c);
		const history = await tablesHistory(c.env, repo, ref);
		return c.json({ data: { ref, head: history.head, truncated: history.truncated, commits: historyForTable(history, name) } });
	} catch (err) {
		return fail(c, err);
	}
});

app.get('/:repo/tables/:name', async (c) => {
	const repo = c.get('repoRecord');
	const ref = c.req.query('ref') || repo.default_branch || 'main';
	try {
		const name = nameParam(c);
		const result = await readTable(c.env, repo.name, name, ref);
		if (!result) return c.json({ error: `Table "${name}" not found at ${ref}` }, 404);
		if (c.req.query('format') === 'csv') {
			const raw = await c.env.REPOS.get(repo.name).then((r) => r?.readBlob(result.file.blob));
			return new Response(raw ?? '', {
				headers: {
					'Content-Type': 'text/csv; charset=utf-8',
					'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.csv`)}`,
					'X-Content-Type-Options': 'nosniff',
				},
			});
		}
		return c.json({
			data: {
				name: result.file.name,
				path: result.file.path,
				ref,
				commit: result.commit,
				blob: result.file.blob,
				columns: result.table.columns,
				rows: result.table.rows,
			},
		});
	} catch (err) {
		return fail(c, err);
	}
});

/**
 * Body: { branch?, columns + rows | csv, message?, base_blob?, rename_to? }
 *   base_blob: string → the blob you loaded; 409 if the table changed since.
 *              null   → create; 409 if the table already exists.
 *              absent → overwrite whatever is there (create if missing).
 *   rename_to: also move the table to a new name in the same commit.
 */
app.put('/:repo/tables/:name', async (c) => {
	const repo = c.get('repoRecord');
	try {
		const name = nameParam(c);
		const body = await c.req.json<Record<string, unknown>>().catch(() => null);
		if (!body || typeof body !== 'object') throw new TableError(400, 'Body must be JSON');
		const branch = branchOf(c, body.branch);
		const { csv } = parseTableInput(body);
		let target = name;
		if (body.rename_to !== undefined && body.rename_to !== null && body.rename_to !== '') {
			const renamed = normalizeTableName(body.rename_to);
			if (!renamed) throw new TableError(400, 'Invalid new table name: use letters, numbers, spaces and . _ ( ) & + - (max 80)');
			target = renamed;
		}
		const hasBase = Object.prototype.hasOwnProperty.call(body, 'base_blob');
		const baseBlob = body.base_blob;
		if (hasBase && baseBlob !== null && (typeof baseBlob !== 'string' || !/^[0-9a-f]{40}$/.test(baseBlob))) {
			throw new TableError(400, 'base_blob must be the 40-character blob id you loaded, or null to create');
		}

		let kind = 'update' as 'create' | 'update' | 'rename';
		const result = await commitTables(c.env, repo, branch, author(c), ({ files }) => {
			const existing = files.find((f) => f.name === name);
			if (hasBase && baseBlob === null && existing) {
				throw new TableError(409, `A table named "${name}" already exists`, { current_blob: existing.blob });
			}
			if (hasBase && typeof baseBlob === 'string') {
				if (!existing) throw new TableError(409, `Table "${name}" was deleted or renamed on ${branch} since you loaded it`, { current_blob: null });
				if (existing.blob !== baseBlob) {
					throw new TableError(409, `Table "${name}" changed on ${branch} since you loaded it. Reload to see the latest version.`, {
						current_blob: existing.blob,
					});
				}
			}
			const changes = new Map<string, string | null>();
			if (target === name) {
				const other = existing ? undefined : clash(files, name);
				if (other) throw new TableError(409, `A table named "${other.name}" already exists`);
				if (!existing) kind = 'create';
				changes.set(existing?.path ?? tablePath(name), csv);
			} else {
				if (!existing) throw new TableError(404, `Table "${name}" not found on ${branch}`);
				const other = clash(files, target, name);
				if (other) throw new TableError(409, `A table named "${other.name}" already exists`);
				kind = 'rename';
				changes.set(existing.path, null);
				changes.set(tablePath(target), csv);
			}
			return { changes, message: commitMessage(body.message, defaultMessage(kind, target, name)) };
		});

		const file = result.files.find((f) => f.name === target);
		const path = file?.path ?? tablePath(target);
		return c.json(
			{
				data: {
					name: target,
					path,
					branch,
					commit: result.commit,
					blob: file?.blob ?? null,
					unchanged: result.unchanged,
				},
			},
			kind === 'create' && !result.unchanged ? 201 : 200
		);
	} catch (err) {
		return fail(c, err);
	}
});

/** Query: ?branch=&base_blob=&message= */
app.delete('/:repo/tables/:name', async (c) => {
	const repo = c.get('repoRecord');
	try {
		const name = nameParam(c);
		const branch = branchOf(c, c.req.query('branch'));
		const baseBlob = c.req.query('base_blob');
		if (baseBlob !== undefined && !/^[0-9a-f]{40}$/.test(baseBlob)) throw new TableError(400, 'base_blob must be a 40-character blob id');
		const result = await commitTables(c.env, repo, branch, author(c), ({ files }) => {
			const existing = files.find((f) => f.name === name);
			if (!existing) throw new TableError(404, `Table "${name}" not found on ${branch}`);
			if (baseBlob && existing.blob !== baseBlob) {
				throw new TableError(409, `Table "${name}" changed on ${branch} since you loaded it. Reload before deleting.`, { current_blob: existing.blob });
			}
			return {
				changes: new Map([[existing.path, null]]),
				message: commitMessage(c.req.query('message'), defaultMessage('delete', name)),
			};
		});
		return c.json({ data: { name, branch, commit: result.commit, deleted: true } });
	} catch (err) {
		return fail(c, err);
	}
});

export default app;
