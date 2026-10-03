import { Hono } from 'hono';
import type { Env } from '../env.ts';
import type { AuthVariables } from '../middleware/auth.ts';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ─── Types ──────────────────────────────────────────────────────

interface CreateTicketBody {
	title: string;
	description?: string;
	agent_id: string;
	base_branch?: string;
	priority?: number;
}

interface UpdateTicketBody {
	status?: 'active' | 'review' | 'cancelled';
	commit_sha?: string;
	title?: string;
	description?: string;
}

// ─── Helper: get TicketQueue DO for a repo ──────────────────────

function getTicketQueueDO(env: Env, repoId: string) {
	const doId = env.TICKET_QUEUE.idFromName(repoId);
	return env.TICKET_QUEUE.get(doId);
}

// ─── GET /api/repos/:repo/tickets ───────────────────────────────
// List all tickets for a repo, optionally filtered by status/agent
app.get('/:repo/tickets', async (c) => {
	const repoName = c.req.param('repo');
	const status = c.req.query('status');
	const agentId = c.req.query('agent_id');
	const { DB } = c.env;

	const repo = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(repoName).first<{ id: string }>();
	if (!repo) return c.json({ error: 'Repository not found' }, 404);

	let sql = 'SELECT * FROM tickets WHERE repo_id = ?';
	const params: string[] = [repo.id];

	if (status) {
		sql += ' AND status = ?';
		params.push(status);
	}
	if (agentId) {
		sql += ' AND agent_id = ?';
		params.push(agentId);
	}

	sql += ' ORDER BY priority DESC, created_at ASC';

	const stmt = DB.prepare(sql);
	const { results } = await stmt.bind(...params).all();

	return c.json({ tickets: results });
});

// ─── POST /api/repos/:repo/tickets ──────────────────────────────
// Create a new ticket and assign a working branch
app.post('/:repo/tickets', async (c) => {
	const repoName = c.req.param('repo');
	const body = await c.req.json<CreateTicketBody>();
	const { DB } = c.env;

	const repo = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(repoName).first<{ id: string }>();
	if (!repo) return c.json({ error: 'Repository not found' }, 404);

	if (!body.title || !body.agent_id) {
		return c.json({ error: 'title and agent_id are required' }, 400);
	}

	const ticketId = crypto.randomUUID();
	const baseBranch = body.base_branch || 'main';
	// Each agent gets its own branch: agent/<agent_id>/<ticket_id_short>
	const branch = `agent/${body.agent_id}/${ticketId.slice(0, 8)}`;

	await DB.prepare(
		`INSERT INTO tickets (id, repo_id, agent_id, title, description, branch, base_branch, status, priority, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, datetime('now'), datetime('now'))`
	).bind(
		ticketId, repo.id, body.agent_id,
		body.title, body.description || null,
		branch, baseBranch,
		body.priority || 0
	).run();

	// Audit
	await DB.prepare(
		'INSERT INTO audit_log (id, repo_id, actor, action, details, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'
	).bind(
		crypto.randomUUID(), repo.id, body.agent_id,
		'ticket.create',
		JSON.stringify({ ticketId, branch, title: body.title })
	).run();

	return c.json({
		id: ticketId,
		branch,
		base_branch: baseBranch,
		status: 'queued',
		message: `Branch "${branch}" assigned. Push commits there, then PATCH status to "review" to enter merge queue.`
	}, 201);
});

// ─── GET /api/repos/:repo/tickets/:ticketId ─────────────────────
app.get('/:repo/tickets/:ticketId', async (c) => {
	const { DB } = c.env;
	const ticket = await DB.prepare('SELECT * FROM tickets WHERE id = ?')
		.bind(c.req.param('ticketId')).first();
	
	if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
	return c.json({ ticket });
});

