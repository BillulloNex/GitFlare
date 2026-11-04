import { Hono, type Context } from 'hono';
import type { Env } from '../env.ts';
import { auditContext, type RepoVariables } from '../middleware/repo-access.ts';
import { audit } from '../lib/audit.ts';
import { getArtifactRefs } from '../lib/artifact-reader.ts';
import { isValidRefName } from '../lib/repo-validation.ts';
import { readJsonObject } from '../lib/request.ts';
import { ticketQueueStub } from './internal-merge.ts';

// All routes run behind repoAccess (src/index.ts): `repoRecord` is set, GET
// needs read, other methods need write. Ticket lookups are scoped to the repo.
// Audit entries use the authenticated principal — `agent_id` is a
// caller-supplied label and is never trusted as the actor.
type TicketEnv = { Bindings: Env; Variables: RepoVariables };
const app = new Hono<TicketEnv>();

// ─── Types ──────────────────────────────────────────────────────

interface CreateTicketBody {
	title?: unknown;
	description?: unknown;
	agent_id?: unknown;
	base_branch?: unknown;
	priority?: unknown;
}

interface UpdateTicketBody {
	status?: unknown;
	commit_sha?: unknown;
	title?: unknown;
	description?: unknown;
}

type TicketRow = {
	id: string;
	repo_id: string;
	agent_id: string;
	title: string;
	description: string | null;
	branch: string;
	base_branch: string;
	status: string;
	priority: number;
	commit_sha: string | null;
	merge_attempts: number;
	started_at: string | null;
};

type Failure = { ok: false; status: 400 | 404 | 409 | 502; body: Record<string, unknown> };

const SHA_RE = /^[0-9a-f]{40}$/;
const AGENT_ID_MAX = 100;

/**
 * Allowed status transitions requested through the API. `merging`, `merged`
 * and `failed` are otherwise set by the merge queue; `failed` → `review` goes
 * through POST /retry.
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
	queued: ['active', 'cancelled'],
	active: ['review', 'cancelled'],
	review: ['active', 'cancelled'], // un-review to push more
	merging: ['cancelled'], // aborts the attempt unless it is already fast-forwarding
	failed: ['active', 'cancelled'], // agent fixes and retries
};

// ─── Helpers ────────────────────────────────────────────────────

function normaliseSha(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const sha = value.trim().toLowerCase();
	return SHA_RE.test(sha) ? sha : null;
}

async function readJson<T extends object>(c: Context<TicketEnv>): Promise<T | null> {
	return (await readJsonObject<T>(c)) as T | null;
}

async function loadTicket(c: Context<TicketEnv>, ticketId: string): Promise<TicketRow | null> {
	return c.env.DB.prepare('SELECT * FROM tickets WHERE id = ? AND repo_id = ?').bind(ticketId, c.get('repoRecord').id).first<TicketRow>();
}

async function logQueue(c: Context<TicketEnv>, ticketId: string, action: string, details: Record<string, unknown>): Promise<void> {
	await c.env.DB.prepare('INSERT INTO merge_queue_log (id, repo_id, ticket_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
		.bind(crypto.randomUUID(), c.get('repoRecord').id, ticketId, action, JSON.stringify(details), new Date().toISOString())
		.run();
}

async function auditTicket(c: Context<TicketEnv>, action: string, details: Record<string, unknown>): Promise<void> {
	const { actor, ipAddress } = auditContext(c);
	await audit(c.env.DB, { repoId: c.get('repoRecord').id, actor, action, details, ipAddress });
}

/**
 * The agent's claimed `commit_sha` must be the actual tip of its branch in
 * Artifacts, and the base branch must exist.
 */
