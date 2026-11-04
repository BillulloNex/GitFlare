import { Hono, type Context } from 'hono';
import type { Env } from '../env.ts';
import { hashKey, safeTimingEqual } from '../lib/crypto.ts';
import { readJsonObject } from '../lib/request.ts';
import { isValidPermission, VALID_PERMISSIONS } from '../lib/access.ts';

/**
 * Bootstrap endpoints — one-time setup for the first admin API key.
 *
 * Lockdown rules (all three endpoints):
 *  - ADMIN_API_KEY must be configured (an empty secret never authenticates).
 *  - Once ANY admin key exists in D1, every endpoint returns 403. From then on
 *    use the normal authenticated /api/keys endpoints.
 *  - Credentials are compared in constant time; expired D1 keys are rejected.
 */
const app = new Hono<{ Bindings: Env }>();

/** Insert guard: only succeeds while no admin key exists (atomic vs. concurrent bootstrap). */
const NO_ADMIN_KEYS = `NOT EXISTS (SELECT 1 FROM api_keys WHERE permissions = 'admin')`;

const LOCKED_RESPONSE = { error: 'Bootstrap is disabled: an admin API key already exists. Use /api/keys.' };

async function adminKeyExists(db: D1Database): Promise<boolean> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE permissions = 'admin'`)
		.first<{ n: number }>();
	return (row?.n ?? 0) > 0;
}

/**
 * Shared gate. Returns a Response to short-circuit with, or null if the caller
 * may proceed. `allowStoredAdminKey` additionally accepts a non-expired D1
 * admin key (only reachable while unlocked, i.e. effectively never — kept so
 * the D1 path can't be abused if the lock rule ever changes).
 */
async function bootstrapGate(c: Context<{ Bindings: Env }>, allowStoredAdminKey: boolean): Promise<Response | null> {
	const authHeader = c.req.header('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return c.json({ error: 'Unauthorized' }, 401);
	}
	const providedKey = authHeader.substring(7);
	if (!providedKey) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	if (await adminKeyExists(c.env.DB)) {
		return c.json(LOCKED_RESPONSE, 403);
	}

	const adminSecret = c.env.ADMIN_API_KEY;
	if (adminSecret && (await safeTimingEqual(providedKey, adminSecret))) {
		return null;
	}

	if (allowStoredAdminKey) {
		const keyHash = await hashKey(providedKey);
		const existing = await c.env.DB.prepare(
			`SELECT id FROM api_keys WHERE key_hash = ? AND permissions = 'admin' AND (expires_at IS NULL OR expires_at > ?)`
		).bind(keyHash, new Date().toISOString()).first();
		if (existing) return null;
	}

	return c.json({ error: 'Forbidden: requires admin' }, 403);
}

function newRawKey(): string {
	return `gf_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * POST /api/bootstrap
 * Creates the initial admin API key using the ADMIN_API_KEY secret.
 */
app.post('/', async (c) => {
	const denied = await bootstrapGate(c, false);
	if (denied) return denied;

	const rawKey = newRawKey();
	const keyPrefix = rawKey.substring(0, 8);
	const keyHash = await hashKey(rawKey);
	const id = crypto.randomUUID();
	const body = (await readJsonObject<{ name?: string }>(c)) ?? {};
	const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'admin-bootstrap';

	const result = await c.env.DB.prepare(
		`INSERT INTO api_keys (id, name, key_hash, key_prefix, repo_id, permissions, created_at)
		 SELECT ?, ?, ?, ?, NULL, 'admin', datetime('now')
		 WHERE ${NO_ADMIN_KEYS}`
	).bind(id, name, keyHash, keyPrefix).run();

	if (!result.meta.changes) {
		// Lost a race with a concurrent bootstrap call.
		return c.json(LOCKED_RESPONSE, 403);
	}

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
 * Creates additional API keys. Only available before any admin key exists.
 */
app.post('/keys', async (c) => {
	const denied = await bootstrapGate(c, true);
	if (denied) return denied;

	const body = await readJsonObject<{
		name?: string;
		permissions?: string;
		repo_id?: string;
	}>(c);

	if (!body || typeof body.name !== 'string' || !body.name.trim()) {
		return c.json({ error: 'name is required' }, 400);
	}
	if ((body.permissions !== undefined && typeof body.permissions !== 'string') || (body.repo_id !== undefined && body.repo_id !== null && typeof body.repo_id !== 'string')) {
		return c.json({ error: 'permissions and repo_id must be strings' }, 400);
	}

	const permissions = body.permissions ?? 'read';
	if (!isValidPermission(permissions)) {
		return c.json({ error: `permissions must be one of: ${VALID_PERMISSIONS.join(', ')}` }, 400);
	}

	const rawKey = newRawKey();
	const keyPrefix = rawKey.substring(0, 8);
	const keyHash = await hashKey(rawKey);
	const id = crypto.randomUUID();

	const result = await c.env.DB.prepare(
		`INSERT INTO api_keys (id, name, key_hash, key_prefix, repo_id, permissions, created_at)
		 SELECT ?, ?, ?, ?, ?, ?, datetime('now')
		 WHERE ${NO_ADMIN_KEYS}`
	).bind(id, body.name, keyHash, keyPrefix, body.repo_id || null, permissions).run();

	if (!result.meta.changes) {
		return c.json(LOCKED_RESPONSE, 403);
	}

	return c.json({
		id,
		key: rawKey,
		key_prefix: keyPrefix,
		permissions,
		repo_id: body.repo_id || null,
		message: '⚠️ Save this key now — it will not be shown again.',
	}, 201);
});

/**
 * GET /api/bootstrap/keys
 * Lists all API keys (without the actual key values). Only available before
 * any admin key exists.
 */
app.get('/keys', async (c) => {
	const denied = await bootstrapGate(c, true);
	if (denied) return denied;

	const { results } = await c.env.DB.prepare(
		'SELECT id, name, key_prefix, repo_id, permissions, created_at, last_used_at FROM api_keys ORDER BY created_at DESC'
	).all();

	return c.json({ keys: results });
});

export default app;
