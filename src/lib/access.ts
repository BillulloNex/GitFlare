/**
 * Repo-level access control. Single source of truth for REST middleware,
 * `git.ts`, and MCP tools.
 */

/** The only permission values a key (or derived principal) may carry. Anything else is denied. */
export const VALID_PERMISSIONS = ['read', 'write', 'admin'] as const;

export type AccessLevel = (typeof VALID_PERMISSIONS)[number];

export function isValidPermission(value: unknown): value is AccessLevel {
	return typeof value === 'string' && (VALID_PERMISSIONS as readonly string[]).includes(value);
}

/** True when `permissions` is a known level at or above `required`. Unknown levels never pass. */
export function meetsLevel(permissions: string | null | undefined, required: AccessLevel): boolean {
	return rank(permissions) >= rank(required) && rank(required) > 0;
}

/**
 * Map a `users.role` to the global permission level it grants.
 * `admin` → admin, `user` → write, `viewer` → read. Unknown roles → null (deny).
 */
export function roleToPermission(role: string | null | undefined): AccessLevel | null {
	switch (role) {
		case 'admin':
			return 'admin';
		case 'user':
			return 'write';
		case 'viewer':
			return 'read';
		default:
			return null;
	}
}

export interface AccessPrincipal {
	/** Owning user — session user, or `api_keys.user_id`. Absent for bootstrap/system keys. */
	userId?: string | null;
	/** API key id, when authenticated by key. */
	keyId?: string | null;
	/** `api_keys.repo_id` — when set, the key is limited to that one repo. */
	repoScope?: string | null;
	/** Global permission level: 'read' | 'write' | 'admin'. Anything else is denied. */
	permissions: string;
}

const LEVEL_RANK: Record<AccessLevel, number> = { read: 1, write: 2, admin: 3 };

function rank(level: string | null | undefined): number {
	return level && Object.hasOwn(LEVEL_RANK, level) ? LEVEL_RANK[level as AccessLevel] : 0;
}

/**
 * Decide whether `principal` may perform a `requiredLevel` operation on a repo.
 *
 * 1. Global `permissions` must be a known level and ≥ `requiredLevel`.
 * 2. A repo-scoped key may only touch its own repo.
 * 3. Keys without a `user_id` (bootstrap/system keys) stop here — global access.
 * 4. Global admins (`admin` role, or an `admin` key — which only an admin can
 *    mint) stop here too: they can see and manage every repo, private or not,
 *    without needing a `repo_members` row.
 * 5. Users: public repo + `read` → allowed. Everything else (any private-repo
 *    access, any write/admin on a public repo) requires a `repo_members` row
 *    whose role is ≥ `requiredLevel`.
 *
 * Note: the global level is a ceiling. A `repo_members.role = 'admin'` row
 * held by a `user`-role account grants at most `write`.
 */
export async function checkRepoAccess(
	principal: AccessPrincipal,
	repoId: string,
	repoIsPrivate: boolean | number,
	requiredLevel: AccessLevel,
	db: D1Database
): Promise<boolean> {
	const required = rank(requiredLevel);
	if (required === 0) return false;

	if (rank(principal.permissions) < required) return false;

	if (principal.repoScope && principal.repoScope !== repoId) return false;

	if (!principal.userId) return true;

	if (principal.permissions === 'admin') return true;

	if (!repoIsPrivate && requiredLevel === 'read') return true;

	const member = await db
		.prepare('SELECT role FROM repo_members WHERE repo_id = ? AND user_id = ?')
		.bind(repoId, principal.userId)
		.first<{ role: string }>();

	return rank(member?.role) >= required;
}

/**
 * SQL `WHERE` fragment (and its bind params) selecting the repositories that
 * `principal` may read. Mirrors `checkRepoAccess(…, 'read')`. Expects the
 * `repositories` table unaliased.
 */
export function readableReposFilter(principal: AccessPrincipal): { where: string; params: string[] } {
	if (rank(principal.permissions) < rank('read')) return { where: '0', params: [] };

	const clauses: string[] = [];
	const params: string[] = [];

	if (principal.repoScope) {
		clauses.push('repositories.id = ?');
		params.push(principal.repoScope);
	}

	// Users that aren't global admins only see public repos + repos they're members of.
	if (principal.userId && principal.permissions !== 'admin') {
		clauses.push('(repositories.is_private = 0 OR repositories.id IN (SELECT repo_id FROM repo_members WHERE user_id = ?))');
		params.push(principal.userId);
	}

	return { where: clauses.length ? clauses.join(' AND ') : '1', params };
}