async function verifyBranchTip(c: Context<TicketEnv>, ticket: TicketRow, commitSha: string): Promise<{ ok: true } | Failure> {
	if (!isValidRefName(ticket.branch) || !isValidRefName(ticket.base_branch)) {
		return { ok: false, status: 400, body: { error: 'Ticket has an invalid branch name' } };
	}
	let refs: Map<string, string>;
	try {
		refs = await getArtifactRefs(c.env, c.get('repoRecord').name);
	} catch (err) {
		console.error('tickets: reading refs failed:', err);
		return { ok: false, status: 502, body: { error: 'Could not read repository refs — try again' } };
	}
	const tip = refs.get(`refs/heads/${ticket.branch}`);
	if (!tip) {
		return { ok: false, status: 409, body: { error: `Branch "${ticket.branch}" does not exist — push your commits first` } };
	}
	if (tip !== commitSha) {
		return {
			ok: false,
			status: 409,
			body: { error: `commit_sha does not match the tip of "${ticket.branch}"`, commit_sha: commitSha, branch_tip: tip },
		};
	}
	if (!refs.has(`refs/heads/${ticket.base_branch}`)) {
		return { ok: false, status: 409, body: { error: `Base branch "${ticket.base_branch}" does not exist` } };
	}
	return { ok: true };
}

async function enqueueTicket(c: Context<TicketEnv>, ticket: TicketRow, commitSha: string): Promise<{ ok: true; info: any } | Failure> {
	const repo = c.get('repoRecord');
	try {
		const res = await ticketQueueStub(c.env, repo.id).fetch(
			new Request('https://do/enqueue', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					ticketId: ticket.id,
					agentId: ticket.agent_id,
					branch: ticket.branch,
					commitSha,
					priority: ticket.priority,
					repoId: repo.id,
					repoName: repo.name,
					baseBranch: ticket.base_branch,
					enqueuedBy: auditContext(c).actor,
				}),
			})
		);
		const info = await res.json().catch(() => null);
		if (!res.ok) return { ok: false, status: 502, body: { error: 'Merge queue rejected the ticket', detail: info } };
		return { ok: true, info };
	} catch (err) {
		console.error('tickets: enqueue failed:', err);
		return { ok: false, status: 502, body: { error: 'Merge queue unavailable — try again' } };
	}
}

/** Remove from the merge queue. Propagates the DO's 409 (fast-forward in progress). */
async function dequeueTicket(c: Context<TicketEnv>, ticketId: string): Promise<{ ok: true; aborted: boolean } | Failure> {
	try {
		const res = await ticketQueueStub(c.env, c.get('repoRecord').id).fetch(
			new Request('https://do/dequeue', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ticketId }),
			})
		);
		const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
		if (res.status === 409) {
			return { ok: false, status: 409, body: { error: String(body?.error ?? 'Ticket is currently being merged and cannot be removed') } };
		}
		if (!res.ok) return { ok: false, status: 502, body: { error: 'Merge queue unavailable — try again' } };
		return { ok: true, aborted: body?.aborted === true };
	} catch (err) {
		console.error('tickets: dequeue failed:', err);
		return { ok: false, status: 502, body: { error: 'Merge queue unavailable — try again' } };
	}
}

// ─── GET /api/repos/:repo/tickets ───────────────────────────────
// List all tickets for a repo, optionally filtered by status/agent
app.get('/:repo/tickets', async (c) => {
	const status = c.req.query('status');
	const agentId = c.req.query('agent_id');
	const repo = c.get('repoRecord');

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

	const { results } = await c.env.DB.prepare(sql).bind(...params).all();
	return c.json({ tickets: results });
});

// ─── GET /api/repos/:repo/tickets/queue ─────────────────────────
// Merge queue status. Registered BEFORE /tickets/:ticketId so "queue" is not
// captured as a ticket id.
app.get('/:repo/tickets/queue', async (c) => {
	const res = await ticketQueueStub(c.env, c.get('repoRecord').id).fetch(new Request('https://do/status'));
	if (!res.ok) return c.json({ error: 'Merge queue unavailable' }, 502);
	return c.json(await res.json());
});

