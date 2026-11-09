import { parse } from 'yaml';
import type { CIPipelineConfig } from '../env.ts';
import { matchesBranchFilter } from './branch-pattern.ts';

/**
 * Parse and validate CI Config from YAML content
 */
export function parseCIConfig(yamlContent: string): CIPipelineConfig {
	const config = parse(yamlContent) as Partial<CIPipelineConfig>;
	if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('CI config must be a mapping');

	if (!config.name) throw new Error("Missing 'name' in CI config");
	// `on` is optional: no `on` block means "run on every push" (see shouldTrigger).
	if (!config.jobs || typeof config.jobs !== 'object') throw new Error("Missing or invalid 'jobs' in CI config");
	validateRunsOn(config['runs-on'], 'Pipeline');

	for (const [jobName, job] of Object.entries(config.jobs)) {
		if (!job || typeof job !== 'object') throw new Error(`Job '${jobName}' must be a mapping`);
		validateRunsOn(job['runs-on'], `Job '${jobName}'`);
		if (!job.steps || !Array.isArray(job.steps)) {
			throw new Error(`Job '${jobName}' must have a 'steps' array`);
		}
	}

	if (config.checkout !== undefined) {
		const checkout: unknown = config.checkout;
		if (!checkout || typeof checkout !== 'object') throw new Error("'checkout' must be a mapping");
		const lfs = (checkout as { lfs?: unknown }).lfs;
		if (lfs !== undefined && lfs !== 'auto' && typeof lfs !== 'boolean') {
			throw new Error("'checkout.lfs' must be auto, true or false");
		}
	}

	return config as CIPipelineConfig;
}

/** A job is dispatched as a unit, so all jobs in one run must resolve to the
 * same backend until multi-backend job orchestration is implemented. */
export function validateRunsOn(value: unknown, label: string): void {
	if (value === undefined) return;
	const values = typeof value === 'string' ? [value] : value;
	if (!Array.isArray(values) || values.length === 0 || !values.every((v) =>
		typeof v === 'string' && /^(runner|github(?::[A-Za-z0-9-]{1,39})?|blacksmith(?::[A-Za-z0-9-]{1,39})?)$/.test(v))) {
		throw new Error(`${label} runs-on must be runner, github, blacksmith, or an account-qualified value (or a nonempty list)`);
	}
}

/**
 * Should a push / pull_request event trigger this pipeline, per its `on` block?
 *
 *   (no `on` block)              → every push, no pull_request
 *   on: push                     → every push
 *   on: [push, pull_request]     → every push / PR
 *   on: { push: }                → every push (null value, GitHub-style)
 *   on: { push: { branches: [main, "release/*"] } } → glob match (lib/branch-pattern.ts)
 *   on: { manual: true }         → no push / PR
 *
 * Only for automatic triggers. Manual runs and reruns (src/api/ci.ts) must NOT
 * call this — the caller asked for the run explicitly.
 */
export function shouldTrigger(config: CIPipelineConfig, event: { type: 'push' | 'pull_request'; branch: string }): boolean {
	// YAML may also give `on` as a string or list, so treat it as unknown.
	const on: unknown = config.on;
	if (on === undefined || on === null) return event.type === 'push';
	if (typeof on === 'string') return on === event.type;
	if (Array.isArray(on)) return on.includes(event.type);
	if (typeof on !== 'object') return false;

	const triggers = on as Record<string, unknown>;
	if (!(event.type in triggers)) return false;
	const filter = triggers[event.type] as { branches?: unknown } | null | undefined;
	const branches = filter?.branches;
	if (branches === undefined || branches === null) return true;
	const patterns = Array.isArray(branches) ? branches.map(String) : [String(branches)];
	if (patterns.length === 0) return true;
	return matchesBranchFilter(patterns, event.branch);
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
