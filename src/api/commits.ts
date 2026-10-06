import { Hono } from 'hono';
import type { Env, ApiKey } from '../env.ts';
// repo-store.ts static data no longer used — all repos read from Artifacts
import { getArtifactCommits, getArtifactCommitDetail } from '../lib/artifact-reader.ts';

const app = new Hono<{ Bindings: Env; Variables: { apiKey?: ApiKey } }>();

/**
 * GET /:repo/commits
 * List commits for a repository with CI status integration
 */
app.get('/:repo/commits', async (c) => {
  const repoName = c.req.param('repo');
  const branch = c.req.query('branch') || 'main';

  // Check repo
  const repo = await c.env.DB.prepare('SELECT id, name FROM repositories WHERE name = ?').bind(repoName).first<{ id: string, name: string }>();

  const commits = await getArtifactCommits(c.env, repoName, branch);
  if (!repo && commits.length === 0) {
    return c.json({ error: 'Repository not found' }, 404);
  }

  // If repo exists in D1, enrich with latest CI run statuses
  if (repo) {
    try {
      const { results: runs } = await c.env.DB
        .prepare('SELECT id, commit_sha, status FROM ci_runs WHERE repo_id = ? ORDER BY created_at DESC')
        .bind(repo.id)
        .all<{ id: string, commit_sha: string, status: 'passed' | 'failed' | 'running' | 'queued' | 'cancelled' }>();

      if (runs && runs.length > 0) {
        // Map recent CI run statuses to commits
        for (let i = 0; i < commits.length; i++) {
          const commit = commits[i];
          const matchingRun = runs.find(r => 
            r.commit_sha === commit.sha || 
            r.commit_sha === commit.short_sha ||
            (i === 0 && r.commit_sha === 'HEAD')
          );
          if (matchingRun) {
            commit.ci_status = matchingRun.status === 'cancelled' ? 'failed' : matchingRun.status;
            commit.ci_run_id = matchingRun.id;
          }
        }
      }
    } catch (e) {
      // Ignore D1 query error, fallback to static CI status
    }
  }

  return c.json({
    repo: repoName,
    branch,
    data: commits
  });
});

/**
 * GET /:repo/commits/:sha
 * Get single commit detail with file diffs and patches
 */
app.get('/:repo/commits/:sha', async (c) => {
  const repoName = c.req.param('repo');
  const sha = c.req.param('sha');

  const commit = await getArtifactCommitDetail(c.env, repoName, sha);
  if (!commit) {
    return c.json({ error: 'Commit not found' }, 404);
  }

  // Cross-reference with D1 CI runs if available
  try {
    const repo = await c.env.DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(repoName).first<{ id: string }>();
    if (repo) {
      const run = await c.env.DB
        .prepare('SELECT id, status FROM ci_runs WHERE repo_id = ? AND (commit_sha = ? OR commit_sha = ?) ORDER BY created_at DESC')
        .bind(repo.id, commit.sha, commit.short_sha)
        .first<{ id: string, status: string }>();
      if (run) {
        commit.ci_status = run.status as any;
        commit.ci_run_id = run.id;
      }
    }
  } catch (e) {
    // Ignore error
  }

  return c.json({
    repo: repoName,
    data: commit
  });
});

export default app;
