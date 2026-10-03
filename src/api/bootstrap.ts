import { Hono } from 'hono';
import type { Env } from '../env.ts';

const app = new Hono<{ Bindings: Env }>();

/**
 * POST /api/bootstrap
 * Creates the initial admin API key using the ADMIN_API_KEY secret.
 * This is the only endpoint that doesn't require a D1-stored key.
 * Once you have your first key, use normal /api/keys endpoints.
 */
app.post('/', async (c) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const providedKey = authHeader.substring(7);
	if (providedKey !== c.env.ADMIN_API_KEY) {
		return c.json({ error: 'Invalid admin key' }, 403);
	}

	// Generate a new API key
	const rawKey = `gf_${crypto.randomUUID().replace(/-/g, '')}`;
	const keyPrefix = rawKey.substring(0, 8);

	// Hash for storage
	const encoder = new TextEncoder();
	const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawKey));
	const keyHash = Array.from(new Uint8Array(hashBuffer))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');

	const id = crypto.randomUUID();
	const body = (await c.req.json().catch(() => ({}))) as { name?: string };

	await c.env.DB.prepare(
		`INSERT INTO api_keys (id, name, key_hash, key_prefix, repo_id, permissions, created_at)
		 VALUES (?, ?, ?, ?, NULL, 'admin', datetime('now'))`
	).bind(id, body.name || 'admin-bootstrap', keyHash, keyPrefix).run();

	return c.json({
		id,
		key: rawKey,
		key_prefix: keyPrefix,
		permissions: 'admin',
		message: '⚠️ Save this key now — it will not be shown again.',
	}, 201);
});

/**
 * POST /api/bootstrap/keys
 * Creates additional API keys (requires admin key from bootstrap).
 */
app.post('/keys', async (c) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const providedKey = authHeader.substring(7);

	// Allow either the ADMIN_API_KEY secret or a D1-stored admin key
	let isAuthed = false;

	if (providedKey === c.env.ADMIN_API_KEY) {
		isAuthed = true;
	} else {
		const encoder = new TextEncoder();
		const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(providedKey));
		const keyHash = Array.from(new Uint8Array(hashBuffer))
			.map(b => b.toString(16).padStart(2, '0'))
			.join('');

		const existing = await c.env.DB.prepare(
			`SELECT * FROM api_keys WHERE key_hash = ? AND permissions = 'admin'`
		).bind(keyHash).first();

		if (existing) isAuthed = true;
	}

	if (!isAuthed) {
		return c.json({ error: 'Forbidden: requires admin' }, 403);
	}

	const body = await c.req.json<{
		name: string;
		permissions?: string;
		repo_id?: string;
	}>();

	const rawKey = `gf_${crypto.randomUUID().replace(/-/g, '')}`;
	const keyPrefix = rawKey.substring(0, 8);

	const encoder = new TextEncoder();
	const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawKey));
	const keyHash = Array.from(new Uint8Array(hashBuffer))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');

	const id = crypto.randomUUID();

	await c.env.DB.prepare(
		`INSERT INTO api_keys (id, name, key_hash, key_prefix, repo_id, permissions, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
	).bind(id, body.name, keyHash, keyPrefix, body.repo_id || null, body.permissions || 'read').run();

	return c.json({
		id,
		key: rawKey,
		key_prefix: keyPrefix,
		permissions: body.permissions || 'read',
		repo_id: body.repo_id || null,
		message: '⚠️ Save this key now — it will not be shown again.',
	}, 201);
});

/**
 * GET /api/bootstrap/keys
 * Lists all API keys (without the actual key values).
 */
app.get('/keys', async (c) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const providedKey = authHeader.substring(7);
	if (providedKey !== c.env.ADMIN_API_KEY) {
		// Also check D1
		const encoder = new TextEncoder();
		const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(providedKey));
		const keyHash = Array.from(new Uint8Array(hashBuffer))
			.map(b => b.toString(16).padStart(2, '0'))
			.join('');
		const existing = await c.env.DB.prepare(
			`SELECT * FROM api_keys WHERE key_hash = ? AND permissions = 'admin'`
		).bind(keyHash).first();
		if (!existing) {
			return c.json({ error: 'Forbidden' }, 403);
		}
	}

	const { results } = await c.env.DB.prepare(
		'SELECT id, name, key_prefix, repo_id, permissions, created_at, last_used_at FROM api_keys ORDER BY created_at DESC'
	).all();

	return c.json({ keys: results });
});

export default app;
