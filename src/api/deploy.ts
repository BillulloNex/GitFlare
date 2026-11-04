import { Hono } from 'hono';
import type { DeployJobMessage, Env } from '../env.ts';
import { audit } from '../lib/audit.ts';
import {
	encryptCoolifyApiKey,
	isDeployTargetType,
	isValidWranglerConfig,
	resolveCommitSha,
} from '../lib/deploy-targets.ts';
import { isValidRefName } from '../lib/repo-validation.ts';
import { auditContext, requireRepoLevel, type RepoVariables } from '../middleware/repo-access.ts';

// All routes run behind repoAccess (src/index.ts): `repoRecord` is set, GET
// needs read, other methods need write. Target CRUD additionally needs admin.
const app = new Hono<{ Bindings: Env; Variables: RepoVariables }>();

type TargetBody = {
	name?: unknown;
	type?: unknown;
	coolify_app_id?: unknown;
	coolify_base_url?: unknown;
	coolify_api_key?: unknown;
	wrangler_config?: unknown;
	branch_filter?: unknown;
	is_active?: unknown;
};

/** undefined = field omitted; null = explicitly cleared. */
function optionalString(value: unknown): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null || value === '') return null;
	return typeof value === 'string' ? value.trim() || null : undefined;
}

function isValidBaseUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:';
	} catch {
		return false;
	}
}

/**
 * Validate the provided fields of a create/update body. Returns column → value
 * for every field that was present (so PUT only touches what it was given),
 * or an error message. Column names come from this fixed set only.
 */
async function targetColumns(
	env: Env,
	body: TargetBody,
	requireAll: boolean
): Promise<{ columns: Record<string, unknown> } | { error: string }> {
	const columns: Record<string, unknown> = {};

	if (body.name !== undefined || requireAll) {
		if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) return { error: 'name is required (max 100 chars)' };
		columns.name = body.name.trim();
	}
	if (body.type !== undefined || requireAll) {
		if (!isDeployTargetType(body.type)) return { error: "type must be 'coolify' or 'cloudflare'" };
		columns.type = body.type;
	}

	const appId = optionalString(body.coolify_app_id);
	if (appId !== undefined) columns.coolify_app_id = appId;

	const baseUrl = optionalString(body.coolify_base_url);
	if (baseUrl !== undefined) {
		if (baseUrl && !isValidBaseUrl(baseUrl)) return { error: 'coolify_base_url must be an http(s) URL' };
		columns.coolify_base_url = baseUrl;
	}

	const wranglerConfig = optionalString(body.wrangler_config);
	if (wranglerConfig !== undefined) {
		if (wranglerConfig && !isValidWranglerConfig(wranglerConfig)) {
			return { error: 'wrangler_config must be a relative path (letters, digits, . _ - /; no ..)' };
		}
		columns.wrangler_config = wranglerConfig;
	}

	if (body.branch_filter !== undefined) {
		if (body.branch_filter === null) {
			columns.branch_filter = null;
		} else if (Array.isArray(body.branch_filter) && body.branch_filter.every((p) => typeof p === 'string' && p.length <= 255)) {
			columns.branch_filter = body.branch_filter.length > 0 ? JSON.stringify(body.branch_filter) : null;
		} else {
			return { error: 'branch_filter must be an array of branch patterns or null' };
		}
	}

	if (body.is_active !== undefined) {
		if (typeof body.is_active !== 'boolean') return { error: 'is_active must be a boolean' };
		columns.is_active = body.is_active ? 1 : 0;
	}

	// Omitted → untouched. null / '' → cleared. Otherwise encrypted (`v1:`).
	const apiKey = optionalString(body.coolify_api_key);
	if (apiKey !== undefined) {
		columns.coolify_api_key_encrypted = apiKey ? await encryptCoolifyApiKey(env, apiKey) : null;
	}

	return { columns };
}

/**
 * List deploy targets. The stored Coolify API key is never returned (to
 * anyone); callers get `has_coolify_api_key`.
 */
