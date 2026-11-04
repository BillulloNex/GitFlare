import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { parseCIConfig } from '../lib/ci-parser.ts';
import { getArtifactCommits, getArtifactFileContent, CI_CONFIG_PATH } from '../lib/artifact-reader.ts';
import { parseStepLogs, readStepLogs, stepLogKey } from '../lib/ci-logs.ts';
import { hasRepoLevel, type RepoVariables } from '../middleware/repo-access.ts';
import { cancelRunnerRun } from '../lib/runner-client.ts';
import { timeAgo } from '../lib/time.ts';
import { isOptionalString, readJsonObject } from '../lib/request.ts';
import { isValidRefName } from '../lib/repo-validation.ts';

// All routes run behind repoAccess (src/index.ts): `repoRecord` is set, GET
// needs read, POST needs write. Every lookup by id is scoped to repoRecord.id.
const app = new Hono<{ Bindings: Env; Variables: RepoVariables }>();

function formatDuration(startedAt?: string | null, finishedAt?: string | null): { ms: number; text: string } {
	if (!startedAt) return { ms: 0, text: '-' };
	const start = new Date(startedAt).getTime();
	const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
	const ms = Math.max(0, end - start);
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return { ms, text: `${seconds}s` };
	const minutes = Math.floor(seconds / 60);
	const remSecs = seconds % 60;
	return { ms, text: `${minutes}m ${remSecs}s` };
}

function deriveJobStatus(stepStatuses: string[]): string {
	if (stepStatuses.some(s => s === 'failed')) return 'failed';
	if (stepStatuses.some(s => s === 'cancelled')) return 'cancelled';
	if (stepStatuses.some(s => s === 'running')) return 'running';
	if (stepStatuses.length && stepStatuses.every(s => s === 'passed' || s === 'skipped')) return 'passed';
	return 'queued';
}

function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'job';
}

/**
 * The commit a run was for, looked up in `commits` (the log of `ref`).
 * A `HEAD` run resolves to the tip only when `commits` is that run's branch.
 * No match → undefined; never substitute an unrelated commit.
 */
function matchRunCommit<T extends { sha: string; short_sha: string }>(
	commits: T[],
	ref: string,
	run: { commit_sha: string; branch: string }
): T | undefined {
	if (run.commit_sha === 'HEAD') return run.branch === ref ? commits[0] : undefined;
	return commits.find(cm => cm.sha === run.commit_sha || cm.short_sha === run.commit_sha);
}

/**
 * Group ci_steps rows (ordered by step_index) into the jobs[].steps[] hierarchy.
 */
function buildJobs(rawSteps: any[]) {
	const groups = new Map<string, any[]>();
	for (const row of rawSteps) {
		const jobName = row.job_name || 'default';
		if (!groups.has(jobName)) groups.set(jobName, []);
		groups.get(jobName)!.push(row);
	}

	return Array.from(groups.entries()).map(([jobName, rows]) => {
		const steps = rows.map(row => {
			const stepDuration = row.duration_ms != null
				? formatDuration(new Date(0).toISOString(), new Date(row.duration_ms).toISOString())
				: formatDuration(row.started_at, row.finished_at);
			return {
				id: row.id,
				name: row.name || row.command,
				command: row.command,
				status: row.status,
				duration: stepDuration.text,
				exit_code: row.exit_code ?? null,
				started_at: row.started_at ?? null,
				finished_at: row.finished_at ?? null,
				logs: parseStepLogs(row.logs)
			};
		});

		const starts = rows.map(r => r.started_at).filter(Boolean).sort();
		const ends = rows.map(r => r.finished_at).filter(Boolean).sort();
		const status = deriveJobStatus(rows.map(r => r.status));
		const jobDuration = formatDuration(starts[0], status === 'running' ? null : ends[ends.length - 1]);

		return {
			id: `job-${slugify(jobName)}`,
			name: jobName,
			sandbox: rows.find(r => r.sandbox)?.sandbox ?? null,
			status,
			duration: jobDuration.text,
			steps
		};
	});
}

/**
 * List CI runs with enhanced commit metadata, duration, and steps summary
 */
