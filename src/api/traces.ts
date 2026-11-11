import { Hono, type Context } from 'hono';
import type { Env } from '../env.ts';
import { auditContext, hasRepoLevel, type RepoVariables } from '../middleware/repo-access.ts';
import { audit } from '../lib/audit.ts';
import { readJsonObject } from '../lib/request.ts';
import { decodeCursor, encodeCursor, parseLimit } from '../lib/diary.ts';
import { readRefs } from '../lib/ideas.ts';
import { parseLabel, parseTraceInput, readSteps } from '../lib/traces.ts';

// All routes run behind repoAccess (src/index.ts): `repoRecord` is set, GET
// needs read, other methods need write. Every lookup is scoped to the repo.
// Replacing or deleting a trace additionally needs its author (or a repo admin to delete).
type TraceEnv = { Bindings: Env; Variables: RepoVariables };
const app = new Hono<TraceEnv>();

type TraceRow = {
	id: string;
	repo_id: string;
	session_id: string | null;
	agent: string;
	model: string | null;
	title: string;
	summary: string;
	started_at: string;
	ended_at: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cost_usd: number | null;
	refs: string | null;
	steps: string;
	step_count: number;
	author: string;
	author_id: string | null;
	created_at: string;
	updated_at: string;
};

/** Every column but the transcript, for lists. */
const SUMMARY_COLUMNS =
	'id, repo_id, session_id, agent, model, title, summary, started_at, ended_at, input_tokens, output_tokens, cost_usd, refs, step_count, author, author_id, created_at, updated_at';

function author(c: Context<TraceEnv>): { name: string; id: string | null } {
	const user = c.get('user');
	if (user) return { name: user.name || user.email, id: user.id };
	const key = c.get('apiKey');
	if (key) return { name: key.name || 'API key', id: key.id };
	return { name: 'system', id: null };
}

/** A trace as the API returns it; the transcript only when the row carries it. */
function publicTrace({ repo_id: _repo, steps, refs, ...row }: Omit<TraceRow, 'steps'> & { steps?: string }) {
	return { ...row, refs: readRefs(refs), ...(steps !== undefined ? { steps: readSteps(steps) } : {}) };
}

async function auditTrace(c: Context<TraceEnv>, action: string, details: Record<string, unknown>): Promise<void> {
	const { actor, ipAddress } = auditContext(c);
	await audit(c.env.DB, { repoId: c.get('repoRecord').id, actor, action, details, ipAddress });
}

// ─── GET /api/repos/:repo/traces?agent=&limit=&cursor= ──────────
// Newest first. `totals` covers the whole repo, broken down by agent.
app.get('/:repo/traces', async (c) => {
	const limit = parseLimit(c.req.query('limit'));
	if (limit === null) return c.json({ error: 'limit must be an integer from 1 to 100' }, 400);
	const rawCursor = c.req.query('cursor');
	const cursor = rawCursor ? decodeCursor(rawCursor) : null;
	if (rawCursor && !cursor) return c.json({ error: 'Invalid cursor' }, 400);
	const agent = parseLabel(c.req.query('agent'), 60);
	if (agent === null) return c.json({ error: 'Invalid agent' }, 400);

	const repoId = c.get('repoRecord').id;
	const where = ['repo_id = ?'];
	const params: unknown[] = [repoId];
	if (agent) where.push('agent = ?'), params.push(agent);
	if (cursor) where.push('(started_at < ? OR (started_at = ? AND id < ?))'), params.push(cursor.happenedAt, cursor.happenedAt, cursor.id);

	type AgentTotals = { agent: string; count: number; input_tokens: number; output_tokens: number; cost_usd: number };
	const [{ results }, { results: byAgent }] = await Promise.all([
		c.env.DB.prepare(`SELECT ${SUMMARY_COLUMNS} FROM ai_traces WHERE ${where.join(' AND ')} ORDER BY started_at DESC, id DESC LIMIT ?`)
			.bind(...params, limit + 1)
			.all<Omit<TraceRow, 'steps'>>(),
		c.env.DB.prepare(
			`SELECT agent, COUNT(*) AS count, COALESCE(SUM(input_tokens), 0) AS input_tokens,
			        COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(cost_usd), 0) AS cost_usd
			   FROM ai_traces WHERE repo_id = ? GROUP BY agent ORDER BY count DESC`
		)
			.bind(repoId)
			.all<AgentTotals>(),
	]);
	const rows = results ?? [];
	const page = rows.slice(0, limit);
	const last = page[page.length - 1];
	const agents = byAgent ?? [];
	const sum = (k: 'count' | 'input_tokens' | 'output_tokens' | 'cost_usd') => agents.reduce((n, a) => n + a[k], 0);
	return c.json({
		data: page.map((r) => publicTrace(r)),
		next_cursor: rows.length > limit && last ? encodeCursor(last.started_at, last.id) : null,
		totals: { count: sum('count'), input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), cost_usd: sum('cost_usd'), by_agent: agents },
	});
});

