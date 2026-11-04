import { describe, expect, it } from 'vitest';
import { matchesBranchFilter } from '../src/lib/branch-pattern.ts';

describe('matchesBranchFilter', () => {
	it.each([
		// [patterns, branch, expected]
		[['main'], 'main', true],
		[['main'], 'main2', false],
		[['main'], 'feature/main', false],

		// `*` — exactly one path segment
		[['release/*'], 'release/1.0', true],
		[['release/*'], 'release/', true],
		[['release/*'], 'release/1.0/hotfix', false],
		[['release/*'], 'release', false],
		[['*'], 'main', true],
		[['*'], 'feature/x', false],
		[['feat-*'], 'feat-login', true],

		// `**` — any depth
		[['feature/**'], 'feature/a', true],
		[['feature/**'], 'feature/a/b/c', true],
		[['feature/**'], 'feature', false],
		[['feature/**'], 'featurex/a', false],
		[['**'], 'anything/at/all', true],

		// `**/` — zero or more whole segments
		[['**/hotfix'], 'hotfix', true],
		[['**/hotfix'], 'release/1.0/hotfix', true],
		[['**/hotfix'], 'release/xhotfix', false],
		[['team/**/wip'], 'team/wip', true],
		[['team/**/wip'], 'team/a/b/wip', true],

		// `?` — one non-slash character
		[['v?.x'], 'v1.x', true],
		[['v?.x'], 'v10.x', false],
		[['v?.x'], 'v/.x', false],

		// regex metacharacters are literal
		[['release-1.0'], 'release-1x0', false],
		[['release-1.*'], 'release-1x0', false],
		[['release-1.*'], 'release-1.0', true],
		[['a+b'], 'aab', false],
		[['a+b'], 'a+b', true],
		[['(x)|y'], 'y', false],

		// refs/heads/ prefix stripped on either side
		[['refs/heads/main'], 'main', true],
		[['main'], 'refs/heads/main', true],
		[['refs/heads/release/*'], 'refs/heads/release/2', true],

		// multiple patterns → any match
		[['main', 'develop', 'release/*'], 'develop', true],
		[['main', 'develop', 'release/*'], 'hotfix/1', false],

		// whitespace trimmed, empty patterns ignored
		[['  main  '], 'main', true],
		[['', '   '], '', false],
		[[], 'main', false],
	] as const)('%j vs %s → %s', (patterns, branch, expected) => {
		expect(matchesBranchFilter(patterns, branch)).toBe(expected);
	});

	it('is case-sensitive like git refs', () => {
		expect(matchesBranchFilter(['Main'], 'main')).toBe(false);
	});

	it('returns consistent results for a cached pattern', () => {
		expect(matchesBranchFilter(['ci/*'], 'ci/a')).toBe(true);
		expect(matchesBranchFilter(['ci/*'], 'ci/a/b')).toBe(false);
		expect(matchesBranchFilter(['ci/*'], 'ci/b')).toBe(true);
	});
});
