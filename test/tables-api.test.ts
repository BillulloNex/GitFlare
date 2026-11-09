// End to end: the tables REST API against a real bare git repo.
// D1 → node:sqlite; Artifacts → the bare repo via `git receive-pack --stateless-rpc`
// and plumbing reads; KV → a Map.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tablesApp from '../src/api/tables.ts';

const ACCOUNT = 'acct';
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

function git(cwd: string, args: string[], input?: Uint8Array): Buffer {
	return execFileSync('git', args, { cwd, input, env: GIT_ENV });
}

function fakeD1(db: DatabaseSync) {
	const stmt = (sql: string, params: unknown[] = []) => ({
		bind: (...p: unknown[]) => stmt(sql, p),
		first: async <T>() => (db.prepare(sql).get(...(params as never[])) as T) ?? null,
		all: async <T>() => ({ results: db.prepare(sql).all(...(params as never[])) as T[] }),
		run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) } }),
	});
	return { prepare: (sql: string) => stmt(sql) };
}

function fakeArtifacts(bare: string) {
	const readCommit = async (hash: string) => {
		const text = git(bare, ['cat-file', '-p', hash]).toString();
		const blank = text.indexOf('\n\n');
		const header = text.slice(0, blank);
		const person = (role: string) => {
			const m = header.match(new RegExp(`^${role} (.*) <(.*)> (\\d+)`, 'm'))!;
			return { name: m[1], email: m[2], at: Number(m[3]) };
		};
		const committer = person('committer');
		return {
			hash,
			treeHash: header.match(/^tree (\w+)/)![1],
			parents: [...header.matchAll(/^parent (\w+)/gm)].map((m) => m[1]),
			author: { name: person('author').name, email: person('author').email },
			committer: { name: committer.name, email: committer.email },
			authoredAt: person('author').at,
			committedAt: committer.at,
			message: text.slice(blank + 2).replace(/\n$/, ''),
		};
	};
	const repo = {
		name: 'lab',
		remote: '',
		createToken: async () => 'artifacts-token',
		info: async () => ({ defaultBranch: 'main' }),
		log: async ({ ref = 'HEAD', limit = 50 }: { ref?: string; limit?: number } = {}) => {
			let out: string;
			try {
				out = git(bare, ['rev-list', '--first-parent', `--max-count=${limit}`, ref]).toString();
			} catch {
				return [];
			}
			return Promise.all(out.split('\n').filter(Boolean).map(readCommit));
		},
		readTree: async (sha: string) =>
			git(bare, ['ls-tree', sha])
				.toString()
				.split('\n')
				.filter(Boolean)
				.map((line) => {
					const [meta, name] = line.split('\t');
					const [mode, type, hash] = meta.split(' ');
					return { name, mode, hash, type: type as 'tree' | 'blob' };
				}),
		readBlob: async (hash: string) => new Blob([git(bare, ['cat-file', 'blob', hash])]),
		readCommit,
		readFile: async () => null,
	};
	async function handle(req: Request): Promise<Response> {
		expect(req.headers.get('Authorization')).toBe('Bearer artifacts-token');
		const url = new URL(req.url);
		if (url.pathname.endsWith('/info/refs')) {
			return new Response(git(bare, ['receive-pack', '--stateless-rpc', '--advertise-refs', bare]));
		}
		if (url.pathname.endsWith('/git-receive-pack')) {
			return new Response(git(bare, ['receive-pack', '--stateless-rpc', bare], new Uint8Array(await req.arrayBuffer())));
		}
		return new Response('not found', { status: 404 });
	}
	return { repo, handle };
}