// ─── PATCH /api/repos/:repo/tickets/:ticketId ───────────────────
// Update ticket status. Setting status to "review" enqueues for merge.
app.patch('/:repo/tickets/:ticketId', async (c) => {
	const repoName = c.req.param('repo');
	const ticketId = c.req.param('ticketId');
	const body = await c.req.json<UpdateTicketBody>();
	const { DB } = c.env;

	const repo = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(repoName).first<{ id: string }>();
	if (!repo) return c.json({ error: 'Repository not found' }, 404);

	const ticket = await DB.prepare('SELECT * FROM tickets WHERE id = ? AND repo_id = ?')
		.bind(ticketId, repo.id).first<any>();
	if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

	// Build dynamic update
	const updates: string[] = ["updated_at = datetime('now')"];
	const values: any[] = [];

	if (body.title) {
		updates.push('title = ?');
		values.push(body.title);
	}
	if (body.description !== undefined) {
		updates.push('description = ?');
		values.push(body.description);
	}
	if (body.commit_sha) {
		updates.push('commit_sha = ?');
		values.push(body.commit_sha);
	}

	if (body.status) {
		// Validate transitions
		const validTransitions: Record<string, string[]> = {
			'queued': ['active', 'cancelled'],
			'active': ['review', 'cancelled'],
			'review': ['active', 'cancelled'],  // can un-review to push more
			'failed': ['active', 'cancelled'],   // agent fixes and retries
		};
		const allowed = validTransitions[ticket.status] || [];
		if (!allowed.includes(body.status)) {
			return c.json({
				error: `Cannot transition from "${ticket.status}" to "${body.status}"`,
				allowed_transitions: allowed,
			}, 400);
		}

		updates.push('status = ?');
		values.push(body.status);

		if (body.status === 'active' && !ticket.started_at) {
			updates.push("started_at = datetime('now')");
		}
	}

	values.push(ticketId);
	await DB.prepare(`UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();

	// If status → "review", enqueue for merge
	if (body.status === 'review') {
		const commitSha = body.commit_sha || ticket.commit_sha;
		if (!commitSha) {
			return c.json({ error: 'commit_sha required when moving to review' }, 400);
		}

		const doStub = getTicketQueueDO(c.env, repo.id);
		const enqueueRes = await doStub.fetch(new Request('https://do/enqueue', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ticketId,
				agentId: ticket.agent_id,
				branch: ticket.branch,
				commitSha,
				priority: ticket.priority,
			}),
		}));

		const queueInfo = await enqueueRes.json() as any;

		// Log
		await DB.prepare(
			'INSERT INTO merge_queue_log (id, repo_id, ticket_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'
		).bind(
			crypto.randomUUID(), repo.id, ticketId, 'enqueued',
			JSON.stringify({ position: queueInfo.position, total: queueInfo.total })
		).run();

		return c.json({
			ticket: { ...ticket, status: 'review', commit_sha: commitSha },
			merge_queue: queueInfo,
		});
	}

	// If cancelled, remove from merge queue
	if (body.status === 'cancelled') {
		const doStub = getTicketQueueDO(c.env, repo.id);
		await doStub.fetch(new Request('https://do/dequeue', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ticketId }),
		}));
	}

	const updated = await DB.prepare('SELECT * FROM tickets WHERE id = ?').bind(ticketId).first();
	return c.json({ ticket: updated });
});

// ─── GET /api/repos/:repo/tickets/queue ─────────────────────────
// Get the merge queue status for this repo
app.get('/:repo/tickets/queue', async (c) => {
	const repoName = c.req.param('repo');
	const { DB } = c.env;

	const repo = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(repoName).first<{ id: string }>();
	if (!repo) return c.json({ error: 'Repository not found' }, 404);

	const doStub = getTicketQueueDO(c.env, repo.id);
	const res = await doStub.fetch(new Request('https://do/status'));
	const status = await res.json();

	return c.json(status);
});

// ─── POST /api/repos/:repo/tickets/:ticketId/retry ──────────────
// Re-enqueue a failed ticket after the agent resolves conflicts
app.post('/:repo/tickets/:ticketId/retry', async (c) => {
	const repoName = c.req.param('repo');
	const ticketId = c.req.param('ticketId');
	const { DB } = c.env;

	const repo = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(repoName).first<{ id: string }>();
	if (!repo) return c.json({ error: 'Repository not found' }, 404);

	const ticket = await DB.prepare('SELECT * FROM tickets WHERE id = ? AND repo_id = ?')
		.bind(ticketId, repo.id).first<any>();
	if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

	if (ticket.status !== 'failed') {
		return c.json({ error: 'Only failed tickets can be retried' }, 400);
	}

	// Move back to review → re-enqueue
	await DB.prepare(
		"UPDATE tickets SET status = 'review', merge_attempts = merge_attempts + 1, updated_at = datetime('now') WHERE id = ?"
	).bind(ticketId).run();

	const doStub = getTicketQueueDO(c.env, repo.id);
	const enqueueRes = await doStub.fetch(new Request('https://do/enqueue', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			ticketId,
			agentId: ticket.agent_id,
			branch: ticket.branch,
			commitSha: ticket.commit_sha,
			priority: ticket.priority,
		}),
	}));

	const queueInfo = await enqueueRes.json();

	await DB.prepare(
		'INSERT INTO merge_queue_log (id, repo_id, ticket_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'
	).bind(
		crypto.randomUUID(), repo.id, ticketId, 'retry',
		JSON.stringify({ attempt: ticket.merge_attempts + 1 })
	).run();

	return c.json({ ticket: { ...ticket, status: 'review' }, merge_queue: queueInfo });
});

// ─── DELETE /api/repos/:repo/tickets/:ticketId ──────────────────
app.delete('/:repo/tickets/:ticketId', async (c) => {
	const ticketId = c.req.param('ticketId');
	const { DB } = c.env;

	const ticket = await DB.prepare('SELECT * FROM tickets WHERE id = ?').bind(ticketId).first<any>();
	if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

	if (ticket.status === 'merging') {
		return c.json({ error: 'Cannot delete a ticket that is currently being merged' }, 409);
	}

	// Remove from queue if present
	if (['review', 'queued'].includes(ticket.status)) {
		const doStub = getTicketQueueDO(c.env, ticket.repo_id);
		await doStub.fetch(new Request('https://do/dequeue', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ticketId }),
		}));
	}

	await DB.prepare('DELETE FROM tickets WHERE id = ?').bind(ticketId).run();

	return c.json({ success: true });
});

export default app;
