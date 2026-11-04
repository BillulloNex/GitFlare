import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { parseCIConfig } from '../lib/ci-parser.ts';
import { getArtifactCommits, getArtifactFileContent, CI_CONFIG_PATH } from '../lib/artifact-reader.ts';

const app = new Hono<{ Bindings: Env }>();

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

function timeAgo(dateString?: string | null): string {
	if (!dateString) return 'recently';
	const diffSec = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
	if (diffSec < 60) return 'just now';
	if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
	if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
	return `${Math.floor(diffSec / 86400)}d ago`;
}

type LogLine = { timestamp: string; stream: 'stdout' | 'stderr'; line: string };

/**
 * Parse the ci_steps.logs column (JSON text) into log line objects.
 * Accepts an array of {timestamp, stream, line} objects or plain strings;
 * non-JSON text is treated as raw stdout split by newline.
 */
function parseStepLogs(raw: unknown): LogLine[] {
	if (raw == null || raw === '') return [];
	let parsed: unknown = raw;
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw);
		} catch {
			return raw.split('\n').filter(Boolean).map(line => ({ timestamp: '', stream: 'stdout', line }));
		}
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.map((entry: any): LogLine => {
		if (typeof entry === 'string') return { timestamp: '', stream: 'stdout', line: entry };
		return {
			timestamp: entry?.timestamp != null ? String(entry.timestamp) : '',
			stream: entry?.stream === 'stderr' ? 'stderr' : 'stdout',
			line: entry?.line != null ? String(entry.line) : (entry?.text != null ? String(entry.text) : '')
		};
	});
}

function deriveJobStatus(stepStatuses: string[]): string {
	if (stepStatuses.some(s => s === 'failed')) return 'failed';
	if (stepStatuses.some(s => s === 'running')) return 'running';
	if (stepStatuses.length && stepStatuses.every(s => s === 'passed' || s === 'skipped')) return 'passed';
	return 'queued';
}

function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'job';
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
	const repoName = c.req.param('repo');
	const { DB } = c.env;
	
	const repoRecord = await DB.prepare('SELECT id, name FROM repositories WHERE name = ?').bind(repoName).first<{ id: string, name: string }>();
	if (!repoRecord) {
		return c.json({ error: 'Repo not found' }, 404);
	}

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
	const commits = await getArtifactCommits(c.env, repoName);

	const enrichedRuns = results.map(run => {
		const matchedCommit = commits.find(cm => 
			cm.sha === run.commit_sha || 
			cm.short_sha === run.commit_sha ||
			run.commit_sha === 'HEAD'
		) || commits[0];

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
	const repoName = c.req.param('repo');
	const runId = c.req.param('id');
	const { DB } = c.env;

	const run = await DB.prepare('SELECT * FROM ci_runs WHERE id = ?').bind(runId).first<any>();
	if (!run) return c.json({ error: 'Run not found' }, 404);

	const commits = await getArtifactCommits(c.env, repoName);
	const matchedCommit = commits.find(cm => 
		cm.sha === run.commit_sha || 
		cm.short_sha === run.commit_sha ||
		run.commit_sha === 'HEAD'
	) || commits[0];

	// Fetch steps from D1
	const { results: rawSteps } = await DB.prepare('SELECT * FROM ci_steps WHERE run_id = ? ORDER BY step_index ASC').bind(runId).all<any>();

	// Fetch deployment info if applicable
	const deployment = await DB.prepare(`
		SELECT d.*, dt.name as target_name, dt.type as target_type, dt.coolify_app_id
		FROM deployments d
		LEFT JOIN deploy_targets dt ON d.target_id = dt.id
		WHERE d.ci_run_id = ? OR d.commit_sha = ?
		ORDER BY d.created_at DESC
	`).bind(runId, run.commit_sha).first<any>();

	const duration = formatDuration(run.started_at || run.created_at, run.finished_at);

	// Build jobs/steps hierarchy from recorded ci_steps rows (empty if none recorded yet)
	const isPassed = run.status === 'passed';
	const isFailed = run.status === 'failed';
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
			deployment: deployment ? {
				id: deployment.id,
				target_name: deployment.target_name || 'production',
				target_type: deployment.target_type || 'coolify',
				coolify_app_id: deployment.coolify_app_id ?? null,
				coolify_deployment_id: deployment.coolify_deployment_id ?? null,
				status: deployment.status || (isPassed ? 'success' : 'failed'),
				url: 'http://grok.beenex.org'
			} : {
				target_name: 'production',
				target_type: 'coolify',
				coolify_app_id: null,
				coolify_deployment_id: null,
				status: isPassed ? 'success' : (isFailed ? 'failed' : 'in_progress'),
				url: 'http://grok.beenex.org'
			},
			jobs,
			raw_steps: rawSteps
		}
	});
});

/**
 * Re-run a workflow
 */
app.post('/:repo/ci/runs/:id/rerun', async (c) => {
	const repoName = c.req.param('repo');
	const runId = c.req.param('id');
	const { DB, CI_QUEUE, CACHE } = c.env;

	const oldRun = await DB.prepare('SELECT * FROM ci_runs WHERE id = ?').bind(runId).first<any>();
	if (!oldRun) return c.json({ error: 'Run not found' }, 404);

	const repoRecord = await DB.prepare('SELECT id, name FROM repositories WHERE id = ?').bind(oldRun.repo_id).first<{ id: string, name: string }>();
	if (!repoRecord) return c.json({ error: 'Repo not found' }, 404);

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
	const repoName = c.req.param('repo');
	const body = await c.req.json<{ branch?: string, commit_sha?: string, config_yaml?: string }>()
		.catch(() => ({} as { branch?: string, commit_sha?: string, config_yaml?: string }));
	
	const { DB, CI_QUEUE, CACHE } = c.env;
	
	const repoRecord = await DB.prepare('SELECT id, name FROM repositories WHERE name = ?').bind(repoName).first<{ id: string, name: string }>();
	if (!repoRecord) return c.json({ error: 'Repo not found' }, 404);

	const branch = body.branch || 'main';
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
 * Cancel a running CI job
 */
app.post('/:repo/ci/runs/:id/cancel', async (c) => {
	const runId = c.req.param('id');
	const { DB } = c.env;
	
	const run = await DB.prepare('SELECT * FROM ci_runs WHERE id = ?').bind(runId).first();
	if (!run) return c.json({ error: 'Run not found' }, 404);

	await DB.prepare("UPDATE ci_runs SET status = 'cancelled', finished_at = ? WHERE id = ?")
		.bind(new Date().toISOString(), runId)
		.run();
	return c.json({ success: true });
});

export default app;
