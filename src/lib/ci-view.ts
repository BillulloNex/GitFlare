export interface StoredStep {
	id?: string;
	job_name: string;
	name: string | null;
	command: string | null;
	status: string;
	exit_code?: number | null;
	stderr_url?: string | null;
	started_at?: string | null;
	finished_at?: string | null;
	duration_ms?: number | null;
}

export interface PresentedStep {
	name: string;
	command: string;
	status: string;
	duration: string;
	exit_code: number | null;
	logs: { timestamp: string; stream: string; line: string }[];
}

export interface PresentedJob {
	id: string;
	name: string;
	status: string;
	duration: string;
	steps: PresentedStep[];
}

function formatMs(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function stepDuration(step: StoredStep): string {
	if (typeof step.duration_ms === 'number') return formatMs(step.duration_ms);
	if (step.started_at && step.finished_at) {
		const ms = new Date(step.finished_at).getTime() - new Date(step.started_at).getTime();
		if (Number.isFinite(ms)) return formatMs(ms);
	}
	return '';
}

function inlineNote(value: string | null | undefined): string | null {
	if (!value) return null;
	if (/^(https?:|r2:)/.test(value)) return null;
	return value;
}

function presentStep(step: StoredStep): PresentedStep {
	const logs: PresentedStep['logs'] = [];
	if (step.command) {
		logs.push({ timestamp: step.started_at ?? '', stream: 'stdout', line: `$ ${step.command}` });
	}
	const note = inlineNote(step.stderr_url);
	if (note) {
		logs.push({
			timestamp: step.finished_at ?? '',
			stream: step.status === 'failed' ? 'stderr' : 'stdout',
			line: note,
		});
	}
	if (step.exit_code != null) {
		logs.push({ timestamp: step.finished_at ?? '', stream: 'stdout', line: `exit ${step.exit_code}` });
	}
	return {
		name: step.name || step.command || 'step',
		command: step.command || '',
		status: step.status,
		duration: stepDuration(step),
		exit_code: step.exit_code ?? null,
		logs,
	};
}

function jobStatus(steps: StoredStep[], fallback: string): string {
	if (steps.some((step) => step.status === 'failed')) return 'failed';
	if (steps.some((step) => step.status === 'running')) return 'running';
	if (steps.length > 0 && steps.every((step) => step.status === 'passed')) return 'passed';
	if (steps.length > 0 && steps.every((step) => step.status === 'skipped')) return 'skipped';
	return fallback;
}

/**
 * Build the CI detail tree from rows that were actually stored.
 * A run with no rows does not get a fabricated lint/test/deploy log.
 */
export function jobsFromSteps(steps: StoredStep[], runStatus: string): PresentedJob[] {
	if (steps.length === 0) {
		return [{
			id: 'no-steps',
			name: 'No steps recorded',
			status: 'failed',
			duration: '',
			steps: [{
				name: 'Nothing was recorded for this run',
				command: '',
				status: 'failed',
				duration: '',
				exit_code: null,
				logs: [{
					timestamp: '',
					stream: 'stderr',
					line: runStatus === 'passed'
						? 'This run is marked passed, but no steps were stored. That status was not produced by an executed command.'
						: 'No CI steps are stored for this run.',
				}],
			}],
		}];
	}

	const groups = new Map<string, StoredStep[]>();
	for (const step of steps) {
		const name = step.job_name || 'job';
		const group = groups.get(name) ?? [];
		group.push(step);
		groups.set(name, group);
	}

	return [...groups.entries()].map(([name, group]) => ({
		id: name,
		name,
		status: jobStatus(group, runStatus),
		duration: '',
		steps: group.map(presentStep),
	}));
}
