import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { requirePermission } from '../middleware/auth.ts';
import type { AuthVariables } from '../middleware/auth.ts';
import { audit } from '../lib/audit.ts';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/**
 * List repositories with pagination.
 */
app.get('/', async (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 50, 100);
  const offset = Number(c.req.query('offset')) || 0;

  const { results } = await c.env.DB
    .prepare('SELECT * FROM repositories ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .bind(limit, offset)
    .all();

  return c.json({ repos: results, limit, offset });
});

/**
 * Create a new repository in Artifacts and D1.
 */
app.post('/', requirePermission('write'), async (c) => {
  const body = await c.req.json<{ name: string; description?: string; is_private?: boolean; default_branch?: string }>();
  
  if (!body.name) {
    return c.json({ error: 'Name is required' }, 400);
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
    if (!err.message?.includes('already exists')) {
      return c.json({ error: 'Failed to create repo in Artifacts: ' + err.message }, 500);
    }
  }

  // Insert into D1
  await c.env.DB
    .prepare(
      `INSERT INTO repositories (id, name, description, is_private, default_branch, artifact_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, body.name, body.description || null, body.is_private ? 1 : 0, body.default_branch || 'main', body.name, now, now)
    .run();

  const user = c.get('user');
  const apiKey = c.get('apiKey');
  await audit(c.env.DB, {
    repoId: id,
    actor: user?.id ?? apiKey?.id ?? 'system',
    action: 'repo.create',
    details: { name: body.name },
    ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined
  });

  return c.json({ id, name: body.name }, 201);
});

/**
 * Update repository metadata.
 */
app.patch('/:repo', requirePermission('write'), async (c) => {
  const repoName = c.req.param('repo');

  const repo = await c.env.DB
    .prepare('SELECT id FROM repositories WHERE name = ?')
    .bind(repoName)
    .first<{ id: string }>();

  if (!repo) {
    return c.json({ error: 'Repository not found' }, 404);
  }

  const body = await c.req.json<{ description?: string; is_private?: boolean }>();
  const sets: string[] = [];
  const values: (string | number)[] = [];

  if (body.description !== undefined) {
    sets.push('description = ?');
    values.push(body.description);
  }
  if (body.is_private !== undefined) {
    sets.push('is_private = ?');
    values.push(body.is_private ? 1 : 0);
  }

  if (sets.length === 0) {
    return c.json({ error: 'Nothing to update' }, 400);
  }

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(repoName);

  await c.env.DB
    .prepare(`UPDATE repositories SET ${sets.join(', ')} WHERE name = ?`)
    .bind(...values)
    .run();

  const user = c.get('user');
  const apiKey = c.get('apiKey');
  await audit(c.env.DB, {
    repoId: repo.id,
    actor: user?.id ?? apiKey?.id ?? 'system',
    action: 'repo.update',
    details: body,
    ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined
  });

  return c.json({ success: true });
});

/**
 * Get repository details.
 */
app.get('/:repo', async (c) => {
  const repoName = c.req.param('repo');

  const repo = await c.env.DB
    .prepare('SELECT * FROM repositories WHERE name = ?')
    .bind(repoName)
    .first();

  if (!repo) {
    return c.json({ error: 'Repository not found' }, 404);
  }

  let remoteUrl = null;
  try {
    const artifactRepo = await c.env.REPOS.get(repoName);
    if (artifactRepo) {
      remoteUrl = artifactRepo.remote;
    }
  } catch (err) {
    // Ignore Artifacts lookup errors or consider it missing remote
  }

  return c.json({ ...repo, remote: remoteUrl });
});

/**
 * Delete a repository from Artifacts and D1.
 */
app.delete('/:repo', requirePermission('admin'), async (c) => {
  const repoName = c.req.param('repo');

  const repo = await c.env.DB
    .prepare('SELECT id FROM repositories WHERE name = ?')
    .bind(repoName)
    .first<{ id: string }>();

  if (!repo) {
    return c.json({ error: 'Repository not found' }, 404);
  }

  try {
    if ((c.env.REPOS as any).delete) {
      await (c.env.REPOS as any).delete(repoName);
    }
  } catch (err) {
    // Ignore Artifacts delete errors
  }

  await c.env.DB
    .prepare('DELETE FROM repositories WHERE name = ?')
    .bind(repoName)
    .run();

  const user = c.get('user');
  const apiKey = c.get('apiKey');
  await audit(c.env.DB, {
    repoId: repo.id,
    actor: user?.id ?? apiKey?.id ?? 'system',
    action: 'repo.delete',
    details: { name: repoName },
    ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined
  });

  return c.json({ success: true });
});

// ─── Branch Protection Management ──────────────────────────────

/**
 * List branch protection rules for a repo.
 */
app.get('/:repo/protection', async (c) => {
  const repoName = c.req.param('repo');
  const repo = await c.env.DB
    .prepare('SELECT id FROM repositories WHERE name = ?')
    .bind(repoName)
    .first<{ id: string }>();

  if (!repo) {
    return c.json({ error: 'Repository not found' }, 404);
  }

  const { results } = await c.env.DB
    .prepare('SELECT * FROM protected_branches WHERE repo_id = ? ORDER BY created_at')
    .bind(repo.id)
    .all();

  return c.json({ rules: results });
});

/**
 * Update a branch protection rule (toggle enforcement, set bypass actors, etc).
 */
app.patch('/:repo/protection/:ruleId', requirePermission('admin'), async (c) => {
  const repoName = c.req.param('repo');
  const ruleId = c.req.param('ruleId');

  const repo = await c.env.DB
    .prepare('SELECT id FROM repositories WHERE name = ?')
    .bind(repoName)
    .first<{ id: string }>();

  if (!repo) {
    return c.json({ error: 'Repository not found' }, 404);
  }

  const rule = await c.env.DB
    .prepare('SELECT * FROM protected_branches WHERE id = ? AND repo_id = ?')
    .bind(ruleId, repo.id)
    .first();

  if (!rule) {
    return c.json({ error: 'Protection rule not found' }, 404);
  }

  const body = await c.req.json<{
    enforce_merge_queue?: boolean;
    allow_force_push?: boolean;
    allow_deletion?: boolean;
    bypass_actors?: string[];
  }>();

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

  const user = c.get('user');
  const apiKey = c.get('apiKey');
  await audit(c.env.DB, {
    repoId: repo.id,
    actor: user?.id ?? apiKey?.id ?? 'system',
    action: 'branch_protection.update',
    details: { ruleId, ...body },
    ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined
  });

  return c.json({ success: true });
});

/**
 * Delete a branch protection rule.
 */
app.delete('/:repo/protection/:ruleId', requirePermission('admin'), async (c) => {
  const repoName = c.req.param('repo');
  const ruleId = c.req.param('ruleId');

  const repo = await c.env.DB
    .prepare('SELECT id FROM repositories WHERE name = ?')
    .bind(repoName)
    .first<{ id: string }>();

  if (!repo) {
    return c.json({ error: 'Repository not found' }, 404);
  }

  await c.env.DB
    .prepare('DELETE FROM protected_branches WHERE id = ? AND repo_id = ?')
    .bind(ruleId, repo.id)
    .run();

  const user = c.get('user');
  const apiKey = c.get('apiKey');
  await audit(c.env.DB, {
    repoId: repo.id,
    actor: user?.id ?? apiKey?.id ?? 'system',
    action: 'branch_protection.delete',
    details: { ruleId },
    ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined
  });

  return c.json({ success: true });
});

export default app;
