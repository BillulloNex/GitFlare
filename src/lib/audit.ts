import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../env.ts';

/**
 * Creates an audit log entry in the D1 database.
 * @param db The D1Database instance.
 * @param opts Options for the audit log entry.
 */
export async function audit(
  db: D1Database,
  opts: {
    repoId?: string;
    actor: string;
    action: string;
    details?: Record<string, unknown>;
    ipAddress?: string;
  }
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  
  await db
    .prepare(
      `INSERT INTO audit_log (id, repo_id, actor, action, details, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      opts.repoId || null,
      opts.actor,
      opts.action,
      opts.details ? JSON.stringify(opts.details) : null,
      opts.ipAddress || null,
      now
    )
    .run();
}
