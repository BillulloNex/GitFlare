import { parse } from 'yaml';
import type { CIPipelineConfig } from '../env.ts';

/**
 * Parse and validate CI Config from YAML content
 */
export function parseCIConfig(yamlContent: string): CIPipelineConfig {
	const config = parse(yamlContent) as Partial<CIPipelineConfig>;

	if (!config.name) throw new Error("Missing 'name' in CI config");
	if (!config.on) throw new Error("Missing 'on' in CI config");
	if (!config.jobs || typeof config.jobs !== 'object') throw new Error("Missing or invalid 'jobs' in CI config");

	for (const [jobName, job] of Object.entries(config.jobs)) {
		if (!job.steps || !Array.isArray(job.steps)) {
			throw new Error(`Job '${jobName}' must have a 'steps' array`);
		}
	}

	return config as CIPipelineConfig;
}

/**
 * Check if a push/PR should trigger CI based on the config's 'on' field
 */
export function shouldTrigger(config: CIPipelineConfig, event: { type: 'push'|'pull_request', branch: string }): boolean {
	if (event.type === 'push' && config.on.push) {
		if (!config.on.push.branches || config.on.push.branches.length === 0) return true;
		return config.on.push.branches.includes(event.branch);
	}
	if (event.type === 'pull_request' && config.on.pull_request) {
		if (!config.on.pull_request.branches || config.on.pull_request.branches.length === 0) return true;
		return config.on.pull_request.branches.includes(event.branch);
	}
	return false;
}

/**
 * Topological sort of jobs by 'needs' dependencies, returns groups that can run in parallel
 */
export function getJobExecutionOrder(config: CIPipelineConfig): string[][] {
	const jobs = config.jobs;
	const graph = new Map<string, string[]>();
	const inDegree = new Map<string, number>();

	for (const name of Object.keys(jobs)) {
		graph.set(name, []);
		inDegree.set(name, 0);
	}

	for (const [name, job] of Object.entries(jobs)) {
		if (job.needs) {
			for (const need of job.needs) {
				if (!jobs[need]) throw new Error(`Job '${name}' needs undefined job '${need}'`);
				graph.get(need)!.push(name);
				inDegree.set(name, inDegree.get(name)! + 1);
			}
		}
	}

	const order: string[][] = [];
	let queue = Array.from(inDegree.entries()).filter(([_, deg]) => deg === 0).map(([name]) => name);

	while (queue.length > 0) {
		order.push([...queue]);
		const nextQueue: string[] = [];
		for (const node of queue) {
			for (const neighbor of graph.get(node)!) {
				inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
				if (inDegree.get(neighbor) === 0) {
					nextQueue.push(neighbor);
				}
			}
		}
		queue = nextQueue;
	}

	if (Array.from(inDegree.values()).some(deg => deg > 0)) {
		throw new Error("Circular dependency detected in jobs");
	}

	return order;
}
