import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { requirePermission, type AuthVariables } from '../middleware/auth.ts';
import { audit } from '../lib/audit.ts';
import {
	encryptToken,
	decryptToken,
	testGitHubConnection,
	triggerGitHubMirror,
} from '../lib/github-mirror.ts';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/**
 * GET /api/repos/:repo/mirror
 * Get mirror configuration for a repository.
 */
app.get('/:repo/mirror', async (c) => {
	const repoName = c.req.param('repo');
	const { DB } = c.env;

	const repo = await DB.prepare('SELECT id FROM repositories WHERE name = ?')
		.bind(repoName)
		.first<{ id: string }>();
	if (!repo) return c.json({ error: 'Repository not found' }, 404);

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
app.post('/:repo/mirror', requirePermission('admin'), async (c) => {
	const repoName = c.req.param('repo');
	const body = await c.req.json<{
		github_url: string;
		github_token: string;
		is_enabled?: boolean;
		branch_filter?: string[] | null;
	}>();
	const { DB } = c.env;

	// Validate input
	if (!body.github_url) {
		return c.json({ error: 'github_url is required' }, 400);
	}
	if (!body.github_token) {
		return c.json({ error: 'github_token is required' }, 400);
	}

	// Validate URL format
	const urlPattern = /github\.com[/:]([^/]+)\/([^/.]+)/;
	if (!urlPattern.test(body.github_url)) {
		return c.json({ error: 'Invalid GitHub URL. Expected format: https://github.com/owner/repo.git' }, 400);
	}

	const repo = await DB.prepare('SELECT id FROM repositories WHERE name = ?')
		.bind(repoName)
		.first<{ id: string }>();
	if (!repo) return c.json({ error: 'Repository not found' }, 404);

	// Test the connection before saving
	const connectionTest = await testGitHubConnection(body.github_url, body.github_token);
	if (!connectionTest.ok) {
		return c.json({
			error: 'GitHub connection test failed',
			details: connectionTest.error,
		}, 400);
	}

	// Encrypt the token
	const encryptedToken = await encryptToken(body.github_token, c.env.SESSION_SECRET);

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
				body.github_url,
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
				github_url: body.github_url,
				github_repo: connectionTest.repoFullName,
			},
			ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined,
		});

		return c.json({
			id: existing.id,
			github_url: body.github_url,
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
				body.github_url,
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
				github_url: body.github_url,
				github_repo: connectionTest.repoFullName,
			},
			ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined,
		});

		return c.json(
			{
				id,
				github_url: body.github_url,
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
app.delete('/:repo/mirror', requirePermission('admin'), async (c) => {
	const repoName = c.req.param('repo');
	const { DB } = c.env;

	const repo = await DB.prepare('SELECT id FROM repositories WHERE name = ?')
		.bind(repoName)
		.first<{ id: string }>();
	if (!repo) return c.json({ error: 'Repository not found' }, 404);

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
		details: { repo: repoName },
		ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined,
	});

	return c.json({ success: true, message: 'Mirror configuration removed' });
});

/**
 * POST /api/repos/:repo/mirror/sync
 * Manually trigger a full mirror sync.
 */
app.post('/:repo/mirror/sync', requirePermission('write'), async (c) => {
	const repoName = c.req.param('repo');
	const { DB } = c.env;

	const repo = await DB.prepare('SELECT id, name FROM repositories WHERE name = ?')
		.bind(repoName)
		.first<{ id: string; name: string }>();
	if (!repo) return c.json({ error: 'Repository not found' }, 404);

	const mirror = await DB.prepare(
		'SELECT id, github_url, github_token_encrypted, branch_filter FROM github_mirrors WHERE repo_id = ? AND is_enabled = 1'
	)
		.bind(repo.id)
		.first<{
			id: string;
			github_url: string;
			github_token_encrypted: string;
			branch_filter: string | null;
		}>();
	if (!mirror) return c.json({ error: 'No active mirror configured' }, 404);

	// Get the default branch to sync
	const defaultBranch = (
		await DB.prepare('SELECT default_branch FROM repositories WHERE id = ?')
			.bind(repo.id)
			.first<{ default_branch: string }>()
	)?.default_branch || 'main';

	// Trigger async mirror
	const branches = [defaultBranch];
	const commitShas = new Map<string, string>();
	commitShas.set(defaultBranch, 'HEAD');

	c.executionCtx.waitUntil(
		triggerGitHubMirror(c.env, repo.id, repo.name, branches, commitShas)
	);

	const user = c.get('user');
	const apiKey = c.get('apiKey');
	await audit(c.env.DB, {
		repoId: repo.id,
		actor: user?.id ?? apiKey?.id ?? 'system',
		action: 'mirror.sync.manual',
		details: { branches },
		ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined,
	});

	return c.json({ message: 'Mirror sync triggered', branches }, 202);
});

/**
 * GET /api/repos/:repo/mirror/log
 * Get mirror sync history.
 */
app.get('/:repo/mirror/log', async (c) => {
	const repoName = c.req.param('repo');
	const limit = Math.min(Number(c.req.query('limit')) || 20, 100);
	const offset = Number(c.req.query('offset')) || 0;
	const { DB } = c.env;

	const repo = await DB.prepare('SELECT id FROM repositories WHERE name = ?')
		.bind(repoName)
		.first<{ id: string }>();
	if (!repo) return c.json({ error: 'Repository not found' }, 404);

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
app.post('/:repo/mirror/test', requirePermission('admin'), async (c) => {
	const body = await c.req.json<{ github_url: string; github_token: string }>();

	if (!body.github_url || !body.github_token) {
		return c.json({ error: 'github_url and github_token are required' }, 400);
	}

	const result = await testGitHubConnection(body.github_url, body.github_token);
	return c.json(result);
});

export default app;
