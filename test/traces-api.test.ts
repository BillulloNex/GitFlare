// End to end: the AI traces REST API against the real migration in node:sqlite.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import tracesApp from '../src/api/traces.ts';

function fakeD1(db: DatabaseSync) {
	const stmt = (sql: string, params: unknown[] = []) => ({
		bind: (...p: unknown[]) => stmt(sql, p),
		first: async <T>() => (db.prepare(sql).get(...(params as never[])) as T) ?? null,
		all: async <T>() => ({ results: db.prepare(sql).all(...(params as never[])) as T[] }),
		run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) } }),
	});
	return { prepare: (sql: string) => stmt(sql) };
}

describe('AI traces API end to end', () => {
	let call: (method: string, path: string, body?: unknown, userId?: string) => Promise<{ status: number; json: any }>;

	beforeEach(() => {
		const db = new DatabaseSync(':memory:');
		db.exec("CREATE TABLE repositories (id TEXT PRIMARY KEY); INSERT INTO repositories VALUES ('r1')");
		db.exec('CREATE TABLE audit_log (id TEXT, repo_id TEXT, actor TEXT, action TEXT, details TEXT, ip_address TEXT, created_at TEXT)');
		db.exec(readFileSync(new URL('../migrations/0017_ai_traces.sql', import.meta.url), 'utf8'));
		const env = { DB: fakeD1(db) };
		call = async (method, path, body, userId = 'u1') => {
			const app = new Hono();
			app.use('/api/repos/:repo/*', async (c, next) => {
				c.set('repoRecord', { id: 'r1', name: 'lab', is_private: 1 });
				c.set('user', { id: userId, name: userId === 'u1' ? 'Ada' : 'Bob', email: `${userId}@example.com` });
				await next();
			});
			app.onError((e) => { throw e; });
			app.route('/api/repos', tracesApp);
			const res = await app.request(`/api/repos/lab${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, env);
			return { status: res.status, json: await res.json() };
		};
	});

	it('logs, replaces by session_id, lists with totals, reads and deletes', async () => {
		const first = await call('POST', '/traces', {
			session_id: 's1',
			agent: 'claude-code',
			model: 'claude-opus-4-5',
			title: 'Add traces',
			input_tokens: 1000,
			output_tokens: 200,
			cost_usd: 0.5,
			steps: [{ role: 'user', content: 'add traces' }],
		});
		expect(first.status).toBe(201);
		expect(first.json.data).toMatchObject({ agent: 'claude-code', step_count: 1, author: 'Ada', steps: [{ role: 'user', content: 'add traces' }] });
		expect(first.json.data.repo_id).toBeUndefined();

		const again = await call('POST', '/traces', { session_id: 's1', agent: 'claude-code', title: 'Add traces, done', input_tokens: 3000, cost_usd: 1.25 });
		expect(again.status).toBe(200);
		expect(again.json.data.id).toBe(first.json.data.id);
		expect(again.json.data.created_at).toBe(first.json.data.created_at);

		expect((await call('POST', '/traces', { session_id: 's1', agent: 'codex', title: 'Hijack' }, 'u2')).status).toBe(409);
		await call('POST', '/traces', { agent: 'codex', title: 'Fix CI', output_tokens: 50, cost_usd: 0.1, refs: { commits: ['abcdef1'] } }, 'u2');

		const list = await call('GET', '/traces');
		expect(list.json.data.map((t: { title: string }) => t.title).sort()).toEqual(['Add traces, done', 'Fix CI']);
		expect(list.json.data[0].steps).toBeUndefined();
		expect(list.json.totals).toMatchObject({ count: 2, input_tokens: 3000, output_tokens: 50, cost_usd: 1.35 });
		expect(list.json.totals.by_agent).toHaveLength(2);
		expect((await call('GET', '/traces?agent=codex')).json.data).toHaveLength(1);

		const got = await call('GET', `/traces/${first.json.data.id}`);
		expect(got.json.data).toMatchObject({ title: 'Add traces, done', steps: [] });

		expect((await call('DELETE', `/traces/${first.json.data.id}`, undefined, 'u2')).status).toBe(403);
		expect((await call('DELETE', `/traces/${first.json.data.id}`)).status).toBe(200);
		expect((await call('GET', `/traces/${first.json.data.id}`)).status).toBe(404);
	});

	it('pages newest first', async () => {
		for (const h of [1, 2, 3]) await call('POST', '/traces', { agent: 'cursor', title: `t${h}`, started_at: `2026-11-0${h}T00:00:00Z` });
		const page1 = await call('GET', '/traces?limit=2');
		expect(page1.json.data.map((t: { title: string }) => t.title)).toEqual(['t3', 't2']);
		const page2 = await call('GET', `/traces?limit=2&cursor=${encodeURIComponent(page1.json.next_cursor)}`);
		expect(page2.json.data.map((t: { title: string }) => t.title)).toEqual(['t1']);
		expect(page2.json.next_cursor).toBeNull();
	});
});
