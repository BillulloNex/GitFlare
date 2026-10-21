import type { Env, CIJobMessage, DeployJobMessage, CIJobConfig } from '../env.ts';
import { CoolifyClient, coolifyDeploymentId, waitForCoolifyDeployment } from '../lib/coolify.ts';

const SHELL_NOT_RUN = 'Not executed. GitFlare does not run shell steps, so this command cannot pass.';
const CLOUDFLARE_NOT_RUN = 'Cloudflare Workers deploy was not performed. No sandbox runner is configured, so this was not marked successful.';

async function recordStep(
	env: Env,
	runId: string,
	index: number,
	jobName: string,
	name: string,
	command: string,
	status: string,
	note: string | null,
	exitCode: number | null,
	running: boolean,
): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT INTO ci_steps (id, run_id, job_name, step_index, name, command, status, exit_code, stderr_url, started_at, finished_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		crypto.randomUUID(),
		runId,
		jobName,
		index,
		name,
		command,
		status,
		exitCode,
		note,
		now,
		running ? null : now,
	).run();
}

async function finishRun(env: Env, runId: string, status: 'passed' | 'failed'): Promise<void> {
	await env.DB.prepare('UPDATE ci_runs SET status = ?, finished_at = ? WHERE id = ?')
		.bind(status, new Date().toISOString(), runId)
		.run();
}

function shellSteps(jobs: Record<string, CIJobConfig> | undefined): { job: string; name: string; command: string }[] {
	const steps: { job: string; name: string; command: string }[] = [];
	for (const [jobName, job] of Object.entries(jobs ?? {})) {
		if (job.deploy) continue;
		for (const step of job.steps ?? []) {
			const command = step.run?.trim();
			if (!command) continue;
			steps.push({ job: jobName, name: step.name || command, command });
		}
	}
	return steps;
}

function branchAllowed(branchFilter: string | null, branch: string): boolean {
	if (!branchFilter) return true;
	try {
		const parsed = JSON.parse(branchFilter);
		return !Array.isArray(parsed) || parsed.includes(branch);
	} catch {
		return false;
	}
}

async function insertDeployment(
	env: Env,
	message: { repoId: string; branch: string; commitSha: string; runId: string },
	targetId: string,
	status: string,
	deploymentId: string | null,
	error: string | null,
): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT INTO deployments (id, repo_id, target_id, ci_run_id, branch, commit_sha, status, coolify_deployment_id, error_message, started_at, finished_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		crypto.randomUUID(),
		message.repoId,
		targetId,
		message.runId,
		message.branch,
		message.commitSha,
		status,
		deploymentId,
		error,
		now,
		status === 'deploying' ? null : now,
		now,
	).run();
}

/**
 * Execute the parts of a CI run that GitFlare can actually perform.
 * Shell steps are recorded as failed because nothing runs them.
 * A run is passed only when a real deploy finishes successfully and no step failed.
 */
export async function handleCIJob(message: CIJobMessage, env: Env): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare("UPDATE ci_runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?")
		.bind(now, message.runId)
		.run();

	let stepIndex = 0;
	const commands = shellSteps(message.config?.jobs);
	for (const step of commands) {
		await recordStep(env, message.runId, stepIndex++, step.job, step.name, step.command, 'failed', SHELL_NOT_RUN, 1, false);
	}

	const { results: targets } = await env.DB.prepare(
		'SELECT * FROM deploy_targets WHERE repo_id = ? AND is_active = 1',
	).bind(message.repoId).all<Record<string, unknown>>();
	const applicable = (targets ?? []).filter((target) => branchAllowed((target.branch_filter as string | null) ?? null, message.branch));

	if (applicable.length === 0) {
		if (commands.length === 0) {
			await recordStep(
				env,
				message.runId,
				stepIndex,
				'deploy',
				'No deploy target',
				'deploy',
				'failed',
				'No active deploy target matches this branch.',
				1,
				false,
			);
		}
		await finishRun(env, message.runId, 'failed');
		return;
	}

	let waitingOnRunner = false;
	let deployFailed = false;
	let deploySucceeded = false;

	for (const target of applicable) {
		if (target.type === 'cloudflare') {
			deployFailed = true;
			await recordStep(env, message.runId, stepIndex++, 'deploy', 'Cloudflare deploy', 'wrangler deploy', 'failed', CLOUDFLARE_NOT_RUN, 1, false);
			await insertDeployment(env, message, target.id as string, 'failed', null, CLOUDFLARE_NOT_RUN);
			continue;
		}

		if (target.type !== 'coolify') {
			deployFailed = true;
			await recordStep(env, message.runId, stepIndex++, 'deploy', 'Unknown deploy target', String(target.type), 'failed', 'Unsupported deploy target.', 1, false);
			continue;
		}

		const outcome = await deployCoolify(env, message, target, stepIndex);
		stepIndex = outcome.nextIndex;
		if (outcome.state === 'running') waitingOnRunner = true;
		else if (outcome.state === 'passed') deploySucceeded = true;
		else deployFailed = true;
	}

	if (waitingOnRunner) return;

	const passed = deploySucceeded && !deployFailed && commands.length === 0;
	await finishRun(env, message.runId, passed ? 'passed' : 'failed');
}