app.get('/:repo/deploys', async (c) => {
	const repoRecord = c.get('repoRecord');
	const { results } = await c.env.DB.prepare('SELECT * FROM deploy_targets WHERE repo_id = ? ORDER BY created_at ASC')
		.bind(repoRecord.id)
		.all<Record<string, unknown>>();
	const data = results.map(({ coolify_api_key_encrypted, ...rest }) => ({
		...rest,
		has_coolify_api_key: !!coolify_api_key_encrypted,
	}));
	return c.json({ data });
});

/**
 * Deployment history for this repo.
 */
app.get('/:repo/deployments', async (c) => {
	const repoRecord = c.get('repoRecord');
	const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '25') || 25, 1), 100);
	const { results } = await c.env.DB.prepare(
		`SELECT d.id, d.target_id, d.ci_run_id, d.branch, d.commit_sha, d.status, d.coolify_deployment_id,
		        d.error_message, d.started_at, d.finished_at, d.created_at, dt.name AS target_name, dt.type AS target_type
		 FROM deployments d LEFT JOIN deploy_targets dt ON dt.id = d.target_id
		 WHERE d.repo_id = ? ORDER BY d.created_at DESC LIMIT ?`
	)
		.bind(repoRecord.id, limit)
		.all();
	return c.json({ data: results });
});

/**
 * Create deploy target
 */
