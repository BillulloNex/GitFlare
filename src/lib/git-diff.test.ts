import { describe, expect, it } from 'vitest';
import { diffAgainstParent, unifiedDiff, type DiffSource, type TreeEntryLike } from './git-diff.ts';

function source(trees: Record<string, TreeEntryLike[]>, files: Record<string, string>): DiffSource {
	return {
		async readTree(hash) {
			return trees[hash] ?? null;
		},
		async readFile(ref, path) {
			const text = files[`${ref}:${path}`];
			return text == null ? null : new TextEncoder().encode(text);
		},
	};
}

describe('unifiedDiff', () => {
	it('counts a one-line replacement', () => {
		const diff = unifiedDiff('0.81.6\n', '0.81.7\n');
		expect(diff.additions).toBe(1);
		expect(diff.deletions).toBe(1);
		expect(diff.patch).toContain('-0.81.6');
		expect(diff.patch).toContain('+0.81.7');
	});

	it('counts every line of a new file', () => {
		const diff = unifiedDiff(null, 'a\nb\n');
		expect(diff.additions).toBe(2);
		expect(diff.deletions).toBe(0);
	});
});

describe('diffAgainstParent', () => {
	it('returns real line stats for a changed blob and ignores unchanged trees', async () => {
		const diff = await diffAgainstParent(
			source(
				{
					old: [{ name: 'VERSION', hash: 'blob-old', type: 'blob' }, { name: 'same', hash: 'tree-same', type: 'tree' }],
					'new': [{ name: 'VERSION', hash: 'blob-new', type: 'blob' }, { name: 'same', hash: 'tree-same', type: 'tree' }],
					'tree-same': [{ name: 'untouched.txt', hash: 'blob-same', type: 'blob' }],
				},
				{
					'parent:VERSION': '0.81.6\n',
					'commit:VERSION': '0.81.7\n',
				},
			),
			{ hash: 'commit', treeHash: 'new' },
			{ hash: 'parent', treeHash: 'old' },
		);
		expect(diff.omitted).toBe(0);
		expect(diff.files).toEqual([
			expect.objectContaining({
				filename: 'VERSION',
				status: 'modified',
				additions: 1,
				deletions: 1,
			}),
		]);
		expect(diff.files[0].patch).toContain('+0.81.7');
	});

	it('does not invent an empty diff when the trees match', async () => {
		const diff = await diffAgainstParent(
			source({ same: [{ name: 'README.md', hash: 'b', type: 'blob' }] }, {}),
			{ hash: 'commit', treeHash: 'same' },
			{ hash: 'parent', treeHash: 'same' },
		);
		expect(diff.files).toEqual([]);
	});

	it('counts lines added in a root commit', async () => {
		const diff = await diffAgainstParent(
			source(
				{ root: [{ name: 'README.md', hash: 'b', type: 'blob' }] },
				{ 'commit:README.md': '# GitFlare\n\nReal contents.\n' },
			),
			{ hash: 'commit', treeHash: 'root' },
			null,
		);
		expect(diff.files).toEqual([
			expect.objectContaining({ filename: 'README.md', status: 'added', additions: 3, deletions: 0 }),
		]);
	});

	it('throws when a tree object is missing instead of reporting zero changes', async () => {
		await expect(diffAgainstParent(
			source({}, {}),
			{ hash: 'commit', treeHash: 'missing' },
			null,
		)).rejects.toThrow(/Missing git tree/);
	});
});
