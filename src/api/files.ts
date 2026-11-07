import { Hono } from 'hono';
import type { Env } from '../env.ts';
import type { RepoVariables } from '../middleware/repo-access.ts';
import { getArtifactBlob, getArtifactRefs, getArtifactRawFile, getArtifactTree } from '../lib/artifact-reader.ts';
import { publicOrigin } from './lfs.ts';

// All routes run behind repoAccess (src/index.ts), which 404s unknown repos
// and enforces read access before any Artifacts lookup.
const app = new Hono<{ Bindings: Env; Variables: RepoVariables }>();

/** Image types served inline from /raw. Everything else is text/plain. SVG is deliberately excluded (scriptable). */
const INLINE_IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** Extensions a browser could render as an active document — always downloaded, never displayed. */
const FORCE_DOWNLOAD_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'xht', 'shtml', 'svg', 'svgz', 'xml', 'xsl', 'mht', 'mhtml']);

function fileExtension(path: string): string {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** RFC 6266 `Content-Disposition` with an ASCII fallback and a UTF-8 filename*. */
function contentDisposition(type: 'inline' | 'attachment', path: string): string {
  const name = path.split('/').pop() || 'file';
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * GET /:repo/branches
 * List branches for repository
 */
app.get('/:repo/branches', async (c) => {
  const repo = c.get('repoRecord');
  const repoName = repo.name;
  const defaultBranch = repo.default_branch || 'main';
  const refs = await getArtifactRefs(c.env, repoName);
  const branches = [...refs]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => {
      const name = ref.slice('refs/heads/'.length);
      return { name, is_default: name === defaultBranch, commit_sha: sha };
    })
    .sort((a, b) => (a.is_default === b.is_default ? a.name.localeCompare(b.name) : a.is_default ? -1 : 1));
  return c.json({ data: branches });
});

/**
 * GET /:repo/tree
 * Browse repository directory tree (GitHub-style)
 */
app.get('/:repo/tree', async (c) => {
  const repo = c.get('repoRecord');
  const repoName = repo.name;
  const path = c.req.query('path') || '';
  const ref = c.req.query('ref') || repo.default_branch || 'main';

  const tree = await getArtifactTree(c.env, repoName, path, ref);
  if (!tree) return c.json({ error: 'Directory not found' }, 404);
  return c.json({ data: tree });
});

/**
 * GET /:repo/blob
 * Get file content, lines, metadata (GitHub-style)
 */
app.get('/:repo/blob', async (c) => {
  const repo = c.get('repoRecord');
  const repoName = repo.name;
  const filePath = c.req.query('path') || '';
  const ref = c.req.query('ref') || repo.default_branch || 'main';

  if (!filePath) {
    return c.json({ error: 'path query parameter is required' }, 400);
  }

  const blob = await getArtifactBlob(c.env, repoName, filePath, ref);
  if (!blob) {
    return c.json({ error: 'File not found' }, 404);
  }

  if (blob.lfs) {
    const row = await c.env.DB.prepare('SELECT state FROM lfs_objects WHERE repo_id = ? AND oid = ?')
      .bind(repo.id, blob.lfs.oid)
      .first<{ state: 'ready' | 'pending' }>();
    const state = row?.state ?? 'missing';
    const origin = publicOrigin(c.env, c.req.url);
    blob.lfs = {
      ...blob.lfs,
      state,
      download_url: `${origin}/api/repos/${encodeURIComponent(repoName)}/lfs/objects/${blob.lfs.oid}?filename=${encodeURIComponent(blob.name)}`,
      note:
        state === 'ready'
          ? 'Large file stored in Git LFS. Use download_url to fetch the bytes; do not edit the pointer text.'
          : 'Git LFS pointer whose object is not available on this server (upload incomplete or pushed without git-lfs).',
    };
  }

  return c.json({ data: blob });
});

/**
 * GET /:repo/raw
 * Serve raw file contents. Repo content is attacker-controlled, so it must
 * never execute on this origin: everything is text/plain except allowlisted
 * raster images, sniffing is off, the response is CSP-sandboxed, and
 * HTML/SVG-like files are forced to download.
 */
app.get('/:repo/raw', async (c) => {
  const repo = c.get('repoRecord');
  const repoName = repo.name;
  const filePath = c.req.query('path') || '';
  const ref = c.req.query('ref') || repo.default_branch || 'main';

  const file = await getArtifactRawFile(c.env, repoName, filePath, ref);
  if (!file) return c.text('Not Found', 404);

  const ext = fileExtension(filePath);
  const imageType = INLINE_IMAGE_TYPES[ext];
  const forceDownload = FORCE_DOWNLOAD_EXTENSIONS.has(ext);

  return new Response(file, {
    headers: {
      'Content-Type': imageType ?? 'text/plain; charset=utf-8',
      'Content-Disposition': contentDisposition(forceDownload ? 'attachment' : 'inline', filePath),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'private, max-age=60'
    }
  });
});

/**
 * Legacy file route: /:repo/files/*
 */
app.get('/:repo/files/*', async (c) => {
  const repo = c.get('repoRecord');
  const repoName = repo.name;
  const wildcardPath = c.req.param('*') || '';
  const ref = c.req.query('ref') || repo.default_branch || 'main';

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
