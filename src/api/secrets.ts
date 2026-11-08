/**
 * Saved secrets for the signed-in user.
 *
 *   GET    /api/secrets?kind=onshape     name, kind, hint — never the key
 *   POST   /api/secrets                  create; Onshape keys are checked first
 *   PATCH  /api/secrets/:id              rename and/or replace the key pair
 *   DELETE /api/secrets/:id
 *
 * A secret is owned by the user. API keys with no user cannot use this.
 * Repositories copy the key at connect time (see api/onshape.ts); deleting
 * a secret here does not disconnect repos that already copied it.
 */
import { Hono } from 'hono';
import type { Env } from '../env.ts';
import type { AuthVariables } from '../middleware/auth.ts';
import { auditContext } from '../middleware/repo-access.ts';
import { audit } from '../lib/audit.ts';
import { readJsonObject } from '../lib/request.ts';
import { OnshapeClient, OnshapeError, normalizeBaseUrl } from '../lib/onshape.ts';
import {
	MAX_SAVED_SECRETS,
	encryptOnshapeSecret,
	isSecretKind,
	onshapeHint,
	parseOnshapeKeys,
	parseSecretName,
	publicSecret,
	type OnshapeSecret,
	type SavedSecretRow,
} from '../lib/saved-secrets.ts';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

function ownerId(c: { get(key: 'user'): AuthVariables['user']; get(key: 'apiKey'): AuthVariables['apiKey'] }): string | null {
	return c.get('user')?.id ?? c.get('apiKey')?.user_id ?? null;
}

async function checkOnshapeKeys(keys: OnshapeSecret): Promise<string | null> {
	try {
		await new OnshapeClient({
			baseUrl: normalizeBaseUrl(null)!,
			accessKey: keys.access_key,
			secretKey: keys.secret_key,
		}).sessionInfo();
		return null;
	} catch (err) {
		return err instanceof OnshapeError ? err.message : `Could not reach Onshape: ${err instanceof Error ? err.message : String(err)}`;
	}
}

app.use('*', async (c, next) => {
	if (!ownerId(c)) return c.json({ error: 'Saved secrets belong to a user account' }, 403);
	await next();
});

app.get('/', async (c) => {
	const kind = c.req.query('kind');
	if (kind !== undefined && !isSecretKind(kind)) return c.json({ error: 'kind must be onshape' }, 400);
	const userId = ownerId(c)!;
	const query = kind
		? c.env.DB.prepare(
				'SELECT id, name, kind, hint, created_at, updated_at FROM saved_secrets WHERE user_id = ? AND kind = ? ORDER BY updated_at DESC'
			).bind(userId, kind)
		: c.env.DB.prepare(
				'SELECT id, name, kind, hint, created_at, updated_at FROM saved_secrets WHERE user_id = ? ORDER BY updated_at DESC'
			).bind(userId);
	const { results } = await query.all<Pick<SavedSecretRow, 'id' | 'name' | 'kind' | 'hint' | 'created_at' | 'updated_at'>>();
	return c.json({ secrets: (results ?? []).map(publicSecret) });
});

