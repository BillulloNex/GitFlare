import { describe, expect, it } from 'vitest';
import {
	checkRepoAccess,
	isValidPermission,
	meetsLevel,
	readableReposFilter,
	roleToPermission,
	type AccessLevel,
	type AccessPrincipal,
} from '../src/lib/access.ts';

// ─── Fake D1: only the repo_members lookup checkRepoAccess performs ───

const REPO = 'repo-1';
const OTHER_REPO = 'repo-2';
const USER = 'user-1';

function fakeDb(members: Record<string, string> = {}) {
	const queries: unknown[][] = [];
	const db = {
		prepare(sql: string) {
			expect(sql).toMatch(/FROM repo_members WHERE repo_id = \? AND user_id = \?/);
			return {
				bind(...params: unknown[]) {
					queries.push(params);
					const [repoId, userId] = params as [string, string];
					return {
						async first() {
							const role = members[`${repoId}:${userId}`];
							return role ? { role } : null;
						},
					};
				},
			};
		},
	};
	return { db: db as unknown as D1Database, queries };
}

const LEVELS: AccessLevel[] = ['read', 'write', 'admin'];
const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };
const KEY_LEVELS = ['read', 'write', 'admin', 'owner', ''] as const; // last two are invalid
const SCOPES = [
	{ label: 'unscoped', repoScope: null },
	{ label: 'scoped to this repo', repoScope: REPO },
	{ label: 'scoped to another repo', repoScope: OTHER_REPO },
] as const;
const PRIVATE = [false, true] as const;

// ─── Matrix 1: system keys (no user_id) — `permissions` + scope are the only gates ───

describe('permission matrix: system keys (no user_id)', () => {
	const cases = KEY_LEVELS.flatMap((perm) =>
		SCOPES.flatMap((scope) =>
			PRIVATE.flatMap((isPrivate) =>
				LEVELS.map((required) => {
					const levelOk = (RANK[perm] ?? 0) >= RANK[required];
					const scopeOk = scope.repoScope === null || scope.repoScope === REPO;
					return { perm, scope, isPrivate, required, expected: levelOk && scopeOk };
				}),
			),
		),
	);

	it.each(cases)(
		'key=$perm $scope.label private=$isPrivate requires $required → $expected',
		async ({ perm, scope, isPrivate, required, expected }) => {
			const { db, queries } = fakeDb();
			const principal: AccessPrincipal = { keyId: 'k', repoScope: scope.repoScope, permissions: perm };
			expect(await checkRepoAccess(principal, REPO, isPrivate, required, db)).toBe(expected);
			expect(queries).toHaveLength(0); // never consults repo_members
		},
	);

	it('accepts D1 integer booleans for is_private', async () => {
		const { db } = fakeDb();
		expect(await checkRepoAccess({ permissions: 'read' }, REPO, 1, 'read', db)).toBe(true);
		expect(await checkRepoAccess({ permissions: 'read' }, REPO, 0, 'read', db)).toBe(true);
	});
});

// ─── Matrix 2: user-owned keys / sessions ───
// Expected values are spelled out explicitly rather than derived, so the
// table reads as the access spec.

type Row = [perm: string, scope: string | null, isPrivate: boolean, member: string | null, required: AccessLevel, expected: boolean];

const USER_MATRIX: Row[] = [
	// Public repo, read: anyone with ≥ read, no membership needed
	['read', null, false, null, 'read', true],
	['write', null, false, null, 'read', true],
	// Public repo, write: needs membership ≥ write
	['write', null, false, null, 'write', false],
	['write', null, false, 'read', 'write', false],
	['write', null, false, 'write', 'write', true],
	['write', null, false, 'admin', 'write', true],
	// Global level is a ceiling: member admin + key write cannot do admin
	['write', null, false, 'admin', 'admin', false],
	// read key can't write even as a repo admin
	['read', null, false, 'admin', 'write', false],
	['read', null, true, 'admin', 'read', true],
	// Private repo: any access needs membership
	['read', null, true, null, 'read', false],
	['write', null, true, null, 'read', false],
	['write', null, true, 'read', 'read', true],
	['write', null, true, 'read', 'write', false],
	['write', null, true, 'write', 'write', true],
	// Unknown member role grants nothing
	['write', null, true, 'owner', 'read', false],
	// Global admins bypass membership entirely
	['admin', null, true, null, 'read', true],
	['admin', null, true, null, 'write', true],
	['admin', null, true, null, 'admin', true],
	['admin', null, false, null, 'admin', true],
	// Repo scope: this repo behaves as unscoped; other repo always denied
	['write', REPO, true, 'write', 'write', true],
	['write', OTHER_REPO, false, 'write', 'read', false],
	['write', OTHER_REPO, true, 'write', 'write', false],
	['admin', OTHER_REPO, true, null, 'read', false],
	// Invalid key level never passes
	['owner', null, false, 'admin', 'read', false],
	['', null, false, 'admin', 'read', false],
];

