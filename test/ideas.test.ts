import { describe, expect, it } from 'vitest';
import {
	isIdeaStatus,
	newIdeaId,
	parseBody,
	parseLogText,
	parseRefs,
	parseTitle,
	readRefs,
	statusChangeText,
} from '../src/lib/ideas.ts';

describe('ideas', () => {
	it('accepts only the four statuses', () => {
		for (const s of ['open', 'exploring', 'done', 'dropped']) expect(isIdeaStatus(s)).toBe(true);
		expect(isIdeaStatus('active')).toBe(false);
		expect(isIdeaStatus(1)).toBe(false);
	});

	it('collapses a title to one trimmed line and rejects empty or long ones', () => {
		expect(parseTitle('  Copper pour\n under U4 ')).toBe('Copper pour under U4');
		expect(parseTitle('   ')).toBeNull();
		expect(parseTitle('x'.repeat(201))).toBeNull();
		expect(parseTitle(5)).toBeNull();
	});

	it('allows an empty body but not a non-string one', () => {
		expect(parseBody(undefined)).toBe('');
		expect(parseBody('  ## Why\nbecause  ')).toBe('## Why\nbecause');
		expect(parseBody(42)).toBeNull();
		expect(parseBody('x'.repeat(20_001))).toBeNull();
	});

	it('requires log text', () => {
		expect(parseLogText(' tried it, 71°C ')).toBe('tried it, 71°C');
		expect(parseLogText('')).toBeNull();
		expect(parseLogText(null)).toBeNull();
	});

	it('parses refs, lower-casing and de-duplicating commits', () => {
		expect(parseRefs(undefined)).toBeUndefined();
		expect(parseRefs({})).toBeUndefined();
		expect(parseRefs({ commits: ['ABCDEF1', 'abcdef1'], branch: 'idea/copper', ci_run_id: 'run-1' })).toEqual({
			commits: ['abcdef1'],
			branch: 'idea/copper',
			ci_run_id: 'run-1',
		});
	});

	it('rejects malformed refs', () => {
		expect(parseRefs([])).toBeNull();
		expect(parseRefs({ commits: 'abcdef1' })).toBeNull();
		expect(parseRefs({ commits: ['not-a-sha'] })).toBeNull();
		expect(parseRefs({ branch: 'has space' })).toBeNull();
		expect(parseRefs({ ci_run_id: '' })).toBeNull();
	});

	it('reads stored refs without throwing', () => {
		expect(readRefs(null)).toBeNull();
		expect(readRefs('not json')).toBeNull();
		expect(readRefs('{"commits":["abcdef1"]}')).toEqual({ commits: ['abcdef1'] });
	});

	it('makes short ids', () => {
		const id = newIdeaId();
		expect(id).toMatch(/^[0-9a-z]{8}$/);
		expect(newIdeaId()).not.toBe(id);
	});

	it('describes a status change, with an optional note', () => {
		expect(statusChangeText('open', 'exploring')).toBe('Status: open → exploring');
		expect(statusChangeText('exploring', 'dropped', 'Too hot.')).toBe('Status: exploring → dropped\n\nToo hot.');
	});
});
