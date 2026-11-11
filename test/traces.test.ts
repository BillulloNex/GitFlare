import { describe, expect, it } from 'vitest';
import { parseLabel, parseSteps, parseTraceInput, readSteps, STEPS_MAX } from '../src/lib/traces.ts';

const now = new Date('2026-11-10T12:00:00Z');
const minimal = { agent: 'claude-code', title: 'Add AI traces' };

describe('traces', () => {
	it('fills defaults for a minimal trace', () => {
		expect(parseTraceInput(minimal, now)).toEqual({
			session_id: null,
			agent: 'claude-code',
			model: null,
			title: 'Add AI traces',
			summary: '',
			started_at: '2026-11-10T12:00:00.000Z',
			ended_at: null,
			input_tokens: null,
			output_tokens: null,
			cost_usd: null,
			refs: undefined,
			steps: [],
		});
	});

	it('keeps usage, refs and steps', () => {
		const input = parseTraceInput(
			{
				...minimal,
				session_id: 'conv:abc-123',
				model: 'claude-opus-4-5',
				started_at: '2026-11-10T06:00:00-05:00',
				ended_at: '2026-11-10T11:30:00Z',
				input_tokens: 12000,
				output_tokens: 3400,
				cost_usd: 0.42,
				refs: { commits: ['ABCDEF1'], branch: 'main' },
				steps: [
					{ role: 'user', content: 'log my traces\r\nplease' },
					{ role: 'tool', name: 'Shell', content: 'ok', at: '2026-11-10T11:01:00Z' },
				],
			},
			now,
		);
		expect(input).toMatchObject({
			session_id: 'conv:abc-123',
			started_at: '2026-11-10T11:00:00.000Z',
			ended_at: '2026-11-10T11:30:00.000Z',
			cost_usd: 0.42,
			refs: { commits: ['abcdef1'], branch: 'main' },
			steps: [
				{ role: 'user', content: 'log my traces\nplease' },
				{ role: 'tool', name: 'Shell', content: 'ok', at: '2026-11-10T11:01:00.000Z' },
			],
		});
	});

	it('names the bad field', () => {
		expect(parseTraceInput({ title: 'x' }, now)).toMatch(/^agent/);
		expect(parseTraceInput({ agent: 'codex' }, now)).toMatch(/^title/);
		expect(parseTraceInput({ ...minimal, session_id: 'has space' }, now)).toMatch(/^session_id/);
		expect(parseTraceInput({ ...minimal, input_tokens: -1 }, now)).toMatch(/tokens/);
		expect(parseTraceInput({ ...minimal, cost_usd: '1' }, now)).toMatch(/^cost_usd/);
		expect(parseTraceInput({ ...minimal, ended_at: '' }, now)).toMatch(/^ended_at/);
		expect(parseTraceInput({ ...minimal, started_at: '2026-11-10T11:00:00Z', ended_at: '2026-11-10T10:00:00Z' }, now)).toMatch(/before/);
		expect(parseTraceInput({ ...minimal, refs: { commits: ['nope'] } }, now)).toMatch(/^refs/);
		expect(parseTraceInput({ ...minimal, steps: [{ role: 'bot', content: 'x' }] }, now)).toMatch(/^steps/);
	});

	it('accepts only single-line labels', () => {
		expect(parseLabel(undefined)).toBeUndefined();
		expect(parseLabel(' cursor ')).toBe('cursor');
		expect(parseLabel('a\nb')).toBeNull();
		expect(parseLabel('x'.repeat(61), 60)).toBeNull();
	});

	it('caps the transcript', () => {
		expect(parseSteps(Array.from({ length: STEPS_MAX + 1 }, () => ({ role: 'user', content: '' })))).toBeNull();
		expect(parseSteps(Array.from({ length: 60 }, () => ({ role: 'tool', content: 'x'.repeat(20_000) })))).toBeNull();
		expect(parseSteps([{ role: 'user', content: 'x'.repeat(20_001) }])).toBeNull();
	});

	it('reads stored steps without throwing', () => {
		expect(readSteps('not json')).toEqual([]);
		expect(readSteps('[{"role":"user","content":"hi"}]')).toEqual([{ role: 'user', content: 'hi' }]);
	});
});
