/**
 * Helpers shared by the git Smart-HTTP routes (git.ts) and the Git LFS
 * routes (lfs.ts), which are mounted on the same /git/:repo prefix and share
 * its Basic-Auth middleware.
 */
import type { ApiKey } from '../env.ts';
import { checkRepoAccess, type AccessLevel } from '../lib/access.ts';
import { principalFrom } from '../middleware/auth.ts';
import type { LfsTokenClaims } from '../lib/lfs-token.ts';

/** Context variables set by the /git auth middleware. Exactly one of the two is present. */
export type GitAuthVariables = {
	apiKey?: ApiKey;
	/** A minted LFS bearer token (lib/lfs-token.ts); only honoured on LFS routes. */
	lfsToken?: LfsTokenClaims;
};

export type GitRepoRow = {
	id: string;
	name: string;
	is_private: number;
	default_branch: string | null;
	lfs_enabled: number;
	lfs_max_object_bytes: number | null;
};

/** `/:repo` param minus one trailing `.git` ("foo.git" → "foo", "a.github" unchanged). */
export function repoNameParam(raw: string): string {
	return raw.replace(/\.git$/, '');
}

export function findGitRepo(db: D1Database, name: string): Promise<GitRepoRow | null> {
	return db
		.prepare('SELECT id, name, is_private, default_branch, lfs_enabled, lfs_max_object_bytes FROM repositories WHERE name = ?')
		.bind(name)
		.first<GitRepoRow>();
}

export function unauthorized(): Response {
	return new Response('Unauthorized', {
		status: 401,
		headers: { 'WWW-Authenticate': 'Basic realm="GitFlare"' },
	});
}

/**
 * Check the authenticated key may perform `level` on the repo, via the shared
 * checkRepoAccess (permission level, key scope, is_private, repo_members).
 * Callers who can't even read the repo get a 404 so private names don't leak;
 * readers lacking `level` get a 403. Returns null when allowed.
 */
export async function denyGitAccess(
	db: D1Database,
	apiKey: ApiKey,
	repo: { id: string; is_private: boolean | number },
	level: AccessLevel
): Promise<Response | null> {
	const principal = principalFrom(null, apiKey);
	if (!principal) {
		return new Response('Forbidden: API key has an invalid permission level', { status: 403 });
	}
	if (!(await checkRepoAccess(principal, repo.id, repo.is_private, 'read', db))) {
		return new Response('Repository not found', { status: 404 });
	}
	if (level !== 'read' && !(await checkRepoAccess(principal, repo.id, repo.is_private, level, db))) {
		return new Response(`Forbidden: ${level} access to this repository required`, { status: 403 });
	}
	return null;
}
