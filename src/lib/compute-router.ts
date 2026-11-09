import type { CIPipelineConfig } from '../env.ts';
import type { ComputeConnection } from './github-ci.ts';

export type ComputeChoice = { backend: 'runner' | 'github' | 'blacksmith'; connection?: ComputeConnection; fallbackReason?: string };

function choices(value: string | string[] | undefined): string[] {
	return value === undefined ? ['runner'] : typeof value === 'string' ? [value] : value;
}

export function selectCompute(config: CIPipelineConfig, connections: ComputeConnection[], isPrivate: boolean): ComputeChoice {
	const requested = Object.values(config.jobs).map((job) => choices(job['runs-on'] ?? config['runs-on']));
	const first = requested[0] || choices(config['runs-on']);
	if (requested.some((list) => JSON.stringify(list) !== JSON.stringify(first))) {
		throw new Error('Jobs with different runs-on preferences are not yet supported in the same workflow run');
	}
	const skipped: string[] = [];
	for (const option of first) {
		if (option === 'runner') return { backend: 'runner', fallbackReason: skipped.join('; ') || undefined };
		const [backend, account] = option.split(':');
		for (const connection of connections) {
			if (account && connection.account_login.toLowerCase() !== account.toLowerCase()) continue;
			if (isPrivate && !connection.allow_private) continue;
			if (connection.account_type !== 'Organization') continue;
			if (backend === 'blacksmith' && !connection.blacksmith_enabled) continue;
			return { backend: backend as 'github' | 'blacksmith', connection, fallbackReason: skipped.join('; ') || undefined };
		}
		skipped.push(`${option}: no eligible GitHub organization connection`);
	}
	throw new Error(`No CI compute available: ${skipped.join('; ')}. Connect GitHub in Account → Connections.`);
}
