/**
 * Internal runner → Worker callbacks. Authenticated by RUNNER_SECRET (fails
 * closed when unset), not user auth.
 *
 *   /api/internal/ci/callback       final CI result (per-step status + full logs)
 *   /api/internal/ci/logs           incremental progress while a run executes
 *   /api/internal/deploy/callback   deployment progress/result  (deployCallbackApp)
 *
 * Protocol: see src/lib/runner-protocol.ts. A request without the protocol
 * header comes from a v1 runner and is accepted in the legacy shape.
 */
import { Hono, type Context } from 'hono';
import type { Env } from '../env.ts';
import { requireRunnerSecret } from '../middleware/runner-auth.ts';
import { parseStepLogs, storeStepLogs, tailLines, type LogLine } from '../lib/ci-logs.ts';
import { enqueueDeploysForRun } from '../lib/deploy-targets.ts';
import { notifyMergeQueueCI } from './internal-merge.ts';
import {
	RUNNER_PROTOCOL_HEADER,
	RUNNER_PROTOCOL_VERSION,
	type RunnerCICallback,
	type RunnerCILogsUpdate,
	type RunnerDeployCallback,
	type RunnerStepReport,
} from '../lib/runner-protocol.ts';

type StepRow = {
	id: string;
	step_index: number;
	global_ordinal: number | null;
	name: string | null;
	command: string;
	status: string;
	started_at: string | null;
};

type RunRow = {
	id: string;
	repo_id: string;
	branch: string;
	commit_sha: string;
	status: string;
	started_at: string | null;
	created_at: string;
	trigger: string;
};

const TERMINAL_STEP_STATUSES = new Set(['passed', 'failed', 'skipped', 'cancelled']);
const STEP_STATUSES = new Set(['pending', 'running', 'passed', 'failed', 'skipped', 'cancelled']);

/**
 * Returns the protocol version of the caller: the header value, or 1 when the
 * header is absent (legacy runner). Responds 426 on an unknown version.
 */
function checkProtocol(c: Context<{ Bindings: Env }>): { version: number } | { error: Response } {
	const raw = c.req.header(RUNNER_PROTOCOL_HEADER);
	if (raw === undefined) return { version: 1 };
	const version = Number(raw);
	if (version !== RUNNER_PROTOCOL_VERSION) {
		return {
			error: c.json({ error: 'Runner protocol mismatch', expected: RUNNER_PROTOCOL_VERSION, got: raw }, 426),
		};
	}
	return { version };
}

/** Normalise a reported step's output into LogLine[] (v2 `logs`, or v1 `stdout`/`stderr`). */
function reportLines(step: RunnerStepReport): LogLine[] {
	if (Array.isArray(step.logs)) return parseStepLogs(step.logs);
	const lines: LogLine[] = [];
	for (const stream of ['stdout', 'stderr'] as const) {
		const raw = step[stream];
		if (typeof raw !== 'string' || !raw) continue;
		for (const line of raw.split('\n')) {
			if (line) lines.push({ timestamp: '', stream, line });
		}
	}
	return lines;
}

function normaliseStepStatus(status: unknown): string | null {
	if (status === 'success') return 'passed';
	return typeof status === 'string' && STEP_STATUSES.has(status) ? status : null;
}

/**
 * Match reported steps to ci_steps rows: by echoed id (v2), else by ordinal,
 * else by position (v1 runners report steps in dispatch order without ids).
 */
function matchSteps(rows: StepRow[], reports: RunnerStepReport[]): Array<{ row: StepRow; report: RunnerStepReport }> {
	const byId = new Map(rows.map((r) => [r.id, r]));
	const ordered = [...rows].sort((a, b) => (a.global_ordinal ?? a.step_index) - (b.global_ordinal ?? b.step_index));
	const byOrdinal = new Map(ordered.map((r, i) => [r.global_ordinal ?? i, r]));
	const used = new Set<string>();
	const pairs: Array<{ row: StepRow; report: RunnerStepReport }> = [];

	reports.forEach((report, position) => {
		let row: StepRow | undefined;
		if (typeof report.id === 'string') row = byId.get(report.id);
		else if (typeof report.ordinal === 'number') row = byOrdinal.get(report.ordinal);
		else row = ordered[position];
		if (!row || used.has(row.id)) return;
		used.add(row.id);
		pairs.push({ row, report });
	});
	return pairs;
}

