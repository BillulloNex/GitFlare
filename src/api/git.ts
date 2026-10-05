import { Hono } from 'hono';
import type { Env, ApiKey } from '../env.ts';
import { parseCIConfig } from '../lib/ci-parser.ts';
import {
	parseReceivePackRequest,
	parseReceivePackResponse,
	buildRejectResponse,
	wrapInSideband,
	type RefUpdate,
} from '../lib/git-protocol.ts';
import { triggerGitHubMirror } from '../lib/github-mirror.ts';

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

// ─── Branch Protection Helper ───────────────────────────────────

/**
 * Check if a branch matches any protection rule for the repo.
 * Supports exact match and basic glob patterns (e.g. "release/*").
 */
async function getProtectedRefs(
	db: D1Database,
	repoId: string,
	refs: RefUpdate[]
): Promise<{ ref: RefUpdate; rule: any }[]> {
	const { results: rules } = await db.prepare(
		'SELECT * FROM protected_branches WHERE repo_id = ?'
	).bind(repoId).all();

	if (!rules || rules.length === 0) return [];

	const violations: { ref: RefUpdate; rule: any }[] = [];

	for (const ref of refs) {
		for (const rule of rules) {
			const pattern = rule.branch_pattern as string;
			let matches = false;

			if (pattern.includes('*')) {
				// Simple glob: "release/*" → matches "release/v1.0"
				const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
				matches = regex.test(ref.branch);
			} else {
				matches = ref.branch === pattern;
			}

			if (matches) {
				violations.push({ ref, rule });
				break;
			}
		}
	}

	return violations;
}

/**
 * POST /git/:repo/git-receive-pack
 * Push packfile transfer
 * 
 * Full flow:
 * 1. Buffer request body and parse ref update commands
 * 2. Check branch protection — reject if pushing to protected branch
 * 3. Acquire RepoCoordinator lock on the refs being pushed
 * 4. Proxy push to Artifacts
 * 5. Parse response — detect which refs actually succeeded
 * 6. Trigger CI only for successful ref updates
 * 7. Release RepoCoordinator lock
 */
