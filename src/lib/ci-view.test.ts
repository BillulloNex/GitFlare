import { describe, expect, it } from 'vitest';
import { jobsFromSteps } from './ci-view.ts';

describe('jobsFromSteps', () => {
	it('does not invent a passing pipeline when nothing was stored', () => {
		const jobs = jobsFromSteps([], 'passed');
		expect(jobs).toHaveLength(1);
		expect(jobs[0].status).toBe('failed');
		expect(jobs[0].steps[0].logs[0].line).toMatch(/no steps were stored/i);
		expect(JSON.stringify(jobs)).not.toMatch(/OpenHands|ruff|pytest|grok\.beenex/);
	});

	it('shows the stored command and its failure note', () => {
		const jobs = jobsFromSteps([{
			job_name: 'test',
			name: 'Run tests',
			command: 'npm test',
			status: 'failed',
			exit_code: 1,
			stderr_url: 'Not executed. GitFlare does not run shell steps.',
		}], 'failed');
		expect(jobs[0].name).toBe('test');
		expect(jobs[0].status).toBe('failed');
		expect(jobs[0].steps[0].command).toBe('npm test');
		expect(jobs[0].steps[0].logs.map((line) => line.line).join('\n')).toContain('npm test');
		expect(jobs[0].steps[0].logs.map((line) => line.line).join('\n')).toContain('does not run shell steps');
	});
});
