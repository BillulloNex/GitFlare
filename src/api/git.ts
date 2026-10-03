import { Hono } from 'hono';
import type { Env, ApiKey } from '../env.ts';
import { parseCIConfig } from '../lib/ci-parser.ts';

const app = new Hono<{ Bindings: Env; Variables: { apiKey: ApiKey } }>();

/**
 * Basic auth middleware for git protocol
 */
app.use('*', async (c, next) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader || !authHeader.startsWith('Basic ')) {
		return new Response('Unauthorized', {
			status: 401,
			headers: {
				'WWW-Authenticate': 'Basic realm="GitFlare"',
			},
		});
	}

	const base64Credentials = authHeader.slice(6);
	const credentials = atob(base64Credentials);
	const [username, password] = credentials.split(':');

	const { DB } = c.env;
	const apiKey = await DB.prepare('SELECT * FROM api_keys WHERE id = ?').bind(password).first() as ApiKey | null;
	
	if (!apiKey) {
		return new Response('Unauthorized', { status: 401 });
	}
	
	c.set('apiKey', apiKey);
	await next();
});

/**
 * GET /git/:repo/info/refs
 * Clone/fetch discovery or push discovery
 */
app.get('/:repo/info/refs', async (c) => {
	const service = c.req.query('service');
	if (!service || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
		return c.text('Invalid service', 400);
	}

	const repoName = c.req.param('repo').replace('.git', '');
	
	const { DB, REPOS } = c.env;
	const repoRecord = await DB.prepare('SELECT id, name FROM repos WHERE name = ?').bind(repoName).first<{ id: string, name: string }>();
	if (!repoRecord) {
		return c.text('Repository not found', 404);
	}

	const artifactRepo = await REPOS.get(repoRecord.name);
	if (!artifactRepo) {
		return c.text('Repository storage not found', 404);
	}

	const permission = service === 'git-receive-pack' ? 'write' : 'read';
	const token = await artifactRepo.createToken(permission, 60);

	const targetUrl = `${artifactRepo.remote}/info/refs?service=${service}`;
	
	const response = await fetch(targetUrl, {
		headers: {
			'Authorization': `Bearer ${token}`
		}
	});

	if (!response.ok) {
		return new Response('Failed to proxy to Artifacts', { status: response.status });
	}

	return new Response(response.body, {
		status: response.status,
		headers: {
			'Content-Type': `application/x-${service}-advertisement`,
			'Cache-Control': 'no-cache',
		}
	});
});

/**
 * POST /git/:repo/git-upload-pack
 * Clone/fetch packfile transfer
 */
app.post('/:repo/git-upload-pack', async (c) => {
	const repoName = c.req.param('repo').replace('.git', '');
	
	const { DB, REPOS } = c.env;
	const repoRecord = await DB.prepare('SELECT id, name FROM repos WHERE name = ?').bind(repoName).first<{ id: string, name: string }>();
	if (!repoRecord) {
		return c.text('Repository not found', 404);
	}

	const artifactRepo = await REPOS.get(repoRecord.name);
	if (!artifactRepo) {
		return c.text('Repository storage not found', 404);
	}

	const token = await artifactRepo.createToken('read', 300);
	const targetUrl = `${artifactRepo.remote}/git-upload-pack`;

	const response = await fetch(targetUrl, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/x-git-upload-pack-request'
		},
		body: c.req.raw.body,
		// @ts-ignore
		duplex: 'half'
	});

	return new Response(response.body, {
		status: response.status,
		headers: {
			'Content-Type': 'application/x-git-upload-pack-result',
			'Cache-Control': 'no-cache',
		}
	});
});

/**
 * POST /git/:repo/git-receive-pack
 * Push packfile transfer
 */
app.post('/:repo/git-receive-pack', async (c) => {
	const repoName = c.req.param('repo').replace('.git', '');
	
	const { DB, REPOS, CI_QUEUE } = c.env;
	const repoRecord = await DB.prepare('SELECT id, name FROM repos WHERE name = ?').bind(repoName).first<{ id: string, name: string }>();
	if (!repoRecord) {
		return c.text('Repository not found', 404);
	}

	const artifactRepo = await REPOS.get(repoRecord.name);
	if (!artifactRepo) {
		return c.text('Repository storage not found', 404);
	}

	const token = await artifactRepo.createToken('write', 300);
	const targetUrl = `${artifactRepo.remote}/git-receive-pack`;

	const [requestBody1, requestBody2] = c.req.raw.body ? c.req.raw.body.tee() : [null, null];

	const response = await fetch(targetUrl, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/x-git-receive-pack-request'
		},
		body: requestBody1,
		// @ts-ignore
		duplex: 'half'
	});

	if (response.ok && requestBody2) {
		await DB.prepare('INSERT INTO audit_log (id, action, repo_id, details) VALUES (?, ?, ?, ?)')
			.bind(crypto.randomUUID(), 'git.push', repoRecord.id, JSON.stringify({ repoName }))
			.run();

		// Hardcoded for implementation mock since extracting refs involves packfile parsing
		const branch = 'main'; 
		const commitSha = 'HEAD';

		try {
			const readToken = await artifactRepo.createToken('read', 60);
			const ciFileRes = await fetch(`${artifactRepo.remote}/raw/HEAD/.gitflare/ci.yml`, {
				headers: { 'Authorization': `Bearer ${readToken}` }
			});
			if (ciFileRes.ok) {
				const yamlContent = await ciFileRes.text();
				const config = parseCIConfig(yamlContent);
				
				const runId = crypto.randomUUID();
				await DB.prepare('INSERT INTO ci_runs (id, repo_id, branch, commit_sha, status, trigger, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
					.bind(runId, repoRecord.id, branch, commitSha, 'queued', 'push', new Date().toISOString())
					.run();
					
				await CI_QUEUE.send({
					runId,
					repoId: repoRecord.id,
					repoName: repoRecord.name,
					branch,
					commitSha,
					config,
					trigger: 'push'
				});
			}
		} catch (e) {
			console.error('Failed to trigger CI:', e);
		}
	}

	return new Response(response.body, {
		status: response.status,
		headers: {
			'Content-Type': 'application/x-git-receive-pack-result',
			'Cache-Control': 'no-cache',
		}
	});
});

export default app;
