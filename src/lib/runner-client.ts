/**
 * Worker → Runner HTTP client.
 *
 * Every call sends the protocol header (see runner-protocol.ts) and returns a
 * classified result instead of throwing, so queue consumers can decide between
 * retry (transient) and fail-fast (permanent).
 */
import type { Env } from '../env.ts';
import {
	RUNNER_PROTOCOL_HEADER,
	RUNNER_PROTOCOL_VERSION,
	type RunnerCIRequest,
	type RunnerDeployRequest,
	type RunnerMergeRequest,
} from './runner-protocol.ts';

/** How long to wait for the runner to acknowledge (not complete) a request. */
const RUNNER_REQUEST_TIMEOUT_MS = 15_000;

export type RunnerResult =
	| { ok: true; status: number; body: unknown }
	| { ok: false; transient: boolean; status?: number; error: string };

/** Public base URL the runner calls back to. APP_URL is required (wrangler.jsonc vars). */
function appBase(env: Env): string {
	if (!env.APP_URL) throw new Error('APP_URL is not configured — runner callback URLs cannot be built');
	return env.APP_URL.replace(/\/+$/, '');
}

export function ciCallbackUrl(env: Env): string {
	return `${appBase(env)}/api/internal/ci/callback`;
}

export function ciLogsUrl(env: Env): string {
	return `${appBase(env)}/api/internal/ci/logs`;
}

export function deployCallbackUrl(env: Env): string {
	return `${appBase(env)}/api/internal/deploy/callback`;
}

export function mergeCallbackUrl(env: Env): string {
	return `${appBase(env)}/api/internal/merge/callback`;
}

async function postToRunner(env: Env, path: string, body: unknown, acceptStatuses: number[]): Promise<RunnerResult> {
	if (!env.RUNNER_URL) return { ok: false, transient: false, error: 'RUNNER_URL is not configured' };
	if (!env.RUNNER_SECRET) return { ok: false, transient: false, error: 'RUNNER_SECRET is not configured' };

	const endpoint = `${env.RUNNER_URL.replace(/\/+$/, '')}${path}`;
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${env.RUNNER_SECRET}`,
				[RUNNER_PROTOCOL_HEADER]: String(RUNNER_PROTOCOL_VERSION),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(RUNNER_REQUEST_TIMEOUT_MS),
		});
	} catch (err) {
		const reason =
			err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
				? `timed out after ${RUNNER_REQUEST_TIMEOUT_MS}ms`
				: err instanceof Error
					? err.message
					: String(err);
		return { ok: false, transient: true, error: `Runner unreachable at ${endpoint}: ${reason}` };
	}

	let text = '';
	try {
		text = await response.text();
	} catch {
		// body unreadable — status alone is enough
	}
	let parsed: unknown = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}

	if (acceptStatuses.includes(response.status)) {
		return { ok: true, status: response.status, body: parsed };
	}

	// 426: protocol mismatch — the other half of a lockstep deploy is still
	// rolling out. 408/429/5xx: runner busy or restarting. All retryable.
	const transient = response.status === 426 || response.status === 408 || response.status === 429 || response.status >= 500;
	return {
		ok: false,
		transient,
		status: response.status,
		error: `Runner returned HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`,
	};
}

/** Submit a CI run. Success = HTTP 202. */
export function dispatchCIRun(env: Env, request: RunnerCIRequest): Promise<RunnerResult> {
	return postToRunner(env, '/webhook/ci', request, [202]);
}

/** Submit a deployment. Success = HTTP 202. */
export function dispatchDeploy(env: Env, request: RunnerDeployRequest): Promise<RunnerResult> {
	return postToRunner(env, '/webhook/deploy', request, [202]);
}

/** Submit a merge-queue git operation. Success = HTTP 202. */
export function dispatchMerge(env: Env, request: RunnerMergeRequest): Promise<RunnerResult> {
	return postToRunner(env, '/webhook/merge', request, [202]);
}

/**
 * Ask the runner to kill a run's container. 200 = killed, 404 = the runner
 * doesn't know the run (already finished, or never dispatched) — both fine.
 */
export function cancelRunnerRun(env: Env, runId: string): Promise<RunnerResult> {
	return postToRunner(env, '/webhook/ci/cancel', { protocolVersion: RUNNER_PROTOCOL_VERSION, runId }, [200, 404]);
}

/** Mint a short-lived read token for the runner to clone with. */
export function mintReadToken(env: Env, repoName: string, ttlSeconds: number): Promise<string> {
	return mintToken(env, repoName, 'read', ttlSeconds);
}

/** Mint a short-lived Artifacts token. */
export async function mintToken(env: Env, repoName: string, permission: 'read' | 'write', ttlSeconds: number): Promise<string> {
	const repo = await env.REPOS.get(repoName);
	if (!repo) throw new Error(`Repository "${repoName}" not found in Artifacts`);
	const tokenResult: unknown = await repo.createToken(permission, ttlSeconds);
	if (typeof tokenResult === 'string') return tokenResult;
	const plaintext = (tokenResult as { plaintext?: unknown } | null)?.plaintext;
	if (typeof plaintext === 'string') return plaintext;
	throw new Error('Artifacts createToken returned an unexpected shape');
}
