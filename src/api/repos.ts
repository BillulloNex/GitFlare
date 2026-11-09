import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { principalFrom, requirePermission } from '../middleware/auth.ts';
import { auditContext, hasRepoLevel, requireRepoLevel, type RepoVariables } from '../middleware/repo-access.ts';
import { audit } from '../lib/audit.ts';
import { checkRepoAccess, isValidPermission, readableReposFilter, VALID_PERMISSIONS } from '../lib/access.ts';
import { isValidRefName, isValidRepoName } from '../lib/repo-validation.ts';
import { isOptionalBoolean, isOptionalString, readJsonObject } from '../lib/request.ts';
import { deleteRepoLfsObjects } from '../lib/lfs-storage.ts';
import { lfsSummary } from './lfs-api.ts';
import { publicOrigin } from './lfs.ts';
import { githubApi, installationToken } from '../lib/github-app.ts';

// Routes under /:repo run behind repoAccess (src/index.ts), which sets
// `repoRecord` + `principal` and enforces read (GET) / write (other methods).
const app = new Hono<{ Bindings: Env; Variables: RepoVariables }>();

/**
 * List repositories the caller can read, with pagination.
 * Private repos only appear for members, global admins, and system keys.
 */
app.get('/', async (c) => {
  const principal = principalFrom(c.get('user'), c.get('apiKey'));
  if (!principal) {
    return c.json({ error: 'Forbidden: unrecognised role or permission level' }, 403);
  }

  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const filter = readableReposFilter(principal);

  const { results } = await c.env.DB
    .prepare(`SELECT * FROM repositories WHERE ${filter.where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...filter.params, limit, offset)
    .all();

  return c.json({ repos: results, limit, offset });
});

/**
 * Create a new repository in Artifacts and D1. The creator becomes an
 * `admin` member (system keys without a user have global access already).
 */
app.post('/', requirePermission('write'), async (c) => {
  const principal = principalFrom(c.get('user'), c.get('apiKey'));
  if (!principal) {
    return c.json({ error: 'Forbidden: unrecognised role or permission level' }, 403);
  }
  if (principal.repoScope) {
    return c.json({ error: 'Forbidden: this API key is scoped to a single repository' }, 403);
  }

  const body = await readJsonObject<{ name: string; description?: string | null; is_private?: boolean; default_branch?: string }>(c);
  if (!body || typeof body.name !== 'string' || !body.name) {
    return c.json({ error: 'Name is required' }, 400);
  }
  if ((body.description !== null && !isOptionalString(body.description)) || !isOptionalBoolean(body.is_private)) {
    return c.json({ error: 'description must be a string and is_private a boolean' }, 400);
  }
  if (!isValidRepoName(body.name)) {
    return c.json({ error: 'Invalid repository name: use 1-100 of A-Z a-z 0-9 . _ - (no leading "-", no trailing ".git")' }, 400);
  }
  const defaultBranch = body.default_branch || 'main';
  if (typeof defaultBranch !== 'string' || !isValidRefName(defaultBranch)) {
    return c.json({ error: 'Invalid default_branch' }, 400);
  }

  // Check if repo already exists in D1
  const existing = await c.env.DB
    .prepare('SELECT id FROM repositories WHERE name = ?')
    .bind(body.name)
    .first();
  if (existing) {
    return c.json({ error: 'Repository already exists' }, 409);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  
  // Create in Artifacts (idempotent — ignore "already exists")
  try {
    await c.env.REPOS.create(body.name);
  } catch (err: any) {
    // If it already exists in Artifacts, that's fine — just continue
    if (!err?.message?.includes('already exists')) {
      console.error(`Artifacts create failed for ${body.name}:`, err);
      return c.json({ error: 'Failed to create repository storage' }, 500);
    }
  }

  // Insert repo + default-branch protection + creator membership atomically.
  // The protection row forces pushes to the default branch through the merge
  // queue (which pushes to Artifacts directly, not via git.ts).
  const statements = [
    c.env.DB
      .prepare(
        `INSERT INTO repositories (id, name, description, is_private, default_branch, artifact_name, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, body.name, body.description || null, body.is_private ? 1 : 0, defaultBranch, body.name, principal.userId, now, now),
    c.env.DB
      .prepare('INSERT OR IGNORE INTO protected_branches (id, repo_id, branch_pattern, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), id, defaultBranch, now, now),
  ];
  if (principal.userId) {
    statements.push(
      c.env.DB
        .prepare("INSERT INTO repo_members (repo_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)")
        .bind(id, principal.userId, now)
    );
  }
  await c.env.DB.batch(statements);

  const ctx = auditContext(c);
  await audit(c.env.DB, {
    repoId: id,
    actor: ctx.actor,
    action: 'repo.create',
    details: { name: body.name },
    ipAddress: ctx.ipAddress
  });

  return c.json({ id, name: body.name }, 201);
});

/** Legacy/system-created repositories may have no owner after migration.
 * An authenticated repo admin can claim one so their compute connections pay. */
app.post('/:repo/owner/claim', requireRepoLevel('admin'), async (c) => {
	const user = c.get('user');
	if (!user) return c.json({ error: 'Sign in to claim repository ownership' }, 403);
	const repo = c.get('repoRecord');
	const result = await c.env.DB.prepare('UPDATE repositories SET owner_id = ? WHERE id = ? AND owner_id IS NULL')
		.bind(user.id, repo.id).run();
	if (!result.meta.changes) return c.json({ error: 'Repository already has an owner' }, 409);
	return c.json({ owner_id: user.id });
});

/**
 * Update repository metadata. Changing `is_private` requires repo admin.
 */
app.patch('/:repo', async (c) => {
  const repo = c.get('repoRecord');

  const body = await readJsonObject<{
    description?: string | null;
    is_private?: boolean;
    lfs_enabled?: boolean;
    lfs_max_object_bytes?: number | null;
  }>(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  if ((body.description !== null && !isOptionalString(body.description)) || !isOptionalBoolean(body.is_private)) {
    return c.json({ error: 'description must be a string and is_private a boolean' }, 400);
  }
  if (!isOptionalBoolean(body.lfs_enabled)) return c.json({ error: 'lfs_enabled must be a boolean' }, 400);
  const lfsMax = body.lfs_max_object_bytes;
  if (lfsMax !== undefined && lfsMax !== null && !(Number.isInteger(lfsMax) && (lfsMax as number) > 0)) {
    return c.json({ error: 'lfs_max_object_bytes must be a positive integer or null' }, 400);
  }

  const adminOnly = body.is_private !== undefined || body.lfs_enabled !== undefined || lfsMax !== undefined;
  if (adminOnly && !(await hasRepoLevel(c, 'admin'))) {
    return c.json({ error: 'Forbidden: changing visibility or LFS policy requires admin access to this repository' }, 403);
  }

  const sets: string[] = [];
  const values: (string | number)[] = [];

  if (body.description !== undefined) {
    sets.push('description = ?');
    values.push(String(body.description));
  }
  if (body.is_private !== undefined) {
    sets.push('is_private = ?');
    values.push(body.is_private ? 1 : 0);
  }
  if (body.lfs_enabled !== undefined) {
    sets.push('lfs_enabled = ?');
    values.push(body.lfs_enabled ? 1 : 0);
  }
  if (lfsMax !== undefined) {
    sets.push('lfs_max_object_bytes = ?');
    values.push(lfsMax as number | null as any);
  }

  if (sets.length === 0) {
    return c.json({ error: 'Nothing to update' }, 400);
  }

  // Never make a repo private in GitFlare while a managed CI mirror remains
  // public on GitHub. A failed mirror update leaves GitFlare visibility alone.
  if (body.is_private === true && !repo.is_private) {
    const { results: mirrors } = await c.env.DB.prepare(
      'SELECT m.full_name, m.connection_id, cc.installation_id FROM github_ci_mirrors m JOIN github_compute_connections cc ON cc.id = m.connection_id WHERE m.repo_id = ? AND m.is_private = 0'
    ).bind(repo.id).all<{ full_name: string; connection_id: string; installation_id: number }>();
    for (const mirror of mirrors) {
      try {
        const token = await installationToken(c.env, mirror.installation_id);
        const response = await githubApi(`/repos/${mirror.full_name}`, token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ private: true }) });
        if (!response.ok) return c.json({ error: `Could not make CI mirror ${mirror.full_name} private on GitHub (${response.status})` }, 502);
        await c.env.DB.prepare('UPDATE github_ci_mirrors SET is_private = 1 WHERE repo_id = ? AND connection_id = ?')
          .bind(repo.id, mirror.connection_id).run();
      } catch (err) { return c.json({ error: `Could not update CI mirror privacy: ${String(err)}` }, 502); }
    }
  }

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(repo.id);

  await c.env.DB
    .prepare(`UPDATE repositories SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const ctx = auditContext(c);
  await audit(c.env.DB, {
    repoId: repo.id,
    actor: ctx.actor,
    action: 'repo.update',
    details: { description: body.description, is_private: body.is_private, lfs_enabled: body.lfs_enabled, lfs_max_object_bytes: lfsMax },
    ipAddress: ctx.ipAddress
  });

  return c.json({ success: true });
});

/**
 * Get repository details.
 */
app.get('/:repo', async (c) => {
  const repo = c.get('repoRecord');
  const principal = c.get('principal');

  let remoteUrl = null;
  try {
    const artifactRepo = await c.env.REPOS.get(repo.name);
    if (artifactRepo) {
      remoteUrl = artifactRepo.remote;
    }
  } catch (err) {
    // Remote URL is informational; a lookup failure just leaves it null
  }

  const lfs = await lfsSummary(c.env, publicOrigin(c.env, c.req.url), repo);
  const access = {
    can_read: await checkRepoAccess(principal, repo.id, repo.is_private, 'read', c.env.DB),
    can_write: await checkRepoAccess(principal, repo.id, repo.is_private, 'write', c.env.DB),
    can_admin: await checkRepoAccess(principal, repo.id, repo.is_private, 'admin', c.env.DB),
  };
  return c.json({ ...repo, remote: remoteUrl, lfs, access });
});

/**
 * Delete a repository from Artifacts and D1.
 * An Artifacts failure aborts the delete (500) so D1 never forgets a repo
 * whose git data still exists.
 */
app.delete('/:repo', requireRepoLevel('admin'), async (c) => {
  const repo = c.get('repoRecord');

  try {
    const artifactRepo = await c.env.REPOS.get(repo.name);
    if (artifactRepo) {
      await c.env.REPOS.delete(repo.name);
    }
  } catch (err: any) {
    console.error(`Artifacts delete failed for ${repo.name}:`, err);
    return c.json({ error: 'Failed to delete repository storage; repository was not deleted' }, 500);
  }

  await c.env.DB
    .prepare('DELETE FROM repositories WHERE id = ?')
    .bind(repo.id)
    .run();

  // LFS objects live under one R2 prefix per repo; remove them after the
  // response (best effort — maintenance can't see them any more, but re-running
  // deleteRepoLfsObjects for the id is safe if it ever needs to be redone).
  c.executionCtx.waitUntil(
    deleteRepoLfsObjects(c.env, repo.id).catch((err) => console.error(`LFS cleanup failed for ${repo.name} (${repo.id}):`, err))
  );

  const ctx = auditContext(c);
  await audit(c.env.DB, {
    repoId: repo.id,
    actor: ctx.actor,
    action: 'repo.delete',
    details: { name: repo.name },
    ipAddress: ctx.ipAddress
  });

  return c.json({ success: true });
});

// ─── Member Management ─────────────────────────────────────────

/**
 * List repo members.
 */
app.get('/:repo/members', async (c) => {
  const repo = c.get('repoRecord');
  const { results } = await c.env.DB
    .prepare(
      `SELECT rm.user_id, rm.role, rm.created_at, u.email, u.name
       FROM repo_members rm LEFT JOIN users u ON u.id = rm.user_id
       WHERE rm.repo_id = ? ORDER BY rm.created_at`
    )
    .bind(repo.id)
    .all();
  return c.json({ members: results });
});

/**
 * Add a member or change their role. Body: `{ user_id | email, role }`.
 */
app.post('/:repo/members', requireRepoLevel('admin'), async (c) => {
  const repo = c.get('repoRecord');
  const body = await readJsonObject<{ user_id?: string; email?: string; role?: string }>(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  const role = body.role ?? 'read';
  if (!isValidPermission(role)) {
    return c.json({ error: `role must be one of: ${VALID_PERMISSIONS.join(', ')}` }, 400);
  }

  let target: { id: string; email: string } | null = null;
  if (typeof body.user_id === 'string' && body.user_id) {
    target = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(body.user_id).first();
  } else if (typeof body.email === 'string' && body.email) {
    target = await c.env.DB
      .prepare('SELECT id, email FROM users WHERE lower(email) = lower(?)')
      .bind(body.email.trim())
      .first();
  } else {
    return c.json({ error: 'user_id or email is required' }, 400);
  }
  if (!target) {
    return c.json({ error: 'User not found (they must sign in once before being added)' }, 404);
  }

  await c.env.DB
    .prepare(
      `INSERT INTO repo_members (repo_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (repo_id, user_id) DO UPDATE SET role = excluded.role`
    )
    .bind(repo.id, target.id, role, new Date().toISOString())
    .run();

  const ctx = auditContext(c);
  await audit(c.env.DB, {
    repoId: repo.id,
    actor: ctx.actor,
    action: 'repo.member.upsert',
    details: { user_id: target.id, role },
    ipAddress: ctx.ipAddress
  });

  return c.json({ repo_id: repo.id, user_id: target.id, email: target.email, role }, 201);
});

/**
 * Remove a member. The last `admin` member can't be removed (global admins
 * can still manage the repo, but owners shouldn't lock themselves out by accident).
 */
app.delete('/:repo/members/:userId', requireRepoLevel('admin'), async (c) => {
  const repo = c.get('repoRecord');
  const userId = c.req.param('userId');

  const member = await c.env.DB
    .prepare('SELECT role FROM repo_members WHERE repo_id = ? AND user_id = ?')
    .bind(repo.id, userId)
    .first<{ role: string }>();
  if (!member) return c.json({ error: 'Member not found' }, 404);

  if (member.role === 'admin') {
    const admins = await c.env.DB
      .prepare("SELECT COUNT(*) AS n FROM repo_members WHERE repo_id = ? AND role = 'admin'")
      .bind(repo.id)
      .first<{ n: number }>();
    if ((admins?.n ?? 0) <= 1) {
      return c.json({ error: 'Cannot remove the last admin member of this repository' }, 409);
    }
  }

  await c.env.DB
    .prepare('DELETE FROM repo_members WHERE repo_id = ? AND user_id = ?')
    .bind(repo.id, userId)
    .run();

  const ctx = auditContext(c);
  await audit(c.env.DB, {
    repoId: repo.id,
    actor: ctx.actor,
    action: 'repo.member.remove',
    details: { user_id: userId },
    ipAddress: ctx.ipAddress
  });

  return c.json({ success: true });
});

// ─── Branch Protection Management ──────────────────────────────

/**
 * List branch protection rules for a repo.
 */
app.get('/:repo/protection', async (c) => {
  const repo = c.get('repoRecord');

  const { results } = await c.env.DB
    .prepare('SELECT * FROM protected_branches WHERE repo_id = ? ORDER BY created_at')
    .bind(repo.id)
    .all();

  return c.json({ rules: results });
});

/**
 * Update a branch protection rule (toggle enforcement, set bypass actors, etc).
 */
app.patch('/:repo/protection/:ruleId', requireRepoLevel('admin'), async (c) => {
  const repo = c.get('repoRecord');
  const ruleId = c.req.param('ruleId');

  const rule = await c.env.DB
    .prepare('SELECT * FROM protected_branches WHERE id = ? AND repo_id = ?')
    .bind(ruleId, repo.id)
    .first();

  if (!rule) {
    return c.json({ error: 'Protection rule not found' }, 404);
  }

  const body = await readJsonObject<{
    enforce_merge_queue?: boolean;
    allow_force_push?: boolean;
    allow_deletion?: boolean;
    bypass_actors?: string[];
  }>(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  if (!isOptionalBoolean(body.enforce_merge_queue) || !isOptionalBoolean(body.allow_force_push) || !isOptionalBoolean(body.allow_deletion)) {
    return c.json({ error: 'enforce_merge_queue, allow_force_push and allow_deletion must be booleans' }, 400);
  }
  if (body.bypass_actors !== undefined && !(Array.isArray(body.bypass_actors) && body.bypass_actors.every((a) => typeof a === 'string'))) {
    return c.json({ error: 'bypass_actors must be an array of strings' }, 400);
  }

  const sets: string[] = [];
  const values: (string | number)[] = [];

  if (body.enforce_merge_queue !== undefined) {
    sets.push('enforce_merge_queue = ?');
    values.push(body.enforce_merge_queue ? 1 : 0);
  }
  if (body.allow_force_push !== undefined) {
    sets.push('allow_force_push = ?');
    values.push(body.allow_force_push ? 1 : 0);
  }
  if (body.allow_deletion !== undefined) {
    sets.push('allow_deletion = ?');
    values.push(body.allow_deletion ? 1 : 0);
  }
  if (body.bypass_actors !== undefined) {
    sets.push('bypass_actors = ?');
    values.push(JSON.stringify(body.bypass_actors));
  }

  if (sets.length === 0) {
    return c.json({ error: 'Nothing to update' }, 400);
  }

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(ruleId);
  values.push(repo.id);

  await c.env.DB
    .prepare(`UPDATE protected_branches SET ${sets.join(', ')} WHERE id = ? AND repo_id = ?`)
    .bind(...values)
    .run();

  const ctx = auditContext(c);
  await audit(c.env.DB, {
    repoId: repo.id,
    actor: ctx.actor,
    action: 'branch_protection.update',
    details: { ruleId, ...body },
    ipAddress: ctx.ipAddress
  });

  return c.json({ success: true });
});

/**
 * Delete a branch protection rule.
 */
app.delete('/:repo/protection/:ruleId', requireRepoLevel('admin'), async (c) => {
  const repo = c.get('repoRecord');
  const ruleId = c.req.param('ruleId');

  await c.env.DB
    .prepare('DELETE FROM protected_branches WHERE id = ? AND repo_id = ?')
    .bind(ruleId, repo.id)
    .run();

  const ctx = auditContext(c);
  await audit(c.env.DB, {
    repoId: repo.id,
    actor: ctx.actor,
    action: 'branch_protection.delete',
    details: { ruleId },
    ipAddress: ctx.ipAddress
  });

  return c.json({ success: true });
});

export default app;
