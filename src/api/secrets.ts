/**
 * Saved secrets for the signed-in user. A secret is a name plus one value
 * (an API key, token, or anything else). Integrations copy it when connecting
 * a repository; deleting it here does not disconnect those repos.
 *
 *   GET    /api/secrets            name and hint — never the value
 *   POST   /api/secrets            { name, value }
 *   PATCH  /api/secrets/:id        rename and/or replace the value
 *   DELETE /api/secrets/:id
 *
 * API keys with no user cannot use this.
 */
import { Hono } from 'hono';
import type { Env } from '../env.ts';
import type { AuthVariables } from '../middleware/auth.ts';
import { auditContext } from '../middleware/repo-access.ts';
import { audit } from '../lib/audit.ts';
import { readJsonObject } from '../lib/request.ts';
import {
	MAX_SAVED_SECRETS,
	encryptTextSecret,
	isSecretKind,
	parseSecretName,
	parseSecretValue,
	publicSecret,
	secretHint,
	type SavedSecretRow,
} from '../lib/saved-secrets.ts';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

function ownerId(c: { get(key: 'user'): AuthVariables['user']; get(key: 'apiKey'): AuthVariables['apiKey'] }): string | null {
	return c.get('user')?.id ?? c.get('apiKey')?.user_id ?? null;
}

app.use('*', async (c, next) => {
	if (!ownerId(c)) return c.json({ error: 'Saved secrets belong to a user account' }, 403);
	await next();
});

app.get('/', async (c) => {
	const kind = c.req.query('kind');
	if (kind !== undefined && !isSecretKind(kind)) return c.json({ error: 'kind must be text or onshape' }, 400);
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
	const body = await readJsonObject<{ name: string; value: string }>(c);
	if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
	const name = parseSecretName(body.name);
	if (!name) return c.json({ error: 'name must be 1–80 characters' }, 400);
	const value = parseSecretValue(body.value);
	if (!value) return c.json({ error: 'value is required' }, 400);

	const userId = ownerId(c)!;
	const { DB } = c.env;
	const count = await DB.prepare('SELECT COUNT(*) AS n FROM saved_secrets WHERE user_id = ?').bind(userId).first<{ n: number }>();
	if ((count?.n ?? 0) >= MAX_SAVED_SECRETS) return c.json({ error: `At most ${MAX_SAVED_SECRETS} saved secrets` }, 400);
	const taken = await DB.prepare('SELECT id FROM saved_secrets WHERE user_id = ? AND name = ?').bind(userId, name).first();
	if (taken) return c.json({ error: `You already have a saved secret named "${name}"` }, 409);

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const hint = secretHint(value);
	await DB.prepare(
		`INSERT INTO saved_secrets (id, user_id, name, kind, payload_encrypted, hint, created_at, updated_at)
		 VALUES (?, ?, ?, 'text', ?, ?, ?, ?)`
	)
		.bind(id, userId, name, await encryptTextSecret(value, c.env.ENCRYPTION_KEY), hint, now, now)
		.run();
	await audit(DB, { ...auditContext(c), action: 'secret.create', details: { id, kind: 'text', name } });
	return c.json({ secret: publicSecret({ id, name, kind: 'text', hint, created_at: now, updated_at: now }) }, 201);
});

app.patch('/:id', async (c) => {
	const body = await readJsonObject<{ name: string; value: string }>(c);
	if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
	const userId = ownerId(c)!;
	const { DB } = c.env;
	const row = await DB.prepare('SELECT * FROM saved_secrets WHERE id = ? AND user_id = ?').bind(c.req.param('id'), userId).first<SavedSecretRow>();
	if (!row) return c.json({ error: 'Saved secret not found' }, 404);

	let name = row.name;
	if (body.name !== undefined) {
		const parsed = parseSecretName(body.name);
		if (!parsed) return c.json({ error: 'name must be 1–80 characters' }, 400);
		name = parsed;
	}
	const value = body.value !== undefined ? parseSecretValue(body.value) : null;
	if (body.value !== undefined && !value) return c.json({ error: 'value is required' }, 400);
	if (name !== row.name) {
		const taken = await DB.prepare('SELECT id FROM saved_secrets WHERE user_id = ? AND name = ? AND id != ?').bind(userId, name, row.id).first();
		if (taken) return c.json({ error: `You already have a saved secret named "${name}"` }, 409);
	}
	if (!value && name === row.name) return c.json({ secret: publicSecret(row) });

	const now = new Date().toISOString();
	const hint = value ? secretHint(value) : row.hint;
	const payload = value ? await encryptTextSecret(value, c.env.ENCRYPTION_KEY) : row.payload_encrypted;
	const kind = value ? 'text' : row.kind;
	await DB.prepare('UPDATE saved_secrets SET name = ?, kind = ?, payload_encrypted = ?, hint = ?, updated_at = ? WHERE id = ?')
		.bind(name, kind, payload, hint, now, row.id)
		.run();
	await audit(DB, { ...auditContext(c), action: 'secret.update', details: { id: row.id, kind, name, value_replaced: Boolean(value) } });
	return c.json({ secret: publicSecret({ ...row, name, kind, hint, updated_at: now }) });
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