describe('permission matrix: user principals', () => {
	it.each(USER_MATRIX)(
		'key=%s scope=%s private=%s member=%s requires %s → %s',
		async (perm, scope, isPrivate, member, required, expected) => {
			const { db } = fakeDb(member ? { [`${REPO}:${USER}`]: member } : {});
			const principal: AccessPrincipal = { userId: USER, keyId: 'k', repoScope: scope, permissions: perm };
			expect(await checkRepoAccess(principal, REPO, isPrivate, required, db)).toBe(expected);
		},
	);

	it('looks up membership for this repo and user only', async () => {
		const { db, queries } = fakeDb({ [`${OTHER_REPO}:${USER}`]: 'admin' });
		expect(await checkRepoAccess({ userId: USER, permissions: 'write' }, REPO, true, 'read', db)).toBe(false);
		expect(queries).toEqual([[REPO, USER]]);
	});

	it('denies an unknown required level without touching the db', async () => {
		const { db, queries } = fakeDb();
		const bogus = 'superuser' as AccessLevel;
		expect(await checkRepoAccess({ permissions: 'admin' }, REPO, false, bogus, db)).toBe(false);
		expect(queries).toHaveLength(0);
	});
});

describe('readableReposFilter', () => {
	it('matches nothing for an invalid level', () => {
		expect(readableReposFilter({ permissions: 'nope' })).toEqual({ where: '0', params: [] });
	});

	it('matches everything for an unscoped system key or a global admin', () => {
		expect(readableReposFilter({ permissions: 'read' })).toEqual({ where: '1', params: [] });
		expect(readableReposFilter({ userId: USER, permissions: 'admin' })).toEqual({ where: '1', params: [] });
	});

	it('limits a scoped key to its repo', () => {
		expect(readableReposFilter({ permissions: 'write', repoScope: REPO })).toEqual({
			where: 'repositories.id = ?',
			params: [REPO],
		});
	});

	it('limits users to public repos and their memberships, combined with scope', () => {
		const f = readableReposFilter({ userId: USER, permissions: 'write', repoScope: REPO });
		expect(f.where).toBe(
			'repositories.id = ? AND (repositories.is_private = 0 OR repositories.id IN (SELECT repo_id FROM repo_members WHERE user_id = ?))',
		);
		expect(f.params).toEqual([REPO, USER]);
	});
});

describe('level helpers', () => {
	it('meetsLevel ranks read < write < admin and rejects unknown values', () => {
		expect(meetsLevel('admin', 'write')).toBe(true);
		expect(meetsLevel('write', 'write')).toBe(true);
		expect(meetsLevel('read', 'write')).toBe(false);
		expect(meetsLevel('owner', 'read')).toBe(false);
		expect(meetsLevel(null, 'read')).toBe(false);
		expect(meetsLevel('toString', 'read')).toBe(false); // no prototype lookups
	});

	it('roleToPermission maps user roles', () => {
		expect(roleToPermission('admin')).toBe('admin');
		expect(roleToPermission('user')).toBe('write');
		expect(roleToPermission('viewer')).toBe('read');
		expect(roleToPermission('guest')).toBeNull();
		expect(roleToPermission(undefined)).toBeNull();
	});

	it('isValidPermission accepts only the three levels', () => {
		expect(LEVELS.every(isValidPermission)).toBe(true);
		expect(isValidPermission('ADMIN')).toBe(false);
		expect(isValidPermission(3)).toBe(false);
	});
});
