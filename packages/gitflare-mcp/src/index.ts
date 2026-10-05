import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GitFlareClient, GitFlareError } from '@gitflare/client';

const GITFLARE_URL = process.env.GITFLARE_URL || 'https://git.beenex.company';
const GITFLARE_API_KEY = process.env.GITFLARE_API_KEY;

if (!GITFLARE_API_KEY) {
  console.error('Error: GITFLARE_API_KEY environment variable is required');
  process.exit(1);
}

const client = new GitFlareClient({ baseUrl: GITFLARE_URL, apiKey: GITFLARE_API_KEY });

const server = new McpServer({
  name: 'gitflare',
  version: '1.0.0',
});

function handleError(err: unknown) {
  const msg = err instanceof GitFlareError ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

server.tool(
  'gitflare_health',
  'Check GitFlare health',
  {},
  async () => {
    try {
      const result = await client.health();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_repo_list',
  'List repositories',
  { limit: z.number().optional(), offset: z.number().optional() },
  async ({ limit, offset }) => {
    try {
      const result = await client.repos.list(limit, offset);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_repo_create',
  'Create a repository',
  { name: z.string(), description: z.string().optional(), is_private: z.boolean().optional(), default_branch: z.string().optional() },
  async ({ name, description, is_private, default_branch }) => {
    try {
      const result = await client.repos.create({ name, description, is_private, default_branch });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_repo_info',
  'Get repository info',
  { name: z.string() },
  async ({ name }) => {
    try {
      const result = await client.repos.get(name);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_repo_delete',
  'Delete a repository',
  { name: z.string() },
  async ({ name }) => {
    try {
      const result = await client.repos.delete(name);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_key_list',
  'List API keys',
  {},
  async () => {
    try {
      const result = await client.keys.list();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_key_create',
  'Create an API key',
  { name: z.string(), permissions: z.enum(['read', 'write', 'admin']).optional(), repo_id: z.string().optional(), expires_in_days: z.number().optional() },
  async ({ name, permissions, repo_id, expires_in_days }) => {
    try {
      const result = await client.keys.create({ name, permissions, repo_id, expires_in_days });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_key_revoke',
  'Revoke an API key',
  { id: z.string() },
  async ({ id }) => {
    try {
      const result = await client.keys.revoke(id);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_ci_runs',
  'Get CI runs for a repository',
  { repo: z.string() },
  async ({ repo }) => {
    try {
      const result = await client.ci.runs(repo);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_ci_trigger',
  'Trigger a CI run',
  { repo: z.string(), branch: z.string().optional() },
  async ({ repo, branch }) => {
    try {
      const result = await client.ci.trigger(repo, { branch });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_ci_status',
  'Get status of a CI run',
  { repo: z.string(), run_id: z.string() },
  async ({ repo, run_id }) => {
    try {
      const result = await client.ci.status(repo, run_id);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_ci_logs',
  'Get logs for a CI job',
  { repo: z.string(), run_id: z.string(), job_id: z.string() },
  async ({ repo, run_id, job_id }) => {
    try {
      const result = await client.ci.logs(repo, run_id, job_id);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_files_tree',
  'Get a file tree of a repository',
  { repo: z.string(), ref: z.string().optional().default('main'), path: z.string().optional().default('/') },
  async ({ repo, ref, path }) => {
    try {
      const result = await client.files.tree(repo, ref, path);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_files_read',
  'Read a file blob',
  { repo: z.string(), path: z.string(), ref: z.string().optional().default('main') },
  async ({ repo, path, ref }) => {
    try {
      const result = await client.files.blob(repo, ref, path);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_commits_list',
  'List commits',
  { repo: z.string(), ref: z.string().optional().default('main'), limit: z.number().optional().default(20) },
  async ({ repo, ref, limit }) => {
    try {
      const result = await client.commits.list(repo, ref, limit);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_deploy_list',
  'List deployments',
  { repo: z.string() },
  async ({ repo }) => {
    try {
      const result = await client.deploys.list(repo);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_deploy_add',
  'Add a deployment configuration',
  { repo: z.string(), name: z.string(), type: z.enum(['coolify', 'cloudflare']), coolify_app_id: z.string().optional(), coolify_base_url: z.string().optional(), coolify_api_key: z.string().optional(), branch_filter: z.array(z.string()).optional() },
  async ({ repo, name, type, coolify_app_id, coolify_base_url, coolify_api_key, branch_filter }) => {
    try {
      const result = await client.deploys.create(repo, { name, type, coolify_app_id, coolify_base_url, coolify_api_key, branch_filter });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_mirror_get',
  'Get mirror configuration',
  { repo: z.string() },
  async ({ repo }) => {
    try {
      const result = await client.mirrors.get(repo);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_mirror_setup',
  'Setup a mirror',
  { repo: z.string(), github_url: z.string(), github_token: z.string().optional(), branch_filter: z.array(z.string()).optional() },
  async ({ repo, github_url, github_token, branch_filter }) => {
    try {
      const result = await client.mirrors.setup(repo, { github_url, github_token, branch_filter });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_mirror_sync',
  'Sync a mirror',
  { repo: z.string() },
  async ({ repo }) => {
    try {
      const result = await client.mirrors.sync(repo);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

server.tool(
  'gitflare_git_remote_url',
  'Get git remote URL for a repository',
  { repo: z.string() },
  async ({ repo }) => {
    try {
      const result = client.gitRemoteUrl(repo);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return handleError(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('GitFlare MCP server running on stdio');
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
