import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { requestId, type RequestIdVariables } from 'hono/request-id';
import { HTTPException } from 'hono/http-exception';
import type { Env, CIJobMessage, DeployJobMessage, LegacyDeployJobMessage } from './env.ts';
import { auth, appOrigin } from './middleware/auth.ts';
import { repoAccess } from './middleware/repo-access.ts';
import { validateSession } from './lib/session.ts';
import reposApp from './api/repos.ts';
import filesApp from './api/files.ts';
import lfsApiApp from './api/lfs-api.ts';
import gitApp from './api/git.ts';
import ciApp from './api/ci.ts';
import commitsApp from './api/commits.ts';
import deployApp from './api/deploy.ts';
import mirrorsApp from './api/mirrors.ts';
import bootstrapApp from './api/bootstrap.ts';
import internalCi, { deployCallbackApp } from './api/internal-ci.ts';
import internalMerge from './api/internal-merge.ts';
import ticketsApp from './api/tickets.ts';
import authApp from './api/auth.ts';
import keysApp from './api/keys.ts';
import { createMcpApp } from './api/mcp.ts';
import { handleCIJob, handleDeployJob } from './queue/ci-consumer.ts';
import { handleMirrorSyncBatch } from './lib/github-mirror.ts';
import type { MirrorSyncMessage } from './env.ts';
import { runScheduledMaintenance } from './lib/maintenance.ts';
import dashboardHtml from './dashboard/index.html';
import lfsDocsHtml from './docs/lfs.html';
import { LOGO_SVG, FAVICON_SVG, WORDMARK_SVG } from './lib/brand';

// ─── Re-export Durable Objects ──────────────────────────────────
export { RepoCoordinator } from './do/repo-coordinator.ts';
export { TicketQueue } from './do/ticket-queue.ts';

// ─── Hono App ───────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env; Variables: RequestIdVariables }>();

// ─── Global Middleware ──────────────────────────────────────────
// Request ID: honours an incoming X-Request-Id, otherwise generates one, and
// echoes it on the response so client reports can be matched to logs.
app.use('*', requestId());

// Errors: sub-apps define no onError of their own, so every uncaught throw
// lands here. Log the full error with the request ID; never send internal
// messages to the client.
app.onError((err, c) => {
	const id = c.get('requestId');
	if (err instanceof HTTPException) {
		if (err.status >= 500) console.error(`[${id}] ${c.req.method} ${c.req.path} → ${err.status}:`, err);
		return c.json({ error: err.status >= 500 ? 'Internal Server Error' : err.message || 'Request failed', request_id: id }, err.status);
	}
	console.error(`[${id}] ${c.req.method} ${c.req.path} unhandled error:`, err);
	return c.json({ error: 'Internal Server Error', request_id: id }, 500);
});

// CORS: only the app's own origin (APP_URL) may make credentialed
// cross-origin requests. Agents/CLIs call server-to-server and don't need CORS.
app.use('*', async (c, next) => {
	const allowed = appOrigin(c.env);
	return cors({
		origin: (origin) => (allowed && origin === allowed ? origin : null),
		credentials: true,
	})(c, next);
});
app.use('/api/*', logger());

// ─── Public Routes (no auth required) ───────────────────────────

// Brand marks: pixel-flame logo, favicon, outlined wordmark
const svgResponse = (svg: string) =>
	new Response(svg, {
		headers: {
			'Content-Type': 'image/svg+xml; charset=utf-8',
			'Cache-Control': 'public, max-age=86400',
		},
	});
app.get('/logo.svg', () => svgResponse(LOGO_SVG));
app.get('/favicon.svg', () => svgResponse(FAVICON_SVG));
app.get('/wordmark.svg', () => svgResponse(WORDMARK_SVG));
app.get('/favicon.ico', () => svgResponse(FAVICON_SVG));
// Old raster logo URL — keep working for anything that linked to it.
app.get('/logo.png', (c) => c.redirect('/logo.svg', 301));

app.get('/health', (c) => {
	return c.json({
		service: 'gitflare',
		status: 'ok',
		version: c.env.GITFLARE_VERSION ?? '1.0.0',
	});
});

// Dashboard: requires session, redirects to login if not authenticated
app.get('/', async (c) => {
	const accept = c.req.header('Accept') ?? '';
	if (accept.includes('text/html')) {
		const user = await validateSession(c.env.DB, c.req.header('Cookie'));
		if (!user) {
			return c.redirect('/api/auth/login');
		}
		return c.html(dashboardHtml);
	}
	return c.json({
		service: 'gitflare',
		status: 'ok',
		version: c.env.GITFLARE_VERSION ?? '1.0.0',
	});
});

