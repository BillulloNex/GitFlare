/**
 * Branch glob matching for CI triggers, branch protection, deploy filters
 * and the merge queue.
 *
 *   `main`        exact match
 *   `release/*`   one path segment (`release/1.0`, not `release/1.0/hotfix`)
 *   `feature/**`  any depth (`feature/a`, `feature/a/b`)
 *   `**`          everything
 *   `v?.x`        `?` matches one non-`/` character
 *
 * Patterns may be given as `refs/heads/<pattern>`; the prefix is stripped from
 * both pattern and branch before matching.
 */

const REFS_HEADS = 'refs/heads/';

const regexCache = new Map<string, RegExp>();

function stripRefsHeads(value: string): string {
	return value.startsWith(REFS_HEADS) ? value.slice(REFS_HEADS.length) : value;
}

function escapeRegex(char: string): string {
	return char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern: string): RegExp {
	const cached = regexCache.get(pattern);
	if (cached) return cached;

	let source = '';
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === '*') {
			if (pattern[i + 1] === '*') {
				i++;
				if (pattern[i + 1] === '/') {
					// `**/` matches zero or more whole segments
					i++;
					source += '(?:.*/)?';
				} else {
					source += '.*';
				}
			} else {
				source += '[^/]*';
			}
		} else if (char === '?') {
			source += '[^/]';
		} else {
			source += escapeRegex(char);
		}
	}

	const regex = new RegExp(`^${source}$`);
	regexCache.set(pattern, regex);
	return regex;
}

/** True if `branch` matches any of `patterns`. An empty pattern list matches nothing. */
export function matchesBranchFilter(patterns: readonly string[], branch: string): boolean {
	const name = stripRefsHeads(branch);
	for (const raw of patterns) {
		const pattern = stripRefsHeads(raw.trim());
		if (!pattern) continue;
		if (pattern === name) return true;
		if ((pattern.includes('*') || pattern.includes('?')) && globToRegExp(pattern).test(name)) return true;
	}
	return false;
}
