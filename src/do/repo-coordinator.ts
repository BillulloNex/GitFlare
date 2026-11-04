import { DurableObject } from 'cloudflare:workers';

interface Lock {
  pusher: string;
  refs: string[];
  expiresAt: number;
}

/**
 * Push lock lifetime. Matches the 300s Artifacts write token minted for the
 * push in src/api/git.ts: once the token is dead the push can't still be
 * writing, so the lock can't outlive a live push nor expire under one.
 */
export const PUSH_LOCK_TTL_MS = 300_000;

const LOCK_PREFIX = 'lock:';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * One instance per repo (idFromName(repoId)). Serialises pushes by holding
 * per-ref locks in DO storage, so they survive eviction/restart. Only reachable
 * from the Worker via its binding — there are no public routes to it.
 */
export class RepoCoordinator extends DurableObject {
  /** Live locks from DO storage; expired ones are deleted as a side effect. */
  private async liveLocks(): Promise<Map<string, Lock>> {
    const stored = await this.ctx.storage.list<Lock>({ prefix: LOCK_PREFIX });
    const now = Date.now();
    const live = new Map<string, Lock>();
    const expired: string[] = [];
    for (const [key, lock] of stored) {
      if (lock.expiresAt <= now) expired.push(key);
      else live.set(key.slice(LOCK_PREFIX.length), lock);
    }
    if (expired.length > 0) await this.ctx.storage.delete(expired);
    return live;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/lock') {
      const body = await request.json().catch(() => null) as { pusher?: unknown; refs?: unknown } | null;
      if (!body || !Array.isArray(body.refs) || body.refs.length === 0 || !body.refs.every(r => typeof r === 'string')) {
        return json({ error: 'refs required' }, 400);
      }
      const refs = body.refs as string[];

      // The DO's input gate keeps this read-check-write sequence atomic.
      const locks = await this.liveLocks();
      for (const lock of locks.values()) {
        if (refs.some(ref => lock.refs.includes(ref))) {
          return json({ error: 'Conflict: ref is locked' }, 409);
        }
      }

      const lockId = crypto.randomUUID();
      const lock: Lock = {
        pusher: typeof body.pusher === 'string' ? body.pusher : 'unknown',
        refs,
        expiresAt: Date.now() + PUSH_LOCK_TTL_MS,
      };
      await this.ctx.storage.put(LOCK_PREFIX + lockId, lock);

      return json({ lock_id: lockId, expires_at: lock.expiresAt });
    }

    if (request.method === 'POST' && url.pathname === '/unlock') {
      const body = await request.json().catch(() => null) as { lock_id?: unknown } | null;
      if (body && typeof body.lock_id === 'string' && body.lock_id) {
        await this.ctx.storage.delete(LOCK_PREFIX + body.lock_id);
      }
      return json({ success: true });
    }

    return json({ error: 'Not Found' }, 404);
  }
}
