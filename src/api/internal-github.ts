import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { verifyGitHubOidc } from '../lib/github-oidc.ts';
import { getArtifactsRemoteUrl } from '../lib/artifacts-url.ts';
import { mintReadToken } from '../lib/runner-client.ts';
import { storeStepLogs, type LogLine } from '../lib/ci-logs.ts';
import { enqueueDeploysForRun } from '../lib/deploy-targets.ts';
import { notifyMergeQueueCI } from './internal-merge.ts';
import { ticketQueueStub } from './internal-merge.ts';
import { mintMergeToken } from '../lib/merge-token.ts';
import { getArtifactRefs } from '../lib/artifact-reader.ts';
import { mintLfsToken } from '../lib/lfs-token.ts';

const app = new Hono<{ Bindings: Env }>();

export interface GithubMergeAttempt {
	ticketId: string;
	repoId: string;
	repoName: string;
	connectionId: string;
	fullName: string;
	workflowSha: string;
	branch: string;
	headSha: string;
	baseSha: string;
	baseBranch: string;
}

async function authorizedMerge(c: { env: Env; req: { param(name: string): string; header(name: string): string | undefined } }): Promise<GithubMergeAttempt | null> {
	const id = c.req.param('id');
	if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
	const stored = await c.env.CACHE.get(`github-merge:${id}`);
	if (!stored) return null;
	const attempt = JSON.parse(stored) as GithubMergeAttempt;
	const auth = c.req.header('Authorization');
	if (!auth?.startsWith('Bearer ')) return null;
	const claims = await verifyGitHubOidc(auth.slice(7), attempt.fullName, attempt.workflowSha);
	const binding = await c.env.DB.prepare('SELECT github_run_id FROM github_merge_run_bindings WHERE attempt_id = ?')
		.bind(id).first<{ github_run_id: string | null }>();
	if (!binding) return null;
	if (!binding.github_run_id) {
		await c.env.DB.prepare('UPDATE github_merge_run_bindings SET github_run_id = ? WHERE attempt_id = ? AND github_run_id IS NULL')
			.bind(claims.run_id, id).run();
	}
	const current = await c.env.DB.prepare('SELECT github_run_id FROM github_merge_run_bindings WHERE attempt_id = ?')
		.bind(id).first<{ github_run_id: string | null }>();
	if (current?.github_run_id !== claims.run_id) return null;
	return attempt;
}

app.get('/merges/:id', async (c) => {
	let attempt: GithubMergeAttempt | null;
	try { attempt = await authorizedMerge(c); } catch { return c.json({ error: 'Unauthorized' }, 401); }
	if (!attempt) return c.json({ error: 'Merge attempt unavailable' }, 404);
	return c.json({ ticket_id: attempt.ticketId, base_sha: attempt.baseSha, head_sha: attempt.headSha,
		checkout: { url: getArtifactsRemoteUrl(c.env, attempt.repoName), token: await mintReadToken(c.env, attempt.repoName, 900) },
		push_url: `${c.env.APP_URL}/git/${encodeURIComponent(attempt.repoName)}.git`,
		push_token: await mintMergeToken(c.env.ENCRYPTION_KEY, { repoId: attempt.repoId, ticketId: attempt.ticketId, attemptId: c.req.param('id') }) });
});

app.post('/merges/:id/complete', async (c) => {
	let attempt: GithubMergeAttempt | null;
	try { attempt = await authorizedMerge(c); } catch { return c.json({ error: 'Unauthorized' }, 401); }
	if (!attempt) return c.json({ error: 'Merge attempt unavailable' }, 404);
	const body = await c.req.json<{ success?: boolean; result_sha?: string; base_sha?: string; error?: string; conflicts?: string[] }>().catch(() => null);
	if (!body || typeof body.success !== 'boolean' || body.base_sha !== attempt.baseSha ||
		(body.success && !/^[0-9a-f]{40}$/i.test(body.result_sha || ''))) return c.json({ error: 'Invalid merge result' }, 400);
	if (body.success) {
		const refs = await getArtifactRefs(c.env, attempt.repoName);
		if (refs.get(`refs/heads/gitflare/merge-queue/${attempt.ticketId}`) !== body.result_sha) {
			return c.json({ error: 'Merge result branch does not match the reported commit' }, 409);
		}
	}
	const result = await ticketQueueStub(c.env, attempt.repoId).fetch(new Request('https://do/merge-result', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ticketId: attempt.ticketId, attemptId: c.req.param('id'), op: 'merge', success: body.success,
			resultSha: body.result_sha, baseSha: attempt.baseSha, error: typeof body.error === 'string' ? body.error.slice(0, 1500) : undefined,
			conflicts: Array.isArray(body.conflicts) ? body.conflicts.filter((x) => typeof x === 'string').slice(0, 100) : undefined }),
	}));
	if (!result.ok) return c.json({ error: 'Merge queue unavailable' }, 503);
	return c.json(await result.json());
});

