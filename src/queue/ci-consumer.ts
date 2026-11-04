import type { Env, CIJobMessage, DeployJobMessage, CIPipelineConfig } from '../env.ts';
import { getJobExecutionOrder } from '../lib/ci-parser.ts';
import { CoolifyClient } from '../lib/coolify.ts';
import { runCISteps, type RunnerStep } from '../lib/sandbox.ts';

function ciCallbackUrl(env: Env): string {
	return `${(env.APP_URL || 'https://git.beenex.company').replace(/\/+$/, '')}/api/internal/ci/callback`;
}

/**
 * Flatten the pipeline into an ordered list of runner steps.
 * Jobs are ordered by `needs` (topological groups); within a group, jobs run
 * in declaration order. Env is merged pipeline → job → step. Steps without a
 * `run` command are skipped.
 */
function getOrderedSteps(config: CIPipelineConfig): (RunnerStep & { jobName: string; stepIndex: number })[] {
	const ordered: (RunnerStep & { jobName: string; stepIndex: number })[] = [];
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

/**
 * Handle CI Job Message from queue
 */
export async function handleCIJob(message: CIJobMessage, env: Env): Promise<void> {
	const { DB, DEPLOY_QUEUE } = env;

	try {
		const { results: targets } = await DB.prepare('SELECT * FROM deploy_targets WHERE repo_id = ?').bind(message.repoId).all();

		// Execute CI steps on the Runner. If it accepts, the run's final status
		// arrives via /api/internal/ci/callback; otherwise fall through to the
		// deploy-target handling below.
		const steps = message.config?.jobs ? getOrderedSteps(message.config) : [];
		if (steps.length > 0) {
			const result = await runCISteps(env.RUNNER_URL, env.RUNNER_SECRET, {
				runId: message.runId,
				repoName: message.repoName,
				branch: message.branch,
				commitSha: message.commitSha,
				steps: steps.map(({ name, command, env: stepEnv, timeout }) => ({ name, command, env: stepEnv, timeout })),
				callbackUrl: ciCallbackUrl(env),
			});

			if (result.accepted) {
				const now = new Date().toISOString();
				await DB.prepare("UPDATE ci_runs SET status = 'running', started_at = ? WHERE id = ?")
					.bind(now, message.runId).run();
				await DB.batch(steps.map((s) =>
					DB.prepare('INSERT INTO ci_steps (id, run_id, job_name, step_index, name, command, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
						.bind(crypto.randomUUID(), message.runId, s.jobName, s.stepIndex, s.name, s.command, 'pending')
				));
				return;
			}

			console.warn(`Runner did not accept CI steps for run ${message.runId}: ${result.error}`);
		}

		if (!targets || targets.length === 0) {
			await DB.prepare("UPDATE ci_runs SET status = 'passed', finished_at = ? WHERE id = ?")
				.bind(new Date().toISOString(), message.runId).run();
			return;
		}

		let runnerHandled = false;

		for (const t of targets) {
			const branchFilter = t.branch_filter ? JSON.parse(t.branch_filter as string) : null;
			if (branchFilter && !branchFilter.includes(message.branch)) {
				continue;
			}

			if (t.type === 'coolify') {
				let useFallback = false;
				try {
					const response = await fetch(`${env.RUNNER_URL}/webhook/deploy`, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${env.RUNNER_SECRET}`
						},
						body: JSON.stringify({
							runId: message.runId,
							repoName: message.repoName,
							branch: message.branch,
							commitSha: message.commitSha,
							coolifyAppId: t.coolify_app_id,
							callbackUrl: ciCallbackUrl(env)
						})
					});

					if (response.status === 202) {
						runnerHandled = true;
						await DB.prepare("UPDATE ci_runs SET status = 'running', started_at = ? WHERE id = ?")
							.bind(new Date().toISOString(), message.runId).run();
						
						const stepId = crypto.randomUUID();
						await DB.prepare('INSERT INTO ci_steps (id, run_id, job_name, step_index, name, command, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
							.bind(stepId, message.runId, 'deploy', 0, 'Runner Deploy', 'webhook', 'running', new Date().toISOString()).run();
					} else {
						useFallback = true;
					}
				} catch (err) {
					console.error("Runner unreachable:", err);
					useFallback = true;
				}

				if (useFallback) {
					const baseUrl = (t.coolify_base_url as string) || env.COOLIFY_BASE_URL;
					const apiKey = (t.coolify_api_key_encrypted as string) || (t.coolify_api_key as string) || env.COOLIFY_API_KEY;
					if (baseUrl && apiKey && t.coolify_app_id) {
						const client = new CoolifyClient(baseUrl, apiKey);
						try {
							const deployRes = await client.deploy(t.coolify_app_id as string);
							console.log("Coolify deploy triggered successfully:", JSON.stringify(deployRes));

							const stepId = crypto.randomUUID();
							await DB.prepare('INSERT INTO ci_steps (id, run_id, job_name, step_index, name, command, status, finished_at, exit_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
								.bind(stepId, message.runId, 'deploy', 0, 'Coolify Deploy', 'api', 'passed', new Date().toISOString(), 0).run();

							await DB.prepare("UPDATE ci_runs SET status = 'passed', finished_at = ? WHERE id = ?")
								.bind(new Date().toISOString(), message.runId).run();

							runnerHandled = true;
						} catch (deployErr: any) {
							console.error("Direct deploy failed:", deployErr);
							const stepId = crypto.randomUUID();
							await DB.prepare('INSERT INTO ci_steps (id, run_id, job_name, step_index, name, command, status, finished_at, exit_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
								.bind(stepId, message.runId, 'deploy', 0, 'Coolify Deploy', 'api', 'failed', new Date().toISOString(), 1).run();
							throw deployErr;
						}
					}
				}
			} else {
				const runId = crypto.randomUUID();
				await DB.prepare('INSERT INTO deployments (id, repo_id, target_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
					.bind(runId, message.repoId, t.id, 'queued', new Date().toISOString()).run();

				await DEPLOY_QUEUE.send({
					runId,
					repoId: message.repoId,
					repoName: message.repoName,
					branch: message.branch,
					commitSha: message.commitSha,
					target: {
						id: t.id as string,
						type: "cloudflare",
						branchFilter: branchFilter
					}
				});
			}
		}

		if (!runnerHandled) {
			await DB.prepare("UPDATE ci_runs SET status = 'passed', finished_at = ? WHERE id = ?")
				.bind(new Date().toISOString(), message.runId).run();
		}
	} catch (error) {
		console.error("CI Job Error:", error);
		await DB.prepare("UPDATE ci_runs SET status = 'failed', finished_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), message.runId).run();
	}
}

/**
 * Handle Deploy Job Message from queue
 */
export async function handleDeployJob(message: DeployJobMessage, env: Env): Promise<void> {
	const { DB } = env;

	await DB.prepare("UPDATE deployments SET status = 'running', started_at = ? WHERE id = ?")
		.bind(new Date().toISOString(), message.runId).run();

	try {
		if (message.target.type === 'coolify') {
			const baseUrl = message.target.coolifyBaseUrl || env.COOLIFY_BASE_URL;
			const apiKey = message.target.coolifyApiKey || env.COOLIFY_API_KEY;
			
			if (!baseUrl || !apiKey || !message.target.coolifyAppId) {
				throw new Error("Missing Coolify credentials or App ID");
			}

			const client = new CoolifyClient(baseUrl, apiKey);
			await client.deploy(message.target.coolifyAppId);
		} else if (message.target.type === 'cloudflare') {
			const command = message.target.wranglerConfig
				? `npx wrangler deploy --config ${message.target.wranglerConfig}`
				: 'npx wrangler deploy';
			const result = await runCISteps(env.RUNNER_URL, env.RUNNER_SECRET, {
				runId: message.runId,
				repoName: message.repoName,
				branch: message.branch,
				commitSha: message.commitSha,
				steps: [{ name: 'Cloudflare Deploy', command }],
				callbackUrl: ciCallbackUrl(env),
			});
			if (!result.accepted) {
				throw new Error(`Runner rejected Cloudflare deploy: ${result.error}`);
			}
			// Accepted: the deploy runs asynchronously on the Runner, so leave the
			// deployment in 'running' rather than marking it successful here.
			return;
		}

		await DB.prepare("UPDATE deployments SET status = 'success', finished_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), message.runId).run();
	} catch (error) {
		console.error("Deploy Job Error:", error);
		await DB.prepare("UPDATE deployments SET status = 'failed', finished_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), message.runId).run();
	}
}