// ─── POST /api/repos/:repo/traces ───────────────────────────────
// Log a session. With a session_id already logged by the caller, the trace is
// replaced in full (200); otherwise a new one is created (201).
app.post('/:repo/traces', async (c) => {
	const body = await readJsonObject<Record<string, unknown>>(c);
	if (!body) return c.json({ error: 'Expected a JSON object' }, 400);
	const input = parseTraceInput(body);
	if (typeof input === 'string') return c.json({ error: input }, 400);

	const repoId = c.get('repoRecord').id;
	const who = author(c);
	const existing = input.session_id
		? await c.env.DB.prepare('SELECT id, author_id, created_at FROM ai_traces WHERE repo_id = ? AND session_id = ?')
				.bind(repoId, input.session_id)
				.first<Pick<TraceRow, 'id' | 'author_id' | 'created_at'>>()
		: null;
	if (existing && existing.author_id !== who.id) return c.json({ error: 'This session_id was logged by someone else' }, 409);

	const now = new Date().toISOString();
	const row: TraceRow = {
		...input,
		id: existing?.id ?? crypto.randomUUID(),
		repo_id: repoId,
		refs: input.refs ? JSON.stringify(input.refs) : null,
		steps: JSON.stringify(input.steps),
		step_count: input.steps.length,
		author: who.name,
		author_id: who.id,
		created_at: existing?.created_at ?? now,
		updated_at: now,
	};
	const columns = Object.keys(row) as (keyof TraceRow)[];
	await c.env.DB.prepare(`INSERT OR REPLACE INTO ai_traces (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
		.bind(...columns.map((k) => row[k]))
		.run();
	if (!existing) await auditTrace(c, 'trace.create', { trace_id: row.id, agent: row.agent });
	return c.json({ data: publicTrace(row) }, existing ? 200 : 201);
});

// ─── GET /api/repos/:repo/traces/:id ────────────────────────────
app.get('/:repo/traces/:id', async (c) => {
	const row = await c.env.DB.prepare('SELECT * FROM ai_traces WHERE id = ? AND repo_id = ?')
		.bind(c.req.param('id'), c.get('repoRecord').id)
		.first<TraceRow>();
	if (!row) return c.json({ error: 'Trace not found' }, 404);
	return c.json({ data: publicTrace(row) });
});

// ─── DELETE /api/repos/:repo/traces/:id ─────────────────────────
app.delete('/:repo/traces/:id', async (c) => {
	const row = await c.env.DB.prepare('SELECT id, author_id FROM ai_traces WHERE id = ? AND repo_id = ?')
		.bind(c.req.param('id'), c.get('repoRecord').id)
		.first<Pick<TraceRow, 'id' | 'author_id'>>();
	if (!row) return c.json({ error: 'Trace not found' }, 404);
	const who = author(c);
	if (!(who.id && row.author_id === who.id) && !(await hasRepoLevel(c, 'admin'))) {
		return c.json({ error: 'Only the author or a repo admin can delete this trace' }, 403);
	}
	await c.env.DB.prepare('DELETE FROM ai_traces WHERE id = ?').bind(row.id).run();
	await auditTrace(c, 'trace.delete', { trace_id: row.id });
	return c.json({ data: { id: row.id, deleted: true } });
});

export default app;
