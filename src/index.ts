import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Env, CIJobMessage, DeployJobMessage } from './env.ts';
import { auth } from './middleware/auth.ts';
import { validateSession } from './lib/session.ts';
import reposApp from './api/repos.ts';
import filesApp from './api/files.ts';
import gitApp from './api/git.ts';
import ciApp from './api/ci.ts';
import commitsApp from './api/commits.ts';
import deployApp from './api/deploy.ts';
import bootstrapApp from './api/bootstrap.ts';
import internal from './api/internal.ts';
import ticketsApp from './api/tickets.ts';
import authApp from './api/auth.ts';
import keysApp from './api/keys.ts';
import { handleCIJob, handleDeployJob } from './queue/ci-consumer.ts';
import dashboardHtml from './dashboard/index.html';
import logoPng from '../assets/octopus-on-fire.png';

// ─── Re-export Durable Objects ──────────────────────────────────
export { RepoCoordinator } from './do/repo-coordinator.ts';
export { CISession } from './do/ci-session.ts';
export { TicketQueue } from './do/ticket-queue.ts';

// ─── Hono App ───────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env }>();

// ─── Global Middleware ──────────────────────────────────────────
app.use('*', cors());
app.use('/api/*', logger());

// ─── Public Routes (no auth required) ───────────────────────────

// Serve the app logo
app.get('/logo.png', (c) => {
	return new Response(logoPng, {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'public, max-age=86400',
		},
	});
});

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

// Auth routes (login, callback, logout, me) — must be public
app.route('/api/auth', authApp);

// Bootstrap uses its own ADMIN_API_KEY check
app.route('/api/bootstrap', bootstrapApp);

// Internal runner callbacks (authenticated by RUNNER_SECRET, not user auth)
app.route('/api', internal);

// ─── Auth Gate ──────────────────────────────────────────────────
// Everything below this line requires authentication
// (session cookie for UI users, API key for agents)
app.use('/api/*', auth);

// ─── Authenticated API Routes ───────────────────────────────────

// API key management: /api/keys
app.route('/api/keys', keysApp);

// File browsing: /api/repos/:repo/tree, /blob, /raw
app.route('/api/repos', filesApp);

// Commits: /api/repos/:repo/commits
app.route('/api/repos', commitsApp);

// CI pipeline: /api/repos/:repo/ci/*
app.route('/api/repos', ciApp);

// Deploy targets: /api/repos/:repo/deploys/*
app.route('/api/repos', deployApp);

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

	async queue(batch: MessageBatch<CIJobMessage | DeployJobMessage>, env: Env, ctx: ExecutionContext) {
		for (const message of batch.messages) {
			try {
				if (batch.queue === 'gitflare-ci-jobs') {
					await handleCIJob(message.body as CIJobMessage, env);
				} else if (batch.queue === 'gitflare-deploy-jobs') {
					await handleDeployJob(message.body as DeployJobMessage, env);
				} else {
					console.warn(`Unknown queue: ${batch.queue}`);
				}
				message.ack();
			} catch (err) {
				console.error(`Error processing message ${message.id}:`, err);
				message.retry();
			}
		}
	},
};
