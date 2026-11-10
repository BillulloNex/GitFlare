import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { appOrigin, principalFrom, type AuthVariables } from '../middleware/auth.ts';
import { auditContext, hasRepoLevel, type RepoVariables } from '../middleware/repo-access.ts';
import { checkRepoAccess } from '../lib/access.ts';
import { hashKey } from '../lib/crypto.ts';
import { audit } from '../lib/audit.ts';
import { readJsonObject } from '../lib/request.ts';

type StationEnv = { Bindings: Env; Variables: RepoVariables };
type Station = { id: string; repo_id: string; name: string; owner_user_id: string; created_at: string; last_seen_at: string | null; status_json: string; revoked_at: string | null };
const app = new Hono<StationEnv>();
export const claimApp = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function pairingCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(10));
	return Array.from(bytes, b => CODE_CHARS[b & 31]).join('');
}
function stationToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return 'gfs_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function publicStation(row: Station) {
	let status: Record<string, unknown> = {};
	try { status = JSON.parse(row.status_json) as Record<string, unknown>; } catch { /* old row */ }
	const online = Boolean(row.last_seen_at && Date.now() - Date.parse(row.last_seen_at) < 35_000);
	return { id: row.id, name: row.name, created_at: row.created_at, online, last_seen_at: row.last_seen_at, status: online ? status : {} };
}
async function loadStation(c: { env: Env; get(name: 'repoRecord'): { id: string } }, id: string): Promise<Station | null> {
	return c.env.DB.prepare('SELECT * FROM capture_stations WHERE id = ? AND repo_id = ? AND revoked_at IS NULL')
		.bind(id, c.get('repoRecord').id).first<Station>();
}
function stationSocket(c: { env: Env }, id: string) {
	return c.env.CAPTURE_ROOM.get(c.env.CAPTURE_ROOM.idFromName(id));
}

