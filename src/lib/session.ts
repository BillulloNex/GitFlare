import type { Env, UserRecord, SessionRecord } from '../env.ts';

const SESSION_COOKIE = 'gf_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Creates a new session for a user and returns the Set-Cookie header value.
 */
export async function createSession(db: D1Database, userId: string, appUrl: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    await db.prepare(
        'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    ).bind(sessionId, userId, expiresAt).run();

    const isSecure = appUrl.startsWith('https');
    return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${isSecure ? '; Secure' : ''}`;
}

/**
 * Validates a session cookie and returns the user if valid.
 */
export async function validateSession(db: D1Database, cookieHeader: string | undefined): Promise<UserRecord | null> {
    if (!cookieHeader) return null;

    const sessionId = parseCookie(cookieHeader, SESSION_COOKIE);
    if (!sessionId) return null;

    const row = await db.prepare(
        `SELECT u.* FROM users u
         INNER JOIN sessions s ON s.user_id = u.id
         WHERE s.id = ? AND s.expires_at > ?`
    ).bind(sessionId, new Date().toISOString()).first<UserRecord>();

    return row ?? null;
}

/**
 * Deletes a session (logout).
 */
export async function deleteSession(db: D1Database, cookieHeader: string | undefined): Promise<string> {
    if (cookieHeader) {
        const sessionId = parseCookie(cookieHeader, SESSION_COOKIE);
        if (sessionId) {
            await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
        }
    }
    // Return an expired cookie to clear it
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Deletes all expired sessions (housekeeping, call periodically).
 */
export async function cleanExpiredSessions(db: D1Database): Promise<number> {
    const result = await db.prepare(
        'DELETE FROM sessions WHERE expires_at < ?'
    ).bind(new Date().toISOString()).run();
    return result.meta.changes ?? 0;
}

/** Parse a single cookie value from the Cookie header. */
function parseCookie(header: string, name: string): string | null {
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match ? match[1] : null;
}
