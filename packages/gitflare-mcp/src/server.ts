/**
 * GitFlare MCP tool definitions — the ONLY MCP server implementation.
 *
 * Every tool is a thin wrapper over the REST API via `@gitflare/client`, so
 * authorization is enforced by the REST layer using whatever credentials the
 * injected client carries. Used by:
 *   - `index.ts`  (stdio, key from GITFLARE_API_KEY)
 *   - `http.ts`   (Streamable HTTP, caller's Bearer key per request)
 *   - the Worker's `/mcp` route (src/api/mcp.ts, caller's credentials, in-process)
 *
 * Must stay runtime-neutral (no `process`, no Node built-ins) — it is bundled
 * into the Cloudflare Worker.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GitFlareClient, GitFlareError } from '@gitflare/client';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const msg = err instanceof GitFlareError || err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

/** Wrap a client call: JSON-encode the result, turn any throw into an MCP error result. */
function run<A>(fn: (args: A) => Promise<unknown> | unknown) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

const refDescription = "Branch, tag or SHA (default: the repo's default branch)";

export function createServer(client: GitFlareClient): McpServer {
  const server = new McpServer(
    { name: 'gitflare', version: '1.0.0' },
    {
      instructions:
        'GitFlare is a git host. Repos are cloned/pushed with ordinary git over HTTPS using an API key as the password. ' +
        'Files over 32 MB must be committed through Git LFS (git lfs track "<pattern>"); GitFlare rejects oversized blobs with a fix recipe. ' +
        'Use gitflare_lfs_status before committing large artifacts. gitflare_files_read returns a structured `lfs` object for LFS pointer files — fetch bytes via its download_url, never edit the pointer text.',
    }
  );

  // ── Health ──
  server.tool('gitflare_health', 'Check GitFlare health', {}, run(() => client.health()));

  // ── Repos ──
  server.tool(
    'gitflare_repo_list',
    'List repositories you can read',
    {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 50, max 100)'),
      offset: z.number().int().min(0).optional().describe('Pagination offset'),
    },
    run(async ({ limit, offset }) => {
      const l = limit ?? 50;
      const o = offset ?? 0;
      return { repos: await client.repos.list(l, o), limit: l, offset: o };
    }),
  );

  server.tool(
    'gitflare_repo_create',
    'Create a repository (private by default)',
    {
      name: z.string(),
      description: z.string().optional(),
      is_private: z.boolean().optional().describe('Default: true'),
      default_branch: z.string().optional().describe('Default: main'),
    },
    run(({ name, description, is_private, default_branch }) =>
      client.repos.create({ name, description, is_private: is_private ?? true, default_branch }),
    ),
  );

  server.tool(
    'gitflare_repo_info',
    'Get repository info',
    { name: z.string() },
    run(({ name }) => client.repos.get(name)),
  );

  server.tool(
    'gitflare_repo_delete',
    'Delete a repository (requires admin on the repo)',
    { name: z.string() },
    run(({ name }) => client.repos.delete(name)),
  );

  // ── API Keys ──
  server.tool('gitflare_key_list', 'List API keys', {}, run(async () => ({ keys: await client.keys.list() })));

  server.tool(
    'gitflare_key_create',
    'Create an API key (cannot exceed your own permission level)',
    {
      name: z.string(),
      permissions: z.enum(['read', 'write', 'admin']).optional().describe('Default: read'),
      repo_id: z.string().optional().describe('Scope the key to one repository'),
      expires_in_days: z.number().int().positive().optional(),
    },
    run(({ name, permissions, repo_id, expires_in_days }) =>
      client.keys.create({ name, permissions, repo_id, expires_in_days }),
    ),
  );

  server.tool(
    'gitflare_key_revoke',
    'Revoke an API key',
    { id: z.string() },
    run(({ id }) => client.keys.revoke(id)),
  );

  // ── CI ──
  server.tool(
    'gitflare_ci_runs',
    'List CI runs for a repository (newest first)',
    {
      repo: z.string(),
      limit: z.number().int().min(1).max(100).optional().describe('Default 25'),
      status: z.enum(['queued', 'running', 'passed', 'failed', 'cancelled']).optional(),
    },
    run(async ({ repo, limit, status }) => ({ runs: await client.ci.runs(repo, { limit, status }) })),
  );

  server.tool(
    'gitflare_ci_trigger',
    'Trigger a CI run on a branch tip (or a specific commit)',
    {
      repo: z.string(),
      branch: z.string().optional().describe("Default: the repo's default branch"),
      commit_sha: z.string().optional(),
    },
    run(({ repo, branch, commit_sha }) => client.ci.trigger(repo, { branch, commit_sha })),
  );

  server.tool(
    'gitflare_ci_status',
    'Get a CI run with its jobs and steps',
    { repo: z.string(), run_id: z.string() },
    run(async ({ repo, run_id }) => {
      // raw_steps duplicates jobs[].steps — drop it to keep tool output compact.
      const { raw_steps: _raw, ...detail } = await client.ci.status(repo, run_id);
      return detail;
    }),
  );

  server.tool(
    'gitflare_ci_logs',
    'Get CI logs. Without step_index: the last ~50 lines of every step (quick view). ' +
      'With step_index: the full log of that step.',
    {
      repo: z.string(),
      run_id: z.string(),
      step_index: z.number().int().min(0).optional().describe('Run-wide step index (the `index` field from the quick view)'),
    },
    run(async ({ repo, run_id, step_index }) =>
      step_index === undefined
        ? { steps: await client.ci.logs(repo, run_id) }
        : client.ci.stepLog(repo, run_id, step_index),
    ),
  );

  server.tool(
    'gitflare_ci_cancel',
    'Cancel a queued or running CI run',
    { repo: z.string(), run_id: z.string() },
    run(({ repo, run_id }) => client.ci.cancel(repo, run_id)),
  );

  // ── Files ──
  server.tool(
    'gitflare_files_tree',
    'Get a file tree of a repository',
    {
      repo: z.string(),
      ref: z.string().optional().describe(refDescription),
      path: z.string().optional().describe('Directory path (default: repo root)'),
    },
    run(({ repo, ref, path }) => client.files.tree(repo, ref, path)),
  );

  server.tool(
    'gitflare_files_read',
    'Read a file. For a Git LFS pointer the result has is_lfs=true and an `lfs` object (oid, size, state, download_url, note): the real bytes are not in `content`.',
    { repo: z.string(), path: z.string(), ref: z.string().optional().describe(refDescription) },
    run(({ repo, path, ref }) => client.files.blob(repo, ref, path)),
  );

  // ── Git LFS ──
  server.tool(
    'gitflare_lfs_status',
    'Git LFS status for a repo: whether uploads are enabled, transfer mode, max object size, object count/bytes, tracked patterns from .gitattributes, endpoint. Files over 32 MB must go through LFS.',
    { repo: z.string() },
    run(({ repo }) => client.lfs.status(repo)),
  );

  server.tool(
    'gitflare_lfs_list',
    'List Git LFS objects stored for a repo (oid, size, state, created_at), newest first',
    {
      repo: z.string(),
      limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
      offset: z.number().int().min(0).optional(),
    },
    run(({ repo, limit, offset }) => client.lfs.list(repo, { limit, offset })),
  );

  // ── Commits ──
  server.tool(
    'gitflare_commits_list',
    'List commits on a branch (newest first)',
    {
      repo: z.string(),
      branch: z.string().optional().describe("Default: the repo's default branch"),
      ref: z.string().optional().describe('Deprecated alias for branch'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
    },
    run(async ({ repo, branch, ref, limit }) => ({ commits: await client.commits.list(repo, branch ?? ref, limit ?? 20) })),
  );

  // ── Deploys ──
  server.tool(
    'gitflare_deploy_list',
    'List deployment targets',
    { repo: z.string() },
    run(async ({ repo }) => ({ targets: await client.deploys.list(repo) })),
  );

  server.tool(
    'gitflare_deploy_add',
    'Add a deployment target (requires admin on the repo)',
    {
      repo: z.string(),
      name: z.string(),
      type: z.enum(['coolify', 'cloudflare', 'cloudrun']),
      coolify_app_id: z.string().optional(),
      coolify_base_url: z.string().optional(),
      coolify_api_key: z.string().optional(),
      wrangler_config: z.string().optional().describe('Cloudflare: wrangler config path'),
      gcp_project_id: z.string().optional().describe('Cloud Run: GCP project id'),
      gcp_region: z.string().optional().describe('Cloud Run: region, e.g. us-central1'),
      gcp_service: z.string().optional().describe('Cloud Run: service name'),
      gcp_service_account_key: z.string().optional().describe('Cloud Run: service-account JSON key (omit to use the runner key)'),
      branch_filter: z.array(z.string()).optional(),
    },
    run(({ repo, ...input }) => client.deploys.create(repo, input)),
  );

  // ── Mirrors ──
  server.tool(
    'gitflare_mirror_get',
    'Get GitHub mirror configuration',
    { repo: z.string() },
    run(async ({ repo }) => ({ mirror: await client.mirrors.get(repo) })),
  );

  server.tool(
    'gitflare_mirror_setup',
    'Create or update a GitHub mirror (requires admin on the repo)',
    {
      repo: z.string(),
      github_url: z.string(),
      github_token: z.string().describe('GitHub token with push access to the target repo'),
      branch_filter: z.array(z.string()).optional(),
    },
    run(({ repo, github_url, github_token, branch_filter }) =>
      client.mirrors.setup(repo, { github_url, github_token, branch_filter }),
    ),
  );

  server.tool(
    'gitflare_mirror_sync',
    'Trigger a full mirror sync (all filtered branches + tags, at current SHAs)',
    { repo: z.string() },
    run(({ repo }) => client.mirrors.sync(repo)),
  );

  // ── Git Remote URL ──
  server.tool(
    'gitflare_git_remote_url',
    'Get the git remote URL for a repository (authenticate with any username and an API key as password)',
    { repo: z.string() },
    run(({ repo }) => ({ url: client.gitRemoteUrl(repo) })),
  );

  return server;
}
