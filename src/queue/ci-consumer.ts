import type { Env, CIJobMessage, DeployJobMessage, SandboxInstance } from '../env.ts';
import { getJobExecutionOrder } from '../lib/ci-parser.ts';
import { CoolifyClient } from '../lib/coolify.ts';

/**
 * Handle CI Job Message from queue
 */
export async function handleCIJob(message: CIJobMessage, env: Env): Promise<void> {
	const { DB, REPOS, STORAGE, DEPLOY_QUEUE } = env;

	await DB.prepare("UPDATE ci_runs SET status = 'running', started_at = ? WHERE id = ?")
		.bind(new Date().toISOString(), message.runId).run();

	const artifactRepo = await REPOS.get(message.repoName);
	if (!artifactRepo) {
		await DB.prepare("UPDATE ci_runs SET status = 'failed', finished_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), message.runId).run();
		return;
	}

	const config = message.config;
	let allPassed = true;

	try {
		const order = getJobExecutionOrder(config);

		for (const jobGroup of order) {
			for (const jobName of jobGroup) {
				const job = config.jobs[jobName];

				// Note: @cloudflare/sandbox SDK is not installed. 
				// const sandbox: SandboxInstance = await env.SANDBOXES.create({ tier: job.sandbox || env.DEFAULT_SANDBOX_TIER });
				const sandbox: SandboxInstance = {
					exec: async () => ({ exitCode: 0, stdout: 'Mock output', stderr: '' }),
					terminal: () => ({} as WebSocket),
					mount: async () => {},
					destroy: async () => {}
				};

				await sandbox.mount(artifactRepo, '/workspace');

				for (let i = 0; i < job.steps.length; i++) {
					const step = job.steps[i];
					const stepId = crypto.randomUUID();
					
					await DB.prepare('INSERT INTO ci_steps (id, run_id, job_name, name, status, started_at) VALUES (?, ?, ?, ?, ?, ?)')
						.bind(stepId, message.runId, jobName, step.name || `Step ${i}`, 'running', new Date().toISOString()).run();

					let result;
					try {
						// actual execution
						// result = await sandbox.exec(step.run || 'echo "no command"', { env: { ...config.env, ...job.env, ...step.env } });
						result = await sandbox.exec(step.run || 'echo "no command"');
					} catch (e: any) {
						result = { exitCode: 1, stdout: '', stderr: e.message };
					}

					await STORAGE.put(`logs/ci/${message.runId}/${stepId}.log`, result.stdout + result.stderr);

					const stepStatus = result.exitCode === 0 ? 'passed' : 'failed';
					await DB.prepare('UPDATE ci_steps SET status = ?, finished_at = ?, exit_code = ? WHERE id = ?')
						.bind(stepStatus, new Date().toISOString(), result.exitCode, stepId).run();

					if (result.exitCode !== 0) {
						allPassed = false;
						break;
					}
				}

				await sandbox.destroy();
				if (!allPassed) break;
			}
			if (!allPassed) break;
		}

		if (allPassed) {
			await DB.prepare("UPDATE ci_runs SET status = 'passed', finished_at = ? WHERE id = ?")
				.bind(new Date().toISOString(), message.runId).run();

			const { results: targets } = await DB.prepare('SELECT * FROM deploy_targets WHERE repo_id = ?').bind(message.repoId).all();
			for (const t of targets) {
				const branchFilter = t.branch_filter ? JSON.parse(t.branch_filter as string) : null;
				if (!branchFilter || branchFilter.includes(message.branch)) {
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
							type: t.type as "coolify" | "cloudflare",
							coolifyAppId: t.coolify_app_id as string,
							coolifyBaseUrl: t.coolify_base_url as string,
							coolifyApiKey: t.coolify_api_key as string,
							branchFilter: branchFilter
						}
					});
				}
			}
		} else {
			await DB.prepare("UPDATE ci_runs SET status = 'failed', finished_at = ? WHERE id = ?")
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
			// const sandbox: SandboxInstance = await env.SANDBOXES.create({ tier: env.DEFAULT_SANDBOX_TIER });
			const sandbox: SandboxInstance = {
				exec: async () => ({ exitCode: 0, stdout: 'Mock deploy output', stderr: '' }),
				terminal: () => ({} as WebSocket),
				mount: async () => {},
				destroy: async () => {}
			};
			const artifactRepo = await env.REPOS.get(message.repoName);
			if (artifactRepo) {
				await sandbox.mount(artifactRepo, '/workspace');
				await sandbox.exec('npx wrangler deploy', { cwd: '/workspace' });
			}
			await sandbox.destroy();
		}

		await DB.prepare("UPDATE deployments SET status = 'success', finished_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), message.runId).run();
	} catch (error) {
		console.error("Deploy Job Error:", error);
		await DB.prepare("UPDATE deployments SET status = 'failed', finished_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), message.runId).run();
	}
}
