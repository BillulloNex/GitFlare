import { createMiddleware } from 'hono/factory';
import type { Env, ApiKey, UserRecord } from '../env.ts';
import { validateSession } from '../lib/session.ts';
import { hashKey } from '../lib/crypto.ts';
import { isValidPermission, meetsLevel, roleToPermission, type AccessLevel, type AccessPrincipal } from '../lib/access.ts';

// ─── Auth Context ───────────────────────────────────────────────
// Every authenticated request has either a user (session) or an apiKey, or both.

type AuthVariables = {
    user: UserRecord | null;
    apiKey: ApiKey | null;
    authType: 'session' | 'apikey' | 'station' | 'none';
};

export type { AuthVariables };

/**
 * Extract API key from Authorization header. Returns null on malformed input
 * (including invalid base64) instead of throwing.
 */
function extractApiKeyFromHeader(authHeader: string): string | null {
    if (authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7);
    }
    if (authHeader.startsWith('Basic ')) {
        let decoded: string;
        try {
            decoded = atob(authHeader.substring(6));
        } catch {
            return null;
        }
        const sep = decoded.indexOf(':');
        return sep >= 0 ? decoded.slice(sep + 1) : decoded;
    }
    return null;
}

/**
 * Look up and validate an API key from D1.
 */
async function lookupApiKey(db: D1Database, rawKey: string): Promise<ApiKey | null> {
    const hashedKey = await hashKey(rawKey);
    return await db
        .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND (expires_at IS NULL OR expires_at > ?)')
        .bind(hashedKey, new Date().toISOString())
        .first<ApiKey>() ?? null;
}

/**
 * Build an access principal from the auth context. Session users get the
 * permission level implied by `users.role`; API keys carry their own.
 * Returns null when unauthenticated or the role/permission is unknown.
 */
export function principalFrom(user: UserRecord | null | undefined, apiKey: ApiKey | null | undefined): AccessPrincipal | null {
    if (user) {
        const permissions = roleToPermission(user.role);
        if (!permissions) return null;
        return { userId: user.id, keyId: null, repoScope: null, permissions };
    }
    if (apiKey) {
        if (!isValidPermission(apiKey.permissions)) return null;
        return { userId: apiKey.user_id, keyId: apiKey.id, repoScope: apiKey.repo_id, permissions: apiKey.permissions };
    }
    return null;
}