app.get('/:repo/ci/runs', async (c) => {
	const repoRecord = c.get('repoRecord');
	const repoName = repoRecord.name;
	const { DB } = c.env;

	const repoId = repoRecord.id;
	const limit = parseInt(c.req.query('limit') || '25');
	const offset = parseInt(c.req.query('offset') || '0');
	const status = c.req.query('status');
	
	let query = 'SELECT * FROM ci_runs WHERE repo_id = ?';
	const params: any[] = [repoId];
	
	if (status && status !== 'all') {
		query += ' AND status = ?';
		params.push(status);
	}
	
	query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
	params.push(limit, offset);
	
	const { results } = await DB.prepare(query).bind(...params).all<any>();
	const defaultBranch = repoRecord.default_branch || 'main';
	const commits = await getArtifactCommits(c.env, repoName, defaultBranch);

	const enrichedRuns = results.map(run => {
		const matchedCommit = matchRunCommit(commits, defaultBranch, run);

		const duration = formatDuration(run.started_at || run.created_at, run.finished_at);
		const shortSha = run.commit_sha === 'HEAD' ? (matchedCommit?.short_sha || 'unknown') : run.commit_sha.slice(0, 7);

		return {
			...run,
			short_sha: shortSha,
			commit_message: matchedCommit?.message || `Run on ${run.branch}`,
			author: matchedCommit?.author || { name: 'Unknown', email: '', avatar: '?' },
			duration_ms: duration.ms,
			duration_text: duration.text,
			time_ago: timeAgo(run.finished_at || run.created_at)
		};
	});

	return c.json({ data: enrichedRuns });
});

/**
 * Get a specific CI run with jobs, steps, terminal logs, and deploy target details
 */
app.get('/:repo/ci/runs/:id', async (c) => {
	const repoRecord = c.get('repoRecord');
	const repoName = repoRecord.name;
	const runId = c.req.param('id');
	const { DB } = c.env;

	const run = await DB.prepare('SELECT * FROM ci_runs WHERE id = ? AND repo_id = ?').bind(runId, repoRecord.id).first<any>();
	if (!run) return c.json({ error: 'Run not found' }, 404);

	const commits = await getArtifactCommits(c.env, repoName, run.branch).catch(() => []);
	const matchedCommit = matchRunCommit(commits, run.branch, run);

	// Fetch steps from D1
	const { results: rawSteps } = await DB.prepare('SELECT * FROM ci_steps WHERE run_id = ? ORDER BY COALESCE(global_ordinal, step_index) ASC, step_index ASC').bind(runId).all<any>();

	// Fetch deployment info if applicable
	const deployment = await DB.prepare(`
		SELECT d.*, dt.name as target_name, dt.type as target_type, dt.coolify_app_id
		FROM deployments d
		LEFT JOIN deploy_targets dt ON d.target_id = dt.id
		WHERE d.repo_id = ? AND (d.ci_run_id = ? OR d.commit_sha = ?)
		ORDER BY d.created_at DESC
	`).bind(repoRecord.id, runId, run.commit_sha).first<any>();

	const duration = formatDuration(run.started_at || run.created_at, run.finished_at);

	// Build jobs/steps hierarchy from recorded ci_steps rows (empty if none recorded yet)
	const jobs = buildJobs(rawSteps);

	return c.json({
		data: {
			...run,
			short_sha: run.commit_sha === 'HEAD' ? (matchedCommit?.short_sha || 'unknown') : run.commit_sha.slice(0, 7),
			commit_message: matchedCommit?.message || `Run on ${run.branch}`,
			author: matchedCommit?.author || { name: 'Unknown', email: '', avatar: '?' },
			duration_ms: duration.ms,
			duration_text: duration.text,
			time_ago: timeAgo(run.finished_at || run.created_at),
			// Only real deployment rows are reported; no deployment → null.
			deployment: deployment ? {
				id: deployment.id,
				target_id: deployment.target_id,
				target_name: deployment.target_name ?? null,
				target_type: deployment.target_type ?? null,
				coolify_app_id: deployment.coolify_app_id ?? null,
				coolify_deployment_id: deployment.coolify_deployment_id ?? null,
				status: deployment.status,
				error_message: deployment.error_message ?? null,
				started_at: deployment.started_at ?? null,
				finished_at: deployment.finished_at ?? null
			} : null,
			jobs,
			raw_steps: rawSteps
		}
	});
});

/**
 * Full log for one step, read from R2.
 *
 * :stepIndex is the step's position across all jobs in the run
 * (ci_steps.global_ordinal; falls back to step_index for rows created before
 * that column existed). If the full log isn't in R2 yet (step still running,
 * or a run from before R2 log storage) the inline tail is returned with
 * `complete: false`.
 */
