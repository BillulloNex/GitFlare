import { Hono } from 'hono';
import type { Env, ApiKey } from '../env.ts';
import { auth, requirePermission } from '../middleware/auth.ts';

const app = new Hono<{ Bindings: Env; Variables: { apiKey: ApiKey } }>();

app.use('*', auth, requirePermission('read'));

/**
 * Browse files in a repository.
 * Route expected to be mounted at /api/repos and path matched is /:repo/files/*
 */
app.get('/:repo/files/*', async (c) => {
  const repoName = c.req.param('repo');
  const path = c.req.param('*');
  const ref = c.req.query('ref') || 'main';

  try {
    const artifactRepo = await c.env.REPOS.get(repoName);
    if (!artifactRepo) {
      return c.json({ error: 'Repository not found in Artifacts' }, 404);
    }
    
    // Create a scoped read token to interact with the repository
    const readToken = await artifactRepo.createToken('read', 300);
    
    // In a full implementation, we would make a subrequest to the ArtifactRepo's remote URL
    // using the readToken to browse files or retrieve file contents via Git Smart HTTP or similar.
    // For now, we return a reasonable placeholder demonstrating the pattern.
    return c.json({
      repo: repoName,
      path: path || '/',
      ref,
      message: 'File browsing not fully implemented, requires Artifacts API integration.',
      listing: [
        { name: 'README.md', type: 'file', size: 1024 },
        { name: 'src', type: 'directory', size: 0 }
      ],
      token_generated: !!readToken
    });
  } catch (err: any) {
    return c.json({ error: 'Error fetching files: ' + err.message }, 500);
  }
});

export default app;
