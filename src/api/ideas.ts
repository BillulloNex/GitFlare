import { Hono, type Context } from 'hono';
import type { Env } from '../env.ts';
import { auditContext, type RepoVariables } from '../middleware/repo-access.ts';
import { audit } from '../lib/audit.ts';
import { readJsonObject } from '../lib/request.ts';
import {
	isIdeaStatus,
	newIdeaId,
	parseBody,
	parseLogText,
	parseRefs,
	parseTitle,
	readRefs,
	statusChangeText,
	type IdeaStatus,
} from '../lib/ideas.ts';

// All routes run behind repoAccess (src/index.ts): `repoRecord` is set, GET
// needs read, other methods need write. Every lookup is scoped to the repo.
type IdeaEnv = { Bindings: Env; Variables: RepoVariables };
const app = new Hono<IdeaEnv>();

type IdeaRow = {
	id: string;
	repo_id: string;
	title: string;
	body: string;
	status: IdeaStatus;
	created_by: string;
	created_by_id: string | null;
	created_at: string;
	updated_at: string;
};

type LogRow = {
	id: string;
	idea_id: string;
	kind: 'note' | 'status';
	author: string;
	author_id: string | null;
	text: string;
	refs: string | null;
	created_at: string;
};

/** Display name + id of whoever is calling: the session user, or the API key's name. */
function author(c: Context<IdeaEnv>): { name: string; id: string | null } {
	const user = c.get('user');
	if (user) return { name: user.name || user.email, id: user.id };
	const key = c.get('apiKey');
	if (key) return { name: key.name || 'API key', id: key.id };
	return { name: 'system', id: null };
}

function loadIdea(c: Context<IdeaEnv>, id: string): Promise<IdeaRow | null> {
	return c.env.DB.prepare('SELECT * FROM ideas WHERE id = ? AND repo_id = ?').bind(id, c.get('repoRecord').id).first<IdeaRow>();
}

function publicLog(row: LogRow) {
	return { ...row, refs: readRefs(row.refs) };
}

async function auditIdea(c: Context<IdeaEnv>, action: string, details: Record<string, unknown>): Promise<void> {
	const { actor, ipAddress } = auditContext(c);
	await audit(c.env.DB, { repoId: c.get('repoRecord').id, actor, action, details, ipAddress });
}

// ─── GET /api/repos/:repo/ideas?status= ─────────────────────────
app.get('/:repo/ideas', async (c) => {
	const status = c.req.query('status');
	if (status !== undefined && !isIdeaStatus(status)) {
		return c.json({ error: 'status must be one of open, exploring, done, dropped' }, 400);
	}
	const where = status ? 'i.repo_id = ? AND i.status = ?' : 'i.repo_id = ?';
	const params = status ? [c.get('repoRecord').id, status] : [c.get('repoRecord').id];
	const { results } = await c.env.DB.prepare(
		`SELECT i.*,
		        (SELECT COUNT(*) FROM idea_logs l WHERE l.idea_id = i.id AND l.kind = 'note') AS log_count
		   FROM ideas i
		  WHERE ${where}
		  ORDER BY i.updated_at DESC
		  LIMIT 500`
	)
		.bind(...params)
		.all<IdeaRow & { log_count: number }>();
	return c.json({ data: results ?? [] });
});

