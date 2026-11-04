/**
 * MCP (Model Context Protocol) endpoint for GitFlare: Streamable HTTP at /mcp.
 *
 * There are no tool implementations here. The tools come from the single MCP
 * server in `packages/gitflare-mcp` and each one calls the REST API through
 * `@gitflare/client`. Those REST calls are dispatched in-process (no network
 * hop) and carry the caller's own credentials (Authorization / session cookie),
 * so every tool goes through exactly the same auth, repo-access and permission
 * checks as a direct REST call.
 *
 * Auth: the `auth` middleware in src/index.ts runs before this route.
 */
import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { GitFlareClient } from '@gitflare/client';
import { createServer } from '../../packages/gitflare-mcp/src/server.ts';
import type { Env } from '../env.ts';
import { principalFrom, type AuthVariables } from '../middleware/auth.ts';

/** Routes a Request through the full Worker app (middleware included). */
export type RestDispatcher = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

/**
 * Request headers forwarded to the inner REST calls. `Authorization` and
 * `Cookie` identify the caller; `Origin` was already checked by the outer
 * `auth` middleware (CSRF guard for cookie auth) and must be forwarded so the
 * inner state-changing requests pass the same check.
 */
const FORWARDED_HEADERS = ['authorization', 'cookie', 'origin', 'cf-connecting-ip', 'x-forwarded-for'] as const;

export function createMcpApp(dispatch: RestDispatcher) {
	const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

	/**
	 * Handle all MCP requests (POST, GET, DELETE) at /mcp. Each request gets a
	 * fresh stateless transport + server instance (Workers are short-lived and
	 * each request may carry different credentials).
	 */
	app.all('/', async (c) => {
		if (!principalFrom(c.get('user'), c.get('apiKey'))) {
			return c.json({ error: 'Forbidden: unrecognised role or permission level' }, 403);
		}

		const headers: Record<string, string> = {};
		for (const name of FORWARDED_HEADERS) {
			const value = c.req.header(name);
			if (value) headers[name] = value;
		}

		const env = c.env;
		const ctx = c.executionCtx as ExecutionContext;
		const client = new GitFlareClient({
			// Same origin the caller reached, so the inner requests see the same
			// host (and the forwarded Origin passes the same CSRF check).
			baseUrl: new URL(c.req.url).origin,
			apiKey: '', // credentials come from the forwarded headers
			headers,
			fetch: (input, init) => Promise.resolve(dispatch(new Request(input, init), env, ctx)),
		});

		const server = createServer(client);
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined, // stateless
			enableJsonResponse: true,
		});

		await server.connect(transport);
		try {
			return await transport.handleRequest(c.req.raw);
		} finally {
			await transport.close();
			await server.close();
		}
	});

	return app;
}
