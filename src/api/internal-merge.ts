/**
 * Merge queue execution (B4.3) + the runner's merge callback.
 *
 * The TicketQueue Durable Object (src/do/ticket-queue.ts) owns the queue and
 * drives each attempt from its alarm handler through these steps:
 *
 *   1. executeMerge        verify the ticket + branch tip, mint a 300 s write
 *                          token, dispatch `op: merge` to the runner
 *   2. runner callback     rebased result pushed to `gitflare/merge-queue/<ticket>`
 *   3. enqueueMergeCI      CI on the result branch (trigger `merge_queue`)
 *   4. CI callback         internal-ci.ts notifies the DO
 *   5. executeFastForward  FRESH write token, `op: fast-forward` base → result
 *   6. runner callback     completeMerge: D1, audit, mirror, deploys
 *
 * Merges push directly to Artifacts with an Artifacts token — NOT through
 * git.ts — so branch protection on the base branch does not block the merge
 * queue. Do not route merges through git.ts.
 *
 * Mounted at /api/internal/merge, authenticated by RUNNER_SECRET (fails
 * closed when unset), not user auth.
 */
import { Hono } from 'hono';
import type { CIPipelineConfig, Env } from '../env.ts';
import { getArtifactsRemoteUrl } from '../lib/artifacts-url.ts';
import { CI_CONFIG_PATH, getArtifactRefs } from '../lib/artifact-reader.ts';
import { audit } from '../lib/audit.ts';
import { parseCIConfig } from '../lib/ci-parser.ts';
import { enqueueDeploysForRun, isFullSha } from '../lib/deploy-targets.ts';
import { triggerGitHubMirror } from '../lib/github-mirror.ts';
import { isValidRefName } from '../lib/repo-validation.ts';
import { cancelRunnerRun, dispatchMerge, mergeCallbackUrl, mintToken } from '../lib/runner-client.ts';
import {
	RUNNER_PROTOCOL_HEADER,
	RUNNER_PROTOCOL_VERSION,
	type RunnerMergeCallback,
	type RunnerMergeRequest,
} from '../lib/runner-protocol.ts';
import { requireRunnerSecret } from '../middleware/runner-auth.ts';
import { acquirePushLock, releasePushLock } from '../lib/push-lock.ts';
import { buildReceivePackRequest } from '../lib/git-objects.ts';
import { parseReceivePackResponse } from '../lib/git-protocol.ts';
import { selectCompute } from '../lib/compute-router.ts';
import { dispatchGitHubMerge, ensureCIMirror, type ComputeConnection } from '../lib/github-ci.ts';
import type { GithubMergeAttempt } from './internal-github.ts';

// ─── Constants ──────────────────────────────────────────────────

/** Artifacts write-token lifetime for each runner git operation. */
export const MERGE_TOKEN_TTL_S = 300;
/** Runner budget for one git op — it must push while the token is still valid. */
export const MERGE_OP_DEADLINE_MS = (MERGE_TOKEN_TTL_S - 20) * 1000;
/** Audit actor for actions the queue performs on its own. */
export const MERGE_QUEUE_ACTOR = 'system:merge-queue';

export function resultBranchFor(ticketId: string): string {
	return `gitflare/merge-queue/${ticketId}`;
}

export function ticketQueueStub(env: Env, repoId: string): DurableObjectStub {
	return env.TICKET_QUEUE.get(env.TICKET_QUEUE.idFromName(repoId));
}

// ─── Types ──────────────────────────────────────────────────────

/** Everything later phases need, resolved from D1 at dispatch time. */
export interface MergeTarget {
	ticketId: string;
	repoId: string;
	repoName: string;
	branch: string;
	baseBranch: string;
	commitSha: string;
}

export type StepFailure = {
	ok: false;
	/** Worth retrying (runner down, Artifacts hiccup). */
	transient: boolean;
	error: string;
	/** The ticket is no longer awaiting merge (cancelled / deleted) — drop silently. */
	abandoned?: boolean;
};

type TicketRow = {
	id: string;
	repo_id: string;
	branch: string;
	base_branch: string;
	status: string;
	repo_name: string;
	owner_id: string | null;
	is_private: number;
};

// ─── Helpers ────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function committerIdentity(env: Env): { name: string; email: string } {
	let host = 'gitflare.invalid';
	try {
		if (env.APP_URL) host = new URL(env.APP_URL).hostname || host;
	} catch {
		// keep default
	}
	return { name: 'GitFlare Merge Queue', email: `merge-queue@${host}` };
}

