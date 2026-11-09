import { Hono } from 'hono';
import type { Env } from '../env.ts';
import type { AuthVariables } from '../middleware/auth.ts';
import { validateSession } from '../lib/session.ts';
import { exchangeUserCode, githubAppConfigured, userInstallations, verifyInstallationOwner } from '../lib/github-app.ts';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.get('/', async (c) => {
	const user = c.get('user');
	if (!user) return c.json({ error: 'Sign in to manage connections' }, 403);
	const { results } = await c.env.DB.prepare(
		'SELECT id, installation_id, account_login, account_type, allow_private, blacksmith_enabled, created_at FROM github_compute_connections WHERE user_id = ? ORDER BY created_at DESC'
	).bind(user.id).all();
	return c.json({ configured: githubAppConfigured(c.env), connections: results });
});

app.get('/github/start', async (c) => {
	const user = c.get('user');
	if (!user) return c.json({ error: 'Sign in to connect GitHub' }, 403);
	if (!githubAppConfigured(c.env)) return c.json({ error: 'GitFlare GitHub App is not configured by the instance administrator' }, 503);
	const state = crypto.randomUUID();
	await c.env.CACHE.put(`github-connect:${state}`, user.id, { expirationTtl: 600 });
	return c.json({ url: `https://github.com/apps/${encodeURIComponent(c.env.GITHUB_APP_SLUG!)}/installations/new?state=${encodeURIComponent(state)}` });
});

app.patch('/:id', async (c) => {
	const user = c.get('user');
	if (!user) return c.json({ error: 'Sign in to manage connections' }, 403);
	const body = await c.req.json<{ allow_private?: unknown; blacksmith_enabled?: unknown }>().catch(() => null);
	if (!body || (body.allow_private === undefined && body.blacksmith_enabled === undefined) ||
		(body.allow_private !== undefined && typeof body.allow_private !== 'boolean') ||
		(body.blacksmith_enabled !== undefined && typeof body.blacksmith_enabled !== 'boolean')) {
		return c.json({ error: 'Expected allow_private and/or blacksmith_enabled booleans' }, 400);
	}
	const result = await c.env.DB.prepare(
		'UPDATE github_compute_connections SET allow_private = COALESCE(?, allow_private), blacksmith_enabled = COALESCE(?, blacksmith_enabled) WHERE id = ? AND user_id = ?'
	).bind(body.allow_private === undefined ? null : Number(body.allow_private), body.blacksmith_enabled === undefined ? null : Number(body.blacksmith_enabled), c.req.param('id'), user.id).run();
	if (!result.meta.changes) return c.json({ error: 'Connection not found' }, 404);
	return c.json({ success: true });
});

app.delete('/:id', async (c) => {
	const user = c.get('user');
	if (!user) return c.json({ error: 'Sign in to manage connections' }, 403);
	const owned = await c.env.DB.prepare('SELECT id FROM github_compute_connections WHERE id = ? AND user_id = ?')
		.bind(c.req.param('id'), user.id).first<{ id: string }>();
	if (!owned) return c.json({ error: 'Connection not found' }, 404);
	const active = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM ci_runs WHERE connection_id = ? AND status IN ('queued', 'running')")
		.bind(c.req.param('id')).first<{ count: number }>();
	if (active?.count) return c.json({ error: 'This connection has active CI runs. Disconnect it after they finish.' }, 409);
	const result = await c.env.DB.prepare('DELETE FROM github_compute_connections WHERE id = ? AND user_id = ?')
		.bind(c.req.param('id'), user.id).run();
	if (!result.meta.changes) return c.json({ error: 'Connection not found' }, 404);
	return c.json({ success: true });
});

export default app;

/** Public OAuth callback. The state is bound to the GitFlare session and the
 * claimed installation must appear in the authorized user's installations. */
export const githubConnectionCallback = new Hono<{ Bindings: Env }>();
githubConnectionCallback.get('/setup', async (c) => {
	const user = await validateSession(c.env.DB, c.req.header('Cookie'));
	const state = c.req.query('state');
	const installationId = Number(c.req.query('installation_id'));
	if (!user || !state || !Number.isSafeInteger(installationId) || installationId <= 0 ||
		await c.env.CACHE.get(`github-connect:${state}`) !== user.id) {
		return c.text('GitHub connection expired or invalid.', 403);
	}
	await c.env.CACHE.put(`github-connect:${state}`, JSON.stringify({ userId: user.id, installationId }), { expirationTtl: 600 });
	const url = new URL('https://github.com/login/oauth/authorize');
	url.searchParams.set('client_id', c.env.GITHUB_APP_CLIENT_ID || '');
	url.searchParams.set('redirect_uri', `${c.env.APP_URL}/api/github/callback`);
	url.searchParams.set('state', state);
	return c.redirect(url.toString());
});
githubConnectionCallback.get('/callback', async (c) => {
	const user = await validateSession(c.env.DB, c.req.header('Cookie'));
	const state = c.req.query('state');
	const code = c.req.query('code');
	if (!user || !state || !code) {
		return c.text('GitHub connection failed: missing authorization or installation.', 400);
	}
	const key = `github-connect:${state}`;
	const stored = await c.env.CACHE.get(key);
	let bound: { userId: string; installationId: number } | null = null;
	try { bound = JSON.parse(stored || 'null'); } catch { /* malformed or expired */ }
	if (!bound || bound.userId !== user.id) return c.text('GitHub connection expired or belongs to another user.', 403);
	const claimedId = bound.installationId;
	await c.env.CACHE.delete(key);
	try {
		const token = await exchangeUserCode(c.env, code);
		const installation = (await userInstallations(token)).find((item) => item.id === claimedId);
		if (!installation) return c.text('GitHub installation does not belong to the authorized account.', 403);
		if (!(await verifyInstallationOwner(token, installation))) return c.text('Only the GitHub account or organization owner can connect its CI compute.', 403);
		const existing = await c.env.DB.prepare('SELECT user_id FROM github_compute_connections WHERE installation_id = ?')
			.bind(claimedId).first<{ user_id: string }>();
		if (existing && existing.user_id !== user.id) return c.text('This GitHub installation is already connected to another GitFlare account.', 409);
		await c.env.DB.prepare(
			`INSERT INTO github_compute_connections (id, user_id, installation_id, account_login, account_type, allow_private, blacksmith_enabled)
			 VALUES (?, ?, ?, ?, ?, ?, 0)
			 ON CONFLICT(installation_id) DO UPDATE SET
			 account_login = excluded.account_login, account_type = excluded.account_type`
		).bind(crypto.randomUUID(), user.id, claimedId, installation.account.login, installation.account.type,
			installation.account.type === 'Organization' ? 1 : 0).run();
		return c.redirect(`${c.env.APP_URL}/?connections=connected`);
	} catch (err) {
		console.error('GitHub connection callback failed', err);
		return c.text('GitHub connection failed. Please retry from GitFlare.', 502);
	}
});