function durationBetween(start: string | null | undefined, end: string): number | null {
	if (!start) return null;
	const ms = new Date(end).getTime() - new Date(start).getTime();
	return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

// ─── CI callbacks (/api/internal/ci) ────────────────────────────

const app = new Hono<{ Bindings: Env }>();
app.use('*', requireRunnerSecret);

/**
 * Final CI result.
 *
 * - Accepts `passed` and `success` (v1) as success.
 * - Per-step: full log → R2, tail → ci_steps.logs; status only moves forward
 *   from pending/running (meta.changes tells us whether we won).
 * - The run row only moves from queued/running, so a `cancelled` (or already
 *   finalised) run is never overwritten — and never deploys.
 * - On a pass, matching deploy targets are enqueued exactly once.
 * - `merge_queue` runs (CI gate on a merge-queue result branch) never deploy:
 *   the outcome is forwarded to the repo's TicketQueue DO, which
 *   fast-forwards the base branch and fans out deploys for it.
 */
app.post('/callback', async (c) => {
	const protocol = checkProtocol(c);
	if ('error' in protocol) return protocol.error;

	let body: RunnerCICallback;
	try {
		body = await c.req.json<RunnerCICallback>();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}
	if (!body || typeof body.runId !== 'string') return c.json({ error: 'runId is required' }, 400);

	const { DB, STORAGE } = c.env;
	const run = await DB.prepare('SELECT id, repo_id, branch, commit_sha, status, started_at, created_at, trigger FROM ci_runs WHERE id = ?')
		.bind(body.runId)
		.first<RunRow>();
	if (!run) return c.json({ error: 'Run not found' }, 404);

	const finalStatus = body.status === 'success' || body.status === 'passed' ? 'passed' : body.status === 'cancelled' ? 'cancelled' : 'failed';
	const now = new Date().toISOString();

	// ── Per-step results ──
	const { results: stepRows } = await DB.prepare(
		'SELECT id, step_index, global_ordinal, name, command, status, started_at FROM ci_steps WHERE run_id = ?'
	)
		.bind(run.id)
		.all<StepRow>();

	const reports = Array.isArray(body.steps) ? body.steps : [];
	let stepsUpdated = 0;
	for (const { row, report } of matchSteps(stepRows, reports)) {
		let status = normaliseStepStatus(report.status) ?? 'failed';
		if (!TERMINAL_STEP_STATUSES.has(status)) status = finalStatus === 'passed' ? 'passed' : 'failed';
		const finishedAt = report.finished_at || now;
		const startedAt = report.started_at || row.started_at;
		const exitCode = typeof report.exit_code === 'number' ? report.exit_code : status === 'passed' ? 0 : null;
		const durationMs = typeof report.duration_ms === 'number' ? report.duration_ms : durationBetween(startedAt, finishedAt);

		const updated = await DB.prepare(
			`UPDATE ci_steps
			 SET status = ?, exit_code = ?, duration_ms = ?, started_at = COALESCE(started_at, ?), finished_at = ?
			 WHERE id = ? AND run_id = ? AND status IN ('pending', 'running')`
		)
			.bind(status, exitCode, durationMs, startedAt, finishedAt, row.id, run.id)
			.run();
		if (updated.meta.changes) stepsUpdated++;

		// Store logs even if the status was already final (e.g. the run was
		// cancelled and the steps marked) — the output is still worth keeping.
		const lines = reportLines(report);
		if (lines.length > 0 || updated.meta.changes) {
			await storeStepLogs(STORAGE, DB, { id: row.id, runId: run.id, ordinal: row.global_ordinal ?? row.step_index }, lines);
		}
	}

	// Anything the runner didn't report never ran; anything left "running"
	// takes the run's outcome (v1 runners reported no per-step results for
	// their single deploy step).
	await DB.prepare("UPDATE ci_steps SET status = 'skipped', finished_at = ? WHERE run_id = ? AND status = 'pending'")
		.bind(now, run.id)
		.run();
	await DB.prepare("UPDATE ci_steps SET status = ?, finished_at = ? WHERE run_id = ? AND status = 'running'")
		.bind(finalStatus, now, run.id)
		.run();

	// ── Run status (never overwrites cancelled / already-final runs) ──
	const runDuration = typeof body.durationMs === 'number' ? body.durationMs : durationBetween(run.started_at || run.created_at, now);
	const runUpdate = await DB.prepare(
		"UPDATE ci_runs SET status = ?, finished_at = ?, duration_ms = ? WHERE id = ? AND status IN ('queued', 'running')"
	)
		.bind(finalStatus, now, runDuration, run.id)
		.run();

	if (!runUpdate.meta.changes) {
		// Cancelled while running, or a duplicate callback. Logs were stored.
		// A merge-queue run still reports its (already final) outcome so the
		// queue doesn't wait for its timeout; the DO ignores duplicates.
		if (run.trigger === 'merge_queue' && !['queued', 'running'].includes(run.status)) {
			await notifyMergeQueueCI(c.env, run, run.status);
		}
		return c.json({ ok: true, ignored: true, runStatus: run.status, stepsUpdated });
	}

	// ── Merge-queue gate (B4.3): the TicketQueue fast-forwards the base
	// branch on a pass and fans out deploys for it — never for the result branch.
	if (run.trigger === 'merge_queue') {
		await notifyMergeQueueCI(c.env, run, finalStatus);
		return c.json({ ok: true, status: finalStatus, stepsUpdated, deployments: [] });
	}

	// ── Deploy fan-out ──
	let deployments: string[] = [];
	if (finalStatus === 'passed') {
		const repo = await DB.prepare('SELECT name FROM repositories WHERE id = ?').bind(run.repo_id).first<{ name: string }>();
		if (repo) {
			deployments = await enqueueDeploysForRun(c.env, run, repo.name);
		}
	}

	return c.json({ ok: true, status: finalStatus, stepsUpdated, deployments });
});

/**
 * Incremental progress (v2 runners, every few seconds while a run executes).
 * Each step report carries its current status and the latest tail of output.
 * Full logs are only written to R2 by the final callback.
 *
 * The response tells the runner whether the run has been cancelled — a
 * backup channel in case the direct cancel webhook didn't reach it.
 */
app.post('/logs', async (c) => {
	const protocol = checkProtocol(c);
	if ('error' in protocol) return protocol.error;

	let body: RunnerCILogsUpdate;
	try {
		body = await c.req.json<RunnerCILogsUpdate>();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}
	if (!body || typeof body.runId !== 'string' || !Array.isArray(body.steps)) {
		return c.json({ error: 'runId and steps are required' }, 400);
	}

	const { DB } = c.env;
	const run = await DB.prepare('SELECT id, status FROM ci_runs WHERE id = ?').bind(body.runId).first<{ id: string; status: string }>();
	if (!run) return c.json({ error: 'Run not found' }, 404);
	if (run.status !== 'running') {
		return c.json({ ok: true, cancelled: run.status === 'cancelled', runStatus: run.status });
	}

	const now = new Date().toISOString();
	const statements: D1PreparedStatement[] = [];
	for (const step of body.steps) {
		if (typeof step.id !== 'string') continue;
		const status = normaliseStepStatus(step.status);
		if (!status || status === 'pending') continue;
		const tail = JSON.stringify(tailLines(reportLines(step)));
		const terminal = TERMINAL_STEP_STATUSES.has(status);
		statements.push(
			DB.prepare(
				`UPDATE ci_steps
				 SET status = ?, logs = ?, started_at = COALESCE(started_at, ?),
				     exit_code = COALESCE(?, exit_code), duration_ms = COALESCE(?, duration_ms),
				     finished_at = CASE WHEN ? THEN COALESCE(?, finished_at) ELSE finished_at END
				 WHERE id = ? AND run_id = ? AND status IN ('pending', 'running')`
			).bind(
				status,
				tail,
				step.started_at || now,
				terminal && typeof step.exit_code === 'number' ? step.exit_code : null,
				terminal && typeof step.duration_ms === 'number' ? step.duration_ms : null,
				terminal ? 1 : 0,
				terminal ? step.finished_at || now : null,
				step.id,
				run.id
			)
		);
	}
	if (statements.length > 0) await DB.batch(statements);

	return c.json({ ok: true, cancelled: false });
});

export default app;

// ─── Deploy callback (/api/internal/deploy) ─────────────────────

export const deployCallbackApp = new Hono<{ Bindings: Env }>();
deployCallbackApp.use('*', requireRunnerSecret);

/**
 * Deployment progress/result from the runner.
 *   running → records the Coolify deployment UUID (status stays 'running')
 *   success | failed → final; only applied while queued/running
 */
deployCallbackApp.post('/callback', async (c) => {
	const protocol = checkProtocol(c);
	if ('error' in protocol) return protocol.error;

	let body: RunnerDeployCallback;
	try {
		body = await c.req.json<RunnerDeployCallback>();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}
	if (!body || typeof body.deploymentId !== 'string') return c.json({ error: 'deploymentId is required' }, 400);
	if (!['running', 'success', 'failed'].includes(body.status)) return c.json({ error: 'Invalid status' }, 400);

	const { DB } = c.env;
	const deployment = await DB.prepare('SELECT id, status FROM deployments WHERE id = ?')
		.bind(body.deploymentId)
		.first<{ id: string; status: string }>();
	if (!deployment) return c.json({ error: 'Deployment not found' }, 404);

	const coolifyId = typeof body.coolifyDeploymentId === 'string' && body.coolifyDeploymentId ? body.coolifyDeploymentId : null;
	const error = typeof body.error === 'string' ? body.error.slice(0, 2000) : null;

	if (body.status === 'running') {
		await DB.prepare(
			`UPDATE deployments SET coolify_deployment_id = COALESCE(?, coolify_deployment_id)
			 WHERE id = ? AND status IN ('queued', 'pending', 'running')`
		)
			.bind(coolifyId, deployment.id)
			.run();
		return c.json({ ok: true });
	}

	const result = await DB.prepare(
		`UPDATE deployments
		 SET status = ?, finished_at = ?, error_message = ?, coolify_deployment_id = COALESCE(?, coolify_deployment_id)
		 WHERE id = ? AND status IN ('queued', 'pending', 'running')`
	)
		.bind(body.status, new Date().toISOString(), body.status === 'failed' ? error || 'Deployment failed' : null, coolifyId, deployment.id)
		.run();

	return c.json({ ok: true, ignored: !result.meta.changes });
});
