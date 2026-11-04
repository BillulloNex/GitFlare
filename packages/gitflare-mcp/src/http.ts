/**
 * Streamable HTTP entry point for the GitFlare MCP server.
 *
 * Auth: every /mcp request must carry `Authorization: Bearer <GitFlare API key>`.
 * The key is verified against GitFlare (cached briefly) and then used for every
 * REST call made on that request's behalf — so callers get exactly the access
 * their own key grants. There is no server-wide key and no anonymous access.
 *
 * Stateless mode: each request gets its own McpServer + transport. (A single
 * shared stateless transport cannot be reused across requests, and sharing one
 * server would mix callers' credentials.)
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { GitFlareClient, GitFlareError } from '@gitflare/client';
import { createServer } from './server.js';

const PORT = parseInt(process.env.PORT || '3100', 10);
/** Optional bind address (default: all interfaces, as before). */
const HOST = process.env.HOST || undefined;
const GITFLARE_URL = process.env.GITFLARE_URL ?? '';
if (!GITFLARE_URL) {
  console.error('GITFLARE_URL environment variable is required (e.g. https://git.example.com)');
  process.exit(1);
}

// ─── Credential verification (cached) ──────────────────────────

const AUTH_CACHE_TTL_MS = 60_000;
const AUTH_CACHE_MAX = 1000;
const verifiedKeys = new Map<string, number>(); // sha256(key) → expiry

function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

type VerifyResult = { ok: true } | { ok: false; status: 401 | 502; message: string };

async function verifyKey(client: GitFlareClient, key: string): Promise<VerifyResult> {
  const fp = fingerprint(key);
  const now = Date.now();
  const expiry = verifiedKeys.get(fp);
  if (expiry && expiry > now) return { ok: true };
  verifiedKeys.delete(fp);

  try {
    await client.verifyAuth();
  } catch (err) {
    if (err instanceof GitFlareError && (err.status === 401 || err.status === 403)) {
      return { ok: false, status: 401, message: 'Invalid or expired GitFlare API key' };
    }
    console.error('GitFlare auth check failed:', err);
    return { ok: false, status: 502, message: 'Could not reach GitFlare to verify credentials' };
  }

  if (verifiedKeys.size >= AUTH_CACHE_MAX) {
    for (const [k, exp] of verifiedKeys) if (exp <= now) verifiedKeys.delete(k);
    if (verifiedKeys.size >= AUTH_CACHE_MAX) verifiedKeys.delete(verifiedKeys.keys().next().value!);
  }
  verifiedKeys.set(fp, now + AUTH_CACHE_TTL_MS);
  return { ok: true };
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

// ─── HTTP plumbing ─────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** JSON-RPC error envelope, so MCP clients surface the message. */
function sendRpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  sendJson(res, status, { jsonrpc: '2.0', error: { code: -32001, message }, id: null }, headers);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  // Stateless server: no SSE stream (GET) or session to terminate (DELETE).
  if (req.method !== 'POST') {
    sendRpcError(res, 405, 'Method not allowed', { Allow: 'POST' });
    return;
  }

  const key = bearerToken(req);
  if (!key) {
    sendRpcError(res, 401, 'Missing Authorization: Bearer <GitFlare API key>', { 'WWW-Authenticate': 'Bearer realm="gitflare-mcp"' });
    return;
  }

  const client = new GitFlareClient({ baseUrl: GITFLARE_URL, apiKey: key });
  const verified = await verifyKey(client, key);
  if (!verified.ok) {
    const headers: Record<string, string> = verified.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="gitflare-mcp", error="invalid_token"' } : {};
    sendRpcError(res, verified.status, verified.message, headers);
    return;
  }

  const server = createServer(client);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}

const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok', transport: 'streamable-http' });
      return;
    }

    if (url.pathname === '/mcp') {
      await handleMcp(req, res);
      return;
    }

    sendJson(res, 404, { error: 'Not found. MCP endpoint is at /mcp' });
  } catch (err) {
    console.error('MCP request failed:', err);
    if (!res.headersSent) sendRpcError(res, 500, 'Internal server error');
    else res.end();
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(`GitFlare MCP server running on http://${HOST ?? 'localhost'}:${PORT}/mcp (Streamable HTTP, Bearer auth → ${GITFLARE_URL})`);
});
