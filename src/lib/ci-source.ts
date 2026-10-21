import type { Env } from '../env.ts';

const CI_PATHS = ['.gitflare/ci.yml', '.gitflare/ci.yaml'];

/** Read the CI config committed at ref. Returns null when the repo has no config. */
export async function readRepoCiYaml(env: Env, repoName: string, ref: string): Promise<string | null> {
	const repo = await env.REPOS.get(repoName);
	if (!repo) return null;
	for (const path of CI_PATHS) {
		const file = await repo.readFile({ ref, path });
		if (!file) continue;
		const text = (await file.text()).replace(/^\uFEFF/, '').trim();
		if (text) return text;
	}
	return null;
}

/** Config used only when a deploy target exists and the repo has no CI file. */
export function deployOnlyConfig(branch: string): string {
	return [
		'name: deploy',
		'on:',
		'  push:',
		`    branches: [${JSON.stringify(branch)}]`,
		'jobs:',
		'  deploy:',
		'    deploy:',
		'      target: coolify',
		'    steps: []',
		'',
	].join('\n');
}
