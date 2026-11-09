import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.ts';
import {
	cancelMergeCI,
	completeMerge,
	enqueueMergeCI,
	executeFastForward,
	executeMerge,
	MERGE_TOKEN_TTL_S,
	recordMergeFailure,
	resultBranchFor,
	type MergeTarget,
} from '../api/internal-merge.ts';
import { getArtifactRefs } from '../lib/artifact-reader.ts';
import { maxCIDurationMs } from '../queue/ci-consumer.ts';

/**
 * TicketQueue Durable Object — one instance per repo (idFromName(repoId)).
 *
 * Serializes merges of agent branches into their base branch. The head of
 * the queue is moved into `active` and driven through these phases by the
 * alarm handler (side-effecting steps) and callbacks (waiting steps):
 *
 *   dispatch     alarm → executeMerge (verify tip, 300 s token, runner rebase)
 *   merging      wait for the runner callback          (timeout: token TTL + 2 min)
 *   ci-dispatch  alarm → enqueueMergeCI on the result branch
 *   ci           wait for internal-ci.ts to report     (timeout: MAX_CI_DURATION_MS + 5 min)
 *   ff-dispatch  alarm → executeFastForward (fresh token, runner fast-forward)
 *   ff           wait for the runner callback          (timeout: token TTL + 2 min)
 *   complete     alarm → completeMerge (D1, audit, mirror, deploys)
 *
 * Every attempt has an `attemptId`; callbacks for any other attempt (timed
 * out, cancelled, restarted) are ignored. On failure or timeout the attempt
 * is dropped, the alarm deleted, the ticket marked failed in D1, and the next
 * entry started. If the base branch moves while CI runs, the attempt is
 * restarted (re-rebased) a bounded number of times.
 */

interface QueueEntry {
	ticketId: string;
	agentId: string;
	branch: string;
	commitSha: string;
	priority: number;
	enqueuedAt: number;
	repoId: string;
	repoName: string;
	baseBranch: string;
	/** Audit actor (user / key id) of whoever moved the ticket to review. */
	enqueuedBy: string | null;
}

type Phase = 'dispatch' | 'merging' | 'ci-dispatch' | 'ci' | 'ff-dispatch' | 'ff' | 'complete';

interface ActiveAttempt {
	attemptId: string;
	entry: QueueEntry;
	phase: Phase;
	/** When the current waiting phase times out (ms epoch). */
	deadline: number;
	/** Dispatch tries in the current *-dispatch phase. */
	tries: number;
	/** Restarts after the base branch moved. */
	restarts: number;
	startedAt: number;
	resultBranch: string;
	/** Resolved from D1 by executeMerge. */
	target?: MergeTarget;
	resultSha?: string;
	baseSha?: string;
	ciRunId?: string | null;
}

interface RunnerResultBody {
	ticketId: string;
	attemptId: string;
	op: 'merge' | 'fast-forward';
	success: boolean;
	resultSha?: string;
	baseSha?: string;
	baseMoved?: boolean;
	conflicts?: string[];
	error?: string;
}

const MAX_DISPATCH_TRIES = 5;
const MAX_RESTARTS = 3;
/** Runner op budget is the token TTL; allow time for callback retries. */
const RUNNER_OP_TIMEOUT_MS = Math.max(MERGE_TOKEN_TTL_S * 1000 + 2 * 60_000, 15 * 60_000);
const CI_TIMEOUT_BUFFER_MS = 5 * 60_000;
const SHA_RE = /^[0-9a-f]{40}$/;

const CANCELLABLE_PHASES: ReadonlySet<Phase> = new Set(['dispatch', 'merging', 'ci-dispatch', 'ci']);

const PHASE_LABEL: Record<Phase, string> = {
	dispatch: 'merge dispatch',
	merging: 'rebase',
	'ci-dispatch': 'CI dispatch',
	ci: 'CI',
	'ff-dispatch': 'fast-forward dispatch',
	ff: 'fast-forward',
	complete: 'completion',
};

