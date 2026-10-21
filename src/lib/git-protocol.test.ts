import { describe, expect, it } from 'vitest';
import { selectSuccessfulUpdates, type RefUpdate, type ReportStatus } from './git-protocol.ts';

const main: RefUpdate = {
	oldSha: 'a'.repeat(40),
	newSha: 'b'.repeat(40),
	refName: 'refs/heads/main',
	branch: 'main',
	isCreate: false,
	isDelete: false,
};

const feature: RefUpdate = {
	...main,
	newSha: 'c'.repeat(40),
	refName: 'refs/heads/feature',
	branch: 'feature',
};

describe('selectSuccessfulUpdates', () => {
	it('does not invent a main update when nothing was parsed', () => {
		expect(selectSuccessfulUpdates(true, null, [])).toEqual([]);
		expect(selectSuccessfulUpdates(false, null, [main])).toEqual([]);
	});

	it('drops the push when unpack failed', () => {
		const report: ReportStatus = { unpackOk: false, unpackError: 'pack corrupt', refResults: [] };
		expect(selectSuccessfulUpdates(true, report, [main])).toEqual([]);
	});

	it('keeps only refs the report says succeeded', () => {
		const report: ReportStatus = {
			unpackOk: true,
			refResults: [
				{ refName: 'refs/heads/main', branch: 'main', success: false, error: 'protected' },
				{ refName: 'refs/heads/feature', branch: 'feature', success: true },
			],
		};
		expect(selectSuccessfulUpdates(true, report, [main, feature])).toEqual([feature]);
	});

	it('trusts the request refs when unpack succeeded but no per-ref lines were returned', () => {
		const report: ReportStatus = { unpackOk: true, refResults: [] };
		expect(selectSuccessfulUpdates(true, report, [feature])).toEqual([feature]);
	});
});
