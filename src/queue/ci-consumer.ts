/**
 * Queue consumers for CI runs and deployments (B1.2).
 *
 * Both handlers follow the same contract with the queue (src/index.ts):
 *   - return normally  → ack
 *   - throw            → retry; after max_retries the message goes to the DLQ
 *
 * Errors are NOT swallowed. Before throwing on a transient failure the row is
 * put back into its claimable state so the retry can claim it again; on the
 * final attempt it is marked failed instead (and the throw still DLQs it).
 *
 * All execution — CI steps AND deploys of every type — goes through the
 * runner. There is no Worker-side Coolify fallback.
 */
import type { CIJobMessage, CIPipelineConfig, DeployJobMessage, Env, LegacyDeployJobMessage } from '../env.ts';
import { getJobExecutionOrder } from '../lib/ci-parser.ts';
import { getArtifactsRemoteUrl } from '../lib/artifacts-url.ts';
import {
	enqueueDeploysForRun,
	isDeployTargetType,
	isValidWranglerConfig,
	readCoolifyApiKey,
	resolveCommitSha,
} from '../lib/deploy-targets.ts';
import {
	ciCallbackUrl,
	ciLogsUrl,
	deployCallbackUrl,
	dispatchCIRun,
	dispatchDeploy,
	mintReadToken,
} from '../lib/runner-client.ts';
import { RUNNER_PROTOCOL_VERSION, type RunnerCIStep, type RunnerDeployRequest } from '../lib/runner-protocol.ts';
import { notifyMergeQueueCI } from '../api/internal-merge.ts';

/** Must match max_retries in wrangler.jsonc (+1 for the first delivery). */
const MAX_DELIVERY_ATTEMPTS = 4;
/** Clone happens at job start; the runner may queue a job briefly first. */
const CHECKOUT_TOKEN_TTL_S = 30 * 60;
/** Coolify poll deadline (B1.4) and Cloudflare deploy budget. */
export const DEPLOY_DEADLINE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CI_DURATION_MS = 15 * 60 * 1000;

export interface QueueDelivery {
	/** 1-based delivery attempt (Message.attempts). */
	attempts: number;
}

/** Thrown for failures worth retrying (runner down, Artifacts hiccup, protocol skew). */
export class TransientError extends Error {}

export function maxCIDurationMs(env: Env): number {
	const n = Number(env.MAX_CI_DURATION_MS);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CI_DURATION_MS;
}

type OrderedStep = Omit<RunnerCIStep, 'id' | 'ordinal'> & { stepIndex: number };

/**
 * Flatten the pipeline into an ordered list of runner steps.
 * Jobs are ordered by `needs` (topological groups); within a group, jobs run
 * in declaration order. Env is merged pipeline → job → step. Steps without a
 * `run` command are skipped.
 */
function getOrderedSteps(config: CIPipelineConfig): OrderedStep[] {
	const ordered: OrderedStep[] = [];
	for (const group of getJobExecutionOrder(config)) {
		for (const jobName of group) {
			const job = config.jobs[jobName];
			job.steps.forEach((step, stepIndex) => {
				if (!step.run) return;
				const env = { ...config.env, ...job.env, ...step.env };
				ordered.push({
					jobName,
					stepIndex,
					name: step.name || step.run,
					command: step.run,
					...(Object.keys(env).length > 0 ? { env } : {}),
					...(step.timeout !== undefined ? { timeout: step.timeout } : {}),
				});
			});
		}
	}
	return ordered;
}

// ─── CI ─────────────────────────────────────────────────────────

async function failRun(env: Env, runId: string, reason: string, fromStatuses: string[] = ['queued', 'running']): Promise<void> {
	const now = new Date().toISOString();
	console.error(`CI run ${runId} failed: ${reason}`);
	const placeholders = fromStatuses.map(() => '?').join(', ');
	const [runUpdate] = await env.DB.batch([
		env.DB.prepare(`UPDATE ci_runs SET status = 'failed', finished_at = ? WHERE id = ? AND status IN (${placeholders})`).bind(
			now,
			runId,
			...fromStatuses
		),
		env.DB.prepare("UPDATE ci_steps SET status = 'skipped', finished_at = ? WHERE run_id = ? AND status IN ('pending', 'running')").bind(
			now,
			runId
		),
	]);
	if (runUpdate.meta.changes) {
		// A merge-queue gate run that never reached the runner still has to
		// release the queue (B4.4) — don't make it wait for the timeout.
		const run = await env.DB.prepare('SELECT id, repo_id, trigger FROM ci_runs WHERE id = ?')
			.bind(runId)
			.first<{ id: string; repo_id: string; trigger: string }>();
		if (run) await notifyMergeQueueCI(env, run, 'failed');
	}
}