function backoffMs(tries: number): number {
	return Math.min(5 * 60_000, 15_000 * 2 ** Math.max(0, tries - 1));
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Parse a JSON object body; null if absent, malformed or not an object. */
async function readJson<T>(request: Request): Promise<Partial<T> | null> {
	const body = await request.json().catch(() => null);
	return body && typeof body === 'object' && !Array.isArray(body) ? (body as Partial<T>) : null;
}

export class TicketQueue extends DurableObject<Env> {
	private queue: QueueEntry[] = [];
	private active: ActiveAttempt | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		this.ctx.blockConcurrencyWhile(async () => {
			this.queue = (await this.ctx.storage.get<QueueEntry[]>('queue')) ?? [];
			this.active = (await this.ctx.storage.get<ActiveAttempt | null>('active')) ?? null;
			// Pre-B4 state: `processing` was a lock nothing ever released. The
			// ticket is still at the head of `queue`, so just drop the lock.
			await this.ctx.storage.delete('processing');
			// Never leave work stranded without an alarm (e.g. after a deploy).
			if ((this.active || this.queue.length > 0) && (await this.ctx.storage.getAlarm()) === null) {
				await this.ctx.storage.setAlarm(this.active?.deadline && this.active.deadline > Date.now() ? this.active.deadline : Date.now());
			}
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'POST' && url.pathname === '/enqueue') return this.handleEnqueue(request);
		if (request.method === 'POST' && url.pathname === '/dequeue') return this.handleDequeue(request);
		if (request.method === 'POST' && url.pathname === '/merge-result') {
			const body = await readJson<RunnerResultBody>(request);
			if (!body || typeof body.ticketId !== 'string' || typeof body.attemptId !== 'string') {
				return json({ error: 'ticketId and attemptId are required' }, 400);
			}
			return json(await this.handleRunnerResult(body as RunnerResultBody));
		}
		if (request.method === 'POST' && url.pathname === '/ci-result') {
			const body = await readJson<{ runId: string; status: string }>(request);
			if (!body || typeof body.runId !== 'string' || typeof body.status !== 'string') {
				return json({ error: 'runId and status are required' }, 400);
			}
			return json(await this.handleCIResult(body as { runId: string; status: string }));
		}
		if (request.method === 'GET' && url.pathname === '/status') return json(this.status());

		return json({ error: 'Not Found' }, 404);
	}

	// ─── Queue mutations ───────────────────────────────────────────

	private async handleEnqueue(request: Request): Promise<Response> {
		const body = await readJson<QueueEntry>(request);
		if (
			!body ||
			typeof body.ticketId !== 'string' ||
			typeof body.branch !== 'string' ||
			typeof body.commitSha !== 'string' ||
			!SHA_RE.test(body.commitSha) ||
			typeof body.repoId !== 'string' ||
			typeof body.repoName !== 'string' ||
			typeof body.baseBranch !== 'string'
		) {
			return json({ error: 'ticketId, branch, commitSha (full SHA), repoId, repoName and baseBranch are required' }, 400);
		}

		if (this.active?.entry.ticketId === body.ticketId) {
			return json({ position: 0, total: this.queue.length, processing: body.ticketId, phase: this.active.phase });
		}

		const existing = this.queue.find((e) => e.ticketId === body.ticketId);
		if (existing) {
			// Re-review with a newly verified commit: merge that one instead.
			existing.commitSha = body.commitSha;
			await this.ctx.storage.put('queue', this.queue);
		} else {
			this.queue.push({
				ticketId: body.ticketId,
				agentId: typeof body.agentId === 'string' ? body.agentId : '',
				branch: body.branch,
				commitSha: body.commitSha,
				priority: typeof body.priority === 'number' ? body.priority : 0,
				enqueuedAt: Date.now(),
				repoId: body.repoId,
				repoName: body.repoName,
				baseBranch: body.baseBranch,
				enqueuedBy: typeof body.enqueuedBy === 'string' ? body.enqueuedBy : null,
			});
			// Higher priority first, then FIFO.
			this.queue.sort((a, b) => (b.priority !== a.priority ? b.priority - a.priority : a.enqueuedAt - b.enqueuedAt));
			await this.ctx.storage.put('queue', this.queue);
		}

		if (!this.active) await this.ctx.storage.setAlarm(Date.now());

		return json({
			position: this.queue.findIndex((e) => e.ticketId === body.ticketId) + 1,
			total: this.queue.length,
			processing: this.active?.entry.ticketId ?? null,
		});
	}

	/**
	 * Remove a ticket from the queue. An active attempt can be aborted while
	 * it is rebasing or in CI; once the fast-forward has been dispatched the
	 * base branch may already have moved, so that returns 409.
	 */
	private async handleDequeue(request: Request): Promise<Response> {
		const body = await readJson<{ ticketId: string }>(request);
		if (!body || typeof body.ticketId !== 'string') return json({ error: 'ticketId is required' }, 400);
		const { ticketId } = body;

		const a = this.active;
		if (a && a.entry.ticketId === ticketId) {
			if (!CANCELLABLE_PHASES.has(a.phase)) {
				return json({ error: `Ticket is being fast-forwarded into ${a.entry.baseBranch}; it can no longer be cancelled`, phase: a.phase }, 409);
			}
			const ciRunId = a.phase === 'ci' || a.phase === 'ci-dispatch' ? a.ciRunId : null;
			await this.endAttempt(a);
			if (ciRunId) await cancelMergeCI(this.env, ciRunId);
			return json({ success: true, removed: true, aborted: true });
		}

		const before = this.queue.length;
		this.queue = this.queue.filter((e) => e.ticketId !== ticketId);
		const removed = this.queue.length !== before;
		if (removed) {
			await this.ctx.storage.put('queue', this.queue);
		}
		return json({ success: true, removed, aborted: false });
	}

	/** Start the next entry, if idle. The alarm performs the dispatch. */
	private async processNext(): Promise<void> {
		if (this.active || this.queue.length === 0) return;
		const entry = this.queue.shift()!;
		this.active = this.newAttempt(entry, 0);
		await this.ctx.storage.put({ queue: this.queue, active: this.active });
		await this.ctx.storage.setAlarm(Date.now());
	}

	private newAttempt(entry: QueueEntry, restarts: number): ActiveAttempt {
		return {
			attemptId: crypto.randomUUID(),
			entry,
			phase: 'dispatch',
			deadline: 0,
			tries: 0,
			restarts,
			startedAt: Date.now(),
			resultBranch: resultBranchFor(entry.ticketId),
			ciRunId: null,
		};
	}

	/**
	 * Drop the active attempt (if it is still `a`), delete its alarm and move
	 * on to the next entry. State is cleared BEFORE any side effects so late
	 * callbacks for this attempt are ignored. Returns false if `a` was stale.
	 */
	private async endAttempt(a: ActiveAttempt): Promise<boolean> {
		if (this.active?.attemptId !== a.attemptId) return false;
		this.active = null;
		await this.ctx.storage.put('active', null);
		await this.ctx.storage.deleteAlarm();
		await this.processNext();
		return true;
	}

	private async fail(a: ActiveAttempt, error: string, details?: Record<string, unknown>): Promise<void> {
		const phase = a.phase;
		if (!(await this.endAttempt(a))) return;
		console.warn(`merge-queue: ticket ${a.entry.ticketId} failed during ${PHASE_LABEL[phase]}: ${error}`);
		await recordMergeFailure(this.env, {
			ticketId: a.entry.ticketId,
			repoId: a.target?.repoId ?? a.entry.repoId,
			attemptId: a.attemptId,
			phase,
			error,
			details,
		});
	}

	/** Base branch moved under us: rebuild the merge on the new tip (bounded). */
	private async restartOrFail(a: ActiveAttempt, error: string): Promise<void> {
		if (this.active?.attemptId !== a.attemptId) return;
		if (a.restarts >= MAX_RESTARTS) {
			await this.fail(a, `${error} — gave up after ${MAX_RESTARTS} restarts`);
			return;
		}
		console.log(`merge-queue: restarting ticket ${a.entry.ticketId}: ${error}`);
		this.active = this.newAttempt(a.entry, a.restarts + 1);
		await this.ctx.storage.put('active', this.active);
		await this.ctx.storage.setAlarm(Date.now());
	}

	/** Persist `a` (if still active) and schedule the alarm. */
	private async save(a: ActiveAttempt, alarmAt: number): Promise<void> {
		if (this.active?.attemptId !== a.attemptId) return;
		await this.ctx.storage.put('active', a);
		await this.ctx.storage.setAlarm(alarmAt);
	}

	private isCurrent(a: ActiveAttempt, phase: Phase): boolean {
		return this.active?.attemptId === a.attemptId && this.active.phase === phase;
	}

	private targetOf(a: ActiveAttempt): MergeTarget {
		return (
			a.target ?? {
				ticketId: a.entry.ticketId,
				repoId: a.entry.repoId,
				repoName: a.entry.repoName,
				branch: a.entry.branch,
				baseBranch: a.entry.baseBranch,
				commitSha: a.entry.commitSha,
			}
		);
	}

	// ─── Alarm: drives side-effecting phases and timeouts ──────────

	async alarm(): Promise<void> {
		const a = this.active;
		if (!a) {
			await this.processNext();
			return;
		}
		try {
			await this.step(a);
		} catch (err) {
			// Never rely on the runtime's limited alarm retries: an exhausted
			// alarm would strand the queue. Unexpected errors count as transient.
			const error = err instanceof Error ? err.message : String(err);
			console.error(`merge-queue: ${PHASE_LABEL[a.phase]} for ${a.entry.ticketId} threw: ${error}`);
			if (this.active?.attemptId !== a.attemptId) return;
			if (a.phase === 'dispatch' || a.phase === 'ci-dispatch' || a.phase === 'ff-dispatch') {
				await this.retryOrFail(a, error, true);
			} else {
				await this.ctx.storage.setAlarm(Date.now() + 60_000);
			}
		}
	}

	private async step(a: ActiveAttempt): Promise<void> {
		switch (a.phase) {
			case 'dispatch':
				return this.runMergeDispatch(a);
			case 'ci-dispatch':
				return this.runCIDispatch(a);
			case 'ff-dispatch':
				return this.runFastForwardDispatch(a);
			case 'complete':
				return this.runComplete(a);
			default:
				if (Date.now() >= a.deadline) return this.timeout(a);
				await this.ctx.storage.setAlarm(a.deadline);
		}
	}

	/** Transient failure: retry with backoff, or give up after MAX_DISPATCH_TRIES. */
	private async retryOrFail(a: ActiveAttempt, error: string, transient: boolean): Promise<void> {
		if (transient && a.tries < MAX_DISPATCH_TRIES) {
			console.warn(`merge-queue: ${PHASE_LABEL[a.phase]} for ${a.entry.ticketId} failed (try ${a.tries}), retrying: ${error}`);
			await this.save(a, Date.now() + backoffMs(a.tries));
			return;
		}
		await this.fail(a, transient ? `${error} (gave up after ${a.tries} tries)` : error);
	}

	private async runMergeDispatch(a: ActiveAttempt): Promise<void> {
		a.tries++;
		await this.ctx.storage.put('active', a);

		const res = await executeMerge(this.env, { ticketId: a.entry.ticketId, commitSha: a.entry.commitSha, attemptId: a.attemptId });
		if (this.active?.attemptId !== a.attemptId) return; // cancelled meanwhile

		if (!res.ok) {
			if (res.abandoned) {
				// Cancelled / deleted — nothing to record.
				await this.endAttempt(a);
				return;
			}
			if (!this.isCurrent(a, 'dispatch')) return;
			await this.retryOrFail(a, res.error, res.transient);
			return;
		}

		a.target = res.target;
		// The runner's callback may already have moved us on.
		if (a.phase === 'dispatch') {
			a.phase = 'merging';
			a.tries = 0;
			a.deadline = Date.now() + RUNNER_OP_TIMEOUT_MS;
			await this.save(a, a.deadline);
		} else {
			await this.ctx.storage.put('active', a);
		}
	}

	private async runCIDispatch(a: ActiveAttempt): Promise<void> {
		if (!a.resultSha) {
			await this.fail(a, 'Merge result SHA missing');
			return;
		}
		a.tries++;
		// Persist the run id first so a CI result arriving mid-await matches.
		a.ciRunId = crypto.randomUUID();
		await this.ctx.storage.put('active', a);
		const runId = a.ciRunId;

		const res = await enqueueMergeCI(this.env, this.targetOf(a), { runId, resultBranch: a.resultBranch, resultSha: a.resultSha });
		if (this.active?.attemptId !== a.attemptId) {
			if (res.ok && res.runId) await cancelMergeCI(this.env, res.runId);
			return;
		}
		if (!this.isCurrent(a, 'ci-dispatch')) return; // CI already reported

		if (!res.ok) {
			await this.retryOrFail(a, res.error, res.transient);
			return;
		}
		a.tries = 0;
		if (res.runId === null) {
			// No CI config in the result — nothing to gate on.
			a.ciRunId = null;
			a.phase = 'ff-dispatch';
			await this.save(a, Date.now());
			return;
		}
		a.phase = 'ci';
		a.deadline = Date.now() + maxCIDurationMs(this.env) + CI_TIMEOUT_BUFFER_MS;
		await this.save(a, a.deadline);
	}

	private async runFastForwardDispatch(a: ActiveAttempt): Promise<void> {
		if (!a.resultSha || !a.baseSha) {
			await this.fail(a, 'Merge result or base SHA missing');
			return;
		}
		a.tries++;
		await this.ctx.storage.put('active', a);

		const res = await executeFastForward(this.env, this.targetOf(a), {
			attemptId: a.attemptId,
			resultBranch: a.resultBranch,
			resultSha: a.resultSha,
			baseSha: a.baseSha,
		});
		if (!this.isCurrent(a, 'ff-dispatch')) return;

		if (!res.ok) {
			if ('baseMoved' in res && res.baseMoved) {
				await this.restartOrFail(a, res.error);
				return;
			}
			await this.retryOrFail(a, res.error, res.transient);
			return;
		}
		a.tries = 0;
		if (res.alreadyDone) {
			a.phase = 'complete';
			await this.save(a, Date.now());
			return;
		}
		a.phase = 'ff';
		a.deadline = Date.now() + RUNNER_OP_TIMEOUT_MS;
		await this.save(a, a.deadline);
	}

	private async runComplete(a: ActiveAttempt): Promise<void> {
		// Clear state first: completion side effects must never run twice.
		if (!(await this.endAttempt(a))) return;
		const resultSha = a.resultSha!;
		await completeMerge(this.env, this.targetOf(a), {
			attemptId: a.attemptId,
			resultSha,
			baseSha: a.baseSha!,
			ciRunId: a.ciRunId ?? null,
			enqueuedBy: a.entry.enqueuedBy,
		});
	}

	private async timeout(a: ActiveAttempt): Promise<void> {
		// The fast-forward may have landed even though its callback was lost.
		if (a.phase === 'ff' && a.resultSha) {
			try {
				const refs = await getArtifactRefs(this.env, this.targetOf(a).repoName);
				if (!this.isCurrent(a, 'ff')) return;
				if (refs.get(`refs/heads/${this.targetOf(a).baseBranch}`) === a.resultSha) {
					a.phase = 'complete';
					await this.save(a, Date.now());
					return;
				}
			} catch (err) {
				console.warn(`merge-queue: could not check base tip after fast-forward timeout: ${String(err)}`);
			}
		}
		const ciRunId = a.phase === 'ci' ? a.ciRunId : null;
		const minutes = Math.round((Date.now() - a.startedAt) / 60_000);
		await this.fail(a, `Merge timed out during ${PHASE_LABEL[a.phase]} (after ${minutes} min)`);
		if (ciRunId) await cancelMergeCI(this.env, ciRunId);
	}

	// ─── Callbacks ─────────────────────────────────────────────────

	/** Runner merge / fast-forward result (via /api/internal/merge/callback). */
	private async handleRunnerResult(body: RunnerResultBody): Promise<Record<string, unknown>> {
		const a = this.active;
		if (!a || a.attemptId !== body.attemptId || a.entry.ticketId !== body.ticketId) {
			return { ok: true, ignored: true, reason: 'stale attempt' };
		}

		if (body.op === 'merge') {
			if (a.phase !== 'dispatch' && a.phase !== 'merging') return { ok: true, ignored: true, reason: `phase is ${a.phase}` };
			if (!body.success) {
				const conflicts = body.conflicts?.length ? body.conflicts : undefined;
				const error = body.error || (conflicts ? `Rebase conflicts in: ${conflicts.join(', ')}` : 'Merge failed');
				await this.fail(a, error, conflicts ? { conflicts } : undefined);
				return { ok: true };
			}
			a.resultSha = body.resultSha;
			a.baseSha = body.baseSha;
			a.phase = 'ci-dispatch';
			a.tries = 0;
			await this.save(a, Date.now());
			return { ok: true };
		}

		if (a.phase !== 'ff-dispatch' && a.phase !== 'ff') return { ok: true, ignored: true, reason: `phase is ${a.phase}` };
		if (!body.success) {
			if (body.baseMoved) await this.restartOrFail(a, body.error || 'Base branch moved');
			else await this.fail(a, body.error || 'Fast-forward failed');
			return { ok: true };
		}
		a.phase = 'complete';
		await this.save(a, Date.now());
		return { ok: true };
	}

	/** CI result for a merge-queue run (via internal-ci.ts / ci-consumer.ts). */
	private async handleCIResult(body: { runId: string; status: string }): Promise<Record<string, unknown>> {
		const a = this.active;
		if (!a || (a.phase !== 'ci' && a.phase !== 'ci-dispatch') || !a.ciRunId || a.ciRunId !== body.runId) {
			return { ok: true, ignored: true };
		}
		if (body.status === 'passed') {
			a.phase = 'ff-dispatch';
			a.tries = 0;
			await this.save(a, Date.now());
			return { ok: true };
		}
		await this.fail(a, `CI ${body.status} on merge result (run ${body.runId})`, { ciRunId: body.runId });
		return { ok: true };
	}

	// ─── Status ────────────────────────────────────────────────────

	private status() {
		const a = this.active;
		return {
			queue: this.queue.map((e, i) => ({
				position: i + 1,
				ticketId: e.ticketId,
				agentId: e.agentId,
				branch: e.branch,
				baseBranch: e.baseBranch,
				commitSha: e.commitSha,
				priority: e.priority,
				enqueuedAt: new Date(e.enqueuedAt).toISOString(),
			})),
			processing: a?.entry.ticketId ?? null,
			active: a
				? {
						ticketId: a.entry.ticketId,
						attemptId: a.attemptId,
						phase: a.phase,
						branch: a.entry.branch,
						baseBranch: a.entry.baseBranch,
						commitSha: a.entry.commitSha,
						resultSha: a.resultSha ?? null,
						ciRunId: a.ciRunId ?? null,
						restarts: a.restarts,
						startedAt: new Date(a.startedAt).toISOString(),
						deadline: a.deadline ? new Date(a.deadline).toISOString() : null,
					}
				: null,
			total: this.queue.length,
		};
	}

}
