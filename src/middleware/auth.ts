import { createMiddleware } from 'hono/factory';
import type { Env, ApiKey } from '../env.ts';

type ContextVariables = {
  apiKey: ApiKey;
};

/**
 * Hashes the API key using SHA-256 for secure storage lookup.
 * @param key The raw API key string.
 * @returns The hex string representation of the hashed key.
 */
async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Middleware that extracts and validates the API key.
 * Supports Bearer and Basic authentication schemes.
 */
export const auth = createMiddleware<{ Bindings: Env; Variables: ContextVariables }>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  let rawKey = '';

  if (!authHeader) {
    return c.json({ error: 'Unauthorized: Missing Authorization header' }, 401);
  }

  if (authHeader.startsWith('Bearer ')) {
    rawKey = authHeader.substring(7);
  } else if (authHeader.startsWith('Basic ')) {
    const b64 = authHeader.substring(6);
    const decoded = atob(b64);
    const parts = decoded.split(':');
    if (parts.length === 2) {
      rawKey = parts[1]; // password is the key
    } else {
      rawKey = decoded;
    }
  } else {
    return c.json({ error: 'Unauthorized: Unsupported Authorization type' }, 401);
  }

  if (!rawKey) {
    return c.json({ error: 'Unauthorized: Empty token' }, 401);
  }

  const hashedKey = await hashKey(rawKey);

  const keyRecord = await c.env.DB
    .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND (expires_at IS NULL OR expires_at > ?)')
    .bind(hashedKey, new Date().toISOString())
    .first<ApiKey>();

  if (!keyRecord) {
    return c.json({ error: 'Unauthorized: Invalid or expired token' }, 401);
  }

  // Update last_used_at in background
  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), keyRecord.id)
      .run()
  );

  c.set('apiKey', keyRecord);
  await next();
});

/**
 * Lenient middleware that validates API key if provided, but allows public access if omitted.
 */
export const optionalAuth = createMiddleware<{ Bindings: Env; Variables: Partial<ContextVariables> }>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader) {
    return await next();
  }

  let rawKey = '';
  if (authHeader.startsWith('Bearer ')) {
    rawKey = authHeader.substring(7);
  } else if (authHeader.startsWith('Basic ')) {
    const b64 = authHeader.substring(6);
    const decoded = atob(b64);
    const parts = decoded.split(':');
    rawKey = parts.length === 2 ? parts[1] : decoded;
  }

  if (rawKey) {
    const hashedKey = await hashKey(rawKey);
    const keyRecord = await c.env.DB
      .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND (expires_at IS NULL OR expires_at > ?)')
      .bind(hashedKey, new Date().toISOString())
      .first<ApiKey>();
    if (keyRecord) {
      c.set('apiKey', keyRecord);
    }
  }

  await next();
});

/**
 * Middleware that checks if the authenticated API key has the required permission level.
 * @param requiredLevel The minimum permission level required.
 */
export const requirePermission = (requiredLevel: 'read' | 'write' | 'admin') => {
  return createMiddleware<{ Bindings: Env; Variables: ContextVariables }>(async (c, next) => {
    const key = c.get('apiKey');
    const levels = { read: 0, write: 1, admin: 2 };
    
    if (!key || levels[key.permissions as keyof typeof levels] < levels[requiredLevel]) {
      return c.json({ error: `Forbidden: Requires ${requiredLevel} permission` }, 403);
    }
    
    await next();
  });
};
