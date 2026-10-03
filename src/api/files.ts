import { Hono } from 'hono';
import type { Env } from '../env.ts';
import type { AuthVariables } from '../middleware/auth.ts';
import { getBranches, getRepoTree, getRepoBlob } from '../lib/repo-store.ts';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/**
 * GET /:repo/branches
 * List branches for repository
 */
app.get('/:repo/branches', async (c) => {
  const repoName = c.req.param('repo');
  const branches = getBranches(repoName);
  return c.json({ data: branches });
});

/**
 * GET /:repo/tree
 * Browse repository directory tree (GitHub-style)
 */
app.get('/:repo/tree', async (c) => {
  const repoName = c.req.param('repo');
  const path = c.req.query('path') || '';
  const ref = c.req.query('ref') || 'main';

  // Check repo existence in D1
  const repo = await c.env.DB.prepare('SELECT * FROM repositories WHERE name = ?').bind(repoName).first();
  if (!repo && repoName.toLowerCase() !== 'starship') {
    return c.json({ error: 'Repository not found' }, 404);
  }

  const tree = getRepoTree(repoName, path, ref);
  return c.json({ data: tree });
});

/**
 * GET /:repo/blob
 * Get file content, lines, metadata (GitHub-style)
 */
app.get('/:repo/blob', async (c) => {
  const repoName = c.req.param('repo');
  const filePath = c.req.query('path') || '';
  const ref = c.req.query('ref') || 'main';

  if (!filePath) {
    return c.json({ error: 'path query parameter is required' }, 400);
  }

  const blob = getRepoBlob(repoName, filePath, ref);
  if (!blob) {
    return c.json({ error: 'File not found' }, 404);
  }

  return c.json({ data: blob });
});

/**
 * GET /:repo/raw
 * Serve raw file contents directly
 */
app.get('/:repo/raw', async (c) => {
  const repoName = c.req.param('repo');
  const filePath = c.req.query('path') || '';
  const ref = c.req.query('ref') || 'main';

  const blob = getRepoBlob(repoName, filePath, ref);
  if (!blob) {
    return c.text('Not Found', 404);
  }

  let contentType = 'text/plain; charset=utf-8';
  if (filePath.endsWith('.md')) contentType = 'text/markdown; charset=utf-8';
  else if (filePath.endsWith('.json')) contentType = 'application/json';
  else if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) contentType = 'text/yaml';
  else if (filePath.endsWith('.html')) contentType = 'text/html';
  else if (filePath.endsWith('.ts') || filePath.endsWith('.js')) contentType = 'text/javascript';

  return new Response(blob.content, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=60'
    }
  });
});

/**
 * Legacy file route: /:repo/files/*
 */
app.get('/:repo/files/*', async (c) => {
  const repoName = c.req.param('repo');
  const wildcardPath = c.req.param('*') || '';
  const ref = c.req.query('ref') || 'main';

  const blob = getRepoBlob(repoName, wildcardPath, ref);
  if (blob) {
    return c.json({
      repo: repoName,
      path: wildcardPath,
      ref,
      name: blob.name,
      content: blob.content,
      size: blob.size,
      lines: blob.lines
    });
  }

  const tree = getRepoTree(repoName, wildcardPath, ref);
  return c.json({
    repo: repoName,
    path: wildcardPath,
    ref,
    listing: tree.entries.map(e => ({ name: e.name, type: e.type === 'tree' ? 'directory' : 'file', size: e.size || 0 }))
  });
});

export default app;