async function deployCoolify(
	env: Env,
	message: CIJobMessage,
	target: Record<string, unknown>,
	stepIndex: number,
): Promise<{ state: 'running' | 'passed' | 'failed'; nextIndex: number }> {
	const appId = target.coolify_app_id as string | undefined;
	const baseUrl = (target.coolify_base_url as string) || env.COOLIFY_BASE_URL;
	const apiKey = (target.coolify_api_key_encrypted as string) || env.COOLIFY_API_KEY;

	if (env.RUNNER_URL && env.RUNNER_SECRET && appId) {
		try {
			const response = await fetch(`${env.RUNNER_URL}/webhook/deploy`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${env.RUNNER_SECRET}`,
				},
				body: JSON.stringify({
					runId: message.runId,
					repoName: message.repoName,
					branch: message.branch,
					commitSha: message.commitSha,
					coolifyAppId: appId,
					callbackUrl: `${env.APP_URL}/api/internal/ci/callback`,
				}),
			});
			if (response.status === 202) {
				await recordStep(env, message.runId, stepIndex, 'deploy', 'Coolify deploy', 'runner webhook', 'running', null, null, true);
				await insertDeployment(env, message, target.id as string, 'deploying', null, null);
				return { state: 'running', nextIndex: stepIndex + 1 };
			}
			console.error(`Runner declined deploy for ${message.repoName}: HTTP ${response.status}`);
		} catch (error) {
			console.error('Runner unreachable:', error);
		}
	}

	if (!baseUrl || !apiKey || !appId) {
		const note = 'Coolify deploy was not started. Missing base URL, API key, or app id.';
		await recordStep(env, message.runId, stepIndex, 'deploy', 'Coolify deploy', 'coolify api', 'failed', note, 1, false);
		await insertDeployment(env, message, target.id as string, 'failed', null, note);
		return { state: 'failed', nextIndex: stepIndex + 1 };
	}

	const client = new CoolifyClient(baseUrl, apiKey);
	try {
		const payload = await client.deploy(appId);
		const deploymentId = coolifyDeploymentId(payload);
		if (!deploymentId) {
			const note = 'Coolify accepted the request but did not return a deployment id, so completion was not verified.';
			await recordStep(env, message.runId, stepIndex, 'deploy', 'Coolify deploy', 'coolify api', 'failed', note, 1, false);
			await insertDeployment(env, message, target.id as string, 'failed', null, note);
			return { state: 'failed', nextIndex: stepIndex + 1 };
		}
		const result = await waitForCoolifyDeployment(client, deploymentId);
		if (result === 'success') {
			await recordStep(env, message.runId, stepIndex, 'deploy', 'Coolify deploy', 'coolify api', 'passed', `Deployment ${deploymentId} finished.`, 0, false);
			await insertDeployment(env, message, target.id as string, 'success', deploymentId, null);
			return { state: 'passed', nextIndex: stepIndex + 1 };
		}
		const note = result === 'timeout'
			? `Deployment ${deploymentId} did not finish within 8 minutes, so it was not marked passed.`
			: `Deployment ${deploymentId} failed.`;
		await recordStep(env, message.runId, stepIndex, 'deploy', 'Coolify deploy', 'coolify api', 'failed', note, 1, false);
		await insertDeployment(env, message, target.id as string, 'failed', deploymentId, note);
		return { state: 'failed', nextIndex: stepIndex + 1 };
	} catch (error: any) {
		const note = error?.message || 'Coolify deploy failed.';
		await recordStep(env, message.runId, stepIndex, 'deploy', 'Coolify deploy', 'coolify api', 'failed', note, 1, false);
		await insertDeployment(env, message, target.id as string, 'failed', null, note);
		return { state: 'failed', nextIndex: stepIndex + 1 };
	}
}

/**
 * Manual deploy from the deploy-target API. Completion is recorded on the deployment row.
 */
export async function handleDeployJob(message: DeployJobMessage, env: Env): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare("UPDATE deployments SET status = 'deploying', started_at = ? WHERE id = ?")
		.bind(now, message.runId)
		.run();

	try {
		if (message.target.type !== 'coolify') {
			throw new Error(CLOUDFLARE_NOT_RUN);
		}
		const baseUrl = message.target.coolifyBaseUrl || env.COOLIFY_BASE_URL;
		const apiKey = message.target.coolifyApiKey || env.COOLIFY_API_KEY;
		if (!baseUrl || !apiKey || !message.target.coolifyAppId) {
			throw new Error('Missing Coolify credentials or app id.');
		}
		const client = new CoolifyClient(baseUrl, apiKey);
		const payload = await client.deploy(message.target.coolifyAppId);
		const deploymentId = coolifyDeploymentId(payload);
		if (!deploymentId) {
			throw new Error('Coolify did not return a deployment id, so completion was not verified.');
		}
		const result = await waitForCoolifyDeployment(client, deploymentId);
		if (result !== 'success') {
			throw new Error(result === 'timeout'
				? `Deployment ${deploymentId} did not finish within 8 minutes.`
				: `Deployment ${deploymentId} failed.`);
		}
		await env.DB.prepare(
			"UPDATE deployments SET status = 'success', coolify_deployment_id = ?, finished_at = ? WHERE id = ?",
		).bind(deploymentId, new Date().toISOString(), message.runId).run();
	} catch (error: any) {
		console.error('Deploy job error:', error);
		await env.DB.prepare(
			"UPDATE deployments SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?",
		).bind(error?.message || 'Deploy failed', new Date().toISOString(), message.runId).run();
	}
}
