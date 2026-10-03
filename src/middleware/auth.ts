import { createMiddleware } from 'hono/factory';
import type { Env, ApiKey, UserRecord } from '../env.ts';
import { validateSession } from '../lib/session.ts';

// ─── Auth Context ───────────────────────────────────────────────
// Every authenticated request has either a user (session) or an apiKey, or both.

type AuthVariables = {
    user: UserRecord | null;
    apiKey: ApiKey | null;
    authType: 'session' | 'apikey' | 'none';
};

export type { AuthVariables };

/**
 * Hashes the API key using SHA-256 for secure storage lookup.
 */
async function hashKey(key: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(key);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Extract API key from Authorization header.
 */
function extractApiKeyFromHeader(authHeader: string): string | null {
    if (authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7);
    }
    if (authHeader.startsWith('Basic ')) {
        const decoded = atob(authHeader.substring(6));
        const parts = decoded.split(':');
        return parts.length === 2 ? parts[1] : decoded;
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
 * Primary auth middleware: requires authentication via EITHER session cookie OR API key.
 * Sets `user`, `apiKey`, and `authType` on the context.
 */
export const auth = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(async (c, next) => {
    // 1. Try session cookie first (UI users)
    const user = await validateSession(c.env.DB, c.req.header('Cookie'));
    if (user) {
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
 */
export const optionalAuth = createMiddleware<{ Bindings: Env; Variables: Partial<AuthVariables> }>(async (c, next) => {
    // Try session
    const user = await validateSession(c.env.DB, c.req.header('Cookie'));
    if (user) {
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
            if (keyRecord) {
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
 * For session users: checks user.role (admin has all permissions).
 * For API keys: checks key.permissions level.
 */
export const requirePermission = (requiredLevel: 'read' | 'write' | 'admin') => {
    return createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(async (c, next) => {
        const levels = { read: 0, write: 1, admin: 2 };
        const authType = c.get('authType');

        if (authType === 'session') {
            const user = c.get('user');
            // Session users get write by default, admin if user.role === 'admin'
            const userLevel = user?.role === 'admin' ? 2 : 1;
            if (userLevel < levels[requiredLevel]) {
                return c.json({ error: `Forbidden: Requires ${requiredLevel} permission` }, 403);
            }
        } else if (authType === 'apikey') {
            const key = c.get('apiKey');
            if (!key || levels[key.permissions as keyof typeof levels] < levels[requiredLevel]) {
                return c.json({ error: `Forbidden: Requires ${requiredLevel} permission` }, 403);
            }
        } else {
            return c.json({ error: 'Unauthorized' }, 401);
        }

        await next();
    });
};
