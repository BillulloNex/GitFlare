import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { requireRepoLevel, type RepoVariables } from '../middleware/repo-access.ts';
import { audit } from '../lib/audit.ts';
import { isOptionalBoolean, readJsonObject } from '../lib/request.ts';
import {
	encryptMirrorToken,
	parseGitHubUrl,
	requestManualMirrorSync,
	testGitHubConnection,
} from '../lib/github-mirror.ts';

// All routes run behind repoAccess (src/index.ts): `repoRecord` is set, GET
// needs read, other methods need write; config changes additionally need admin.
const app = new Hono<{ Bindings: Env; Variables: RepoVariables }>();

/**
 * GET /api/repos/:repo/mirror
 * Get mirror configuration for a repository.
 */
app.get('/:repo/mirror', async (c) => {
	const { DB } = c.env;

	const repo = c.get('repoRecord');

	const mirror = await DB.prepare(
		'SELECT id, repo_id, github_url, is_enabled, branch_filter, last_sync_at, last_sync_status, last_sync_error, created_at, updated_at FROM github_mirrors WHERE repo_id = ?'
	)
		.bind(repo.id)
		.first();

	if (!mirror) {
		return c.json({ mirror: null });
	}

	return c.json({
		mirror: {
			...mirror,
			branch_filter: mirror.branch_filter ? JSON.parse(mirror.branch_filter as string) : null,
		},
	});
});

/**
 * POST /api/repos/:repo/mirror
 * Create or update mirror configuration.
 * Requires admin permission on the repo.
 */
