import { stringify } from 'yaml';
import type { Env } from '../env.ts';
import { githubApi, installationToken } from './github-app.ts';
import { pushRefsToGitHub } from './github-mirror.ts';

export interface ComputeConnection {
	id: string;
	installation_id: number;
	account_login: string;
	account_type: string;
	allow_private: number;
	blacksmith_enabled: number;
}
type PreparedMirror = { fullName: string; token: string; workflowSha: string };

export function ciMirrorFullName(repo: { id: string; name: string }, accountLogin: string): string {
	return `${accountLogin}/gf-${repo.name.slice(0, 84)}-${repo.id.slice(0, 8)}`;
}

const AGENT_SCRIPT = String.raw`
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const id = context.payload.client_payload.run_id;
const origin = process.env.GITFLARE_URL;
if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid GitFlare run id');
async function call(suffix, body) {
  const token = await core.getIDToken('gitflare');
  const res = await fetch(origin + '/api/internal/github/runs/' + id + suffix, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error('GitFlare callback failed: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
  return res.json();
}
const job = await call('');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitflare-'));
const deadline = Date.now() + job.maxDurationMs;
let outcome = 'passed';
let detail = '';
try {
  const gitEnv = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: 'Authorization: Bearer ' + job.checkout.token };
  cp.execFileSync('git', ['clone', '-q', '--no-checkout', job.checkout.url, dir], { env: gitEnv, stdio: 'pipe', timeout: 120000 });
  cp.execFileSync('git', ['checkout', '-q', job.sha], { cwd: dir, env: gitEnv, stdio: 'pipe', timeout: 120000 });
  if (job.checkout.lfs) {
    const check = cp.spawnSync('git', ['lfs', 'version'], { cwd: dir, encoding: 'utf8' });
    if (check.status !== 0 && job.checkout.lfs.mode === true) throw new Error('git-lfs is required by checkout.lfs: true');
    if (check.status === 0) {
      const lfsEnv = { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'lfs.url', GIT_CONFIG_VALUE_0: job.checkout.lfs.url,
        GIT_CONFIG_KEY_1: 'http.extraHeader', GIT_CONFIG_VALUE_1: 'Authorization: Bearer ' + job.checkout.lfs.token };
      cp.execFileSync('git', ['lfs', 'pull'], { cwd: dir, env: lfsEnv, timeout: 120000, stdio: 'pipe' });
    }
  }
  for (const step of job.steps) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('CI run exceeded its time limit');
    const started = Date.now();
    const result = cp.spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', step.command], {
      cwd: dir, env: { ...process.env, ...step.env }, encoding: 'utf8',
      timeout: Math.min(step.timeout ? step.timeout * 1000 : remaining, remaining), maxBuffer: 1024 * 1024,
    });
    const logs = ((result.stdout || '') + (result.stderr || '') + (result.error ? '\n' + result.error.message : '')).slice(0, 100000);
    const exitCode = result.status === null ? 1 : result.status;
    await call('/steps', { step_id: step.id, exit_code: exitCode, logs, duration_ms: Date.now() - started });
    if (logs) core.info(logs);
    if (exitCode !== 0) { outcome = 'failed'; detail = 'Step ' + step.name + ' failed'; break; }
  }
} catch (error) {
  outcome = 'failed'; detail = String(error).slice(0, 500);
} finally {
  await call('/complete', { status: outcome, detail });
  fs.rmSync(dir, { recursive: true, force: true });
}
if (outcome !== 'passed') core.setFailed(detail);
`;

const MERGE_SCRIPT = String.raw`
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const id = context.payload.client_payload.attempt_id;
const origin = process.env.GITFLARE_URL;
if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid merge attempt id');
async function call(suffix, body) {
  const token = await core.getIDToken('gitflare');
  const res = await fetch(origin + '/api/internal/github/merges/' + id + suffix, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error('GitFlare merge callback failed: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
  return res.json();
}
const task = await call('');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitflare-merge-'));
let success = false;
let resultSha = null;
let error = '';
let conflicts = [];
try {
  const readEnv = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: 'Authorization: Bearer ' + task.checkout.token };
  cp.execFileSync('git', ['clone', '-q', task.checkout.url, dir], { env: readEnv, timeout: 120000 });
  cp.execFileSync('git', ['checkout', '-q', '--detach', task.head_sha], { cwd: dir, env: readEnv });
  cp.execFileSync('git', ['-c', 'user.name=GitFlare Merge Queue', '-c', 'user.email=merge-queue@gitflare.invalid', 'rebase', task.base_sha],
    { cwd: dir, env: readEnv, timeout: 180000, stdio: 'pipe' });
  resultSha = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const writeEnv = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from('x-access-token:' + task.push_token).toString('base64') };
  cp.execFileSync('git', ['push', task.push_url, 'HEAD:refs/heads/gitflare/merge-queue/' + task.ticket_id],
    { cwd: dir, env: writeEnv, timeout: 120000, stdio: 'pipe' });
  success = true;
} catch (e) {
  error = String(e).slice(0, 1500);
  try { conflicts = cp.execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').filter(Boolean).slice(0, 100); } catch (_) {}
} finally {
  await call('/complete', { success, result_sha: resultSha, base_sha: task.base_sha, error, conflicts });
  fs.rmSync(dir, { recursive: true, force: true });
}
if (!success) core.setFailed(error);
`;