type Run = { id: string; repo_id: string; branch: string; commit_sha: string; status: string;
	trigger: string; github_run_id: string | null; github_workflow_sha: string | null; started_at: string | null; created_at: string; connection_id: string };

async function authorizedRun(c: { env: Env; req: { param(name: string): string; header(name: string): string | undefined } }): Promise<Run | null> {
	const id = c.req.param('id');
	if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
	const run = await c.env.DB.prepare("SELECT * FROM ci_runs WHERE id = ? AND backend IN ('github', 'blacksmith')")
		.bind(id).first<Run>();
	if (!run || !run.connection_id) return null;
	const mirror = await c.env.DB.prepare('SELECT full_name, workflow_sha FROM github_ci_mirrors WHERE repo_id = ? AND connection_id = ?')
		.bind(run.repo_id, run.connection_id).first<{ full_name: string; workflow_sha: string }>();
	if (!mirror) return null;
	const auth = c.req.header('Authorization');
	if (!auth?.startsWith('Bearer ')) return null;
	if (!run.github_workflow_sha) return null;
	const claims = await verifyGitHubOidc(auth.slice(7), mirror.full_name, run.github_workflow_sha);
	if (run.github_run_id && run.github_run_id !== claims.run_id) return null;
	if (!run.github_run_id) {
		const bound = await c.env.DB.prepare(
			"UPDATE ci_runs SET github_run_id = ? WHERE id = ? AND github_run_id IS NULL AND status = 'running'"
		).bind(claims.run_id, id).run();
		if (!bound.meta.changes) {
			const current = await c.env.DB.prepare('SELECT github_run_id FROM ci_runs WHERE id = ?').bind(id).first<{ github_run_id: string | null }>();
			if (current?.github_run_id !== claims.run_id) return null;
		}
	}
	return run;
}

app.get('/runs/:id', async (c) => {
	let run: Run | null;
	try { run = await authorizedRun(c); } catch (err) { console.warn('GitHub OIDC rejected', err); return c.json({ error: 'Unauthorized' }, 401); }
	if (!run || run.status !== 'running') return c.json({ error: 'Run unavailable' }, 404);
	const repo = await c.env.DB.prepare('SELECT name FROM repositories WHERE id = ?').bind(run.repo_id).first<{ name: string }>();
	if (!repo) return c.json({ error: 'Repository unavailable' }, 404);
	const { results: steps } = await c.env.DB.prepare(
		'SELECT id, name, command, job_name, step_index FROM ci_steps WHERE run_id = ? ORDER BY global_ordinal ASC'
	).bind(run.id).all<{ id: string; name: string; command: string; job_name: string; step_index: number }>();
	// The queue snapshot is the source for environment and timeout values.
	const snapshot = await c.env.DB.prepare('SELECT config_snapshot FROM ci_runs WHERE id = ?').bind(run.id).first<{ config_snapshot: string | null }>();
	let config: { env?: Record<string, string>; checkout?: { lfs?: 'auto' | boolean }; jobs?: Record<string, { env?: Record<string, string>; steps?: Array<{ env?: Record<string, string>; timeout?: number }> }> } = {};
	try { config = JSON.parse(snapshot?.config_snapshot || '{}'); } catch { /* invalid snapshot has no overrides */ }
	const prepared = steps.map((step) => {
		const job = config.jobs?.[step.job_name];
		const source = job?.steps?.[step.step_index];
		return { ...step, env: { ...config.env, ...job?.env, ...source?.env }, timeout: source?.timeout };
	});
	const lfsMode = config.checkout?.lfs ?? 'auto';
	return c.json({ sha: run.commit_sha, steps: prepared, maxDurationMs: Number(c.env.MAX_CI_DURATION_MS) || 900000,
		checkout: { url: getArtifactsRemoteUrl(c.env, repo.name), token: await mintReadToken(c.env, repo.name, 1800),
			lfs: lfsMode === false ? null : { mode: lfsMode, url: `${c.env.APP_URL}/git/${encodeURIComponent(repo.name)}.git/info/lfs`,
				token: await mintLfsToken(c.env.ENCRYPTION_KEY, { repoId: run.repo_id, scope: 'read', ttlSeconds: 1800 }) } } });
});