app.post('/:repo/deploys', requireRepoLevel('admin'), async (c) => {
	const body = await c.req.json<TargetBody>().catch(() => null);
	if (!body || typeof body !== 'object') return c.json({ error: 'Invalid JSON body' }, 400);
	const repoRecord = c.get('repoRecord');

	const parsed = await targetColumns(c.env, body, true);
	if ('error' in parsed) return c.json({ error: parsed.error }, 400);
	const cols = parsed.columns;
	if (cols.type === 'coolify' && !cols.coolify_app_id) return c.json({ error: 'coolify_app_id is required for coolify targets' }, 400);

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await c.env.DB.prepare(
		`INSERT INTO deploy_targets (id, repo_id, name, type, is_active, coolify_app_id, coolify_base_url, coolify_api_key_encrypted, wrangler_config, branch_filter, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			id,
			repoRecord.id,
			cols.name,
			cols.type,
			cols.is_active ?? 1,
			cols.coolify_app_id ?? null,
			cols.coolify_base_url ?? null,
			cols.coolify_api_key_encrypted ?? null,
			cols.wrangler_config ?? null,
			cols.branch_filter ?? null,
			now,
			now
		)
		.run();

	await audit(c.env.DB, { ...auditContext(c), repoId: repoRecord.id, action: 'deploy_target.create', details: { id, type: cols.type } });
	return c.json({ data: { id } }, 201);
});

/**
 * Update deploy target. Partial: omitted fields are left unchanged — in
 * particular, omitting `coolify_api_key` keeps the stored key (send `null`
 * to clear it).
 */
app.put('/:repo/deploys/:id', requireRepoLevel('admin'), async (c) => {
	const targetId = c.req.param('id');
	const body = await c.req.json<TargetBody>().catch(() => null);
	if (!body || typeof body !== 'object') return c.json({ error: 'Invalid JSON body' }, 400);
	const repoRecord = c.get('repoRecord');

	const parsed = await targetColumns(c.env, body, false);
	if ('error' in parsed) return c.json({ error: parsed.error }, 400);
	const entries = Object.entries(parsed.columns);
	if (entries.length === 0) return c.json({ error: 'No updatable fields provided' }, 400);

	const assignments = entries.map(([col]) => `${col} = ?`).join(', ');
	const result = await c.env.DB.prepare(`UPDATE deploy_targets SET ${assignments}, updated_at = ? WHERE id = ? AND repo_id = ?`)
		.bind(...entries.map(([, v]) => v), new Date().toISOString(), targetId, repoRecord.id)
		.run();
	if (!result.meta.changes) return c.json({ error: 'Deploy target not found' }, 404);

	await audit(c.env.DB, {
		...auditContext(c),
		repoId: repoRecord.id,
		action: 'deploy_target.update',
		details: { id: targetId, fields: entries.map(([col]) => col) },
	});
	return c.json({ success: true });
});

/**
 * Delete deploy target
 */
app.delete('/:repo/deploys/:id', requireRepoLevel('admin'), async (c) => {
	const targetId = c.req.param('id');
	const repoRecord = c.get('repoRecord');

	const result = await c.env.DB.prepare('DELETE FROM deploy_targets WHERE id = ? AND repo_id = ?').bind(targetId, repoRecord.id).run();
	if (!result.meta.changes) return c.json({ error: 'Deploy target not found' }, 404);
	await audit(c.env.DB, { ...auditContext(c), repoId: repoRecord.id, action: 'deploy_target.delete', details: { id: targetId } });
	return c.json({ success: true });
});

/**
 * Manual deploy trigger. Body (optional): `{ branch?, commit_sha? }`.
 * Defaults to the repo's default branch at its current tip. Runs on the
 * runner like every other deploy; the queue message carries ids only.
 */
app.post('/:repo/deploys/:id/run', async (c) => {
	const targetId = c.req.param('id');
	const { DB, DEPLOY_QUEUE } = c.env;
	const repoRecord = c.get('repoRecord');
	const body = await c.req
		.json<{ branch?: unknown; commit_sha?: unknown }>()
		.catch(() => ({}) as { branch?: unknown; commit_sha?: unknown });

	const target = await DB.prepare('SELECT id FROM deploy_targets WHERE id = ? AND repo_id = ?')
		.bind(targetId, repoRecord.id)
		.first<{ id: string }>();
	if (!target) return c.json({ error: 'Deploy target not found' }, 404);

	const branch =
		typeof body.branch === 'string' && body.branch ? body.branch.replace(/^refs\/heads\//, '') : repoRecord.default_branch || 'main';
	if (!isValidRefName(branch)) return c.json({ error: 'Invalid branch name' }, 400);
	const requestedSha = typeof body.commit_sha === 'string' && body.commit_sha ? body.commit_sha.toLowerCase() : null;
	if (requestedSha && !/^[0-9a-f]{7,40}$/.test(requestedSha)) return c.json({ error: 'commit_sha must be a hex SHA' }, 400);

	// A full SHA is used as given; none / short is resolved against the branch tip.
	let commitSha: string | null;
	try {
		commitSha = await resolveCommitSha(c.env, repoRecord.name, branch, requestedSha);
	} catch (err) {
		return c.json({ error: `Could not read repository refs: ${String(err)}` }, 502);
	}
	if (!commitSha) {
		return c.json({ error: requestedSha ? `Commit ${requestedSha} is not the tip of '${branch}'` : `Branch '${branch}' not found` }, 400);
	}

	const deploymentId = crypto.randomUUID();
	await DB.prepare(
		"INSERT INTO deployments (id, repo_id, target_id, ci_run_id, branch, commit_sha, status, created_at) VALUES (?, ?, ?, NULL, ?, ?, 'queued', ?)"
	)
		.bind(deploymentId, repoRecord.id, targetId, branch, commitSha, new Date().toISOString())
		.run();

	const message: DeployJobMessage = {
		deploymentId,
		targetId,
		ciRunId: null,
		repoId: repoRecord.id,
		repoName: repoRecord.name,
		branch,
		commitSha,
	};
	await DEPLOY_QUEUE.send(message);

	await audit(DB, {
		...auditContext(c),
		repoId: repoRecord.id,
		action: 'deploy.manual',
		details: { deploymentId, targetId, branch, commitSha },
	});
	return c.json({ data: { id: deploymentId, branch, commit_sha: commitSha, status: 'queued' } }, 202);
});

export default app;