// ─── POST /api/repos/:repo/tickets ──────────────────────────────
// Create a new ticket and assign a working branch
app.post('/:repo/tickets', async (c) => {
	const body = await readJson<CreateTicketBody>(c);
	if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
	const repo = c.get('repoRecord');

	const title = typeof body.title === 'string' ? body.title.trim() : '';
	const agentId = typeof body.agent_id === 'string' ? body.agent_id.trim() : '';
	if (!title || !agentId) return c.json({ error: 'title and agent_id are required' }, 400);
	if (agentId.length > AGENT_ID_MAX) return c.json({ error: `agent_id must be at most ${AGENT_ID_MAX} characters` }, 400);
	if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
		return c.json({ error: 'description must be a string' }, 400);
	}
	if (body.priority !== undefined && (typeof body.priority !== 'number' || !Number.isInteger(body.priority))) {
		return c.json({ error: 'priority must be an integer' }, 400);
	}

	const baseBranch = body.base_branch === undefined ? repo.default_branch || 'main' : body.base_branch;
	if (typeof baseBranch !== 'string' || !isValidRefName(baseBranch) || baseBranch.startsWith('refs/')) {
		return c.json({ error: 'base_branch is not a valid branch name' }, 400);
	}

	const ticketId = crypto.randomUUID();
	// Each agent gets its own branch: agent/<agent_id>/<ticket_id_short>
	const branch = `agent/${agentId}/${ticketId.slice(0, 8)}`;
	if (!isValidRefName(branch)) {
		return c.json({ error: 'agent_id produces an invalid branch name (no spaces, "..", "~^:?*[\\", or leading "-"/".")' }, 400);
	}
	const priority = typeof body.priority === 'number' ? body.priority : 0;

	await c.env.DB.prepare(
		`INSERT INTO tickets (id, repo_id, agent_id, title, description, branch, base_branch, status, priority, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, datetime('now'), datetime('now'))`
	)
		.bind(ticketId, repo.id, agentId, title, (body.description as string | null | undefined) ?? null, branch, baseBranch, priority)
		.run();

	await auditTicket(c, 'ticket.create', { ticketId, agentId, branch, baseBranch, title });

	return c.json(
		{
			id: ticketId,
			branch,
			base_branch: baseBranch,
			status: 'queued',
			message: `Branch "${branch}" assigned. Push commits there, then PATCH status to "review" with commit_sha to enter the merge queue.`,
		},
		201
	);
});

// ─── GET /api/repos/:repo/tickets/:ticketId ─────────────────────
app.get('/:repo/tickets/:ticketId', async (c) => {
	const ticket = await loadTicket(c, c.req.param('ticketId'));
	if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
	return c.json({ ticket });
});