export function buildGithubWorkflow(appUrl: string): string {
	const config = {
		name: 'GitFlare CI',
		on: { repository_dispatch: { types: ['gitflare-ci', 'gitflare-merge'] } },
		permissions: { contents: 'read', 'id-token': 'write' },
		jobs: {
			ci: {
				if: "github.event.action == 'gitflare-ci'",
				'runs-on': '${{ github.event.client_payload.runner_label }}',
				'timeout-minutes': 20,
				env: { GITFLARE_URL: appUrl },
				steps: [{ uses: 'actions/github-script@v8', with: { script: AGENT_SCRIPT } }],
			},
			merge: {
				if: "github.event.action == 'gitflare-merge'",
				'runs-on': '${{ github.event.client_payload.runner_label }}',
				'timeout-minutes': 12,
				env: { GITFLARE_URL: appUrl },
				steps: [{ uses: 'actions/github-script@v8', with: { script: MERGE_SCRIPT } }],
			},
		},
	};
	return stringify(config);
}

async function apiJson<T>(path: string, token: string, init?: RequestInit): Promise<T> {
	const res = await githubApi(path, token, init);
	if (!res.ok) throw new Error(`GitHub API ${path} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
	return res.status === 204 ? (undefined as T) : res.json<T>();
}

async function ensureWorkflow(env: Env, fullName: string, token: string): Promise<string> {
	const path = `/repos/${fullName}/contents/.github/workflows/gitflare.yml`;
	const content = btoa(unescape(encodeURIComponent(buildGithubWorkflow(env.APP_URL))));
	const current = await githubApi(`${path}?ref=gitflare-control`, token);
	if (current.status !== 404 && !current.ok) throw new Error(`Could not read GitHub CI workflow (${current.status})`);
	const old = current.ok ? await current.json<{ sha: string; content: string }>() : null;
	if (old?.content?.replace(/\s/g, '') !== content) {
		await apiJson(path, token, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: 'Update GitFlare CI dispatch workflow.', content, branch: 'gitflare-control', ...(old ? { sha: old.sha } : {}) }) });
	}
	const ref = await apiJson<{ object: { sha: string } }>(`/repos/${fullName}/git/ref/heads/gitflare-control`, token);
	return ref.object.sha;
}

/** A separate control branch holds the dispatch workflow; source branches are
 * mirrored verbatim and cannot overwrite it. */
export async function ensureCIMirror(env: Env, repo: { id: string; name: string; is_private: number }, connection: ComputeConnection): Promise<{ fullName: string; token: string; workflowSha: string }> {
	const token = await installationToken(env, connection.installation_id);
	const existing = await env.DB.prepare('SELECT full_name, is_private FROM github_ci_mirrors WHERE repo_id = ? AND connection_id = ?')
		.bind(repo.id, connection.id).first<{ full_name: string; is_private: number }>();
	if (existing) {
		if (existing.is_private !== Number(repo.is_private)) {
			if (repo.is_private) throw new Error('GitHub CI mirror is public while GitFlare repository is private');
			const changed = await githubApi(`/repos/${existing.full_name}`, token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ private: false }) });
			if (!changed.ok) throw new Error(`Could not update CI mirror visibility (${changed.status})`);
			await env.DB.prepare('UPDATE github_ci_mirrors SET is_private = 0 WHERE repo_id = ? AND connection_id = ?')
				.bind(repo.id, connection.id).run();
		}
		const workflowSha = await ensureWorkflow(env, existing.full_name, token);
		await env.DB.prepare('UPDATE github_ci_mirrors SET workflow_sha = ? WHERE repo_id = ? AND connection_id = ?')
			.bind(workflowSha, repo.id, connection.id).run();
		return { fullName: existing.full_name, token, workflowSha };
	}
	if (connection.account_type !== 'Organization') throw new Error('GitHub CI mirrors currently require an organization connection');
	const mirrorName = ciMirrorFullName(repo, connection.account_login).split('/')[1];
	const description = `GitFlare CI mirror ${repo.id}`;
	const create = await githubApi(`/orgs/${encodeURIComponent(connection.account_login)}/repos`, token,
		{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: mirrorName, private: Boolean(repo.is_private), auto_init: true, description }) });
	let created: { full_name: string; default_branch: string; private: boolean; owner: { login: string }; description: string };
	if (create.ok) created = await create.json();
	else if (create.status === 422) {
		created = await apiJson(`/repos/${encodeURIComponent(connection.account_login)}/${encodeURIComponent(mirrorName)}`, token);
		if (created.description !== description) throw new Error('A different GitHub repository already uses the CI mirror name');
	} else throw new Error(`GitHub mirror creation failed (${create.status})`);
	if (created.owner.login.toLowerCase() !== connection.account_login.toLowerCase() || created.private !== Boolean(repo.is_private)) {
		throw new Error('GitHub created a mirror with unexpected owner or visibility');
	}
	const fullName = created.full_name;
	if (created.default_branch !== 'gitflare-control') {
		const initial = await apiJson<{ object: { sha: string } }>(`/repos/${fullName}/git/ref/heads/${encodeURIComponent(created.default_branch)}`, token);
		const control = await githubApi(`/repos/${fullName}/git/refs`, token, { method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ref: 'refs/heads/gitflare-control', sha: initial.object.sha }) });
		if (!control.ok && control.status !== 422) throw new Error(`GitHub control branch creation failed (${control.status})`);
	}
	await apiJson(`/repos/${fullName}`, token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ default_branch: 'gitflare-control' }) });
	const workflowSha = await ensureWorkflow(env, fullName, token);
	await env.DB.prepare('INSERT INTO github_ci_mirrors (repo_id, connection_id, full_name, is_private, workflow_sha) VALUES (?, ?, ?, ?, ?)')
		.bind(repo.id, connection.id, fullName, Number(repo.is_private), workflowSha).run();
	return { fullName, token, workflowSha };
}

export async function dispatchGitHubCI(env: Env, repo: { id: string; name: string; is_private: number }, connection: ComputeConnection,
	runId: string, branch: string, sha: string, blacksmith: boolean, prepared?: PreparedMirror): Promise<string> {
	if (branch === 'gitflare-control') throw new Error('Branch name gitflare-control is reserved for GitFlare CI mirrors');
	const mirror = prepared ?? await ensureCIMirror(env, repo, connection);
	const sync = await pushRefsToGitHub(env, repo.name, `https://github.com/${mirror.fullName}.git`, mirror.token, [branch]);
	if (!sync.some((result) => result.status === 'success' && result.sha === sha)) {
		throw new Error(`Could not mirror ${repo.name}@${sha.slice(0, 7)} to GitHub: ${sync.map((r) => r.error).filter(Boolean).join('; ')}`);
	}
	const runnerLabel = blacksmith ? 'blacksmith-2vcpu-ubuntu-2404' : 'ubuntu-latest';
	await apiJson(`/repos/${mirror.fullName}/dispatches`, mirror.token, { method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ event_type: 'gitflare-ci', client_payload: { run_id: runId, runner_label: runnerLabel } }) });
	return mirror.fullName;
}

export async function dispatchGitHubMerge(env: Env, repo: { id: string; name: string; is_private: number }, connection: ComputeConnection,
	attemptId: string, branch: string, headSha: string, baseBranch: string, baseSha: string, blacksmith: boolean, prepared?: PreparedMirror): Promise<string> {
	if (branch === 'gitflare-control' || baseBranch === 'gitflare-control') throw new Error('gitflare-control is reserved for CI mirrors');
	const mirror = prepared ?? await ensureCIMirror(env, repo, connection);
	const sync = await pushRefsToGitHub(env, repo.name, `https://github.com/${mirror.fullName}.git`, mirror.token, [branch, baseBranch]);
	if (!sync.some((r) => r.status === 'success' && r.sha === headSha) || !sync.some((r) => r.status === 'success' && r.sha === baseSha)) {
		throw new Error('Could not mirror the queued head and base commits to GitHub');
	}
	await apiJson(`/repos/${mirror.fullName}/dispatches`, mirror.token, { method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ event_type: 'gitflare-merge', client_payload: { attempt_id: attemptId,
			runner_label: blacksmith ? 'blacksmith-2vcpu-ubuntu-2404' : 'ubuntu-latest' } }) });
	return mirror.fullName;
}