// ─── POST /api/repos/:repo/ideas ────────────────────────────────
app.post('/:repo/ideas', async (c) => {
	const body = await readJsonObject<{ title: unknown; body: unknown; status: unknown }>(c);
	if (!body) return c.json({ error: 'Expected a JSON object' }, 400);

	const title = parseTitle(body.title);
	if (!title) return c.json({ error: 'title is required (max 200 characters)' }, 400);
	const text = parseBody(body.body);
	if (text === null) return c.json({ error: 'body must be a string (max 20000 characters)' }, 400);
	const status = body.status === undefined ? 'open' : body.status;
	if (!isIdeaStatus(status)) return c.json({ error: 'status must be one of open, exploring, done, dropped' }, 400);

	const who = author(c);
	const now = new Date().toISOString();
	const row: IdeaRow = {
		id: newIdeaId(),
		repo_id: c.get('repoRecord').id,
		title,
		body: text,
		status,
		created_by: who.name,
		created_by_id: who.id,
		created_at: now,
		updated_at: now,
	};
	await c.env.DB.prepare(
		`INSERT INTO ideas (id, repo_id, title, body, status, created_by, created_by_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(row.id, row.repo_id, row.title, row.body, row.status, row.created_by, row.created_by_id, row.created_at, row.updated_at)
		.run();
	await auditIdea(c, 'idea.create', { idea_id: row.id, title });
	return c.json({ data: { ...row, log_count: 0 } }, 201);
});

// ─── GET /api/repos/:repo/ideas/:id ─────────────────────────────
app.get('/:repo/ideas/:id', async (c) => {
	const idea = await loadIdea(c, c.req.param('id'));
	if (!idea) return c.json({ error: 'Idea not found' }, 404);
	const { results } = await c.env.DB.prepare('SELECT * FROM idea_logs WHERE idea_id = ? ORDER BY created_at ASC, rowid ASC')
		.bind(idea.id)
		.all<LogRow>();
	return c.json({ data: { ...idea, logs: (results ?? []).map(publicLog) } });
});

// ─── PATCH /api/repos/:repo/ideas/:id ───────────────────────────
// Edit title/body and/or change status. A status change also appends a
// `status` log entry, with the optional `note` as its explanation.
app.patch('/:repo/ideas/:id', async (c) => {
	const idea = await loadIdea(c, c.req.param('id'));
	if (!idea) return c.json({ error: 'Idea not found' }, 404);
	const body = await readJsonObject<{ title: unknown; body: unknown; status: unknown; note: unknown }>(c);
	if (!body) return c.json({ error: 'Expected a JSON object' }, 400);

	const next = { ...idea };
	if (body.title !== undefined) {
		const title = parseTitle(body.title);
		if (!title) return c.json({ error: 'title must be non-empty (max 200 characters)' }, 400);
		next.title = title;
	}
	if (body.body !== undefined) {
		const text = parseBody(body.body);
		if (text === null) return c.json({ error: 'body must be a string (max 20000 characters)' }, 400);
		next.body = text;
	}
	if (body.status !== undefined) {
		if (!isIdeaStatus(body.status)) return c.json({ error: 'status must be one of open, exploring, done, dropped' }, 400);
		next.status = body.status;
	}
	let note: string | null = null;
	if (body.note !== undefined && body.note !== null && body.note !== '') {
		note = parseLogText(body.note);
		if (!note) return c.json({ error: 'note must be a string (max 20000 characters)' }, 400);
	}

	const statusChanged = next.status !== idea.status;
	if (!statusChanged && next.title === idea.title && next.body === idea.body) {
		return c.json({ data: idea });
	}

	const who = author(c);
	next.updated_at = new Date().toISOString();
	const statements = [
		c.env.DB.prepare('UPDATE ideas SET title = ?, body = ?, status = ?, updated_at = ? WHERE id = ? AND repo_id = ?').bind(
			next.title,
			next.body,
			next.status,
			next.updated_at,
			idea.id,
			idea.repo_id
		),
	];
	if (statusChanged) {
		statements.push(
			c.env.DB.prepare('INSERT INTO idea_logs (id, idea_id, kind, author, author_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
				crypto.randomUUID(),
				idea.id,
				'status',
				who.name,
				who.id,
				statusChangeText(idea.status, next.status, note),
				next.updated_at
			)
		);
	}
	await c.env.DB.batch(statements);
	if (statusChanged) await auditIdea(c, 'idea.status', { idea_id: idea.id, from: idea.status, to: next.status });
	return c.json({ data: next });
});

// ─── POST /api/repos/:repo/ideas/:id/log ────────────────────────
// Append a note. Entries are never edited or deleted.
app.post('/:repo/ideas/:id/log', async (c) => {
	const idea = await loadIdea(c, c.req.param('id'));
	if (!idea) return c.json({ error: 'Idea not found' }, 404);
	const body = await readJsonObject<{ text: unknown; refs: unknown }>(c);
	if (!body) return c.json({ error: 'Expected a JSON object' }, 400);

	const text = parseLogText(body.text);
	if (!text) return c.json({ error: 'text is required (max 20000 characters)' }, 400);
	const refs = parseRefs(body.refs);
	if (refs === null) {
		return c.json({ error: 'refs must be { commits?: sha[], branch?: string, ci_run_id?: string }' }, 400);
	}

	const who = author(c);
	const now = new Date().toISOString();
	const row: LogRow = {
		id: crypto.randomUUID(),
		idea_id: idea.id,
		kind: 'note',
		author: who.name,
		author_id: who.id,
		text,
		refs: refs ? JSON.stringify(refs) : null,
		created_at: now,
	};
	await c.env.DB.batch([
		c.env.DB.prepare('INSERT INTO idea_logs (id, idea_id, kind, author, author_id, text, refs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
			row.id,
			row.idea_id,
			row.kind,
			row.author,
			row.author_id,
			row.text,
			row.refs,
			row.created_at
		),
		c.env.DB.prepare('UPDATE ideas SET updated_at = ? WHERE id = ?').bind(now, idea.id),
	]);
	return c.json({ data: publicLog(row) }, 201);
});

// ─── DELETE /api/repos/:repo/ideas/:id ──────────────────────────
// For mistakes and duplicates. Ideas that didn't pan out should be `dropped`.
app.delete('/:repo/ideas/:id', async (c) => {
	const idea = await loadIdea(c, c.req.param('id'));
	if (!idea) return c.json({ error: 'Idea not found' }, 404);
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM idea_logs WHERE idea_id = ?').bind(idea.id),
		c.env.DB.prepare('DELETE FROM ideas WHERE id = ? AND repo_id = ?').bind(idea.id, idea.repo_id),
	]);
	await auditIdea(c, 'idea.delete', { idea_id: idea.id, title: idea.title });
	return c.json({ data: { id: idea.id, deleted: true } });
});

export default app;