app.get('/:repo/stations', async c => {
	const { results } = await c.env.DB.prepare('SELECT * FROM capture_stations WHERE repo_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
		.bind(c.get('repoRecord').id).all<Station>();
	return c.json({ data: (results ?? []).map(publicStation) });
});

app.post('/:repo/stations/pairings', async c => {
	const user = c.get('user');
	if (!user) return c.json({ error: 'Sign in to create a pairing code' }, 403);
	const body = await readJsonObject<{ name: unknown }>(c);
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	if (!name || name.length > 80) return c.json({ error: 'Station name must be 1–80 characters' }, 400);
	const code = pairingCode();
	const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
	await c.env.DB.prepare('INSERT INTO capture_pairings (id, repo_id, name, code_hash, created_by_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
		.bind(crypto.randomUUID(), c.get('repoRecord').id, name, await hashKey(code), user.id, expiresAt).run();
	c.executionCtx.waitUntil(audit(c.env.DB, { repoId: c.get('repoRecord').id, actor: user.id, action: 'station.pairing.create', details: { name }, ipAddress: auditContext(c).ipAddress }));
	return c.json({ data: { code: code.slice(0, 5) + '-' + code.slice(5), expires_at: expiresAt } }, 201);
});

claimApp.post('/claim', async c => {
	const user = c.get('user');
	if (!user) return c.json({ error: 'Sign in on the Mac mini before pairing' }, 403);
	const body = await readJsonObject<{ code: unknown }>(c);
	const code = typeof body?.code === 'string' ? body.code.toUpperCase().replace(/[^A-Z2-9]/g, '') : '';
	if (code.length !== 10) return c.json({ error: 'Enter the 10-character pairing code' }, 400);
	const pairing = await c.env.DB.prepare(
		`SELECT p.*, r.name AS repo_name, r.is_private AS repo_private FROM capture_pairings p
		 JOIN repositories r ON r.id = p.repo_id WHERE p.code_hash = ? AND p.claimed_at IS NULL AND p.expires_at > ?`
	).bind(await hashKey(code), new Date().toISOString()).first<{ id: string; repo_id: string; name: string; repo_name: string; repo_private: number }>();
	if (!pairing) return c.json({ error: 'This pairing code is invalid or expired' }, 404);
	const principal = principalFrom(user, null);
	if (!principal || !(await checkRepoAccess(principal, pairing.repo_id, pairing.repo_private, 'write', c.env.DB))) {
		return c.json({ error: 'You need write access to this repository' }, 403);
	}
	const claimed = await c.env.DB.prepare('UPDATE capture_pairings SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL')
		.bind(new Date().toISOString(), pairing.id).run();
	if (!claimed.meta.changes) return c.json({ error: 'This pairing code was already used' }, 409);
	const id = crypto.randomUUID();
	const token = stationToken();
	await c.env.DB.prepare('INSERT INTO capture_stations (id, repo_id, name, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
		.bind(id, pairing.repo_id, pairing.name, await hashKey(token), user.id, new Date().toISOString()).run();
	c.executionCtx.waitUntil(audit(c.env.DB, { repoId: pairing.repo_id, actor: user.id, action: 'station.pair', details: { station_id: id, name: pairing.name }, ipAddress: c.req.header('cf-connecting-ip') || undefined }));
	return c.json({ data: { id, name: pairing.name, repo: pairing.repo_name, token } }, 201);
});

app.post('/:repo/stations/:id/heartbeat', async c => {
	if (c.get('authType') !== 'station' || c.get('apiKey')?.id !== c.req.param('id')) return c.json({ error: 'Station credential required' }, 403);
	const body = await readJsonObject<{ recording: unknown; feeds: unknown; pending: unknown; error: unknown }>(c);
	if (!body || typeof body.recording !== 'boolean' || !Array.isArray(body.feeds) || body.feeds.length > 6 || !Number.isInteger(body.pending) || (body.pending as number) < 0) {
		return c.json({ error: 'Invalid station status' }, 400);
	}
	const feeds = body.feeds.map(f => typeof f === 'string' ? f.slice(0, 80) : '').filter(Boolean);
	const status = JSON.stringify({ recording: body.recording, feeds, pending: body.pending, error: typeof body.error === 'string' ? body.error.slice(0, 200) : '' });
	await c.env.DB.prepare('UPDATE capture_stations SET last_seen_at = ?, status_json = ? WHERE id = ? AND revoked_at IS NULL')
		.bind(new Date().toISOString(), status, c.req.param('id')).run();
	return c.json({ data: { ok: true } });
});

app.get('/:repo/stations/:id/rtc', async c => {
	const station = await loadStation(c, c.req.param('id'));
	if (!station) return c.json({ error: 'Station not found' }, 404);
	const fallback = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], relayAvailable: false };
	if (!c.env.REALTIME_TURN_KEY_ID || !c.env.REALTIME_TURN_API_TOKEN) return c.json({ data: fallback });
	try {
		const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(c.env.REALTIME_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
			method: 'POST', headers: { Authorization: `Bearer ${c.env.REALTIME_TURN_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 3600 }),
		});
		if (!response.ok) throw new Error(`TURN credential request returned ${response.status}`);
		const data = await response.json() as { iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }> };
		if (!Array.isArray(data.iceServers)) throw new Error('TURN credential response omitted iceServers');
		return c.json({ data: { iceServers: data.iceServers, relayAvailable: true } });
	} catch (error) {
		console.warn('station: TURN credentials unavailable', error);
		return c.json({ data: fallback });
	}
});

app.get('/:repo/stations/:id/socket', async c => {
	if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return c.json({ error: 'WebSocket required' }, 426);
	if (c.req.header('Origin') !== appOrigin(c.env)) return c.json({ error: 'Invalid WebSocket origin' }, 403);
	const station = await loadStation(c, c.req.param('id'));
	if (!station) return c.json({ error: 'Station not found' }, 404);
	const isStation = c.get('authType') === 'station' && c.get('apiKey')?.id === station.id;
	const canControl = isStation || await hasRepoLevel(c, 'write');
	const stub = stationSocket(c, station.id);
	return stub.fetch(new Request('https://capture-room/socket', { headers: { Upgrade: 'websocket', 'X-Capture-Role': isStation ? 'station' : 'viewer', 'X-Capture-Control': canControl ? 'yes' : 'no' } }));
});

app.delete('/:repo/stations/:id', async c => {
	const station = await loadStation(c, c.req.param('id'));
	if (!station) return c.json({ error: 'Station not found' }, 404);
	if (c.get('user')?.id !== station.owner_user_id && !(await hasRepoLevel(c, 'admin'))) return c.json({ error: 'Only the owner or a repo admin can remove this station' }, 403);
	await c.env.DB.prepare('UPDATE capture_stations SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), station.id).run();
	await stationSocket(c, station.id).fetch('https://capture-room/revoke', { method: 'POST' });
	c.executionCtx.waitUntil(audit(c.env.DB, { repoId: station.repo_id, actor: auditContext(c).actor, action: 'station.remove', details: { station_id: station.id }, ipAddress: auditContext(c).ipAddress }));
	return c.json({ data: { id: station.id, removed: true } });
});

export default app;