/**
 * Release a claimed run so a retry can claim it again (transient failure), or
 * fail it if this was the last delivery. Always rethrows so the queue retries
 * / dead-letters the message.
 */
async function releaseOrFailRun(env: Env, runId: string, delivery: QueueDelivery, error: string): Promise<never> {
	if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
		await failRun(env, runId, `${error} (gave up after ${delivery.attempts} attempts)`);
	} else {
		await env.DB.prepare("UPDATE ci_runs SET status = 'queued', started_at = NULL WHERE id = ? AND status = 'running'").bind(runId).run();
	}
	throw new TransientError(error);
}

export async function handleCIJob(message: CIJobMessage, env: Env, delivery: QueueDelivery): Promise<void> {
	const { DB } = env;

	const run = await DB.prepare('SELECT id, repo_id, branch, commit_sha, status, trigger FROM ci_runs WHERE id = ?')
		.bind(message.runId)
		.first<{ id: string; repo_id: string; branch: string; commit_sha: string; status: string; trigger: string }>();
	if (!run) {
		console.warn(`CI run ${message.runId} no longer exists — dropping message`);
		return;
	}
	if (run.status !== 'queued') {
		// Already claimed by an earlier delivery, cancelled, or finished.
		console.log(`CI run ${run.id} is '${run.status}', not dispatching`);
		return;
	}

	// ── Resolve HEAD to the branch tip ──
	let commitSha: string | null;
	try {
		commitSha = await resolveCommitSha(env, message.repoName, run.branch, run.commit_sha);
	} catch (err) {
		if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) await failRun(env, run.id, `Could not read refs: ${String(err)}`, ['queued']);
		throw new TransientError(`Could not read refs for ${message.repoName}: ${String(err)}`);
	}
	if (!commitSha) {
		await failRun(env, run.id, `Branch '${run.branch}' (or commit '${run.commit_sha}') not found`, ['queued']);
		return;
	}

	const steps = message.config?.jobs ? getOrderedSteps(message.config) : [];
	const now = new Date().toISOString();

	// ── Claim (prevents double dispatch on redelivery / concurrent consumers) ──
	const claim = await DB.prepare(
		"UPDATE ci_runs SET status = 'running', started_at = ?, commit_sha = ? WHERE id = ? AND status = 'queued'"
	)
		.bind(now, commitSha, run.id)
		.run();
	if (!claim.meta.changes) {
		console.log(`CI run ${run.id} was claimed or cancelled concurrently`);
		return;
	}

	if (steps.length === 0) {
		// Nothing to execute: pass immediately and fan out deploys, as the
		// callback would.
		await DB.prepare("UPDATE ci_runs SET status = 'passed', finished_at = ?, duration_ms = 0 WHERE id = ? AND status = 'running'")
			.bind(now, run.id)
			.run();
		if (run.trigger === 'merge_queue') {
			// Merge-queue gate: the TicketQueue fast-forwards and deploys the base branch.
			await notifyMergeQueueCI(env, run, 'passed');
			return;
		}
		await enqueueDeploysForRun(env, { ...run, commit_sha: commitSha }, message.repoName);
		return;
	}

	// ── Create step rows (ids + global ordinals) BEFORE dispatch ──
	// A previous delivery may already have created them (and the runner may
	// even have accepted that dispatch before the ack timed out). Reuse those
	// ids when the shape matches so the runner's echoed ids still resolve.
	const { results: existing } = await DB.prepare(
		'SELECT id, global_ordinal FROM ci_steps WHERE run_id = ? ORDER BY global_ordinal ASC'
	)
		.bind(run.id)
		.all<{ id: string; global_ordinal: number | null }>();
	const reuse = existing.length === steps.length && existing.every((row, i) => row.global_ordinal === i);

	const runnerSteps: RunnerCIStep[] = steps.map((s, ordinal) => ({
		id: reuse ? existing[ordinal].id : crypto.randomUUID(),
		ordinal,
		jobName: s.jobName,
		name: s.name,
		command: s.command,
		...(s.env ? { env: s.env } : {}),
		...(s.timeout !== undefined ? { timeout: s.timeout } : {}),
	}));
	if (reuse) {
		await DB.prepare(
			"UPDATE ci_steps SET status = 'pending', exit_code = NULL, started_at = NULL, finished_at = NULL, duration_ms = NULL WHERE run_id = ? AND status IN ('pending', 'running')"
		)
			.bind(run.id)
			.run();
	} else {
		await DB.batch([
			DB.prepare('DELETE FROM ci_steps WHERE run_id = ?').bind(run.id),
			...runnerSteps.map((s, i) =>
				DB.prepare(
					"INSERT INTO ci_steps (id, run_id, job_name, step_index, global_ordinal, name, command, status, logs) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '[]')"
				).bind(s.id, run.id, s.jobName, steps[i].stepIndex, s.ordinal, s.name, s.command)
			),
		]);
	}

	// ── Dispatch ──
	let token: string;
	let url: string;
	try {
		token = await mintReadToken(env, message.repoName, CHECKOUT_TOKEN_TTL_S);
		url = getArtifactsRemoteUrl(env, message.repoName);
	} catch (err) {
		return releaseOrFailRun(env, run.id, delivery, `Could not mint checkout token: ${String(err)}`);
	}

	const result = await dispatchCIRun(env, {
		protocolVersion: RUNNER_PROTOCOL_VERSION,
		runId: run.id,
		repoName: message.repoName,
		checkout: { url, token, branch: run.branch, commitSha },
		steps: runnerSteps,
		maxDurationMs: maxCIDurationMs(env),
		callbackUrl: ciCallbackUrl(env),
		logsUrl: ciLogsUrl(env),
	});

	if (result.ok) {
		console.log(`CI run ${run.id} dispatched: ${runnerSteps.length} step(s) @ ${commitSha.slice(0, 7)}`);
		return;
	}
	if (result.transient) {
		return releaseOrFailRun(env, run.id, delivery, result.error);
	}
	// Permanent rejection (bad payload, auth misconfig): fail now, don't retry.
	await failRun(env, run.id, result.error);
}

