import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Env, CIJobMessage, DeployJobMessage } from './env.ts';
import reposApp from './api/repos.ts';
import filesApp from './api/files.ts';
import gitApp from './api/git.ts';
import ciApp from './api/ci.ts';
import commitsApp from './api/commits.ts';
import deployApp from './api/deploy.ts';
import bootstrapApp from './api/bootstrap.ts';
import internal from './api/internal.ts';
import { handleCIJob, handleDeployJob } from './queue/ci-consumer.ts';
import dashboardHtml from './dashboard/index.html';

// ─── Re-export Durable Objects ──────────────────────────────────
// Wrangler needs these at the top level of the worker module
export { RepoCoordinator } from './do/repo-coordinator.ts';
export { CISession } from './do/ci-session.ts';

// ─── Hono App ───────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env }>();

// ─── Global Middleware ──────────────────────────────────────────
app.use('*', cors());
app.use('/api/*', logger());

// ─── Health Check ───────────────────────────────────────────────
app.get('/health', (c) => {
	return c.json({
		service: 'gitflare',
		status: 'ok',
		version: c.env.GITFLARE_VERSION ?? '0.1.0',
	});
});

// ─── Dashboard ──────────────────────────────────────────────────
// Serve the dashboard HTML when browser requests the root
app.get('/', (c) => {
	const accept = c.req.header('Accept') ?? '';
	if (accept.includes('text/html')) {
		return c.html(dashboardHtml);
	}
	return c.json({
		service: 'gitflare',
		status: 'ok',
		version: c.env.GITFLARE_VERSION ?? '0.1.0',
		endpoints: {
			api: '/api/repos',
			git: '/git/:repo',
			health: '/health',
			dashboard: '/ (Accept: text/html)',
		},
	});
});

// ─── API Routes ─────────────────────────────────────────────────
// ─── Bootstrap (uses ADMIN_API_KEY secret, no D1 key needed) ────
app.route('/api/bootstrap', bootstrapApp);

// Internal runner callbacks
app.route('/api', internal);

// File browsing: /api/repos/:repo/tree, /blob, /raw
app.route('/api/repos', filesApp);

// Commits: /api/repos/:repo/commits, /api/repos/:repo/commits/:sha
app.route('/api/repos', commitsApp);

// CI pipeline: /api/repos/:repo/ci/*
app.route('/api/repos', ciApp);

// Deploy targets: /api/repos/:repo/deploys/*
app.route('/api/repos', deployApp);

// Repo CRUD
app.route('/api/repos', reposApp);

// ─── Git Smart HTTP Protocol ────────────────────────────────────
// Standard git clone/push/pull via Smart HTTP v2
// Routes: GET /git/:repo/info/refs, POST /git/:repo/git-upload-pack, etc.
app.route('/git', gitApp);

// ─── Catch-All 404 ──────────────────────────────────────────────
app.all('*', (c) => {
	return c.json({ error: 'Not Found', path: c.req.path }, 404);
});

// ─── Worker Export ──────────────────────────────────────────────
export default {
	fetch: app.fetch,

	/**
	 * Queue consumer handler.
	 * Processes CI job and deploy job messages from Cloudflare Queues.
	 */
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