app.post('/', async (c) => {
	const body = await readJsonObject<{ name: string; kind: string; access_key: string; secret_key: string }>(c);
	if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
	if (!isSecretKind(body.kind)) return c.json({ error: 'kind must be onshape' }, 400);
	const name = parseSecretName(body.name);
	if (!name) return c.json({ error: 'name must be 1–80 characters' }, 400);
	const keys = parseOnshapeKeys(body.access_key, body.secret_key);
	if (!keys) return c.json({ error: 'access_key and secret_key are required' }, 400);

	const userId = ownerId(c)!;
	const { DB } = c.env;
	const count = await DB.prepare('SELECT COUNT(*) AS n FROM saved_secrets WHERE user_id = ?').bind(userId).first<{ n: number }>();
	if ((count?.n ?? 0) >= MAX_SAVED_SECRETS) return c.json({ error: `At most ${MAX_SAVED_SECRETS} saved secrets` }, 400);
	const taken = await DB.prepare('SELECT id FROM saved_secrets WHERE user_id = ? AND kind = ? AND name = ?').bind(userId, body.kind, name).first();
	if (taken) return c.json({ error: `You already have a saved Onshape key named "${name}"` }, 409);

	const failed = await checkOnshapeKeys(keys);
	if (failed) return c.json({ error: 'Onshape check failed', details: failed }, 400);

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const hint = onshapeHint(keys.access_key);
	await DB.prepare(
		`INSERT INTO saved_secrets (id, user_id, name, kind, payload_encrypted, hint, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(id, userId, name, body.kind, await encryptOnshapeSecret(keys, c.env.ENCRYPTION_KEY), hint, now, now)
		.run();
	await audit(DB, { ...auditContext(c), action: 'secret.create', details: { id, kind: body.kind, name } });
	return c.json({ secret: publicSecret({ id, name, kind: body.kind, hint, created_at: now, updated_at: now }) }, 201);
});

app.patch('/:id', async (c) => {
	const body = await readJsonObject<{ name: string; access_key: string; secret_key: string }>(c);
	if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
	const userId = ownerId(c)!;
	const { DB } = c.env;
	const row = await DB.prepare('SELECT * FROM saved_secrets WHERE id = ? AND user_id = ?').bind(c.req.param('id'), userId).first<SavedSecretRow>();
	if (!row || row.kind !== 'onshape') return c.json({ error: 'Saved secret not found' }, 404);

	let name = row.name;
	if (body.name !== undefined) {
		const parsed = parseSecretName(body.name);
		if (!parsed) return c.json({ error: 'name must be 1–80 characters' }, 400);
		name = parsed;
	}
	const replacing = body.access_key !== undefined || body.secret_key !== undefined;
	if (replacing && (body.access_key === undefined || body.secret_key === undefined)) {
		return c.json({ error: 'Replace both the access key and the secret key' }, 400);
	}
	const keys = replacing ? parseOnshapeKeys(body.access_key, body.secret_key) : null;
	if (replacing && !keys) return c.json({ error: 'access_key and secret_key are required' }, 400);
	if (name !== row.name) {
		const taken = await DB.prepare('SELECT id FROM saved_secrets WHERE user_id = ? AND kind = ? AND name = ? AND id != ?')
			.bind(userId, row.kind, name, row.id)
			.first();
		if (taken) return c.json({ error: `You already have a saved Onshape key named "${name}"` }, 409);
	}
	if (!replacing && name === row.name) return c.json({ secret: publicSecret(row) });

	if (keys) {
		const failed = await checkOnshapeKeys(keys);
		if (failed) return c.json({ error: 'Onshape check failed', details: failed }, 400);
	}

	const now = new Date().toISOString();
	const hint = keys ? onshapeHint(keys.access_key) : row.hint;
	const payload = keys ? await encryptOnshapeSecret(keys, c.env.ENCRYPTION_KEY) : row.payload_encrypted;
	await DB.prepare('UPDATE saved_secrets SET name = ?, payload_encrypted = ?, hint = ?, updated_at = ? WHERE id = ?')
		.bind(name, payload, hint, now, row.id)
		.run();
	await audit(DB, { ...auditContext(c), action: 'secret.update', details: { id: row.id, kind: row.kind, name, keys_replaced: Boolean(keys) } });
	return c.json({ secret: publicSecret({ ...row, name, hint, updated_at: now }) });
});

app.delete('/:id', async (c) => {
	const userId = ownerId(c)!;
	const row = await c.env.DB.prepare('SELECT id, kind, name FROM saved_secrets WHERE id = ? AND user_id = ?')
		.bind(c.req.param('id'), userId)
		.first<{ id: string; kind: string; name: string }>();
	if (!row) return c.json({ error: 'Saved secret not found' }, 404);
	await c.env.DB.prepare('DELETE FROM saved_secrets WHERE id = ?').bind(row.id).run();
	await audit(c.env.DB, { ...auditContext(c), action: 'secret.delete', details: { id: row.id, kind: row.kind, name: row.name } });
	return c.json({ deleted: true });
});

export default app;