app.post('/:repo/git-receive-pack', async (c) => {
	const repoName = c.req.param('repo').replace('.git', '');
	const isInternalMerge = c.req.header('X-GitFlare-Internal') === c.env.RUNNER_SECRET;
	
	const { DB, REPOS, CI_QUEUE, REPO_COORDINATOR } = c.env;
	const repoRecord = await DB.prepare('SELECT id, name FROM repositories WHERE name = ?').bind(repoName).first<{ id: string, name: string }>();
	if (!repoRecord) {
		return c.text('Repository not found', 404);
	}

	// ── Step 1: Buffer and parse request ────────────────────────
	const requestBody = await c.req.arrayBuffer();
	let parsedRefs: RefUpdate[] = [];

	try {
		const parsed = parseReceivePackRequest(requestBody);
		parsedRefs = parsed.refs;
		console.log(`Push to ${repoName}: ${parsedRefs.map(r => `${r.branch}(${r.newSha.slice(0, 7)})`).join(', ')}`);
	} catch (err: any) {
		console.error('Failed to parse receive-pack request:', err.message);
		// Continue anyway — worst case we can't do branch protection
		// but the push still works
	}

	// ── Step 2: Branch protection ───────────────────────────────
	if (parsedRefs.length > 0 && !isInternalMerge) {
		const violations = await getProtectedRefs(DB, repoRecord.id, parsedRefs);

		if (violations.length > 0) {
			const protectedNames = violations.map(v => v.ref.branch).join(', ');
			console.log(`Rejected push to protected branch(es): ${protectedNames} on ${repoName}`);

			// Build a proper git protocol rejection response
			const rejectedRefs = violations.map(v => v.ref);
			const rejectBody = buildRejectResponse(
				rejectedRefs,
				`protected branch — use the merge queue (POST /api/repos/${repoName}/tickets)`
			);

			// Audit log
			c.executionCtx.waitUntil(
				DB.prepare('INSERT INTO audit_log (id, action, repo_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
					.bind(
						crypto.randomUUID(), 'git.push.rejected', repoRecord.id,
						c.get('apiKey')?.id || 'unknown',
						JSON.stringify({ reason: 'branch_protection', branches: protectedNames }),
						new Date().toISOString()
					).run()
			);

			const wrappedReject = wrapInSideband(rejectBody);
			return new Response(wrappedReject.buffer.slice(wrappedReject.byteOffset, wrappedReject.byteOffset + wrappedReject.byteLength), {
				status: 200, // Git protocol uses 200 even for rejections
				headers: {
					'Content-Type': 'application/x-git-receive-pack-result',
					'Cache-Control': 'no-cache',
				}
			});
		}
	}

	// ── Step 3: Acquire RepoCoordinator lock ────────────────────
	const refNames = parsedRefs.map(r => r.refName);
	let lockId: string | null = null;

	if (refNames.length > 0) {
		const doId = REPO_COORDINATOR.idFromName(repoRecord.id);
		const coordinator = REPO_COORDINATOR.get(doId);
		const apiKey = c.get('apiKey');

		try {
			const lockRes = await coordinator.fetch(new Request('https://do/lock', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					pusher: apiKey?.id || 'unknown',
					refs: refNames,
				}),
			}));

			if (lockRes.status === 409) {
				// Another push is in progress for the same ref
				const rejectBody = buildRejectResponse(
					parsedRefs,
					'another push is in progress for this ref — try again shortly'
				);
				return new Response(wrapInSideband(rejectBody), {
					status: 200,
					headers: {
						'Content-Type': 'application/x-git-receive-pack-result',
						'Cache-Control': 'no-cache',
					}
				});
			}

			const lockData = await lockRes.json() as { lock_id: string };
			lockId = lockData.lock_id;
		} catch (err: any) {
			console.error('Failed to acquire lock:', err.message);
			// Continue without lock — better to allow the push than to break git
		}
	}

	// ── Step 4: Proxy push to Artifacts ─────────────────────────
	try {
		const token = await getRepoToken(c.env, repoRecord.name, 'write', 300);

		const response = await fetch(`${getRemoteUrl(repoRecord.name)}/git-receive-pack`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/x-git-receive-pack-request'
			},
			body: requestBody,
		});

		// ── Step 5: Parse response to detect actual success/failure ──
		const responseBody = await response.arrayBuffer();
		let successfulBranches: string[] = [];
		let successfulShas: Map<string, string> = new Map();

		if (response.ok) {
			try {
				const report = parseReceivePackResponse(responseBody);

				if (report) {
					if (!report.unpackOk) {
						console.error(`Unpack failed for ${repoName}: ${report.unpackError}`);
					}

					for (const result of report.refResults) {
						if (result.success) {
							successfulBranches.push(result.branch);
							// Find the corresponding SHA from our parsed refs
							const matchingRef = parsedRefs.find(r => r.branch === result.branch);
							if (matchingRef) {
								successfulShas.set(result.branch, matchingRef.newSha);
							}
						} else {
							console.log(`Ref rejected by Artifacts: ${result.refName} — ${result.error}`);
						}
					}

					console.log(`Push result for ${repoName}: ${report.refResults.length} refs, ${successfulBranches.length} succeeded`);
				} else {
					// Couldn't parse response — fall back to assuming success for all refs
					// (this happens with some git protocol variations)
					console.warn(`Could not parse report-status for ${repoName}, falling back`);
					for (const ref of parsedRefs) {
						successfulBranches.push(ref.branch);
						successfulShas.set(ref.branch, ref.newSha);
					}
				}
			} catch (parseErr: any) {
				console.error('Failed to parse receive-pack response:', parseErr.message);
				// Fall back to assuming success for parsed refs
				for (const ref of parsedRefs) {
					successfulBranches.push(ref.branch);
					successfulShas.set(ref.branch, ref.newSha);
				}
			}
		}

		// ── Step 6: Post-push hooks (only for actually-successful refs) ──
		if (successfulBranches.length > 0) {
			// Audit log
			c.executionCtx.waitUntil(
				DB.prepare('INSERT INTO audit_log (id, action, repo_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
					.bind(
						crypto.randomUUID(), 'git.push', repoRecord.id,
						c.get('apiKey')?.id || 'system',
						JSON.stringify({
							repoName,
							branches: successfulBranches,
							commits: Object.fromEntries(successfulShas),
						}),
						new Date().toISOString()
					).run()
			);

			// Notify RepoCoordinator for WebSocket clients
			const doId = REPO_COORDINATOR.idFromName(repoRecord.id);
			const coordinator = REPO_COORDINATOR.get(doId);
			for (const branch of successfulBranches) {
				c.executionCtx.waitUntil(
					coordinator.fetch(new Request('https://do/push-event', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							branch,
							commit_sha: successfulShas.get(branch) || 'unknown',
							pusher: c.get('apiKey')?.id || 'unknown',
						}),
					}))
				);
			}

			// Trigger CI for each successfully-pushed branch
			c.executionCtx.waitUntil((async () => {
				for (const branch of successfulBranches) {
					const commitSha = successfulShas.get(branch) || 'unknown';

					try {
						let yamlContent = await c.env.CACHE.get(`ci-config:${repoRecord.name}`);

						if (!yamlContent) {
							yamlContent = `
name: auto
on:
  push:
    branches: [main]
jobs:
  deploy:
    sandbox: standard-2
    steps:
      - name: Push received
        run: echo "Deploying ${repoRecord.name}@${branch}"
`;
						}

						const config = parseCIConfig(yamlContent);

						// Check if this branch should trigger CI based on config
						const pushConfig = config.on?.push;
						if (pushConfig?.branches && !pushConfig.branches.includes(branch)) {
							console.log(`Skipping CI for ${repoName}@${branch} — not in trigger branches`);
							continue;
						}

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
						console.log(`CI triggered: run=${runId} repo=${repoName} branch=${branch} sha=${commitSha.slice(0, 7)}`);
					} catch (e: any) {
						console.error(`Failed to trigger CI for ${repoName}@${branch}:`, e.message);
					}
				}
			})());
		}

		// ── Step 6.5: Mirror to GitHub (async, non-blocking) ────────
		if (successfulBranches.length > 0) {
			c.executionCtx.waitUntil(
				triggerGitHubMirror(c.env, repoRecord.id, repoRecord.name, successfulBranches, successfulShas)
			);
		}

		// ── Step 7: Release lock ────────────────────────────────────
		if (lockId) {
			const doId = REPO_COORDINATOR.idFromName(repoRecord.id);
			const coordinator = REPO_COORDINATOR.get(doId);
			c.executionCtx.waitUntil(
				coordinator.fetch(new Request('https://do/unlock', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ lock_id: lockId }),
				}))
			);
		}

		// The client negotiates side-band-64k, so wrap the Artifacts response
		// in sideband framing. Artifacts returns raw report-status pkt-lines
		// (e.g. "unpack ok\n", "ok refs/heads/main\n") without sideband
		// wrapping, but the client expects band-1 framing.
		const sidebandBody = wrapInSideband(responseBody);

		return new Response(sidebandBody, {
			status: response.status,
			headers: {
				'Content-Type': 'application/x-git-receive-pack-result',
				'Cache-Control': 'no-cache',
			}
		});
	} catch (err: any) {
		// Release lock on error
		if (lockId) {
			const doId = REPO_COORDINATOR.idFromName(repoRecord.id);
			const coordinator = REPO_COORDINATOR.get(doId);
			try {
				await coordinator.fetch(new Request('https://do/unlock', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ lock_id: lockId }),
				}));
			} catch { /* ignore cleanup errors */ }
		}

		console.error(`Git receive-pack error for ${repoName}:`, err.message);
		return c.json({ error: 'Git protocol error', details: err.message }, 500);
	}
});

export default app;

