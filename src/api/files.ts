import { Hono } from 'hono';
import type { Env } from '../env.ts';
import type { AuthVariables } from '../middleware/auth.ts';
// repo-store.ts static data no longer used — all repos read from Artifacts
import { getArtifactBlob, getArtifactBranches, getArtifactRawFile, getArtifactTree } from '../lib/artifact-reader.ts';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/**
 * GET /:repo/branches
 * List branches for repository
 */
app.get('/:repo/branches', async (c) => {
  const repoName = c.req.param('repo');
  const repo = await c.env.DB.prepare('SELECT default_branch FROM repositories WHERE name = ?').bind(repoName).first<{ default_branch: string }>();
  const branches = await getArtifactBranches(c.env, repoName, repo?.default_branch || 'main');
  if (!repo && branches.length === 0) return c.json({ error: 'Repository not found' }, 404);
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

  const tree = await getArtifactTree(c.env, repoName, path, ref);
  if (!tree) return c.json({ error: 'Directory not found' }, 404);
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

  const blob = await getArtifactBlob(c.env, repoName, filePath, ref);
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

  const file = await getArtifactRawFile(c.env, repoName, filePath, ref);
  if (!file) return c.text('Not Found', 404);
  return new Response(file, {
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'Cache-Control': 'private, max-age=60'
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

  const blob = await getArtifactBlob(c.env, repoName, wildcardPath, ref);
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

  const tree = await getArtifactTree(c.env, repoName, wildcardPath, ref);
  if (!tree) return c.json({ error: 'Path not found' }, 404);
  return c.json({
    repo: repoName,
    path: wildcardPath,
    ref,
    listing: tree.entries.map(e => ({ name: e.name, type: e.type === 'tree' ? 'directory' : 'file', size: e.size || 0 }))
  });
});

export default app;
