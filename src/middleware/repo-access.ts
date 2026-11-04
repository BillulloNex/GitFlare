import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { Env, RepoRecord } from '../env.ts';
import { principalFrom, type AuthVariables } from './auth.ts';
import { checkRepoAccess, type AccessLevel, type AccessPrincipal } from '../lib/access.ts';
import { isValidRepoName } from '../lib/repo-validation.ts';

/**
 * Context variables available to every handler under `/api/repos/:repo`.
 * Set by `repoAccess`, which runs after `auth`.
 */
export type RepoVariables = AuthVariables & {
	repoRecord: RepoRecord;
	principal: AccessPrincipal;
};

type RepoEnv = { Bindings: Env; Variables: RepoVariables };

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Repo access gate for `/api/repos/:repo` and `/api/repos/:repo/*`.
 *
 * - Resolves the repo from D1 (404 if missing or the name is invalid).
 * - Read methods need `read`; every other method needs `write` — on a public
 *   repo that still means a `repo_members` row (or global admin / system key).
 * - Callers without read access get a 404, so private repo names don't leak.
 * - Attaches `repoRecord` and `principal` to the context.
 *
 * Handlers that need `admin` add `requireRepoLevel('admin')` on top.
 */
export const repoAccess = createMiddleware<RepoEnv>(async (c, next) => {
	// `/:repo` and `/:repo/*` can both match one request — only resolve once.
	if (c.get('repoRecord')) return await next();

	const repoName = c.req.param('repo');
	if (!repoName || !isValidRepoName(repoName)) {
		return c.json({ error: 'Repository not found' }, 404);
	}

	const principal = principalFrom(c.get('user'), c.get('apiKey'));
	if (!principal) {
		return c.json({ error: 'Forbidden: unrecognised role or permission level' }, 403);
	}

	const repo = await c.env.DB
		.prepare('SELECT * FROM repositories WHERE name = ?')
		.bind(repoName)
		.first<RepoRecord>();
	if (!repo) {
		return c.json({ error: 'Repository not found' }, 404);
	}

	if (!(await checkRepoAccess(principal, repo.id, repo.is_private, 'read', c.env.DB))) {
		return c.json({ error: 'Repository not found' }, 404);
	}

	if (!READ_METHODS.has(c.req.method)) {
		if (!(await checkRepoAccess(principal, repo.id, repo.is_private, 'write', c.env.DB))) {
			return c.json({ error: 'Forbidden: write access to this repository required' }, 403);
		}
	}

	c.set('repoRecord', repo);
	c.set('principal', principal);
	await next();
});

/**
 * True when the caller holds `level` on the current repo.
 * Only valid inside handlers mounted behind `repoAccess`.
 */
export function hasRepoLevel(c: Context<RepoEnv>, level: AccessLevel): Promise<boolean> {
	const repo = c.get('repoRecord');
	const principal = c.get('principal');
	if (!repo || !principal) return Promise.resolve(false);
	return checkRepoAccess(principal, repo.id, repo.is_private, level, c.env.DB);
}

/** Per-route guard requiring `level` on the current repo (on top of `repoAccess`). */
export const requireRepoLevel = (level: AccessLevel) =>
	createMiddleware<RepoEnv>(async (c, next) => {
		if (!(await hasRepoLevel(c, level))) {
			return c.json({ error: `Forbidden: ${level} access to this repository required` }, 403);
		}
		await next();
	});

/** Audit actor + IP for the current request. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any app whose Variables include AuthVariables
export function auditContext(c: Context<any>): { actor: string; ipAddress?: string } {
	const user = c.get('user') as AuthVariables['user'] | undefined;
	const apiKey = c.get('apiKey') as AuthVariables['apiKey'] | undefined;
	return {
		actor: user?.id ?? apiKey?.id ?? 'system',
		ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined,
	};
}
