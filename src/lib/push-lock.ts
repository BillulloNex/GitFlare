/**
 * Per-repo push lock (RepoCoordinator DO) for server-side writers such as the
 * Onshape sync. Same DO contract as the git push path in src/api/git.ts, so a
 * server-side commit and a user's push to the same branch never interleave.
 */
import type { Env } from '../env.ts';

export async function acquirePushLock(
	env: Pick<Env, 'REPO_COORDINATOR'>,
	repoId: string,
	pusher: string,
	refNames: string[]
): Promise<{ lockId: string } | { error: string }> {
	try {
		const coordinator = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repoId));
		const res = await coordinator.fetch(
			new Request('https://do/lock', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ pusher, refs: refNames }),
			})
		);
		if (res.status === 409) return { error: 'another push is in progress for this ref' };
		if (!res.ok) return { error: `push lock request failed: HTTP ${res.status}` };
		const data = (await res.json()) as { lock_id?: string };
		return data.lock_id ? { lockId: data.lock_id } : { error: 'push lock response had no lock id' };
	} catch (err) {
		return { error: `push lock unavailable: ${err instanceof Error ? err.message : String(err)}` };
	}
}

export async function releasePushLock(env: Pick<Env, 'REPO_COORDINATOR'>, repoId: string, lockId: string): Promise<void> {
	try {
		const coordinator = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repoId));
		await coordinator.fetch(
			new Request('https://do/unlock', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ lock_id: lockId }),
			})
		);
	} catch (err) {
		console.error('[push-lock] release failed:', err instanceof Error ? err.message : String(err));
	}
}