async function logQueue(env: Env, repoId: string, ticketId: string, action: string, details: Record<string, unknown>): Promise<void> {
	try {
		await env.DB.prepare(
			'INSERT INTO merge_queue_log (id, repo_id, ticket_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)'
		)
			.bind(crypto.randomUUID(), repoId, ticketId, action, JSON.stringify(details), new Date().toISOString())
			.run();
	} catch (err) {
		console.error(`merge_queue_log ${action} for ${ticketId} failed:`, errorMessage(err));
	}
}

/**
 * Read the CI config at `ref`. Unlike getArtifactFileContent this THROWS on
 * read errors: a transient failure must not be mistaken for "no CI config"
 * (which would skip the CI gate).
 */
async function readCIConfig(env: Env, repoName: string, ref: string): Promise<string | null> {
	const repo = await env.REPOS.get(repoName);
	if (!repo) throw new Error(`Repository "${repoName}" not found in Artifacts`);
	const file = await repo.readFile({ ref, path: CI_CONFIG_PATH });
	return file ? await file.text() : null;
}

// ─── 1. Merge (rebase onto base, push result branch) ────────────

/**
 * Start a merge attempt: verify the ticket is still awaiting merge and that
 * the agent's branch tip is exactly the queued `commitSha`, mark the ticket
 * `merging`, then dispatch the rebase to the runner with a 300 s write token.
 */