// ─── Deploy ─────────────────────────────────────────────────────

/** Accept both the current id-only shape and pre-B1 messages already in the queue. */
export function normaliseDeployMessage(body: DeployJobMessage | LegacyDeployJobMessage): DeployJobMessage | null {
	if ('deploymentId' in body && typeof body.deploymentId === 'string') return body;
	const legacy = body as LegacyDeployJobMessage;
	if (typeof legacy.runId !== 'string' || !legacy.target?.id) return null;
	// Legacy: `runId` was the deployments.id. Any `target.coolifyApiKey` is
	// deliberately ignored — credentials are re-read from D1.
	return {
		deploymentId: legacy.runId,
		targetId: legacy.target.id,
		ciRunId: null,
		repoId: legacy.repoId,
		repoName: legacy.repoName,
		branch: legacy.branch,
		commitSha: legacy.commitSha,
	};
}

async function failDeployment(env: Env, deploymentId: string, reason: string): Promise<void> {
	console.error(`Deployment ${deploymentId} failed: ${reason}`);
	await env.DB.prepare(
		"UPDATE deployments SET status = 'failed', finished_at = ?, error_message = ? WHERE id = ? AND status IN ('queued', 'pending', 'running')"
	)
		.bind(new Date().toISOString(), reason.slice(0, 2000), deploymentId)
		.run();
}

async function releaseOrFailDeployment(env: Env, deploymentId: string, delivery: QueueDelivery, error: string): Promise<never> {
	if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
		await failDeployment(env, deploymentId, `${error} (gave up after ${delivery.attempts} attempts)`);
	} else {
		await env.DB.prepare("UPDATE deployments SET status = 'queued', started_at = NULL WHERE id = ? AND status = 'running'")
			.bind(deploymentId)
			.run();
	}
	throw new TransientError(error);
}

type TargetRow = {
	id: string;
	repo_id: string;
	type: string;
	is_active: number;
	coolify_app_id: string | null;
	coolify_base_url: string | null;
	coolify_api_key_encrypted: string | null;
	wrangler_config: string | null;
};

