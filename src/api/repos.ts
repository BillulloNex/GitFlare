import { Hono } from 'hono';
import type { Env, ApiKey } from '../env.ts';
import { auth, requirePermission } from '../middleware/auth.ts';
import { audit } from '../lib/audit.ts';

const app = new Hono<{ Bindings: Env; Variables: { apiKey: ApiKey } }>();

app.use('*', auth);

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

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  
  // Create in Artifacts
  try {
    await c.env.REPOS.create(body.name);
  } catch (err: any) {
    return c.json({ error: 'Failed to create repo in Artifacts: ' + err.message }, 500);
  }

  // Insert into D1
  await c.env.DB
    .prepare(
      `INSERT INTO repositories (id, name, description, is_private, default_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, body.name, body.description || null, body.is_private ? 1 : 0, body.default_branch || 'main', now, now)
    .run();

  await audit(c.env.DB, {
    repoId: id,
    actor: c.get('apiKey').id,
    action: 'repo.create',
    details: { name: body.name },
    ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined
  });

  return c.json({ id, name: body.name }, 201);
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
    // ArtifactNamespace might not have a delete method depending on specific binding implementation.
    // If it does, we call it. Assuming it does based on instructions.
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

  await audit(c.env.DB, {
    repoId: repo.id,
    actor: c.get('apiKey').id,
    action: 'repo.delete',
    details: { name: repoName },
    ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined
  });

  return c.json({ success: true });
});

export default app;