export async function executeMerge(
	env: Env,
	params: { ticketId: string; commitSha: string; attemptId: string }
): Promise<({ ok: true } & { target: MergeTarget }) | StepFailure> {
	const { DB } = env;
	const ticket = await DB.prepare(
		`SELECT t.id, t.repo_id, t.branch, t.base_branch, t.status, r.name AS repo_name, r.owner_id, r.is_private
		 FROM tickets t JOIN repositories r ON r.id = t.repo_id WHERE t.id = ?`
	)
		.bind(params.ticketId)
		.first<TicketRow>();
	if (!ticket) return { ok: false, transient: false, abandoned: true, error: 'Ticket no longer exists' };
	if (ticket.status !== 'review' && ticket.status !== 'merging') {
		return { ok: false, transient: false, abandoned: true, error: `Ticket is '${ticket.status}', not awaiting merge` };
	}
	if (!isValidRefName(ticket.branch) || !isValidRefName(ticket.base_branch)) {
		return { ok: false, transient: false, error: 'Ticket has an invalid branch name' };
	}
	if (!isFullSha(params.commitSha)) {
		return { ok: false, transient: false, error: 'Queued commit SHA is not a full 40-character SHA' };
	}

	const target: MergeTarget = {
		ticketId: ticket.id,
		repoId: ticket.repo_id,
		repoName: ticket.repo_name,
		branch: ticket.branch,
		baseBranch: ticket.base_branch,
		commitSha: params.commitSha,
	};

	// The agent's branch must still point at the commit that was reviewed.
	let refs: Map<string, string>;
	try {
		refs = await getArtifactRefs(env, target.repoName);
	} catch (err) {
		return { ok: false, transient: true, error: `Could not read refs: ${errorMessage(err)}` };
	}
	const tip = refs.get(`refs/heads/${target.branch}`);
	if (!tip) return { ok: false, transient: false, error: `Branch '${target.branch}' does not exist` };
	if (tip !== target.commitSha) {
		return {
			ok: false,
			transient: false,
			error: `Branch '${target.branch}' moved: tip is ${tip.slice(0, 12)} but ${target.commitSha.slice(0, 12)} was queued. Set the ticket back to review with the new commit_sha.`,
		};
	}
	if (!refs.has(`refs/heads/${target.baseBranch}`)) {
		return { ok: false, transient: false, error: `Base branch '${target.baseBranch}' does not exist` };
	}

	const now = new Date().toISOString();
	const claim = await DB.prepare(
		"UPDATE tickets SET status = 'merging', updated_at = ? WHERE id = ? AND status IN ('review', 'merging')"
	)
		.bind(now, target.ticketId)
		.run();
	if (!claim.meta.changes) {
		return { ok: false, transient: false, abandoned: true, error: 'Ticket was cancelled before the merge started' };
	}
	let config: CIPipelineConfig | null = null;
	try {
		const yaml = await readCIConfig(env, target.repoName, target.branch);
		if (yaml) config = parseCIConfig(yaml);
	} catch (err) { return { ok: false, transient: false, error: `Could not select merge compute: ${errorMessage(err)}` }; }
	if (config) {
		const { results: connections } = ticket.owner_id ? await DB.prepare('SELECT * FROM github_compute_connections WHERE user_id = ? ORDER BY created_at ASC')
			.bind(ticket.owner_id).all<ComputeConnection>() : { results: [] as ComputeConnection[] };
		let choice;
		try { choice = selectCompute(config, connections, Boolean(ticket.is_private)); }
		catch (err) { return { ok: false, transient: false, error: errorMessage(err) }; }
		if (choice.backend !== 'runner' && choice.connection) {
			const connection = choice.connection;
			let prepared;
			try { prepared = await ensureCIMirror(env, { id: target.repoId, name: target.repoName, is_private: ticket.is_private }, connection); }
			catch (err) { return { ok: false, transient: true, error: `GitHub CI mirror unavailable: ${errorMessage(err)}` }; }
			const attempt: GithubMergeAttempt = { ticketId: target.ticketId, repoId: target.repoId, repoName: target.repoName,
				connectionId: connection.id, fullName: prepared.fullName, workflowSha: prepared.workflowSha,
				branch: target.branch, headSha: target.commitSha, baseSha: refs.get(`refs/heads/${target.baseBranch}`)!, baseBranch: target.baseBranch };
			await DB.prepare('INSERT OR IGNORE INTO github_merge_run_bindings (attempt_id) VALUES (?)').bind(params.attemptId).run();
			await env.CACHE.put(`github-merge:${params.attemptId}`, JSON.stringify(attempt), { expirationTtl: 3600 });
			try {
				await dispatchGitHubMerge(env, { id: target.repoId, name: target.repoName, is_private: ticket.is_private }, connection,
					params.attemptId, target.branch, target.commitSha, target.baseBranch, attempt.baseSha, choice.backend === 'blacksmith', prepared);
				await logQueue(env, target.repoId, target.ticketId, 'merge_start', { attemptId: params.attemptId, backend: choice.backend });
				return { ok: true, target };
			} catch (err) {
				await env.CACHE.delete(`github-merge:${params.attemptId}`);
				return { ok: false, transient: true, error: `GitHub merge dispatch failed: ${errorMessage(err)}` };
			}
		}
	}

	let token: string;
	try {
		token = await mintToken(env, target.repoName, 'write', MERGE_TOKEN_TTL_S);
	} catch (err) {
		return { ok: false, transient: true, error: `Could not mint write token: ${errorMessage(err)}` };
	}

	const request: RunnerMergeRequest = {
		protocolVersion: RUNNER_PROTOCOL_VERSION,
		op: 'merge',
		ticketId: target.ticketId,
		attemptId: params.attemptId,
		repoName: target.repoName,
		repoUrl: getArtifactsRemoteUrl(env, target.repoName),
		token,
		branch: target.branch,
		commitSha: target.commitSha,
		baseBranch: target.baseBranch,
		resultBranch: resultBranchFor(target.ticketId),
		committer: committerIdentity(env),
		callbackUrl: mergeCallbackUrl(env),
		deadlineMs: MERGE_OP_DEADLINE_MS,
	};
	const result = await dispatchMerge(env, request);
	if (!result.ok) {
		// 404: a runner without /webhook/merge (mid lockstep deploy) — retry.
		return { ok: false, transient: result.transient || result.status === 404, error: result.error };
	}

	await logQueue(env, target.repoId, target.ticketId, 'merge_start', {
		attemptId: params.attemptId,
		branch: target.branch,
		baseBranch: target.baseBranch,
		commitSha: target.commitSha,
	});
	return { ok: true, target };
}

// ─── 3. CI gate on the result branch ────────────────────────────

/**
 * Enqueue CI for the merge result as run `result.runId` (chosen by the DO and
 * persisted BEFORE this call, so a CI result that arrives while we are still
 * awaiting can be matched). `runId: null` means the result has no CI config,
 * so there is nothing to gate on.
 */
