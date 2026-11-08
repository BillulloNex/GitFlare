/**
 * Scheduled maintenance (B1.6), run from the Worker's `scheduled()` handler.
 *
 *   - CI runs stuck in `running` longer than MAX_CI_DURATION_MS (+ grace) → failed,
 *     and the runner is asked to kill the container (best effort)
 *   - CI runs stuck in `queued` (message lost / dead-lettered) → failed
 *   - Deployments stuck in `running` / `queued` → failed
 *   - Expired sessions → deleted
 *   - LFS objects left `pending` for a day → promoted if the bytes are in R2, else purged
 *   - Diary uploads never attached to an entry for a day → bytes and rows deleted
 *
 * Timestamps are compared with julianday() because rows mix ISO-8601
 * (`2026-01-01T00:00:00.000Z`, written by the app) and SQLite's
 * `datetime('now')` format (column defaults), which don't sort as strings.
 */
import type { Env } from '../env.ts';
import { maxCIDurationMs, MAX_DEPLOY_DEADLINE_MS } from '../queue/ci-consumer.ts';
import { cancelRunnerRun } from './runner-client.ts';
import { cleanExpiredSessions } from './session.ts';
import { reconcileStalePendingLfs } from './lfs-storage.ts';
import { purgeOrphanDiaryMedia } from '../api/diary.ts';

/** Grace on top of the runner's own deadline so its final callback can land first. */
const RUNNING_GRACE_MS = 5 * 60 * 1000;
/** Queue retries with backoff finish well within this. */
const QUEUED_TIMEOUT_MS = 60 * 60 * 1000;
/** An LFS upload action is valid for minutes; a day later a pending row is either stored or abandoned. */
const LFS_PENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Container deploys clone + install + deploy; give them more than the largest runner deadline. */
const DEPLOY_RUNNING_TIMEOUT_MS = MAX_DEPLOY_DEADLINE_MS * 2 + RUNNING_GRACE_MS;

function cutoff(msAgo: number): string {
	return new Date(Date.now() - msAgo).toISOString();
}

export interface MaintenanceReport {
	stuckRuns: number;
	stuckQueuedRuns: number;
	stuckDeployments: number;
	expiredSessions: number;
	lfsPromoted: number;
	lfsPurged: number;
	diaryOrphansPurged: number;
}

async function failStuckRuns(env: Env): Promise<{ running: number; queued: number }> {
	const { DB } = env;
	const now = new Date().toISOString();

	const { results: running } = await DB.prepare(
		`SELECT id FROM ci_runs
		 WHERE status = 'running' AND julianday(COALESCE(started_at, created_at)) < julianday(?)
		 LIMIT 100`
	)
		.bind(cutoff(maxCIDurationMs(env) + RUNNING_GRACE_MS))
		.all<{ id: string }>();

	const { results: queued } = await DB.prepare(
		`SELECT id FROM ci_runs
		 WHERE status = 'queued' AND julianday(created_at) < julianday(?)
		 LIMIT 100`
	)
		.bind(cutoff(QUEUED_TIMEOUT_MS))
		.all<{ id: string }>();

	let failedRunning = 0;
	for (const { id } of running) {
		const res = await DB.prepare("UPDATE ci_runs SET status = 'failed', finished_at = ? WHERE id = ? AND status = 'running'")
			.bind(now, id)
			.run();
		if (!res.meta.changes) continue;
		failedRunning++;
		await DB.batch([
			DB.prepare("UPDATE ci_steps SET status = 'failed', finished_at = ? WHERE run_id = ? AND status = 'running'").bind(now, id),
			DB.prepare("UPDATE ci_steps SET status = 'skipped', finished_at = ? WHERE run_id = ? AND status = 'pending'").bind(now, id),
		]);
		// The runner enforces its own deadline, but if it lost track of the
		// run (restart) make sure no container keeps going.
		const cancel = await cancelRunnerRun(env, id);
		if (!cancel.ok) console.warn(`maintenance: runner cancel for ${id} failed: ${cancel.error}`);
	}

	let failedQueued = 0;
	for (const { id } of queued) {
		const res = await DB.prepare("UPDATE ci_runs SET status = 'failed', finished_at = ? WHERE id = ? AND status = 'queued'")
			.bind(now, id)
			.run();
		if (!res.meta.changes) continue;
		failedQueued++;
		await DB.prepare("UPDATE ci_steps SET status = 'skipped', finished_at = ? WHERE run_id = ? AND status IN ('pending', 'running')")
			.bind(now, id)
			.run();
	}

	return { running: failedRunning, queued: failedQueued };
}

async function failStuckDeployments(env: Env): Promise<number> {
	const now = new Date().toISOString();
	const res = await env.DB.prepare(
		`UPDATE deployments
		 SET status = 'failed', finished_at = ?,
		     error_message = CASE WHEN status = 'running' THEN 'Timed out waiting for the runner to report a result'
		                          ELSE 'Timed out waiting in the deploy queue' END
		 WHERE (status = 'running' AND julianday(COALESCE(started_at, created_at)) < julianday(?))
		    OR (status IN ('queued', 'pending') AND julianday(created_at) < julianday(?))`
	)
		.bind(now, cutoff(DEPLOY_RUNNING_TIMEOUT_MS), cutoff(QUEUED_TIMEOUT_MS))
		.run();
	return res.meta.changes ?? 0;
}

export async function runScheduledMaintenance(env: Env): Promise<MaintenanceReport> {
	const report: MaintenanceReport = { stuckRuns: 0, stuckQueuedRuns: 0, stuckDeployments: 0, expiredSessions: 0, lfsPromoted: 0, lfsPurged: 0, diaryOrphansPurged: 0 };

	// Each task is independent — one failing must not stop the others.
	const tasks: Array<Promise<void>> = [
		failStuckRuns(env).then((r) => {
			report.stuckRuns = r.running;
			report.stuckQueuedRuns = r.queued;
		}),
		failStuckDeployments(env).then((n) => {
			report.stuckDeployments = n;
		}),
		cleanExpiredSessions(env.DB).then((n) => {
			report.expiredSessions = n;
		}),
		reconcileStalePendingLfs(env, LFS_PENDING_TIMEOUT_MS).then((r) => {
			report.lfsPromoted = r.promoted;
			report.lfsPurged = r.purged;
		}),
		purgeOrphanDiaryMedia(env, LFS_PENDING_TIMEOUT_MS).then((n) => {
			report.diaryOrphansPurged = n;
		}),
	];
	const outcomes = await Promise.allSettled(tasks);
	for (const o of outcomes) {
		if (o.status === 'rejected') console.error('maintenance task failed:', o.reason);
	}

	console.log(`maintenance: ${JSON.stringify(report)}`);
	return report;
}