// ─── PATCH /api/repos/:repo/tickets/:ticketId ───────────────────
// Update a ticket. Setting status to "review" verifies commit_sha against the
// branch tip and enqueues for merge. Everything is validated BEFORE any write.
app.patch('/:repo/tickets/:ticketId', async (c) => {
	const ticketId = c.req.param('ticketId');
	const body = await readJson<UpdateTicketBody>(c);
	if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
	const { DB } = c.env;
	const repo = c.get('repoRecord');

	const ticket = await loadTicket(c, ticketId);
	if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

	// ── Validate input ──
	if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) {
		return c.json({ error: 'title must be a non-empty string' }, 400);
	}
	if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
		return c.json({ error: 'description must be a string or null' }, 400);
	}
	let commitSha: string | null = null;
	if (body.commit_sha !== undefined) {
		commitSha = normaliseSha(body.commit_sha);
		if (!commitSha) return c.json({ error: 'commit_sha must be a full 40-character hex SHA' }, 400);
	}
	const newStatus = body.status;
	if (commitSha && newStatus === undefined && ['review', 'merging'].includes(ticket.status)) {
		// The queue merges the SHA verified at enqueue time; changing it here
		// would desync D1 from the queue. Un-review, then review again.
		return c.json({ error: 'Ticket is in the merge queue — set status to "active", then back to "review" with the new commit_sha' }, 409);
	}
	if (newStatus !== undefined) {
		const allowed = VALID_TRANSITIONS[ticket.status] || [];
		if (typeof newStatus !== 'string' || !allowed.includes(newStatus)) {
			return c.json({ error: `Cannot transition from "${ticket.status}" to "${String(newStatus)}"`, allowed_transitions: allowed }, 400);
		}
	}

	// ── Entering review: verify the SHA against the real branch tip ──
	let reviewSha: string | null = null;
	if (newStatus === 'review') {
		reviewSha = commitSha ?? normaliseSha(ticket.commit_sha);
		if (!reviewSha) return c.json({ error: 'commit_sha (full SHA) is required when moving to review' }, 400);
		const verified = await verifyBranchTip(c, ticket, reviewSha);
		if (!verified.ok) return c.json(verified.body, verified.status);
	}

	// ── Leaving the queue: dequeue first; the DO refuses (409) mid fast-forward ──
	let aborted = false;
	const leavesQueue = newStatus === 'cancelled' || (newStatus === 'active' && ticket.status === 'review');
	if (leavesQueue && ['review', 'merging'].includes(ticket.status)) {
		const dequeued = await dequeueTicket(c, ticketId);
		if (!dequeued.ok) return c.json(dequeued.body, dequeued.status);
		aborted = dequeued.aborted;
	}

	// ── Write ──
	const updates: string[] = ["updated_at = datetime('now')"];
	const values: (string | number | null)[] = [];
	if (typeof body.title === 'string') {
		updates.push('title = ?');
		values.push(body.title.trim());
	}
	if (body.description !== undefined) {
		updates.push('description = ?');
		values.push(body.description as string | null);
	}
	if (reviewSha ?? commitSha) {
		updates.push('commit_sha = ?');
		values.push((reviewSha ?? commitSha)!);
	}
	let where = 'id = ? AND repo_id = ?';
	const whereValues: string[] = [ticketId, repo.id];
	if (typeof newStatus === 'string') {
		updates.push('status = ?');
		values.push(newStatus);
		if (newStatus === 'active' && !ticket.started_at) updates.push("started_at = datetime('now')");
		if (newStatus === 'review') updates.push('last_error = NULL');
		if (newStatus === 'cancelled') {
			// The queue may have moved review → merging meanwhile.
			where += " AND status NOT IN ('merged', 'cancelled')";
		} else {
			where += ' AND status = ?';
			whereValues.push(ticket.status);
		}
	}
	const result = await DB.prepare(`UPDATE tickets SET ${updates.join(', ')} WHERE ${where}`).bind(...values, ...whereValues).run();
	if (typeof newStatus === 'string' && !result.meta.changes) {
		const current = await loadTicket(c, ticketId);
		return c.json({ error: 'Ticket status changed concurrently — reload and try again', ticket: current }, 409);
	}

	// ── Enqueue (after the D1 write so the queue sees `review`) ──
	let queueInfo: unknown = undefined;
	if (newStatus === 'review' && reviewSha) {
		const enqueued = await enqueueTicket(c, ticket, reviewSha);
		if (!enqueued.ok) {
			await DB.prepare("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ? AND repo_id = ? AND status = 'review'")
				.bind(ticket.status, ticketId, repo.id)
				.run();
			return c.json(enqueued.body, enqueued.status);
		}
		queueInfo = enqueued.info;
		await logQueue(c, ticketId, 'enqueued', { commitSha: reviewSha, position: enqueued.info?.position, total: enqueued.info?.total });
	} else if (leavesQueue && ['review', 'merging'].includes(ticket.status)) {
		await logQueue(c, ticketId, 'dequeued', { reason: newStatus, aborted });
	}

	await auditTicket(c, newStatus ? `ticket.${newStatus === 'cancelled' ? 'cancel' : newStatus}` : 'ticket.update', {
		ticketId,
		from: ticket.status,
		to: newStatus ?? ticket.status,
		...(reviewSha ?? commitSha ? { commitSha: reviewSha ?? commitSha } : {}),
		...(aborted ? { abortedMerge: true } : {}),
	});

	const updated = await loadTicket(c, ticketId);
	return c.json(queueInfo === undefined ? { ticket: updated } : { ticket: updated, merge_queue: queueInfo });
});

