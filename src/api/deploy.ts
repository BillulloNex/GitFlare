import { Hono } from 'hono';
import type { Env } from '../env.ts';

const app = new Hono<{ Bindings: Env }>();

/**
 * List deploy targets
 */
app.get('/:repo/deploys', async (c) => {
	const repoName = c.req.param('repo');
	const { DB } = c.env;
	
	const repoRecord = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(repoName).first<{ id: string }>();
	if (!repoRecord) return c.json({ error: 'Repo not found' }, 404);

	const { results } = await DB.prepare('SELECT * FROM deploy_targets WHERE repo_id = ?').bind(repoRecord.id).all();
	return c.json({ data: results });
});

/**
 * Create deploy target
 */
app.post('/:repo/deploys', async (c) => {
	const repoName = c.req.param('repo');
	const body = await c.req.json();
	const { DB } = c.env;

	const repoRecord = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(repoName).first<{ id: string }>();
	if (!repoRecord) return c.json({ error: 'Repo not found' }, 404);

	const id = crypto.randomUUID();
	await DB.prepare(`INSERT INTO deploy_targets (id, repo_id, name, type, coolify_app_id, coolify_base_url, coolify_api_key_encrypted, branch_filter, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.bind(
			id, repoRecord.id, body.name, body.type, 
			body.coolify_app_id || null, body.coolify_base_url || null, body.coolify_api_key || null, 
			body.branch_filter ? JSON.stringify(body.branch_filter) : null,
			new Date().toISOString()
		).run();

	return c.json({ data: { id } }, 201);
});

/**
 * Update deploy target
 */
app.put('/:repo/deploys/:id', async (c) => {
	const targetId = c.req.param('id');
	const body = await c.req.json();
	const { DB } = c.env;

	await DB.prepare(`UPDATE deploy_targets 
		SET name = ?, type = ?, coolify_app_id = ?, coolify_base_url = ?, coolify_api_key_encrypted = ?, branch_filter = ? 
		WHERE id = ?`)
		.bind(
			body.name, body.type, 
			body.coolify_app_id || null, body.coolify_base_url || null, body.coolify_api_key || null, 
			body.branch_filter ? JSON.stringify(body.branch_filter) : null,
			targetId
		).run();

	return c.json({ success: true });
});

/**
 * Delete deploy target
 */
app.delete('/:repo/deploys/:id', async (c) => {
	const targetId = c.req.param('id');
	const { DB } = c.env;

	await DB.prepare('DELETE FROM deploy_targets WHERE id = ?').bind(targetId).run();
	return c.json({ success: true });
});

/**
 * Manual deploy trigger
 */
app.post('/:repo/deploys/:id/run', async (c) => {
	const targetId = c.req.param('id');
	const repoName = c.req.param('repo');
	const { DB, DEPLOY_QUEUE } = c.env;

	const repoRecord = await DB.prepare('SELECT id, name FROM repositories WHERE name = ?').bind(repoName).first<{ id: string, name: string }>();
	if (!repoRecord) return c.json({ error: 'Repo not found' }, 404);

	const target = await DB.prepare('SELECT * FROM deploy_targets WHERE id = ?').bind(targetId).first();
	if (!target) return c.json({ error: 'Deploy target not found' }, 404);

	const runId = crypto.randomUUID();
	await DB.prepare('INSERT INTO deployments (id, repo_id, target_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
		.bind(runId, repoRecord.id, targetId, 'queued', new Date().toISOString()).run();

	const deployTarget = {
		id: target.id as string,
		type: target.type as "coolify" | "cloudflare",
		coolifyAppId: target.coolify_app_id as string | undefined,
		coolifyBaseUrl: target.coolify_base_url as string | undefined,
		coolifyApiKey: target.coolify_api_key_encrypted as string | undefined,
		branchFilter: target.branch_filter ? JSON.parse(target.branch_filter as string) : undefined
	};

	await DEPLOY_QUEUE.send({
		runId,
		repoId: repoRecord.id,
		repoName: repoRecord.name,
		branch: 'main', 
		commitSha: 'HEAD',
		target: deployTarget
	});

	return c.json({ data: { id: runId } }, 202);
});

export default app;