app.post('/runs/:id/steps', async (c) => {
	let run: Run | null;
	try { run = await authorizedRun(c); } catch { return c.json({ error: 'Unauthorized' }, 401); }
	if (!run || run.status !== 'running') return c.json({ error: 'Run unavailable' }, 404);
	const body = await c.req.json<{ step_id?: string; exit_code?: number; logs?: string; duration_ms?: number }>().catch(() => null);
	if (!body || typeof body.step_id !== 'string' || !Number.isInteger(body.exit_code) ||
		typeof body.logs !== 'string' || body.logs.length > 150000 || !Number.isFinite(body.duration_ms) || Number(body.duration_ms) < 0) {
		return c.json({ error: 'Invalid step report' }, 400);
	}
	const step = await c.env.DB.prepare('SELECT id, global_ordinal FROM ci_steps WHERE id = ? AND run_id = ?')
		.bind(body.step_id, run.id).first<{ id: string; global_ordinal: number }>();
	if (!step) return c.json({ error: 'Step not found' }, 404);
	const now = new Date().toISOString();
	const changed = await c.env.DB.prepare(
		"UPDATE ci_steps SET status = ?, exit_code = ?, duration_ms = ?, finished_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND run_id = ? AND status IN ('pending', 'running')"
	).bind(body.exit_code === 0 ? 'passed' : 'failed', body.exit_code, body.duration_ms, now, now, step.id, run.id).run();
	if (changed.meta.changes) {
		const lines: LogLine[] = body.logs.split('\n').filter(Boolean).map((line) => ({ timestamp: now, stream: 'stdout', line }));
		await storeStepLogs(c.env.STORAGE, c.env.DB, { id: step.id, runId: run.id, ordinal: step.global_ordinal }, lines);
	}
	return c.json({ ok: true });
});

app.post('/runs/:id/complete', async (c) => {
	let run: Run | null;
	try { run = await authorizedRun(c); } catch { return c.json({ error: 'Unauthorized' }, 401); }
	if (!run) return c.json({ error: 'Run unavailable' }, 404);
	const body = await c.req.json<{ status?: string; detail?: string }>().catch(() => null);
	if (!body || !['passed', 'failed'].includes(body.status || '')) return c.json({ error: 'Invalid completion' }, 400);
	const now = new Date().toISOString();
	const counts = await c.env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed FROM ci_steps WHERE run_id = ?")
		.bind(run.id).first<{ total: number; passed: number }>();
	const status = body.status === 'passed' && counts?.total === counts?.passed ? 'passed' : 'failed';
	const updated = await c.env.DB.prepare(
		"UPDATE ci_runs SET status = ?, finished_at = ?, duration_ms = ?, error_message = ? WHERE id = ? AND status = 'running'"
	).bind(status, now, Date.parse(now) - Date.parse(run.started_at || run.created_at),
		status === 'failed' ? (typeof body.detail === 'string' ? body.detail.slice(0, 2000) : 'GitHub CI failed') : null, run.id).run();
	if (!updated.meta.changes) return c.json({ ok: true, ignored: true });
	await c.env.DB.prepare("UPDATE ci_steps SET status = 'skipped', finished_at = ? WHERE run_id = ? AND status IN ('pending', 'running')")
		.bind(now, run.id).run();
	if (run.trigger === 'merge_queue') await notifyMergeQueueCI(c.env, run, status);
	else if (status === 'passed') {
		const repo = await c.env.DB.prepare('SELECT name FROM repositories WHERE id = ?').bind(run.repo_id).first<{ name: string }>();
		if (repo) await enqueueDeploysForRun(c.env, run, repo.name);
	}
	return c.json({ ok: true, status });
});

export default app;