/** Origin of `APP_URL` (e.g. `https://git.example.com`), or null when unset/invalid. */
export function appOrigin(env: Pick<Env, 'APP_URL'>): string | null {
    if (!env.APP_URL) return null;
    try {
        return new URL(env.APP_URL).origin;
    } catch {
        return null;
    }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF guard for cookie-authenticated requests. A state-changing request
 * riding on the session cookie must carry an `Origin` equal to APP_URL's
 * origin (or the Worker's own origin). `SameSite=Lax` alone does not stop a
 * sibling subdomain — it is "same-site" — so the Origin check is required.
 * Requests without an `Origin` header are rejected (fail closed); browsers
 * always send it on non-GET fetches and form posts.
 */
function isSameOriginWrite(req: { method: string; url: string; header(name: string): string | undefined }, env: Pick<Env, 'APP_URL'>): boolean {
    if (SAFE_METHODS.has(req.method)) return true;
    const origin = req.header('Origin');
    if (!origin) return false;
    if (origin === appOrigin(env)) return true;
    try {
        return origin === new URL(req.url).origin;
    } catch {
        return false;
    }
}

/**
 * Primary auth middleware: requires authentication via EITHER session cookie OR API key.
 * Sets `user`, `apiKey`, and `authType` on the context.
 */
export const auth = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(async (c, next) => {
    // A paired Capture Station uses its own repo-scoped credential. It is
    // intentionally valid for only the diary upload and station heartbeat /
    // signaling routes, even if the same browser also has a user session.
    const protocols = c.req.header('Sec-WebSocket-Protocol')?.split(',').map(s => s.trim()) ?? [];
    const stationToken = extractApiKeyFromHeader(c.req.header('Authorization') ?? '') || protocols.find(p => p.startsWith('gfs_'));
    if (stationToken?.startsWith('gfs_')) {
        const path = new URL(c.req.url).pathname;
        const match = /^\/api\/repos\/([^/]+)\/(.+)$/.exec(path);
        if (!match) return c.json({ error: 'Station credential is not valid for this route' }, 403);
        const suffix = match[2];
        const mediaRoute = (c.req.method === 'POST' && (suffix === 'diary' || suffix === 'diary/media' || /^diary\/media\/[A-Za-z0-9_-]+\/complete$/.test(suffix)))
            || (c.req.method === 'PUT' && /^diary\/media\/[A-Za-z0-9_-]+\/parts\/\d+$/.test(suffix));
        const stationRoute = /^(stations\/([A-Za-z0-9_-]+)\/(heartbeat|socket|rtc))$/.exec(suffix);
        if (!mediaRoute && !stationRoute) return c.json({ error: 'Station credential is not valid for this route' }, 403);
        const tokenHash = await hashKey(stationToken);
        const station = await c.env.DB.prepare(
            `SELECT s.id, s.repo_id, s.name, s.owner_user_id, s.created_at, r.name AS repo_name, u.role AS owner_role
             FROM capture_stations s JOIN repositories r ON r.id = s.repo_id
             JOIN users u ON u.id = s.owner_user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL`
        ).bind(tokenHash).first<{ id: string; repo_id: string; name: string; owner_user_id: string; created_at: string; repo_name: string; owner_role: string }>();
        let requestedRepo: string;
        try { requestedRepo = decodeURIComponent(match[1]); } catch { return c.json({ error: 'Invalid repository path' }, 400); }
        if (!station || !meetsLevel(roleToPermission(station.owner_role), 'write') || station.repo_name !== requestedRepo
            || (stationRoute && stationRoute[2] !== station.id)) return c.json({ error: 'Station credential is invalid or revoked' }, 401);
        c.set('user', null);
        c.set('apiKey', { id: station.id, name: station.name, repo_id: station.repo_id, user_id: station.owner_user_id, permissions: 'write', created_at: station.created_at, expires_at: null });
        c.set('authType', 'station');
        return await next();
    }

    // 1. Try session cookie first (UI users)
    const user = await validateSession(c.env.DB, c.req.header('Cookie'));
    if (user) {
        if (!roleToPermission(user.role)) {
            return c.json({ error: 'Forbidden: account role is not recognised' }, 403);
        }
        if (!isSameOriginWrite(c.req, c.env)) {
            return c.json({ error: 'Forbidden: cross-origin request rejected' }, 403);
        }
        c.set('user', user);
        c.set('apiKey', null);
        c.set('authType', 'session');
        return await next();
    }

    // 2. Try API key (agents / programmatic access)
    const authHeader = c.req.header('Authorization');
    if (authHeader) {
        const rawKey = extractApiKeyFromHeader(authHeader);
        if (rawKey) {
            const keyRecord = await lookupApiKey(c.env.DB, rawKey);
            if (keyRecord) {
                if (!isValidPermission(keyRecord.permissions)) {
                    return c.json({ error: 'Forbidden: API key has an invalid permission level' }, 403);
                }
                // Update last_used_at in background
                c.executionCtx.waitUntil(
                    c.env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
                        .bind(new Date().toISOString(), keyRecord.id)
                        .run()
                );
                c.set('user', null);
                c.set('apiKey', keyRecord);
                c.set('authType', 'apikey');
                return await next();
            }
        }
    }

    return c.json({ error: 'Unauthorized: Provide a session cookie or API key' }, 401);
});

/**
 * Lenient auth: authenticates if credentials provided, but allows anonymous access.
 * Credentials with an unknown role/permission level are ignored (treated as anonymous).
 */
export const optionalAuth = createMiddleware<{ Bindings: Env; Variables: Partial<AuthVariables> }>(async (c, next) => {
    // Try session
    const user = await validateSession(c.env.DB, c.req.header('Cookie'));
    if (user && roleToPermission(user.role) && isSameOriginWrite(c.req, c.env)) {
        c.set('user', user);
        c.set('apiKey', null);
        c.set('authType', 'session');
        return await next();
    }

    // Try API key
    const authHeader = c.req.header('Authorization');
    if (authHeader) {
        const rawKey = extractApiKeyFromHeader(authHeader);
        if (rawKey) {
            const keyRecord = await lookupApiKey(c.env.DB, rawKey);
            if (keyRecord && isValidPermission(keyRecord.permissions)) {
                c.set('user', null);
                c.set('apiKey', keyRecord);
                c.set('authType', 'apikey');
            }
        }
    }

    return await next();
});

/**
 * Permission check middleware. Works with both session users and API keys.
 * Session users: level comes from `users.role` (admin → admin, user → write, viewer → read).
 * API keys: level comes from `api_keys.permissions`. Unknown values are denied.
 */
export const requirePermission = (requiredLevel: AccessLevel) => {
    return createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(async (c, next) => {
        const authType = c.get('authType');
        if (authType !== 'session' && authType !== 'apikey') {
            return c.json({ error: 'Unauthorized' }, 401);
        }

        const principal = principalFrom(c.get('user'), c.get('apiKey'));
        if (!principal || !meetsLevel(principal.permissions, requiredLevel)) {
            return c.json({ error: `Forbidden: Requires ${requiredLevel} permission` }, 403);
        }

        await next();
    });
};
