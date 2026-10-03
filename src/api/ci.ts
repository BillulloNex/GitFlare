import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { parseCIConfig } from '../lib/ci-parser.ts';

const app = new Hono<{ Bindings: Env }>();

/**
 * List CI runs with pagination, filterable by status
 */
app.get('/:repo/ci/runs', async (c) => {
	const repoName = c.req.param('repo');
	const { DB } = c.env;
	
	const repoRecord = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(repoName).first<{ id: string }>();
	if (!repoRecord) return c.json({ error: 'Repo not found' }, 404);

	const limit = parseInt(c.req.query('limit') || '10');
	const offset = parseInt(c.req.query('offset') || '0');
	const status = c.req.query('status');
	
	let query = 'SELECT * FROM ci_runs WHERE repo_id = ?';
	const params: any[] = [repoRecord.id];
	
	if (status) {
		query += ' AND status = ?';
		params.push(status);
	}
	
	query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
	params.push(limit, offset);
	
	const { results } = await DB.prepare(query).bind(...params).all();
	return c.json({ data: results });
});

/**
 * Get a specific CI run with its steps
 */
app.get('/:repo/ci/runs/:id', async (c) => {
	const repoName = c.req.param('repo');
	const runId = c.req.param('id');
	const { DB } = c.env;

	const run = await DB.prepare('SELECT * FROM ci_runs WHERE id = ?').bind(runId).first();
	if (!run) return c.json({ error: 'Run not found' }, 404);

	const { results: steps } = await DB.prepare('SELECT * FROM ci_steps WHERE run_id = ? ORDER BY created_at ASC').bind(runId).all();
	
	return c.json({ data: { ...run, steps } });
});

/**
 * Manual CI trigger
 */
app.post('/:repo/ci/trigger', async (c) => {
	const repoName = c.req.param('repo');
	const body = await c.req.json<{ branch?: string, commit_sha?: string }>();
	
	const { DB, REPOS, CI_QUEUE } = c.env;
	
	const repoRecord = await DB.prepare('SELECT id, name FROM repositories WHERE name = ?').bind(repoName).first<{ id: string, name: string }>();
	if (!repoRecord) return c.json({ error: 'Repo not found' }, 404);

	const artifactRepo = await REPOS.get(repoRecord.name);
	if (!artifactRepo) return c.json({ error: 'Artifact repo not found' }, 404);

	const branch = body.branch || 'main';
	const commitSha = body.commit_sha || 'HEAD';

	const token = await artifactRepo.createToken('read', 60);
	const ciRes = await fetch(`${artifactRepo.remote}/raw/${commitSha}/.gitflare/ci.yml`, {
		headers: { 'Authorization': `Bearer ${token}` }
	});

	if (!ciRes.ok) {
		return c.json({ error: 'CI config not found' }, 404);
	}

	const yamlContent = await ciRes.text();
	const config = parseCIConfig(yamlContent);
	
	const runId = crypto.randomUUID();
	await DB.prepare('INSERT INTO ci_runs (id, repo_id, branch, commit_sha, status, trigger, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.bind(runId, repoRecord.id, branch, commitSha, 'queued', 'manual', new Date().toISOString())
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

	return c.json({ data: { id: runId } }, 201);
});

/**
 * Cancel a running CI job
 */
app.post('/:repo/ci/runs/:id/cancel', async (c) => {
	const runId = c.req.param('id');
	const { DB } = c.env;
	
	const run = await DB.prepare('SELECT * FROM ci_runs WHERE id = ?').bind(runId).first();
	if (!run) return c.json({ error: 'Run not found' }, 404);

	await DB.prepare("UPDATE ci_runs SET status = 'cancelled' WHERE id = ?").bind(runId).run();
	return c.json({ success: true });
});

export default app;
