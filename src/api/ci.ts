import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { parseCIConfig } from '../lib/ci-parser.ts';
import { getArtifactCommits } from '../lib/artifact-reader.ts';
import { deployOnlyConfig, readRepoCiYaml } from '../lib/ci-source.ts';
import { jobsFromSteps } from '../lib/ci-view.ts';

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
		const matchedCommit = matchCommit(commits, run.commit_sha);
		const duration = formatDuration(run.started_at || run.created_at, run.finished_at);
		const label = commitLabel(run, matchedCommit);
		return {
			...run,
			...label,
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
	const matchedCommit = matchCommit(commits, run.commit_sha);
	const label = commitLabel(run, matchedCommit);

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
	const jobs = jobsFromSteps(rawSteps ?? [], run.status);

	return c.json({
		data: {
			...run,
			...label,
			duration_ms: duration.ms,
			duration_text: duration.text,
			time_ago: timeAgo(run.finished_at || run.created_at),
			deployment: deployment ? {
				id: deployment.id,
				target_name: deployment.target_name,
				target_type: deployment.target_type,
				coolify_app_id: deployment.coolify_app_id,
				coolify_deployment_id: deployment.coolify_deployment_id,
				status: deployment.status,
				error_message: deployment.error_message,
			} : null,
			jobs,
			raw_steps: rawSteps
		}
	});
});

function matchCommit(commits: { sha: string; short_sha: string; message: string; author: { name: string; email: string } }[], commitSha: string) {
	if (!commitSha || commitSha === 'HEAD') return null;
	return commits.find((commit) => commit.sha === commitSha || commit.short_sha === commitSha) ?? null;
}

function commitLabel(run: { commit_sha: string; branch: string }, matched: { short_sha: string; message: string; author: { name: string; email: string } } | null) {
	if (run.commit_sha === 'HEAD') {
		return {
			short_sha: 'unknown',
			commit_message: `Unresolved commit on ${run.branch}`,
			author: { name: 'Unknown', email: '' },
		};
	}
	return {
		short_sha: matched?.short_sha || run.commit_sha.slice(0, 7),
		commit_message: matched?.message || `Commit ${run.commit_sha.slice(0, 7)}`,
		author: matched?.author || { name: 'Unknown', email: '' },
	};
}

async function configForRun(env: Env, repoName: string, repoId: string, branch: string, ref: string): Promise<string | null> {
	const yaml = await readRepoCiYaml(env, repoName, ref);
	if (yaml) return yaml;
	const { results } = await env.DB.prepare(
		'SELECT id FROM deploy_targets WHERE repo_id = ? AND is_active = 1',
	).bind(repoId).all();
	return results?.length ? deployOnlyConfig(branch) : null;
}

/**
 * Re-run a workflow
 */
app.post('/:repo/ci/runs/:id/rerun', async (c) => {
	const repoName = c.req.param('repo');
	const runId = c.req.param('id');
	const { DB, CI_QUEUE } = c.env;

	const oldRun = await DB.prepare('SELECT * FROM ci_runs WHERE id = ?').bind(runId).first<any>();
	if (!oldRun) return c.json({ error: 'Run not found' }, 404);

	const repoRecord = await DB.prepare('SELECT id, name FROM repositories WHERE id = ?').bind(oldRun.repo_id).first<{ id: string, name: string }>();
	if (!repoRecord) return c.json({ error: 'Repo not found' }, 404);

	const ref = oldRun.commit_sha === 'HEAD' ? oldRun.branch : oldRun.commit_sha;
	const yamlContent = oldRun.config_snapshot || await configForRun(c.env, repoRecord.name, repoRecord.id, oldRun.branch, ref);
	if (!yamlContent) return c.json({ error: 'No .gitflare/ci.yml and no active deploy target. Nothing would run.' }, 400);

	let config;
	try {
		config = parseCIConfig(yamlContent);
	} catch (error: any) {
		return c.json({ error: `CI config is invalid: ${error.message}` }, 400);
	}

	const newRunId = crypto.randomUUID();
	const now = new Date().toISOString();

	await DB.prepare('INSERT INTO ci_runs (id, repo_id, branch, commit_sha, status, trigger, config_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
		.bind(newRunId, repoRecord.id, oldRun.branch, oldRun.commit_sha, 'queued', 'manual', yamlContent, now)
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
	
	const { DB, CI_QUEUE } = c.env;
	
	const repoRecord = await DB.prepare('SELECT id, name FROM repositories WHERE name = ?').bind(repoName).first<{ id: string, name: string }>();
	if (!repoRecord) return c.json({ error: 'Repo not found' }, 404);

	const branch = body.branch || 'main';
	let commitSha = body.commit_sha || '';
	if (!commitSha) {
		const head = await getArtifactCommits(c.env, repoName, branch, 1);
		commitSha = head[0]?.sha || '';
	}
	if (!commitSha || commitSha === 'HEAD') {
		return c.json({ error: `No commit found on ${branch}` }, 400);
	}

	let yamlContent: string | null = body.config_yaml || null;
	if (!yamlContent) {
		yamlContent = await configForRun(c.env, repoRecord.name, repoRecord.id, branch, commitSha);
	}
	if (!yamlContent) {
		return c.json({ error: 'No .gitflare/ci.yml and no active deploy target. Nothing would run.' }, 400);
	}

	let config;
	try {
		config = parseCIConfig(yamlContent);
	} catch (error: any) {
		return c.json({ error: `CI config is invalid: ${error.message}` }, 400);
	}
	const runId = crypto.randomUUID();
	const now = new Date().toISOString();

	await DB.prepare('INSERT INTO ci_runs (id, repo_id, branch, commit_sha, status, trigger, config_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
		.bind(runId, repoRecord.id, branch, commitSha, 'queued', 'manual', yamlContent, now)
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
