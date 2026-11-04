/**
 * Worker ↔ Runner wire protocol (B1.7).
 *
 * The Worker and packages/runner deploy in lockstep. Every request in either
 * direction carries `X-GitFlare-Runner-Protocol: <version>`:
 *
 *   Worker → Runner   The runner rejects a mismatched/missing version with 426,
 *                     which the Worker treats as transient (retry via the
 *                     queue) — a rolling deploy converges within a retry or two.
 *   Runner → Worker   A mismatched version is rejected with 426. A MISSING
 *                     header means a v1 runner (pre-B1); its callbacks are
 *                     accepted in the legacy shape so runs in flight during the
 *                     cutover still complete.
 *
 * Bump RUNNER_PROTOCOL_VERSION here AND in packages/runner/src/protocol.ts
 * together whenever a payload shape changes incompatibly.
 */
import type { LogLine } from './ci-logs.ts';

export const RUNNER_PROTOCOL_VERSION = 2;
export const RUNNER_PROTOCOL_HEADER = 'X-GitFlare-Runner-Protocol';

// ─── Worker → Runner ────────────────────────────────────────────

/** Read-only checkout credentials. The token is short-lived and never stored. */
export interface RunnerCheckout {
	url: string;
	token: string;
	branch: string;
	commitSha: string;
}

export interface RunnerCIStep {
	/** ci_steps.id — echoed back in logs/callback for matching. */
	id: string;
	/** ci_steps.global_ordinal — position across all jobs in the run. */
	ordinal: number;
	jobName: string;
	name: string;
	command: string;
	env?: Record<string, string>;
	/** Seconds */
	timeout?: number;
}

export interface RunnerCIRequest {
	protocolVersion: number;
	runId: string;
	repoName: string;
	checkout: RunnerCheckout;
	steps: RunnerCIStep[];
	/** Whole-run budget; the runner kills the job container when exceeded. */
	maxDurationMs: number;
	callbackUrl: string;
	logsUrl: string;
}

export interface RunnerDeployRequest {
	protocolVersion: number;
	deploymentId: string;
	ciRunId: string | null;
	type: 'coolify' | 'cloudflare';
	callbackUrl: string;
	/** Poll / execution deadline for the deploy. */
	deadlineMs: number;
	coolify?: { baseUrl: string; apiKey: string; appId: string };
	cloudflare?: { checkout: RunnerCheckout; repoName: string; wranglerConfig: string | null };
}

/**
 * Merge-queue git operation (B4.3). The runner runs git with argv arrays on a
 * scratch clone and pushes DIRECTLY to Artifacts with the short-lived write
 * token (never through the Worker's git.ts proxy).
 *
 *   merge         fetch base + agent branch, rebase `commitSha` onto the base
 *                 tip, force-push the result to `resultBranch`
 *   fast-forward  push `resultSha` to `baseBranch` (non-force: Artifacts
 *                 rejects it unless it is a fast-forward), then delete
 *                 `resultBranch` (best effort)
 */
export interface RunnerMergeRequest {
	protocolVersion: number;
	op: 'merge' | 'fast-forward';
	ticketId: string;
	/** Echoed back in the callback; stale attempts are ignored by the queue. */
	attemptId: string;
	repoName: string;
	repoUrl: string;
	/** Artifacts write token (300 s). Passed to git via env, never argv. */
	token: string;
	/** Agent branch (merge only). */
	branch: string;
	/** Verified agent commit to rebase (merge only). */
	commitSha: string;
	baseBranch: string;
	/** fast-forward: base tip the result was built on (lease). */
	baseSha?: string;
	resultBranch: string;
	/** fast-forward: commit to move `baseBranch` to. */
	resultSha?: string;
	committer: { name: string; email: string };
	callbackUrl: string;
	deadlineMs: number;
}

// ─── Runner → Worker ────────────────────────────────────────────

export interface RunnerMergeCallback {
	ticketId: string;
	attemptId: string;
	op: 'merge' | 'fast-forward';
	success: boolean;
	/** merge: rebased head pushed to resultBranch. fast-forward: new base tip. */
	resultSha?: string;
	/** Base tip the operation saw. */
	baseSha?: string;
	/** fast-forward only: the base branch moved since the merge was built. */
	baseMoved?: boolean;
	/** merge only: paths with conflicts. */
	conflicts?: string[];
	error?: string;
	durationMs?: number;
	/** Tail of git output (token-masked). */
	logs?: string[];
}

export type RunnerStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled';

export interface RunnerStepReport {
	id?: string;
	ordinal?: number;
	name?: string;
	command?: string;
	status: RunnerStepStatus;
	exit_code?: number | null;
	duration_ms?: number | null;
	started_at?: string | null;
	finished_at?: string | null;
	/** v2: structured lines. */
	logs?: LogLine[];
	/** v1 (legacy runner): raw output. */
	stdout?: string;
	stderr?: string;
}

export interface RunnerCICallback {
	runId: string;
	/** v1 runners send 'success'; v2 sends 'passed'. */
	status: 'passed' | 'success' | 'failed' | 'cancelled';
	steps?: RunnerStepReport[];
	error?: string;
	durationMs?: number;
}

export interface RunnerCILogsUpdate {
	runId: string;
	steps: RunnerStepReport[];
}

export interface RunnerDeployCallback {
	deploymentId: string;
	status: 'running' | 'success' | 'failed';
	coolifyDeploymentId?: string;
	error?: string;
	durationMs?: number;
	logs?: LogLine[];
}