// ─── POST /api/repos/:repo/tickets/:ticketId/retry ──────────────
// Re-enqueue a failed ticket after the agent resolves conflicts. Optional
// body `{ commit_sha }` if the agent pushed new commits; it must be the tip.
app.post('/:repo/tickets/:ticketId/retry', async (c) => {
	const ticketId = c.req.param('ticketId');
	const { DB } = c.env;
	const repo = c.get('repoRecord');

	const ticket = await loadTicket(c, ticketId);
	if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
	if (ticket.status !== 'failed') return c.json({ error: 'Only failed tickets can be retried' }, 400);

	const body = (await readJson<{ commit_sha?: unknown }>(c)) ?? {};
	let commitSha: string | null;
	if (body.commit_sha !== undefined) {
		commitSha = normaliseSha(body.commit_sha);
		if (!commitSha) return c.json({ error: 'commit_sha must be a full 40-character hex SHA' }, 400);
	} else {
		commitSha = normaliseSha(ticket.commit_sha);
		if (!commitSha) return c.json({ error: 'commit_sha (full SHA) is required' }, 400);
	}
	const verified = await verifyBranchTip(c, ticket, commitSha);
	if (!verified.ok) return c.json(verified.body, verified.status);

	const moved = await DB.prepare(
		`UPDATE tickets SET status = 'review', commit_sha = ?, last_error = NULL, merge_attempts = merge_attempts + 1, updated_at = datetime('now')
		 WHERE id = ? AND repo_id = ? AND status = 'failed'`
	)
		.bind(commitSha, ticketId, repo.id)
		.run();
	if (!moved.meta.changes) return c.json({ error: 'Ticket status changed concurrently — reload and try again' }, 409);

	const enqueued = await enqueueTicket(c, ticket, commitSha);
	if (!enqueued.ok) {
		await DB.prepare("UPDATE tickets SET status = 'failed', updated_at = datetime('now') WHERE id = ? AND repo_id = ? AND status = 'review'")
			.bind(ticketId, repo.id)
			.run();
		return c.json(enqueued.body, enqueued.status);
	}

	await logQueue(c, ticketId, 'retry', { attempt: ticket.merge_attempts + 1, commitSha });
	await auditTicket(c, 'ticket.retry', { ticketId, commitSha, attempt: ticket.merge_attempts + 1 });

	return c.json({ ticket: { ...ticket, status: 'review', commit_sha: commitSha }, merge_queue: enqueued.info });
});

// ─── DELETE /api/repos/:repo/tickets/:ticketId ──────────────────
app.delete('/:repo/tickets/:ticketId', async (c) => {
	const ticketId = c.req.param('ticketId');
	const repo = c.get('repoRecord');

	const ticket = await loadTicket(c, ticketId);
	if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

	// Remove from the queue first (aborts an in-flight attempt unless it is
	// already fast-forwarding, in which case the DO answers 409).
	if (['review', 'merging'].includes(ticket.status)) {
		const dequeued = await dequeueTicket(c, ticketId);
		if (!dequeued.ok) return c.json(dequeued.body, dequeued.status);
	}

	await c.env.DB.prepare('DELETE FROM tickets WHERE id = ? AND repo_id = ?').bind(ticketId, repo.id).run();
	await auditTicket(c, 'ticket.delete', { ticketId, status: ticket.status, branch: ticket.branch });

	return c.json({ success: true });
});

export default app;
