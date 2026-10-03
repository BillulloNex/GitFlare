import { Hono } from 'hono';
import type { Env, ApiKey } from '../env.ts';
import { parseCIConfig } from '../lib/ci-parser.ts';

const app = new Hono<{ Bindings: Env; Variables: { apiKey: ApiKey } }>();

// ─── Git-specific Basic Auth ────────────────────────────────────
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

	// Hash the key and look up by hash
	const { DB } = c.env;
	const encoder = new TextEncoder();
	const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password));
	const keyHash = Array.from(new Uint8Array(hashBuffer))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');

	const apiKey = await DB.prepare(
		'SELECT * FROM api_keys WHERE key_hash = ? AND (expires_at IS NULL OR expires_at > ?)'
	).bind(keyHash, new Date().toISOString()).first() as ApiKey | null;
	
	if (!apiKey) {
		return new Response('Unauthorized', { status: 401 });
	}
	
	c.set('apiKey', apiKey);
	await next();
});

/**
 * Helper: get the Artifacts repo remote URL and a scoped token.
 *
 * The Artifacts binding's .get() returns an RPC proxy that supports
 * createToken() but does NOT expose .remote. We construct the remote URL
 * from the known account ID and namespace.
 */
const ACCOUNT_ID = 'aed09ddf6077b29514def05ed3d5e699';
const ARTIFACTS_NAMESPACE = 'gitflare-repos';

function getRemoteUrl(repoName: string): string {
	return `https://${ACCOUNT_ID}.artifacts.cloudflare.net/git/${ARTIFACTS_NAMESPACE}/${repoName}.git`;
}

async function getRepoToken(
	env: Env,
	repoName: string,
	permission: 'read' | 'write',
	ttlSeconds: number
): Promise<string> {
	const artifactRepo = await env.REPOS.get(repoName);
	if (!artifactRepo) {
		throw new Error('Repository storage not found');
	}

	// createToken returns either a string or { plaintext: string }
	const tokenResult = await artifactRepo.createToken(permission, ttlSeconds);
	if (typeof tokenResult === 'string') return tokenResult;
	if (tokenResult && typeof tokenResult === 'object' && 'plaintext' in (tokenResult as any)) {
		return (tokenResult as any).plaintext;
	}
	return String(tokenResult);
}

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
	
	const { DB } = c.env;
	const repoRecord = await DB.prepare('SELECT id, name FROM repositories WHERE name = ?').bind(repoName).first<{ id: string, name: string }>();
	if (!repoRecord) {
		return c.text('Repository not found', 404);
	}

	try {
		const permission = service === 'git-receive-pack' ? 'write' : 'read';
		const token = await getRepoToken(c.env, repoRecord.name, permission, 60);

		const targetUrl = `${getRemoteUrl(repoRecord.name)}/info/refs?service=${service}`;
		
		const response = await fetch(targetUrl, {
			headers: {
				'Authorization': `Bearer ${token}`
			}
		});

		if (!response.ok) {
			const body = await response.text();
			console.error(`Artifacts proxy error: ${response.status} ${body}`);
			return new Response(`Artifacts error: ${response.status}`, { status: response.status });
		}

		return new Response(response.body, {
			status: response.status,
			headers: {
				'Content-Type': `application/x-${service}-advertisement`,
				'Cache-Control': 'no-cache',
			}
		});
	} catch (err: any) {
		console.error(`Git info/refs error for ${repoName}:`, err.message, err.stack);
		return c.json({ error: 'Git protocol error', details: err.message }, 500);
	}
});

/**
 * POST /git/:repo/git-upload-pack
 * Clone/fetch packfile transfer
 */
app.post('/:repo/git-upload-pack', async (c) => {
	const repoName = c.req.param('repo').replace('.git', '');
	
	const { DB } = c.env;
	const repoRecord = await DB.prepare('SELECT id, name FROM repositories WHERE name = ?').bind(repoName).first<{ id: string, name: string }>();
	if (!repoRecord) {
		return c.text('Repository not found', 404);
	}

	try {
		const token = await getRepoToken(c.env, repoRecord.name, 'read', 300);

		const response = await fetch(`${getRemoteUrl(repoRecord.name)}/git-upload-pack`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/x-git-upload-pack-request'
			},
			body: c.req.raw.body,
			// @ts-ignore — needed for streaming request body
			duplex: 'half'
		});

		return new Response(response.body, {
			status: response.status,
			headers: {
				'Content-Type': 'application/x-git-upload-pack-result',
				'Cache-Control': 'no-cache',
			}
		});
	} catch (err: any) {
		console.error(`Git upload-pack error for ${repoName}:`, err.message);
		return c.json({ error: 'Git protocol error', details: err.message }, 500);
	}
});

/**
 * POST /git/:repo/git-receive-pack
 * Push packfile transfer — also triggers CI after a successful push
 */
app.post('/:repo/git-receive-pack', async (c) => {
	const repoName = c.req.param('repo').replace('.git', '');
	
	const { DB, REPOS, CI_QUEUE } = c.env;
	const repoRecord = await DB.prepare('SELECT id, name FROM repositories WHERE name = ?').bind(repoName).first<{ id: string, name: string }>();
	if (!repoRecord) {
		return c.text('Repository not found', 404);
	}

	try {
		const token = await getRepoToken(c.env, repoRecord.name, 'write', 300);

		const response = await fetch(`${getRemoteUrl(repoRecord.name)}/git-receive-pack`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/x-git-receive-pack-request'
			},
			body: c.req.raw.body,
			// @ts-ignore
			duplex: 'half'
		});

		// Post-push hooks: audit log + CI trigger
		if (response.ok) {
			const branch = 'main';
			const commitSha = 'HEAD';

			// Audit log
			c.executionCtx.waitUntil(
				DB.prepare('INSERT INTO audit_log (id, action, repo_id, details, created_at) VALUES (?, ?, ?, ?, ?)')
					.bind(crypto.randomUUID(), 'git.push', repoRecord.id, JSON.stringify({ repoName, branch }), new Date().toISOString())
					.run()
			);

			// Trigger CI if .gitflare/ci.yml exists
			c.executionCtx.waitUntil((async () => {
				try {
					const readToken = await getRepoToken(c.env, repoRecord.name, 'read', 60);
					const ciFileRes = await fetch(`${getRemoteUrl(repoRecord.name)}/raw/HEAD/.gitflare/ci.yml`, {
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
						console.log(`CI triggered: run=${runId} repo=${repoName}`);
					}
				} catch (e: any) {
					console.error('Failed to trigger CI:', e.message);
				}
			})());
		}

		return new Response(response.body, {
			status: response.status,
			headers: {
				'Content-Type': 'application/x-git-receive-pack-result',
				'Cache-Control': 'no-cache',
			}
		});
	} catch (err: any) {
		console.error(`Git receive-pack error for ${repoName}:`, err.message);
		return c.json({ error: 'Git protocol error', details: err.message }, 500);
	}
});

export default app;