describe('tables API end to end', () => {
	let dir: string;
	let bare: string;
	let db: DatabaseSync;
	let app: Hono<any>;
	let env: any;
	const repoRecord = { id: 'repo1', name: 'lab', default_branch: 'main', is_private: false, description: null, created_at: '', updated_at: '' };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'gitflare-tables-'));
		bare = join(dir, 'lab.git');
		git(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
		db = new DatabaseSync(':memory:');
		db.exec(`
			CREATE TABLE audit_log (id TEXT, repo_id TEXT, actor TEXT, action TEXT, details TEXT, ip_address TEXT, created_at TEXT);
			CREATE TABLE github_mirrors (id TEXT, repo_id TEXT, branch_filter TEXT, is_enabled INTEGER);
			CREATE TABLE protected_branches (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, branch_pattern TEXT NOT NULL, enforce_merge_queue INTEGER NOT NULL DEFAULT 1);
		`);
		const artifacts = fakeArtifacts(bare);
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const req = new Request(input, init);
			if (new URL(req.url).hostname === `${ACCOUNT}.artifacts.cloudflare.net`) return artifacts.handle(req);
			throw new Error(`unexpected fetch ${req.url}`);
		});
		const kv = new Map<string, string>();
		env = {
			DB: fakeD1(db),
			CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
			REPOS: { get: async (name: string) => (name === 'lab' ? artifacts.repo : null) },
			CACHE: {
				get: async (k: string, type?: string) => (kv.has(k) ? (type === 'json' ? JSON.parse(kv.get(k)!) : kv.get(k)) : null),
				put: async (k: string, v: string) => void kv.set(k, v),
			},
			REPO_COORDINATOR: {
				idFromName: (n: string) => n,
				get: () => ({ fetch: async (r: Request) => Response.json(new URL(r.url).pathname === '/lock' ? { lock_id: 'lock' } : {}) }),
			},
		};
		app = new Hono();
		app.use('/api/repos/:repo/*', async (c, next) => {
			c.set('repoRecord', repoRecord);
			c.set('user', { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' });
			await next();
		});
		app.route('/api/repos', tablesApp);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	});

	const call = async (method: string, path: string, body?: unknown) => {
		const res = await app.request(`/api/repos/lab${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, env);
		return { status: res.status, body: (await res.json()) as any };
	};
	const show = (path: string) => git(bare, ['show', `main:${path}`]).toString();
	const log = () => git(bare, ['log', '--format=%s|%an', 'main']).toString().trim().split('\n');

	it('creates, edits, renames and deletes tables as commits, with history and conflict checks', async () => {
		// Create in an empty repository: the first commit creates main.
		const created = await call('PUT', '/tables/BOM', { base_blob: null, columns: ['Part', 'Qty'], rows: [['M3 bolt, 10mm', '4']] });
		expect(created.status).toBe(201);
		expect(show('tables/BOM.csv')).toBe('Part,Qty\n"M3 bolt, 10mm",4\n');
		expect(log()).toEqual(['Create table BOM|Ada Lovelace']);

		// Create-only refuses an existing name, case-insensitively too.
		expect((await call('PUT', '/tables/BOM', { base_blob: null, columns: ['x'] })).status).toBe(409);
		expect((await call('PUT', '/tables/bom', { base_blob: null, columns: ['x'] })).status).toBe(409);

		// Read it back.
		const read = await call('GET', '/tables/BOM');
		expect(read.status).toBe(200);
		expect(read.body.data).toMatchObject({ name: 'BOM', columns: ['Part', 'Qty'], rows: [['M3 bolt, 10mm', '4']], blob: created.body.data.blob });

		// Edit with the loaded blob: one commit with the given message.
		const edited = await call('PUT', '/tables/BOM', {
			base_blob: read.body.data.blob,
			columns: ['Part', 'Qty', 'Supplier'],
			rows: [['M3 bolt, 10mm', '6', 'McMaster']],
			message: 'More bolts',
		});
		expect(edited.status).toBe(200);
		expect(show('tables/BOM.csv')).toBe('Part,Qty,Supplier\n"M3 bolt, 10mm",6,McMaster\n');

		// A stale save is refused and tells the client the current blob.
		const stale = await call('PUT', '/tables/BOM', { base_blob: read.body.data.blob, columns: ['Part'], rows: [] });
		expect(stale.status).toBe(409);
		expect(stale.body.current_blob).toBe(edited.body.data.blob);

		// Saving identical content makes no commit.
		const same = await call('PUT', '/tables/BOM', { base_blob: edited.body.data.blob, csv: 'Part,Qty,Supplier\n"M3 bolt, 10mm",6,McMaster\n' });
		expect(same.body.data.unchanged).toBe(true);
		expect(log()).toHaveLength(2);

		// A second table, then a rename.
		await call('PUT', '/tables/Collaborators', { columns: ['Name', 'Email'], rows: [['Grace', 'grace@example.com']] });
		const renamed = await call('PUT', '/tables/BOM', {
			base_blob: edited.body.data.blob,
			rename_to: 'Parts list',
			columns: ['Part', 'Qty', 'Supplier'],
			rows: [['M3 bolt, 10mm', '6', 'McMaster']],
		});
		expect(renamed.status).toBe(200);
		expect(renamed.body.data.name).toBe('Parts list');

		const list = await call('GET', '/tables');
		expect(list.body.data.tables.map((t: any) => [t.name, t.last_change?.message])).toEqual([
			['Collaborators', 'Create table Collaborators'],
			['Parts list', 'Rename table BOM to Parts list'],
		]);

		// History follows the rename back to the creation.
		const history = await call('GET', '/tables/Parts%20list/history');
		expect(history.body.data.commits.map((c: any) => [c.message, c.changes[0].kind])).toEqual([
			['Rename table BOM to Parts list', 'renamed'],
			['More bolts', 'modified'],
			['Create table BOM', 'added'],
		]);

		// An old version is readable by commit id under its old name.
		const oldSha = history.body.data.commits[2].sha;
		const old = await call('GET', `/tables/BOM?ref=${oldSha}`);
		expect(old.body.data.rows).toEqual([['M3 bolt, 10mm', '4']]);

		// Delete commits the removal.
		const deleted = await call('DELETE', `/tables/Collaborators?base_blob=${list.body.data.tables[0].blob}`);
		expect(deleted.status).toBe(200);
		expect(git(bare, ['ls-tree', '-r', '--name-only', 'main']).toString().trim().split('\n')).toEqual(['tables/Parts list.csv']);
		expect((await call('GET', '/tables/Collaborators')).status).toBe(404);
	});

	it('refuses protected branches, unknown branches and bad input', async () => {
		db.exec(`INSERT INTO protected_branches (id, repo_id, branch_pattern, enforce_merge_queue) VALUES ('p1', 'repo1', 'main', 1)`);
		await call('PUT', '/tables/Runs', { columns: ['Run'] }); // the first commit on the default branch is allowed
		const blocked = await call('PUT', '/tables/Runs', { columns: ['Run', 'Result'] });
		expect(blocked.status).toBe(409);
		expect(blocked.body.error).toMatch(/protected/);

		expect((await call('PUT', '/tables/Runs', { branch: 'nope', columns: ['Run'] })).status).toBe(404);
		expect((await call('PUT', '/tables/..%2Fetc', { columns: ['Run'] })).status).toBe(400);
		expect((await call('PUT', '/tables/Runs', { columns: ['a', 'a'] })).status).toBe(400);
	});
});