// Public docs: the push guard and LFS error messages link here.
app.get('/docs/lfs', (c) => c.html(lfsDocsHtml));

// Auth routes (login, callback, logout, me) — must be public
app.route('/api/auth', authApp);

// Bootstrap uses its own ADMIN_API_KEY check
app.route('/api/bootstrap', bootstrapApp);

// Internal runner callbacks (authenticated by RUNNER_SECRET, not user auth).
// Mounted on their own prefixes so each sub-app's RUNNER_SECRET middleware
// only applies to /api/internal/{ci,deploy,merge}/* — never to the rest of /api.
app.route('/api/internal/ci', internalCi);
app.route('/api/internal/deploy', deployCallbackApp);
app.route('/api/internal/merge', internalMerge);

// ─── Auth Gate ──────────────────────────────────────────────────
// Everything below this line requires authentication
// (session cookie for UI users, API key for agents)
app.use('/api/*', auth);
app.use('/mcp/*', auth);
app.use('/mcp', auth);

// Per-repo access control: resolves the repo, enforces is_private /
// repo_members / key scope, and attaches `repoRecord` + `principal`.
// GET/HEAD need read; every other method needs write. Admin-only routes add
// requireRepoLevel('admin'). (GET/POST /api/repos — list/create — don't match.)
app.use('/api/repos/:repo', repoAccess);
app.use('/api/repos/:repo/*', repoAccess);

// ─── Authenticated API Routes ───────────────────────────────────

// MCP endpoint: /mcp (Streamable HTTP for AI agents). Tools call the REST API
// in-process through this same app, with the caller's credentials.
app.route('/mcp', createMcpApp((request, env, ctx) => app.fetch(request, env, ctx)));

// API key management: /api/keys
app.route('/api/keys', keysApp);

// File browsing: /api/repos/:repo/tree, /blob, /raw
app.route('/api/repos', filesApp);

// Commits: /api/repos/:repo/commits
app.route('/api/repos', commitsApp);

// Git LFS management: /api/repos/:repo/lfs/* (the git-lfs client uses /git/:repo.git/info/lfs)
app.route('/api/repos', lfsApiApp);

// CI pipeline: /api/repos/:repo/ci/*
app.route('/api/repos', ciApp);

// Deploy targets: /api/repos/:repo/deploys/*
app.route('/api/repos', deployApp);

// GitHub Mirror: /api/repos/:repo/mirror/*
app.route('/api/repos', mirrorsApp);

// Tickets & Merge Queue: /api/repos/:repo/tickets/*
app.route('/api/repos', ticketsApp);

// Repo CRUD: /api/repos
app.route('/api/repos', reposApp);

// ─── Git Smart HTTP Protocol ────────────────────────────────────
// Has its own Basic auth (git protocol requires WWW-Authenticate headers)
app.route('/git', gitApp);

// ─── Catch-All 404 ──────────────────────────────────────────────
app.all('*', (c) => {
	return c.json({ error: 'Not Found', path: c.req.path }, 404);
});

// ─── Worker Export ──────────────────────────────────────────────
export default {
	fetch: app.fetch,

	async queue(batch: MessageBatch<CIJobMessage | DeployJobMessage | LegacyDeployJobMessage>, env: Env, ctx: ExecutionContext) {
		// GitHub mirror: batch-level handler (merges jobs per repo, acks/retries itself).
		if (batch.queue === 'gitflare-mirror-sync') {
			await handleMirrorSyncBatch(batch as unknown as MessageBatch<MirrorSyncMessage>, env);
			return;
		}
		for (const message of batch.messages) {
			try {
				const delivery = { attempts: message.attempts };
				if (batch.queue === 'gitflare-ci-jobs') {
					await handleCIJob(message.body as CIJobMessage, env, delivery);
				} else if (batch.queue === 'gitflare-deploy-jobs') {
					await handleDeployJob(message.body as DeployJobMessage | LegacyDeployJobMessage, env, delivery);
				} else {
					console.warn(`Unknown queue: ${batch.queue}`);
				}
				message.ack();
			} catch (err) {
				// Handlers throw only when a retry is warranted; after max_retries
				// the message lands in the queue's DLQ.
				console.error(`Error processing message ${message.id} (attempt ${message.attempts}):`, err);
				message.retry({ delaySeconds: Math.min(300, 15 * 2 ** (message.attempts - 1)) });
			}
		}
	},

	/** Cron (wrangler.jsonc triggers.crons): fail stuck runs/deployments, purge expired sessions. */
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(runScheduledMaintenance(env));
	},
};
