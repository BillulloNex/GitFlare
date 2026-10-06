/**
 * MCP (Model Context Protocol) endpoint for GitFlare.
 * 
 * Serves a Streamable HTTP MCP server at /mcp, giving AI agents
 * direct access to GitFlare's D1 database and Artifacts storage.
 * 
 * Auth: requires a valid API key (Bearer token) — same as /api/* routes.
 */
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { Env } from '../env.ts';
import type { AuthVariables } from '../middleware/auth.ts';
import { getArtifactTree, getArtifactBlob, getArtifactCommits } from '../lib/artifact-reader.ts';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

function registerTools(server: McpServer, env: Env) {
	const { DB } = env;

	// ── Health ──
	server.tool('gitflare_health', 'Check GitFlare health', {}, async () => {
		return { content: [{ type: 'text', text: JSON.stringify({ service: 'gitflare', status: 'ok', version: env.GITFLARE_VERSION ?? '1.0.0' }) }] };
	});

	// ── Repos ──
	server.tool('gitflare_repo_list', 'List repositories', {
		limit: z.number().optional().describe('Max results (default 50, max 100)'),
		offset: z.number().optional().describe('Pagination offset'),
	}, async ({ limit, offset }) => {
		const l = Math.min(limit ?? 50, 100);
		const o = offset ?? 0;
		const { results } = await DB.prepare('SELECT * FROM repositories ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(l, o).all();
		return { content: [{ type: 'text', text: JSON.stringify({ repos: results, limit: l, offset: o }, null, 2) }] };
	});

	server.tool('gitflare_repo_create', 'Create a repository', {
		name: z.string(),
		description: z.string().optional(),
		is_private: z.boolean().optional(),
		default_branch: z.string().optional(),
	}, async ({ name, description, is_private, default_branch }) => {
		const existing = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(name).first();
		if (existing) return { content: [{ type: 'text', text: 'Error: Repository already exists' }], isError: true };
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		try { await env.REPOS.create(name); } catch (err: any) {
			if (!err.message?.includes('already exists')) return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
		}
		await DB.prepare('INSERT INTO repositories (id, name, description, is_private, default_branch, artifact_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
			.bind(id, name, description || null, is_private ? 1 : 0, default_branch || 'main', name, now, now).run();
		return { content: [{ type: 'text', text: JSON.stringify({ id, name }, null, 2) }] };
	});

	server.tool('gitflare_repo_info', 'Get repository info', {
		name: z.string(),
	}, async ({ name }) => {
		const repo = await DB.prepare('SELECT * FROM repositories WHERE name = ?').bind(name).first();
		if (!repo) return { content: [{ type: 'text', text: 'Error: Repository not found' }], isError: true };
		let remoteUrl = null;
		try { const ar = await env.REPOS.get(name); if (ar) remoteUrl = ar.remote; } catch {}
		return { content: [{ type: 'text', text: JSON.stringify({ ...repo, remote: remoteUrl }, null, 2) }] };
	});

	server.tool('gitflare_repo_delete', 'Delete a repository', {
		name: z.string(),
	}, async ({ name }) => {
		const repo = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(name).first<{ id: string }>();
		if (!repo) return { content: [{ type: 'text', text: 'Error: Repository not found' }], isError: true };
		try { if ((env.REPOS as any).delete) await (env.REPOS as any).delete(name); } catch {}
		await DB.prepare('DELETE FROM repositories WHERE name = ?').bind(name).run();
		return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
	});

	// ── API Keys ──
	server.tool('gitflare_key_list', 'List API keys', {}, async () => {
		const { results } = await DB.prepare('SELECT id, name, key_prefix, repo_id, permissions, created_at, expires_at, last_used_at FROM api_keys ORDER BY created_at DESC').all();
		return { content: [{ type: 'text', text: JSON.stringify({ keys: results }, null, 2) }] };
	});

	server.tool('gitflare_key_create', 'Create an API key', {
		name: z.string(),
		permissions: z.enum(['read', 'write', 'admin']).optional(),
		repo_id: z.string().optional(),
		expires_in_days: z.number().optional(),
	}, async ({ name, permissions, repo_id, expires_in_days }) => {
		const perm = permissions || 'read';
		const rawKey = `gf_${crypto.randomUUID().replace(/-/g, '')}`;
		const keyPrefix = rawKey.substring(0, 8);
		const encoder = new TextEncoder();
		const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawKey));
		const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
		const id = crypto.randomUUID();
		const expiresAt = expires_in_days ? new Date(Date.now() + expires_in_days * 86400000).toISOString() : null;
		await DB.prepare("INSERT INTO api_keys (id, name, key_hash, key_prefix, repo_id, permissions, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)")
			.bind(id, name, keyHash, keyPrefix, repo_id || null, perm, expiresAt).run();
		return { content: [{ type: 'text', text: JSON.stringify({ id, key: rawKey, key_prefix: keyPrefix, permissions: perm, expires_at: expiresAt }, null, 2) }] };
	});

	server.tool('gitflare_key_revoke', 'Revoke an API key', {
		id: z.string(),
	}, async ({ id }) => {
		const target = await DB.prepare('SELECT id FROM api_keys WHERE id = ?').bind(id).first();
		if (!target) return { content: [{ type: 'text', text: 'Error: API key not found' }], isError: true };
		await DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run();
		return { content: [{ type: 'text', text: JSON.stringify({ success: true, revoked: id }) }] };
	});

	// ── CI ──
	server.tool('gitflare_ci_runs', 'Get CI runs for a repository', {
		repo: z.string(),
	}, async ({ repo }) => {
		const repoRecord = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(repo).first<{ id: string }>();
		if (!repoRecord) return { content: [{ type: 'text', text: 'Error: Repo not found' }], isError: true };
		const { results } = await DB.prepare('SELECT * FROM ci_runs WHERE repo_id = ? ORDER BY created_at DESC LIMIT 25').bind(repoRecord.id).all();
		return { content: [{ type: 'text', text: JSON.stringify({ data: results }, null, 2) }] };
	});

	server.tool('gitflare_ci_trigger', 'Trigger a CI run', {
		repo: z.string(),
		branch: z.string().optional(),
	}, async ({ repo, branch }) => {
		const repoRecord = await DB.prepare('SELECT id, name FROM repositories WHERE name = ?').bind(repo).first<{ id: string; name: string }>();
		if (!repoRecord) return { content: [{ type: 'text', text: 'Error: Repo not found' }], isError: true };
		const b = branch || 'main';
		const runId = crypto.randomUUID();
		const now = new Date().toISOString();
		await DB.prepare("INSERT INTO ci_runs (id, repo_id, branch, commit_sha, status, trigger, created_at) VALUES (?, ?, ?, ?, 'queued', 'manual', ?)")
			.bind(runId, repoRecord.id, b, 'HEAD', now).run();
		return { content: [{ type: 'text', text: JSON.stringify({ id: runId, status: 'queued', branch: b }, null, 2) }] };
	});

	server.tool('gitflare_ci_status', 'Get status of a CI run', {
		repo: z.string(),
		run_id: z.string(),
	}, async ({ repo, run_id }) => {
		const run = await DB.prepare('SELECT * FROM ci_runs WHERE id = ?').bind(run_id).first();
		if (!run) return { content: [{ type: 'text', text: 'Error: Run not found' }], isError: true };
		return { content: [{ type: 'text', text: JSON.stringify(run, null, 2) }] };
	});

	server.tool('gitflare_ci_logs', 'Get logs for a CI run', {
		repo: z.string(),
		run_id: z.string(),
		job_id: z.string().optional().describe('Filter steps by job (optional)'),
	}, async ({ repo, run_id }) => {
		const { results } = await DB.prepare('SELECT * FROM ci_steps WHERE run_id = ? ORDER BY step_index ASC').bind(run_id).all();
		return { content: [{ type: 'text', text: JSON.stringify({ steps: results }, null, 2) }] };
	});

	// ── Files ──
	server.tool('gitflare_files_tree', 'Get a file tree of a repository', {
		repo: z.string(),
		ref: z.string().optional().default('main'),
		path: z.string().optional().default('/'),
	}, async ({ repo, ref, path }) => {
		const tree = await getArtifactTree(env, repo, path, ref);
		if (!tree) return { content: [{ type: 'text', text: 'Error: Directory not found' }], isError: true };
		return { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }] };
	});

	server.tool('gitflare_files_read', 'Read a file blob', {
		repo: z.string(),
		path: z.string(),
		ref: z.string().optional().default('main'),
	}, async ({ repo, path, ref }) => {
		const blob = await getArtifactBlob(env, repo, path, ref);
		if (!blob) return { content: [{ type: 'text', text: 'Error: File not found' }], isError: true };
		return { content: [{ type: 'text', text: JSON.stringify(blob, null, 2) }] };
	});

	// ── Commits ──
	server.tool('gitflare_commits_list', 'List commits', {
		repo: z.string(),
		ref: z.string().optional().default('main'),
		limit: z.number().optional().default(20),
	}, async ({ repo, ref, limit }) => {
		const commits = await getArtifactCommits(env, repo, ref, limit);
		return { content: [{ type: 'text', text: JSON.stringify(commits, null, 2) }] };
	});

	// ── Deploys ──
	server.tool('gitflare_deploy_list', 'List deployment targets', {
		repo: z.string(),
	}, async ({ repo }) => {
		const repoRecord = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(repo).first<{ id: string }>();
		if (!repoRecord) return { content: [{ type: 'text', text: 'Error: Repo not found' }], isError: true };
		const { results } = await DB.prepare('SELECT * FROM deploy_targets WHERE repo_id = ?').bind(repoRecord.id).all();
		return { content: [{ type: 'text', text: JSON.stringify({ data: results }, null, 2) }] };
	});

	server.tool('gitflare_deploy_add', 'Add a deployment configuration', {
		repo: z.string(),
		name: z.string(),
		type: z.enum(['coolify', 'cloudflare']),
		coolify_app_id: z.string().optional(),
		coolify_base_url: z.string().optional(),
		coolify_api_key: z.string().optional(),
		branch_filter: z.array(z.string()).optional(),
	}, async ({ repo, name, type, coolify_app_id, coolify_base_url, coolify_api_key, branch_filter }) => {
		const repoRecord = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(repo).first<{ id: string }>();
		if (!repoRecord) return { content: [{ type: 'text', text: 'Error: Repo not found' }], isError: true };
		const id = crypto.randomUUID();
		await DB.prepare('INSERT INTO deploy_targets (id, repo_id, name, type, coolify_app_id, coolify_base_url, coolify_api_key_encrypted, branch_filter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
			.bind(id, repoRecord.id, name, type, coolify_app_id || null, coolify_base_url || null, coolify_api_key || null, branch_filter ? JSON.stringify(branch_filter) : null, new Date().toISOString()).run();
		return { content: [{ type: 'text', text: JSON.stringify({ id }, null, 2) }] };
	});

	// ── Mirrors ──
	server.tool('gitflare_mirror_get', 'Get mirror configuration', {
		repo: z.string(),
	}, async ({ repo }) => {
		const repoRecord = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(repo).first<{ id: string }>();
		if (!repoRecord) return { content: [{ type: 'text', text: 'Error: Repo not found' }], isError: true };
		const mirror = await DB.prepare('SELECT id, repo_id, github_url, is_enabled, branch_filter, last_sync_at, last_sync_status, last_sync_error, created_at, updated_at FROM github_mirrors WHERE repo_id = ?')
			.bind(repoRecord.id).first();
		return { content: [{ type: 'text', text: JSON.stringify({ mirror: mirror || null }, null, 2) }] };
	});

	server.tool('gitflare_mirror_setup', 'Setup a GitHub mirror', {
		repo: z.string(),
		github_url: z.string(),
		github_token: z.string().optional(),
		branch_filter: z.array(z.string()).optional(),
	}, async ({ repo, github_url, github_token, branch_filter }) => {
		const repoRecord = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(repo).first<{ id: string }>();
		if (!repoRecord) return { content: [{ type: 'text', text: 'Error: Repo not found' }], isError: true };
		if (!github_token) return { content: [{ type: 'text', text: 'Error: github_token is required' }], isError: true };
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		await DB.prepare('INSERT INTO github_mirrors (id, repo_id, github_url, github_token_encrypted, is_enabled, branch_filter, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
			.bind(id, repoRecord.id, github_url, github_token, branch_filter ? JSON.stringify(branch_filter) : null, now, now).run();
		return { content: [{ type: 'text', text: JSON.stringify({ id, github_url, message: 'Mirror created' }, null, 2) }] };
	});

	server.tool('gitflare_mirror_sync', 'Trigger a mirror sync', {
		repo: z.string(),
	}, async ({ repo }) => {
		const repoRecord = await DB.prepare('SELECT id FROM repositories WHERE name = ?').bind(repo).first<{ id: string }>();
		if (!repoRecord) return { content: [{ type: 'text', text: 'Error: Repo not found' }], isError: true };
		const mirror = await DB.prepare('SELECT id FROM github_mirrors WHERE repo_id = ? AND is_enabled = 1').bind(repoRecord.id).first();
		if (!mirror) return { content: [{ type: 'text', text: 'Error: No active mirror configured' }], isError: true };
		return { content: [{ type: 'text', text: JSON.stringify({ message: 'Mirror sync triggered' }) }] };
	});

	// ── Git Remote URL ──
	server.tool('gitflare_git_remote_url', 'Get git remote URL for a repository', {
		repo: z.string(),
	}, async ({ repo }) => {
		const appUrl = env.APP_URL || 'https://git.beenex.company';
		return { content: [{ type: 'text', text: JSON.stringify({ url: `${appUrl}/git/${repo}` }) }] };
	});
}

/**
 * Handle all MCP requests (POST, GET, DELETE) at /mcp.
 * Each request gets a fresh stateless transport + server instance since
 * Workers are short-lived and can't hold persistent connections.
 */
app.all('/', async (c) => {
	const server = new McpServer({ name: 'gitflare', version: '1.0.0' });
	registerTools(server, c.env);

	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined, // stateless
		enableJsonResponse: true,
	});

	await server.connect(transport);

	try {
		const response = await transport.handleRequest(c.req.raw);
		return response;
	} finally {
		// Clean up after the request
		await transport.close();
		await server.close();
	}
});

export default app;