app.post('/:repo/mirror', requireRepoLevel('admin'), async (c) => {
	const body = await readJsonObject<{
		github_url: string;
		github_token: string;
		is_enabled?: boolean;
		branch_filter?: string[] | null;
	}>(c);
	const { DB } = c.env;

	// Validate input
	if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
	if (typeof body.github_url !== 'string' || !body.github_url) {
		return c.json({ error: 'github_url is required' }, 400);
	}
	if (typeof body.github_token !== 'string' || !body.github_token) {
		return c.json({ error: 'github_token is required' }, 400);
	}
	if (!isOptionalBoolean(body.is_enabled)) {
		return c.json({ error: 'is_enabled must be a boolean' }, 400);
	}
	if (
		body.branch_filter !== undefined &&
		body.branch_filter !== null &&
		!(Array.isArray(body.branch_filter) && body.branch_filter.every((p) => typeof p === 'string'))
	) {
		return c.json({ error: 'branch_filter must be an array of strings or null' }, 400);
	}

	// Validate URL format (anchored) and keep only the canonical form built from
	// the parsed parts — the stored URL is later fetched with the token attached.
	const parsedUrl = typeof body.github_url === 'string' ? parseGitHubUrl(body.github_url) : null;
	if (!parsedUrl) {
		return c.json({ error: 'Invalid GitHub URL. Expected format: https://github.com/owner/repo.git' }, 400);
	}
	const githubUrl = parsedUrl.canonicalUrl;

	const repo = c.get('repoRecord');

	// Test the connection before saving
	const connectionTest = await testGitHubConnection(githubUrl, body.github_token);
	if (!connectionTest.ok) {
		return c.json({
			error: 'GitHub connection test failed',
			details: connectionTest.error,
		}, 400);
	}

	// Encrypt the token
	const encryptedToken = await encryptMirrorToken(c.env, body.github_token);

	// Check if mirror already exists (upsert)
	const existing = await DB.prepare('SELECT id FROM github_mirrors WHERE repo_id = ?')
		.bind(repo.id)
		.first<{ id: string }>();

	const now = new Date().toISOString();

	if (existing) {
		// Update existing mirror
		await DB.prepare(
			`UPDATE github_mirrors
			 SET github_url = ?, github_token_encrypted = ?, is_enabled = ?, branch_filter = ?, updated_at = ?
			 WHERE id = ?`
		)
			.bind(
				githubUrl,
				encryptedToken,
				body.is_enabled !== false ? 1 : 0,
				body.branch_filter ? JSON.stringify(body.branch_filter) : null,
				now,
				existing.id
			)
			.run();

		const user = c.get('user');
		const apiKey = c.get('apiKey');
		await audit(c.env.DB, {
			repoId: repo.id,
			actor: user?.id ?? apiKey?.id ?? 'system',
			action: 'mirror.update',
			details: {
				github_url: githubUrl,
				github_repo: connectionTest.repoFullName,
			},
			ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined,
		});

		return c.json({
			id: existing.id,
			github_url: githubUrl,
			github_repo: connectionTest.repoFullName,
			message: 'Mirror configuration updated',
		});
	} else {
		// Create new mirror
		const id = crypto.randomUUID();
		await DB.prepare(
			`INSERT INTO github_mirrors (id, repo_id, github_url, github_token_encrypted, is_enabled, branch_filter, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(
				id,
				repo.id,
				githubUrl,
				encryptedToken,
				body.is_enabled !== false ? 1 : 0,
				body.branch_filter ? JSON.stringify(body.branch_filter) : null,
				now,
				now
			)
			.run();

		const user = c.get('user');
		const apiKey = c.get('apiKey');
		await audit(c.env.DB, {
			repoId: repo.id,
			actor: user?.id ?? apiKey?.id ?? 'system',
			action: 'mirror.create',
			details: {
				github_url: githubUrl,
				github_repo: connectionTest.repoFullName,
			},
			ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined,
		});

		return c.json(
			{
				id,
				github_url: githubUrl,
				github_repo: connectionTest.repoFullName,
				message: 'Mirror configuration created',
			},
			201
		);
	}
});

/**
 * DELETE /api/repos/:repo/mirror
 * Remove mirror configuration.
 */
app.delete('/:repo/mirror', requireRepoLevel('admin'), async (c) => {
	const { DB } = c.env;

	const repo = c.get('repoRecord');

	const mirror = await DB.prepare('SELECT id FROM github_mirrors WHERE repo_id = ?')
		.bind(repo.id)
		.first<{ id: string }>();
	if (!mirror) return c.json({ error: 'No mirror configured' }, 404);

	// Delete sync log first (FK constraint)
	await DB.prepare('DELETE FROM mirror_sync_log WHERE mirror_id = ?').bind(mirror.id).run();
	await DB.prepare('DELETE FROM github_mirrors WHERE id = ?').bind(mirror.id).run();

	const user = c.get('user');
	const apiKey = c.get('apiKey');
	await audit(c.env.DB, {
		repoId: repo.id,
		actor: user?.id ?? apiKey?.id ?? 'system',
		action: 'mirror.delete',
		details: { repo: repo.name },
		ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined,
	});

	return c.json({ success: true, message: 'Mirror configuration removed' });
});

/**
 * POST /api/repos/:repo/mirror/sync
 * Manually trigger a full mirror sync: every branch passing the mirror's
 * branch filter plus every tag, at the SHAs Artifacts advertises right now.
 * Runs on the mirror queue; returns 202 with the ref → SHA map being synced.
 */
app.post('/:repo/mirror/sync', requireRepoLevel('write'), async (c) => {
	const repo = c.get('repoRecord');

	const result = await requestManualMirrorSync(c.env, repo, (p) => c.executionCtx.waitUntil(p));
	if (!result.ok) return c.json({ error: result.error }, result.status);

	const user = c.get('user');
	const apiKey = c.get('apiKey');
	await audit(c.env.DB, {
		repoId: repo.id,
		actor: user?.id ?? apiKey?.id ?? 'system',
		action: 'mirror.sync.manual',
		details: { refs: result.refs, queued: result.queued },
		ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined,
	});

	return c.json({ message: 'Mirror sync triggered', queued: result.queued, refs: result.refs }, 202);
});

/**
 * GET /api/repos/:repo/mirror/log
 * Get mirror sync history.
 */
app.get('/:repo/mirror/log', async (c) => {
	const limit = Math.min(Number(c.req.query('limit')) || 20, 100);
	const offset = Number(c.req.query('offset')) || 0;
	const { DB } = c.env;

	const repo = c.get('repoRecord');

	const mirror = await DB.prepare('SELECT id FROM github_mirrors WHERE repo_id = ?')
		.bind(repo.id)
		.first<{ id: string }>();
	if (!mirror) return c.json({ log: [], total: 0 });

	const { results } = await DB.prepare(
		'SELECT * FROM mirror_sync_log WHERE mirror_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
	)
		.bind(mirror.id, limit, offset)
		.all();

	const countResult = await DB.prepare(
		'SELECT COUNT(*) as total FROM mirror_sync_log WHERE mirror_id = ?'
	)
		.bind(mirror.id)
		.first<{ total: number }>();

	return c.json({ log: results, total: countResult?.total || 0, limit, offset });
});

/**
 * POST /api/repos/:repo/mirror/test
 * Test GitHub connection without saving.
 */
app.post('/:repo/mirror/test', requireRepoLevel('admin'), async (c) => {
	const body = await readJsonObject<{ github_url: string; github_token: string }>(c);

	if (!body || typeof body.github_url !== 'string' || !body.github_url || typeof body.github_token !== 'string' || !body.github_token) {
		return c.json({ error: 'github_url and github_token are required' }, 400);
	}

	const result = await testGitHubConnection(body.github_url, body.github_token);
	return c.json(result);
});

export default app;