export async function enqueueMergeCI(
	env: Env,
	target: MergeTarget,
	result: { runId: string; resultBranch: string; resultSha: string }
): Promise<{ ok: true; runId: string | null } | StepFailure> {
	let yaml: string | null;
	try {
		yaml = await readCIConfig(env, target.repoName, result.resultBranch);
	} catch (err) {
		return { ok: false, transient: true, error: `Could not read ${CI_CONFIG_PATH}: ${errorMessage(err)}` };
	}
	if (!yaml) return { ok: true, runId: null };

	let config: CIPipelineConfig;
	try {
		config = parseCIConfig(yaml);
	} catch (err) {
		return { ok: false, transient: false, error: `Invalid ${CI_CONFIG_PATH} in merge result: ${errorMessage(err)}` };
	}

	// The merge queue gate runs regardless of `on.push` filters.
	const runId = result.runId;
	await env.DB.prepare(
		"INSERT INTO ci_runs (id, repo_id, branch, commit_sha, status, trigger, created_at) VALUES (?, ?, ?, ?, 'queued', 'merge_queue', ?)"
	)
		.bind(runId, target.repoId, result.resultBranch, result.resultSha, new Date().toISOString())
		.run();
	try {
		await env.CI_QUEUE.send({
			runId,
			repoId: target.repoId,
			repoName: target.repoName,
			branch: result.resultBranch,
			commitSha: result.resultSha,
			config,
			trigger: 'merge_queue',
		});
	} catch (err) {
		await env.DB.prepare("UPDATE ci_runs SET status = 'failed', finished_at = ? WHERE id = ? AND status = 'queued'")
			.bind(new Date().toISOString(), runId)
			.run();
		return { ok: false, transient: true, error: `Could not enqueue CI: ${errorMessage(err)}` };
	}

	await logQueue(env, target.repoId, target.ticketId, 'ci_start', { runId, resultSha: result.resultSha });
	return { ok: true, runId };
}

/**
 * Tell the repo's TicketQueue that a merge-queue CI run finished. No-op for
 * other triggers. The DO ignores runs that aren't the active attempt's.
 * Never throws — the DO's CI timeout is the backstop.
 */
export async function notifyMergeQueueCI(
	env: Env,
	run: { id: string; repo_id: string; trigger: string },
	status: string
): Promise<void> {
	if (run.trigger !== 'merge_queue') return;
	try {
		const res = await ticketQueueStub(env, run.repo_id).fetch(
			new Request('https://do/ci-result', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ runId: run.id, status }),
			})
		);
		if (!res.ok) console.error(`merge-queue: CI result for run ${run.id} rejected: HTTP ${res.status}`);
	} catch (err) {
		console.error(`merge-queue: notifying CI result for run ${run.id} failed:`, errorMessage(err));
	}
}

/** Best-effort: stop a merge-queue CI run that no longer matters (timeout / cancel). */
export async function cancelMergeCI(env: Env, runId: string): Promise<void> {
	const now = new Date().toISOString();
	try {
		await env.DB.batch([
			env.DB.prepare("UPDATE ci_runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued', 'running')").bind(
				now,
				runId
			),
			env.DB.prepare("UPDATE ci_steps SET status = 'cancelled', finished_at = ? WHERE run_id = ? AND status IN ('pending', 'running')").bind(
				now,
				runId
			),
		]);
		const cancel = await cancelRunnerRun(env, runId);
		if (!cancel.ok) console.warn(`merge-queue: runner cancel for CI run ${runId} failed: ${cancel.error}`);
	} catch (err) {
		console.error(`merge-queue: cancelling CI run ${runId} failed:`, errorMessage(err));
	}
}

// ─── 5. Fast-forward the base branch ────────────────────────────

/**
 * After CI passes: mint a FRESH write token and have the runner move the base
 * branch to the result (non-force push — Artifacts rejects anything that is
 * not a fast-forward).
 */