app.get('/:repo/ci/runs/:id/logs/:stepIndex', async (c) => {
	const repo = c.get('repoRecord');
	const runId = c.req.param('id');
	const rawIndex = c.req.param('stepIndex');
	const { DB, STORAGE } = c.env;

	if (!/^\d{1,6}$/.test(rawIndex)) return c.json({ error: 'Invalid step index' }, 400);
	const ordinal = Number(rawIndex);

	const run = await DB.prepare('SELECT id FROM ci_runs WHERE id = ? AND repo_id = ?')
		.bind(runId, repo.id)
		.first<{ id: string }>();
	if (!run) return c.json({ error: 'Run not found' }, 404);

	const { results: steps } = await DB.prepare(
		`SELECT id, job_name, step_index, global_ordinal, name, command, status, logs, stdout_url
		 FROM ci_steps
		 WHERE run_id = ? AND COALESCE(global_ordinal, step_index) = ?`
	)
		.bind(run.id, ordinal)
		.all<{
			id: string;
			job_name: string;
			step_index: number;
			global_ordinal: number | null;
			name: string | null;
			command: string;
			status: string;
			logs: string | null;
			stdout_url: string | null;
		}>();

	if (steps.length === 0) return c.json({ error: 'Step not found' }, 404);
	if (steps.length > 1) {
		// Only possible for legacy rows without global_ordinal, where step_index restarts per job.
		return c.json({ error: 'Step index is ambiguous for this run (multiple jobs share it)' }, 409);
	}
	const step = steps[0];

	const key = step.stdout_url || stepLogKey(run.id, ordinal);
	const full = await readStepLogs(STORAGE, key);
	const logs = full ?? parseStepLogs(step.logs);

	return c.json({
		data: {
			run_id: run.id,
			step_id: step.id,
			step_index: ordinal,
			job_name: step.job_name,
			name: step.name || step.command,
			status: step.status,
			source: full ? 'r2' : 'tail',
			complete: full !== null,
			line_count: logs.length,
			logs,
		},
	});
});

/**
 * Re-run a workflow
 */
