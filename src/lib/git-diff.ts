import type { CommitFileDiff } from './repo-store.ts';

const MAX_CONTENT_FILES = 80;
const MAX_BYTES = 1_000_000;
const MAX_LCS_CELLS = 400_000;

export interface TreeEntryLike {
	name: string;
	hash: string;
	type: string;
}

export interface DiffSource {
	readTree(hash: string): Promise<TreeEntryLike[] | null>;
	readFile(ref: string, path: string): Promise<Uint8Array | null>;
}

interface Edit {
	op: 'eq' | 'ins' | 'del';
	line: string;
}

interface PendingChange {
	path: string;
	status: 'added' | 'modified' | 'deleted';
	kind: string;
	oldHash?: string;
	newHash?: string;
}

export function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split('\n');
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
}

function lcsDiff(before: string[], after: string[]): Edit[] {
	const n = before.length;
	const m = after.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const edits: Edit[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (before[i] === after[j]) {
			edits.push({ op: 'eq', line: before[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			edits.push({ op: 'del', line: before[i] });
			i++;
		} else {
			edits.push({ op: 'ins', line: after[j] });
			j++;
		}
	}
	while (i < n) edits.push({ op: 'del', line: before[i++] });
	while (j < m) edits.push({ op: 'ins', line: after[j++] });
	return edits;
}

export function diffLines(before: string[], after: string[]): Edit[] {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	let endBefore = before.length - 1;
	let endAfter = after.length - 1;
	while (endBefore >= start && endAfter >= start && before[endBefore] === after[endAfter]) {
		endBefore--;
		endAfter--;
	}
	const prefix = before.slice(0, start).map((line): Edit => ({ op: 'eq', line }));
	const suffix = before.slice(endBefore + 1).map((line): Edit => ({ op: 'eq', line }));
	const midBefore = before.slice(start, endBefore + 1);
	const midAfter = after.slice(start, endAfter + 1);
	const middle = midBefore.length * midAfter.length > MAX_LCS_CELLS
		? [
			...midBefore.map((line): Edit => ({ op: 'del', line })),
			...midAfter.map((line): Edit => ({ op: 'ins', line })),
		]
		: lcsDiff(midBefore, midAfter);
	return [...prefix, ...middle, ...suffix];
}

export function unifiedDiff(before: string | null, after: string | null, context = 3): { additions: number; deletions: number; patch: string } {
	const edits = diffLines(before == null ? [] : splitLines(before), after == null ? [] : splitLines(after));
	let additions = 0;
	let deletions = 0;
	for (const edit of edits) {
		if (edit.op === 'ins') additions++;
		else if (edit.op === 'del') deletions++;
	}
	if (additions === 0 && deletions === 0) return { additions, deletions, patch: '' };

	const rows: { op: Edit['op']; line: string; oldNo: number; newNo: number }[] = [];
	let oldNo = 1;
	let newNo = 1;
	for (const edit of edits) {
		rows.push({ op: edit.op, line: edit.line, oldNo, newNo });
		if (edit.op !== 'ins') oldNo++;
		if (edit.op !== 'del') newNo++;
	}

	const changed = rows.map((row, index) => (row.op === 'eq' ? -1 : index)).filter((index) => index >= 0);
	const hunks: { start: number; end: number }[] = [];
	for (const index of changed) {
		const start = Math.max(0, index - context);
		const end = Math.min(rows.length - 1, index + context);
		const last = hunks[hunks.length - 1];
		if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
		else hunks.push({ start, end });
	}

	const lines: string[] = [];
	for (const hunk of hunks) {
		const slice = rows.slice(hunk.start, hunk.end + 1);
		const oldStart = slice.find((row) => row.op !== 'ins')?.oldNo ?? 0;
		const newStart = slice.find((row) => row.op !== 'del')?.newNo ?? 0;
		const oldCount = slice.filter((row) => row.op !== 'ins').length;
		const newCount = slice.filter((row) => row.op !== 'del').length;
		lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
		for (const row of slice) {
			const prefix = row.op === 'ins' ? '+' : row.op === 'del' ? '-' : ' ';
			lines.push(prefix + row.line);
		}
	}
	return { additions, deletions, patch: lines.join('\n') };
}

function decodeBytes(bytes: Uint8Array): { binary: boolean; text: string } {
	if (bytes.byteLength > MAX_BYTES || bytes.includes(0)) return { binary: true, text: '' };
	try {
		return { binary: false, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) };
	} catch {
		return { binary: true, text: '' };
	}
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await fn(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

async function walk(
	source: DiffSource,
	oldTree: string | null,
	newTree: string | null,
	prefix: string,
): Promise<PendingChange[]> {
	if (oldTree && newTree && oldTree === newTree) return [];
	const [oldEntries, newEntries] = await Promise.all([
		oldTree ? source.readTree(oldTree) : Promise.resolve([] as TreeEntryLike[]),
		newTree ? source.readTree(newTree) : Promise.resolve([] as TreeEntryLike[]),
	]);
	if (oldTree && !oldEntries) throw new Error(`Missing git tree ${oldTree}`);
	if (newTree && !newEntries) throw new Error(`Missing git tree ${newTree}`);

	const oldMap = new Map((oldEntries ?? []).map((entry) => [entry.name, entry]));
	const newMap = new Map((newEntries ?? []).map((entry) => [entry.name, entry]));
	const names = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort();
	const nested = await mapLimit(names, 8, async (name) => {
		const previous = oldMap.get(name);
		const next = newMap.get(name);
		const path = prefix ? `${prefix}/${name}` : name;
		if (previous && next && previous.hash === next.hash && previous.type === next.type) return [];

		const oldIsTree = previous?.type === 'tree';
		const newIsTree = next?.type === 'tree';
		if (oldIsTree || newIsTree) {
			if (oldIsTree && newIsTree) return walk(source, previous!.hash, next!.hash, path);
			const removed = oldIsTree
				? await walk(source, previous!.hash, null, path)
				: previous
					? [{ path, status: 'deleted' as const, kind: previous.type, oldHash: previous.hash }]
					: [];
			const added = newIsTree
				? await walk(source, null, next!.hash, path)
				: next
					? [{ path, status: 'added' as const, kind: next.type, newHash: next.hash }]
					: [];
			return [...removed, ...added];
		}
		if (previous && next) {
			return [{ path, status: 'modified' as const, kind: next.type, oldHash: previous.hash, newHash: next.hash }];
		}
		if (next) return [{ path, status: 'added' as const, kind: next.type, newHash: next.hash }];
		if (previous) return [{ path, status: 'deleted' as const, kind: previous.type, oldHash: previous.hash }];
		return [];
	});
	return nested.flat();
}

async function readText(source: DiffSource, ref: string, path: string): Promise<{ binary: boolean; text: string } | null> {
	const bytes = await source.readFile(ref, path);
	if (!bytes) return null;
	return decodeBytes(bytes);
}

function binaryPatch(status: PendingChange['status']): string {
	if (status === 'added') return 'Binary file added';
	if (status === 'deleted') return 'Binary file deleted';
	return 'Binary file differs';
}

async function renderChange(
	source: DiffSource,
	change: PendingChange,
	commitHash: string,
	parentHash: string | null,
): Promise<CommitFileDiff> {
	if (change.kind === 'gitlink') {
		return {
			filename: change.path,
			status: change.status,
			additions: 0,
			deletions: 0,
			patch: `Submodule ${change.status}`,
		};
	}

	const before = change.status === 'added' || !parentHash ? null : await readText(source, parentHash, change.path);
	const after = change.status === 'deleted' ? null : await readText(source, commitHash, change.path);
	if ((change.status !== 'added' && !before) || (change.status !== 'deleted' && !after)) {
		return {
			filename: change.path,
			status: change.status,
			additions: 0,
			deletions: 0,
			patch: 'File content could not be read from the repository.',
		};
	}
	if (before?.binary || after?.binary) {
		return {
			filename: change.path,
			status: change.status,
			additions: 0,
			deletions: 0,
			patch: binaryPatch(change.status),
		};
	}

	const diff = unifiedDiff(
		change.status === 'added' ? null : before!.text,
		change.status === 'deleted' ? null : after!.text,
	);
	return {
		filename: change.path,
		status: change.status,
		additions: diff.additions,
		deletions: diff.deletions,
		patch: diff.patch,
	};
}

/**
 * Diff a commit against its first parent by walking only the trees whose hashes differ.
 * Line counts come from the blob contents. Missing trees throw instead of reporting an empty diff.
 */
export async function diffAgainstParent(
	source: DiffSource,
	commit: { hash: string; treeHash: string },
	parent: { hash: string; treeHash: string } | null,
): Promise<{ files: CommitFileDiff[]; omitted: number }> {
	const changes = await walk(source, parent?.treeHash ?? null, commit.treeHash, '');
	const shown = changes.slice(0, MAX_CONTENT_FILES);
	const files = await mapLimit(shown, 8, (change) => renderChange(source, change, commit.hash, parent?.hash ?? null));
	return { files, omitted: changes.length - shown.length };
}
