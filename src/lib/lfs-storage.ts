/**
 * LFS storage bookkeeping shared by the API routes, repo deletion and
 * scheduled maintenance. Pure R2/D1 helpers; no request handling.
 */
import type { Env } from '../env.ts';
import { lfsObjectKey, lfsRepoPrefix } from './lfs.ts';

export interface LfsRepoStats {
	object_count: number;
	total_bytes: number;
	pending_count: number;
}

export async function lfsRepoStats(db: D1Database, repoId: string): Promise<LfsRepoStats> {
	const row = await db
		.prepare(
			`SELECT
			   COALESCE(SUM(CASE WHEN state = 'ready' THEN 1 ELSE 0 END), 0) AS object_count,
			   COALESCE(SUM(CASE WHEN state = 'ready' THEN size ELSE 0 END), 0) AS total_bytes,
			   COALESCE(SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count
			 FROM lfs_objects WHERE repo_id = ?`
		)
		.bind(repoId)
		.first<LfsRepoStats>();
	return row ?? { object_count: 0, total_bytes: 0, pending_count: 0 };
}

/**
 * Delete every LFS object of a repo from R2 (1000 keys per call, the R2
 * maximum) and the D1 rows. Safe to re-run; returns the number of keys removed.
 */
export async function deleteRepoLfsObjects(env: Env, repoId: string): Promise<number> {
	const prefix = lfsRepoPrefix(repoId);
	let cursor: string | undefined;
	let removed = 0;
	do {
		const page = await env.STORAGE.list({ prefix, cursor, limit: 1000 });
		const keys = page.objects.map((o) => o.key);
		if (keys.length) {
			await env.STORAGE.delete(keys);
			removed += keys.length;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	await env.DB.prepare('DELETE FROM lfs_objects WHERE repo_id = ?').bind(repoId).run();
	return removed;
}

/**
 * Reconcile `pending` rows older than `olderThanMs`: promote the ones whose
 * bytes did arrive in R2 (presigned upload without a verify call), delete the
 * rest (upload action issued, client never uploaded). Returns counts.
 */
export async function reconcileStalePendingLfs(env: Env, olderThanMs: number, limit = 100): Promise<{ promoted: number; purged: number }> {
	const cutoff = new Date(Date.now() - olderThanMs).toISOString();
	const { results } = await env.DB.prepare(
		`SELECT repo_id, oid FROM lfs_objects WHERE state = 'pending' AND julianday(created_at) < julianday(?) LIMIT ?`
	)
		.bind(cutoff, limit)
		.all<{ repo_id: string; oid: string }>();

	let promoted = 0;
	let purged = 0;
	for (const row of results) {
		const head = await env.STORAGE.head(lfsObjectKey(row.repo_id, row.oid));
		if (head) {
			await env.DB.prepare("UPDATE lfs_objects SET state = 'ready', size = ? WHERE repo_id = ? AND oid = ? AND state = 'pending'")
				.bind(head.size, row.repo_id, row.oid)
				.run();
			promoted++;
		} else {
			await env.DB.prepare("DELETE FROM lfs_objects WHERE repo_id = ? AND oid = ? AND state = 'pending'").bind(row.repo_id, row.oid).run();
			purged++;
		}
	}
	return { promoted, purged };
}