export async function executeFastForward(
	env: Env,
	target: MergeTarget,
	params: { attemptId: string; resultBranch: string; resultSha: string; baseSha: string }
): Promise<{ ok: true; alreadyDone: boolean } | (StepFailure & { baseMoved?: boolean })> {
	let refs: Map<string, string>;
	try {
		refs = await getArtifactRefs(env, target.repoName);
	} catch (err) {
		return { ok: false, transient: true, error: `Could not read refs: ${errorMessage(err)}` };
	}
	const baseTip = refs.get(`refs/heads/${target.baseBranch}`);
	if (baseTip === params.resultSha) return { ok: true, alreadyDone: true };
	if (baseTip !== params.baseSha) {
		return {
			ok: false,
			transient: false,
			baseMoved: true,
			error: `Base branch '${target.baseBranch}' moved during CI (${params.baseSha.slice(0, 12)} → ${(baseTip ?? 'deleted').slice(0, 12)})`,
		};
	}
	if (await env.CACHE.get(`github-merge:${params.attemptId}`)) {
		const refName = `refs/heads/${target.baseBranch}`;
		const lock = await acquirePushLock(env, target.repoId, MERGE_QUEUE_ACTOR, [refName]);
		if ('error' in lock) return { ok: false, transient: true, error: lock.error };
		try {
			const current = await getArtifactRefs(env, target.repoName);
			if (current.get(refName) !== params.baseSha) return { ok: false, transient: false, baseMoved: true, error: 'Base branch moved during CI' };
			const token = await mintToken(env, target.repoName, 'write', MERGE_TOKEN_TTL_S);
			const body = await buildReceivePackRequest({ refName, oldSha: params.baseSha, newSha: params.resultSha, objects: [] });
			const response = await fetch(`${getArtifactsRemoteUrl(env, target.repoName)}/git-receive-pack`, {
				method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-git-receive-pack-request' }, body,
			});
			if (!response.ok) return { ok: false, transient: response.status >= 500, error: `Artifacts fast-forward failed (${response.status})` };
			const report = parseReceivePackResponse(new Uint8Array(await response.arrayBuffer()));
			if (!report?.unpackOk || !report.refResults.some((r) => r.refName === refName && r.success)) {
				return { ok: false, transient: true, error: 'Artifacts did not confirm the fast-forward' };
			}
			return { ok: true, alreadyDone: true };
		} catch (err) {
			return { ok: false, transient: true, error: `Worker fast-forward failed: ${errorMessage(err)}` };
		} finally {
			await releasePushLock(env, target.repoId, lock.lockId);
		}
	}

	let token: string;
	try {
		token = await mintToken(env, target.repoName, 'write', MERGE_TOKEN_TTL_S);
	} catch (err) {
		return { ok: false, transient: true, error: `Could not mint write token: ${errorMessage(err)}` };
	}

	const result = await dispatchMerge(env, {
		protocolVersion: RUNNER_PROTOCOL_VERSION,
		op: 'fast-forward',
		ticketId: target.ticketId,
		attemptId: params.attemptId,
		repoName: target.repoName,
		repoUrl: getArtifactsRemoteUrl(env, target.repoName),
		token,
		branch: target.branch,
		commitSha: target.commitSha,
		baseBranch: target.baseBranch,
		baseSha: params.baseSha,
		resultBranch: params.resultBranch,
		resultSha: params.resultSha,
		committer: committerIdentity(env),
		callbackUrl: mergeCallbackUrl(env),
		deadlineMs: MERGE_OP_DEADLINE_MS,
	});
	if (!result.ok) return { ok: false, transient: result.transient || result.status === 404, error: result.error };
	return { ok: true, alreadyDone: false };
}

// ─── 6. Outcomes ────────────────────────────────────────────────

/**
 * The base branch now points at the merge result: record it, audit it,
 * mirror the base branch and fan out deploys for
 * the CI run that gated it. Each side effect is independent and best-effort.
 */
export async function completeMerge(
	env: Env,
	target: MergeTarget,
	params: { attemptId: string; resultSha: string; baseSha: string; ciRunId: string | null; enqueuedBy: string | null }
): Promise<void> {
	const { DB } = env;
	const now = new Date().toISOString();
	const step = async (label: string, fn: () => Promise<unknown>) => {
		try {
			await fn();
		} catch (err) {
			console.error(`merge-queue: ${label} failed for ticket ${target.ticketId}:`, errorMessage(err));
		}
	};

	// Unconditional: the base branch really moved, whatever the ticket row says.
	await step('ticket update', () =>
		DB.prepare(
			"UPDATE tickets SET status = 'merged', merge_commit_sha = ?, last_error = NULL, completed_at = ?, updated_at = ? WHERE id = ?"
		)
			.bind(params.resultSha, now, now, target.ticketId)
			.run()
	);
	await logQueue(env, target.repoId, target.ticketId, 'merge_success', {
		attemptId: params.attemptId,
		mergeCommitSha: params.resultSha,
		baseSha: params.baseSha,
		ciRunId: params.ciRunId,
	});
	await step('audit', () =>
		audit(DB, {
			repoId: target.repoId,
			actor: MERGE_QUEUE_ACTOR,
			action: 'ticket.merge',
			details: {
				ticketId: target.ticketId,
				branch: target.branch,
				baseBranch: target.baseBranch,
				commitSha: target.commitSha,
				baseSha: params.baseSha,
				mergeCommitSha: params.resultSha,
				ciRunId: params.ciRunId,
				enqueuedBy: params.enqueuedBy,
			},
		})
	);
	// triggerGitHubMirror never throws (it audits its own failures).
	await triggerGitHubMirror(env, target.repoId, target.repoName, [target.baseBranch]);
	if (params.ciRunId) {
		const ciRunId = params.ciRunId;
		await step('deploy fan-out', () =>
			enqueueDeploysForRun(
				env,
				{ id: ciRunId, repo_id: target.repoId, branch: target.baseBranch, commit_sha: params.resultSha },
				target.repoName
			)
		);
	}
}