app.post('/:repo/ci/runs/:id/rerun', async (c) => {
	const repoRecord = c.get('repoRecord');
	const runId = c.req.param('id');
	const { DB, CI_QUEUE, CACHE } = c.env;

	const oldRun = await DB.prepare('SELECT * FROM ci_runs WHERE id = ? AND repo_id = ?').bind(runId, repoRecord.id).first<any>();
	if (!oldRun) return c.json({ error: 'Run not found' }, 404);

	// Resolve config before inserting the run so a missing config doesn't leave an orphaned queued run
	const yamlContent = await getArtifactFileContent(c.env, repoRecord.name, CI_CONFIG_PATH, oldRun.branch);
	if (!yamlContent) return c.json({ error: 'No CI config found in repository' }, 400);
	await CACHE.put(`ci-config:${repoRecord.name}`, yamlContent);

	const config = parseCIConfig(yamlContent);
	const newRunId = crypto.randomUUID();
	const now = new Date().toISOString();

	await DB.prepare('INSERT INTO ci_runs (id, repo_id, branch, commit_sha, status, trigger, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.bind(newRunId, repoRecord.id, oldRun.branch, oldRun.commit_sha, 'queued', 'manual', now)
		.run();

	await CI_QUEUE.send({
		runId: newRunId,
		repoId: repoRecord.id,
		repoName: repoRecord.name,
		branch: oldRun.branch,
		commitSha: oldRun.commit_sha,
		config,
		trigger: 'manual'
	});

	return c.json({ data: { id: newRunId, status: 'queued' } }, 201);
});

/**
 * Manual CI trigger
 */
app.post('/:repo/ci/trigger', async (c) => {
	// An empty/absent body is allowed (trigger the default branch tip).
	const body = (await readJsonObject<{ branch?: string; commit_sha?: string; config_yaml?: string }>(c)) ?? {};
	if (!isOptionalString(body.branch) || !isOptionalString(body.commit_sha) || !isOptionalString(body.config_yaml)) {
		return c.json({ error: 'branch, commit_sha and config_yaml must be strings' }, 400);
	}
	if (body.branch !== undefined && !isValidRefName(body.branch)) {
		return c.json({ error: 'Invalid branch name' }, 400);
	}
	if (body.commit_sha !== undefined && body.commit_sha !== 'HEAD' && !/^[0-9a-f]{7,64}$/i.test(body.commit_sha)) {
		return c.json({ error: 'commit_sha must be a hex SHA or HEAD' }, 400);
	}

	const { DB, CI_QUEUE, CACHE } = c.env;
	const repoRecord = c.get('repoRecord');

	// An inline config_yaml is arbitrary code execution on the runner — admin only.
	if (body.config_yaml && !(await hasRepoLevel(c, 'admin'))) {
		return c.json({ error: 'Forbidden: config_yaml requires admin access to this repository' }, 403);
	}

	const branch = body.branch || repoRecord.default_branch || 'main';
	// Manual runs bypass `on.push` trigger filtering (shouldTrigger) — the
	// caller asked for this run explicitly. Same for reruns above.
	// No commit specified → run against the branch tip
	const commitSha = body.commit_sha || 'HEAD';

	// Config precedence: request body → repo file in Artifacts → KV cache
	let yamlContent: string | null = body.config_yaml || null;
	if (!yamlContent) {
		yamlContent = await getArtifactFileContent(c.env, repoRecord.name, CI_CONFIG_PATH, branch);
		if (yamlContent) await CACHE.put(`ci-config:${repoRecord.name}`, yamlContent);
	}
	if (!yamlContent) {
		yamlContent = await CACHE.get(`ci-config:${repoRecord.name}`);
	}
	if (!yamlContent) {
		return c.json({ error: `No CI config found. Provide config_yaml in request body or add ${CI_CONFIG_PATH} to the repo` }, 400);
	}

	const config = parseCIConfig(yamlContent);
	const runId = crypto.randomUUID();
	const now = new Date().toISOString();

	await DB.prepare('INSERT INTO ci_runs (id, repo_id, branch, commit_sha, status, trigger, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.bind(runId, repoRecord.id, branch, commitSha, 'queued', 'manual', now)
		.run();

	await CI_QUEUE.send({
		runId,
		repoId: repoRecord.id,
		repoName: repoRecord.name,
		branch,
		commitSha,
		config,
		trigger: 'manual'
	});

	return c.json({ data: { id: runId, status: 'queued', branch, commitSha } }, 201);
});

/**
 * Cancel a queued or running CI run.
 *
 * The DB is updated first (queued/running → cancelled, guarded so a finished
 * run can't be "cancelled" after the fact). The final runner callback never
 * overwrites `cancelled` and never deploys for it. Then the runner is told to
 * kill the run's container; if that call fails the runner still learns about
 * it from its next /internal/ci/logs heartbeat.
 */
app.post('/:repo/ci/runs/:id/cancel', async (c) => {
	const runId = c.req.param('id');
	const { DB } = c.env;
	const repoRecord = c.get('repoRecord');

	const run = await DB.prepare('SELECT id, status FROM ci_runs WHERE id = ? AND repo_id = ?')
		.bind(runId, repoRecord.id)
		.first<{ id: string; status: string }>();
	if (!run) return c.json({ error: 'Run not found' }, 404);

	const now = new Date().toISOString();
	const result = await DB.prepare(
		"UPDATE ci_runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND repo_id = ? AND status IN ('queued', 'running')"
	)
		.bind(now, runId, repoRecord.id)
		.run();
	if (!result.meta.changes) {
		return c.json({ error: `Run is already ${run.status}` }, 409);
	}

	await DB.batch([
		DB.prepare("UPDATE ci_steps SET status = 'cancelled', finished_at = ? WHERE run_id = ? AND status = 'running'").bind(now, runId),
		DB.prepare("UPDATE ci_steps SET status = 'skipped', finished_at = ? WHERE run_id = ? AND status = 'pending'").bind(now, runId),
	]);

	// A queued run was never dispatched; the consumer's claim (status = 'queued') will now fail.
	let runner: { notified: boolean; error?: string } = { notified: false };
	if (run.status === 'running') {
		const res = await cancelRunnerRun(c.env, runId);
		// Detail (runner URL, response body) stays in the log below, not the response.
		runner = res.ok ? { notified: true } : { notified: false, error: 'Runner could not be reached; it will stop the run on its next heartbeat' };
		if (!res.ok) console.warn(`Cancel: runner not reachable for run ${runId}: ${res.error}`);
	}

	return c.json({ success: true, data: { id: runId, status: 'cancelled', runner } });
});

export default app;
