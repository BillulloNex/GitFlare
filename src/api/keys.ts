import { Hono } from 'hono';
import type { Env } from '../env.ts';
import type { AuthVariables } from '../middleware/auth.ts';
import { requirePermission } from '../middleware/auth.ts';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/**
 * Hash a raw API key for storage.
 */
async function hashKey(key: string): Promise<string> {
	const encoder = new TextEncoder();
	const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(key));
	return Array.from(new Uint8Array(hashBuffer))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * GET /api/keys
 * List API keys for the authenticated user.
 * Admin users can see all keys.
 */
app.get('/', async (c) => {
	const user = c.get('user');
	const apiKey = c.get('apiKey');

	let results;

	if (user?.role === 'admin' || apiKey?.permissions === 'admin') {
		// Admins see all keys
		const query = await c.env.DB.prepare(
			'SELECT id, name, key_prefix, repo_id, user_id, permissions, created_at, expires_at, last_used_at FROM api_keys ORDER BY created_at DESC'
		).all();
		results = query.results;
	} else if (user) {
		// Regular users see only their own keys
		const query = await c.env.DB.prepare(
			'SELECT id, name, key_prefix, repo_id, user_id, permissions, created_at, expires_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
		).bind(user.id).all();
		results = query.results;
	} else {
		// API key auth — can only see info about itself
		results = apiKey ? [{
			id: apiKey.id,
			name: apiKey.name,
			key_prefix: (apiKey as any).key_prefix,
			repo_id: apiKey.repo_id,
			user_id: apiKey.user_id,
			permissions: apiKey.permissions,
			created_at: apiKey.created_at,
			expires_at: apiKey.expires_at,
		}] : [];
	}

	return c.json({ keys: results });
});

/**
 * POST /api/keys
 * Create a new API key.
 * Session users: key is linked to them automatically.
 * Admin API keys: can create keys for any user or unlinked.
 */
app.post('/', async (c) => {
	const user = c.get('user');
	const existingKey = c.get('apiKey');

	const body = await c.req.json<{
		name: string;
		permissions?: 'read' | 'write' | 'admin';
		repo_id?: string;
		expires_in_days?: number;
	}>();

	if (!body.name) {
		return c.json({ error: 'name is required' }, 400);
	}

	const requestedPermissions = body.permissions || 'read';

	// Only admin users/keys can create admin keys
	if (requestedPermissions === 'admin') {
		const isAdmin = user?.role === 'admin' || existingKey?.permissions === 'admin';
		if (!isAdmin) {
			return c.json({ error: 'Only admins can create admin API keys' }, 403);
		}
	}

	// Session users can create up to write-level keys
	// API keys can only create keys with equal or lower permissions
	if (existingKey) {
		const levels = { read: 0, write: 1, admin: 2 };
		const callerLevel = levels[existingKey.permissions as keyof typeof levels] ?? 0;
		const requestedLevel = levels[requestedPermissions];
		if (requestedLevel > callerLevel) {
			return c.json({ error: `Cannot create key with higher permissions than your own (${existingKey.permissions})` }, 403);
		}
	}

	const rawKey = `gf_${crypto.randomUUID().replace(/-/g, '')}`;
	const keyPrefix = rawKey.substring(0, 8);
	const keyHash = await hashKey(rawKey);
	const id = crypto.randomUUID();

	const expiresAt = body.expires_in_days
		? new Date(Date.now() + body.expires_in_days * 24 * 60 * 60 * 1000).toISOString()
		: null;

	// Link to user if authenticated via session
	const userId = user?.id ?? null;

	await c.env.DB.prepare(
		`INSERT INTO api_keys (id, name, key_hash, key_prefix, repo_id, user_id, permissions, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`
	).bind(id, body.name, keyHash, keyPrefix, body.repo_id || null, userId, requestedPermissions, expiresAt).run();

	return c.json({
		id,
		key: rawKey,
		key_prefix: keyPrefix,
		permissions: requestedPermissions,
		repo_id: body.repo_id || null,
		user_id: userId,
		expires_at: expiresAt,
		message: '⚠️ Save this key now — it will not be shown again.',
	}, 201);
});

/**
 * DELETE /api/keys/:id
 * Revoke an API key.
 * Users can revoke their own keys. Admins can revoke any key.
 */
app.delete('/:id', async (c) => {
	const keyId = c.req.param('id');
	const user = c.get('user');
	const existingKey = c.get('apiKey');

	const target = await c.env.DB.prepare(
		'SELECT id, user_id, permissions FROM api_keys WHERE id = ?'
	).bind(keyId).first<{ id: string; user_id: string | null; permissions: string }>();

	if (!target) {
		return c.json({ error: 'API key not found' }, 404);
	}

	// Permission check: own key, or admin
	const isAdmin = user?.role === 'admin' || existingKey?.permissions === 'admin';
	const isOwner = user && target.user_id === user.id;

	if (!isAdmin && !isOwner) {
		return c.json({ error: 'Forbidden: You can only revoke your own keys' }, 403);
	}

	// Prevent revoking the key you're currently using
	if (existingKey && existingKey.id === keyId) {
		return c.json({ error: 'Cannot revoke the API key you are currently using' }, 400);
	}

	await c.env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(keyId).run();

	return c.json({ success: true, revoked: keyId });
});

export default app;