/**
 * Mark the ticket failed (only if it is still awaiting merge — never
 * overwrites `cancelled` or `merged`), log and audit the reason.
 */
export async function recordMergeFailure(
	env: Env,
	params: { ticketId: string; repoId?: string; attemptId: string; phase: string; error: string; details?: Record<string, unknown> }
): Promise<void> {
	const { DB } = env;
	const now = new Date().toISOString();
	const error = params.error.slice(0, 2000);
	let repoId = params.repoId;
	try {
		await DB.prepare("UPDATE tickets SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND status IN ('review', 'merging')")
			.bind(error, now, params.ticketId)
			.run();
		if (!repoId) {
			const row = await DB.prepare('SELECT repo_id FROM tickets WHERE id = ?').bind(params.ticketId).first<{ repo_id: string }>();
			repoId = row?.repo_id;
		}
	} catch (err) {
		console.error(`merge-queue: failing ticket ${params.ticketId} in D1 failed:`, errorMessage(err));
	}
	if (!repoId) return;

	const details = { attemptId: params.attemptId, phase: params.phase, error, ...params.details };
	await logQueue(env, repoId, params.ticketId, 'merge_fail', details);
	try {
		await audit(DB, { repoId, actor: MERGE_QUEUE_ACTOR, action: 'ticket.merge_failed', details: { ticketId: params.ticketId, ...details } });
	} catch (err) {
		console.error(`merge-queue: audit for ticket ${params.ticketId} failed:`, errorMessage(err));
	}
}

// ─── Runner callback (/api/internal/merge/callback) ─────────────

const app = new Hono<{ Bindings: Env }>();

app.use('*', requireRunnerSecret);

/**
 * Result of a runner merge / fast-forward op. Forwarded to the repo's
 * TicketQueue DO, which ignores it unless `attemptId` is the attempt in
 * flight (late callbacks from timed-out or cancelled attempts are dropped).
 */
app.post('/callback', async (c) => {
	const version = c.req.header(RUNNER_PROTOCOL_HEADER);
	if (version !== undefined && Number(version) !== RUNNER_PROTOCOL_VERSION) {
		return c.json({ error: 'Runner protocol mismatch', expected: RUNNER_PROTOCOL_VERSION, got: version }, 426);
	}

	let body: RunnerMergeCallback;
	try {
		body = await c.req.json<RunnerMergeCallback>();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}
	if (
		!body ||
		typeof body.ticketId !== 'string' ||
		typeof body.attemptId !== 'string' ||
		(body.op !== 'merge' && body.op !== 'fast-forward') ||
		typeof body.success !== 'boolean'
	) {
		return c.json({ error: 'ticketId, attemptId, op and success are required' }, 400);
	}
	if (body.success && (!isFullSha(body.resultSha) || !isFullSha(body.baseSha))) {
		return c.json({ error: 'resultSha and baseSha must be full SHAs on success' }, 400);
	}

	const ticket = await c.env.DB.prepare('SELECT repo_id FROM tickets WHERE id = ?').bind(body.ticketId).first<{ repo_id: string }>();
	if (!ticket) return c.json({ ok: true, ignored: true, reason: 'ticket not found' });

	const res = await ticketQueueStub(c.env, ticket.repo_id).fetch(
		new Request('https://do/merge-result', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ticketId: body.ticketId,
				attemptId: body.attemptId,
				op: body.op,
				success: body.success,
				resultSha: body.resultSha,
				baseSha: body.baseSha,
				baseMoved: body.baseMoved === true,
				conflicts: Array.isArray(body.conflicts) ? body.conflicts.filter((p) => typeof p === 'string').slice(0, 100) : undefined,
				error: typeof body.error === 'string' ? body.error.slice(0, 2000) : undefined,
			}),
		})
	);
	if (!res.ok) return c.json({ error: 'Merge queue unavailable' }, 503);
	return c.json(await res.json());
});

export default app;