export async function handleDeployJob(body: DeployJobMessage | LegacyDeployJobMessage, env: Env, delivery: QueueDelivery): Promise<void> {
	const { DB } = env;
	const message = normaliseDeployMessage(body);
	if (!message) {
		console.error('Dropping malformed deploy message', JSON.stringify(Object.keys(body ?? {})));
		return;
	}

	const deployment = await DB.prepare('SELECT id, repo_id, target_id, ci_run_id, branch, commit_sha, status FROM deployments WHERE id = ?')
		.bind(message.deploymentId)
		.first<{ id: string; repo_id: string; target_id: string; ci_run_id: string | null; branch: string | null; commit_sha: string | null; status: string }>();
	if (!deployment) {
		console.warn(`Deployment ${message.deploymentId} no longer exists — dropping message`);
		return;
	}
	if (deployment.status !== 'queued' && deployment.status !== 'pending') {
		console.log(`Deployment ${deployment.id} is '${deployment.status}', not dispatching`);
		return;
	}

	const target = await DB.prepare('SELECT * FROM deploy_targets WHERE id = ? AND repo_id = ?')
		.bind(deployment.target_id, deployment.repo_id)
		.first<TargetRow>();
	if (!target) {
		await failDeployment(env, deployment.id, 'Deploy target no longer exists');
		return;
	}
	if (!isDeployTargetType(target.type)) {
		await failDeployment(env, deployment.id, `Unsupported deploy target type '${target.type}'`);
		return;
	}

	const branch = deployment.branch || message.branch;
	let commitSha: string | null;
	try {
		commitSha = await resolveCommitSha(env, message.repoName, branch, deployment.commit_sha || message.commitSha);
	} catch (err) {
		if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) await failDeployment(env, deployment.id, `Could not read refs: ${String(err)}`);
		throw new TransientError(`Could not read refs for ${message.repoName}: ${String(err)}`);
	}
	if (!commitSha) {
		await failDeployment(env, deployment.id, `Branch '${branch}' not found`);
		return;
	}

	// ── Build the runner request (each target uses its own URL + key) ──
	const request: RunnerDeployRequest = {
		protocolVersion: RUNNER_PROTOCOL_VERSION,
		deploymentId: deployment.id,
		ciRunId: deployment.ci_run_id ?? message.ciRunId,
		type: target.type,
		callbackUrl: deployCallbackUrl(env),
		deadlineMs: DEPLOY_DEADLINE_MS,
	};

	if (target.type === 'coolify') {
		const baseUrl = target.coolify_base_url || env.COOLIFY_BASE_URL;
		let apiKey: string | null;
		try {
			apiKey = (await readCoolifyApiKey(env, target.coolify_api_key_encrypted)) || env.COOLIFY_API_KEY || null;
		} catch (err) {
			await failDeployment(env, deployment.id, `Could not decrypt Coolify API key: ${String(err)}`);
			return;
		}
		if (!baseUrl || !apiKey || !target.coolify_app_id) {
			await failDeployment(env, deployment.id, 'Coolify target is missing base URL, API key or app id');
			return;
		}
		request.coolify = { baseUrl, apiKey, appId: target.coolify_app_id };
	} else {
		if (target.wrangler_config && !isValidWranglerConfig(target.wrangler_config)) {
			await failDeployment(env, deployment.id, 'Invalid wrangler_config path on deploy target');
			return;
		}
		try {
			request.cloudflare = {
				repoName: message.repoName,
				wranglerConfig: target.wrangler_config || null,
				checkout: {
					url: getArtifactsRemoteUrl(env, message.repoName),
					token: await mintReadToken(env, message.repoName, CHECKOUT_TOKEN_TTL_S),
					branch,
					commitSha,
				},
			};
		} catch (err) {
			if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) await failDeployment(env, deployment.id, `Could not mint checkout token: ${String(err)}`);
			throw new TransientError(`Could not mint checkout token: ${String(err)}`);
		}
	}

	// ── Claim, then dispatch ──
	const claim = await DB.prepare(
		"UPDATE deployments SET status = 'running', started_at = ?, branch = ?, commit_sha = ? WHERE id = ? AND status IN ('queued', 'pending')"
	)
		.bind(new Date().toISOString(), branch, commitSha, deployment.id)
		.run();
	if (!claim.meta.changes) {
		console.log(`Deployment ${deployment.id} was claimed concurrently`);
		return;
	}

	const result = await dispatchDeploy(env, request);
	if (result.ok) {
		console.log(`Deployment ${deployment.id} (${target.type}) dispatched to runner`);
		return;
	}
	if (result.transient) {
		return releaseOrFailDeployment(env, deployment.id, delivery, result.error);
	}
	await failDeployment(env, deployment.id, result.error);
}
