import { Hono } from 'hono';
import type { Env } from '../env.ts';
import type { AuthVariables } from '../middleware/auth.ts';
import { principalFrom } from '../middleware/auth.ts';
import { hashKey } from '../lib/crypto.ts';
import { isValidPermission, meetsLevel, VALID_PERMISSIONS } from '../lib/access.ts';
import { isOptionalString, readJsonObject } from '../lib/request.ts';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

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

	const body = await readJsonObject<{
		name: string;
		permissions?: string;
		repo_id?: string;
		expires_in_days?: number;
	}>(c);

	if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
	if (typeof body.name !== 'string' || !body.name.trim()) {
		return c.json({ error: 'name is required' }, 400);
	}
	if (!isOptionalString(body.permissions) || (body.repo_id !== undefined && body.repo_id !== null && typeof body.repo_id !== 'string')) {
		return c.json({ error: 'permissions and repo_id must be strings' }, 400);
	}
	if (
		body.expires_in_days !== undefined &&
		body.expires_in_days !== null &&
		!(typeof body.expires_in_days === 'number' && Number.isFinite(body.expires_in_days) && body.expires_in_days > 0 && body.expires_in_days <= 3650)
	) {
		return c.json({ error: 'expires_in_days must be a number between 1 and 3650' }, 400);
	}

	const requestedPermissions = body.permissions ?? 'read';
	if (!isValidPermission(requestedPermissions)) {
		return c.json({ error: `permissions must be one of: ${VALID_PERMISSIONS.join(', ')}` }, 400);
	}

	// Cap at the caller's own level:
	//   session viewer → read, user → write, admin → admin
	//   API key        → its own permissions
	const caller = principalFrom(user, existingKey);
	if (!caller) {
		return c.json({ error: 'Forbidden: unrecognised role or permission level' }, 403);
	}
	if (!meetsLevel(caller.permissions, requestedPermissions)) {
		return c.json({ error: `Cannot create a ${requestedPermissions} key — your access level is ${caller.permissions}` }, 403);
	}

	// A repo-scoped key may only mint keys scoped to that same repo.
	if (caller.repoScope && body.repo_id !== caller.repoScope) {
		return c.json({ error: 'A repo-scoped API key can only create keys for its own repository (set repo_id)' }, 403);
	}

	const rawKey = `gf_${crypto.randomUUID().replace(/-/g, '')}`;
	const keyPrefix = rawKey.substring(0, 8);
	const keyHash = await hashKey(rawKey);
	const id = crypto.randomUUID();

	const expiresAt = body.expires_in_days
		? new Date(Date.now() + body.expires_in_days * 24 * 60 * 60 * 1000).toISOString()
		: null;

	// Link to the owning user: the session user, or the calling key's owner.
	// (A key with no user_id has global access — don't let user keys mint those.)
	const userId = caller.userId ?? null;

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
