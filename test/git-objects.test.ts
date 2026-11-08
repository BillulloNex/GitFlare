import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	MODE_TREE,
	applyTreeChanges,
	buildReceivePackRequest,
	makeBlob,
	makeCommit,
	makeTree,
	type GitObject,
	type TreeEntry,
} from '../src/lib/git-objects.ts';
import { parseReceivePackResponse } from '../src/lib/git-protocol.ts';

// These tests check our objects against the real git binary: same ids as
// `git hash-object`, packs git accepts, and a receive-pack request that
// `git receive-pack --stateless-rpc` applies to a bare repository.

const dirs: string[] = [];
function tempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), 'gitflare-objects-'));
	dirs.push(dir);
	git(dir, ['init', '-q', '--bare', '-b', 'main']);
	return dir;
}
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
function git(cwd: string, args: string[], input?: Uint8Array): string {
	return execFileSync('git', args, { cwd, input, env: GIT_ENV }).toString();
}

/** Push `objects` + move `refName` with our receive-pack request; return git's report. */
function receivePack(repo: string, body: Uint8Array) {
	const out = execFileSync('git', ['receive-pack', '--stateless-rpc', repo], { input: body, env: GIT_ENV });
	return parseReceivePackResponse(new Uint8Array(out));
}

/** Reads trees from the bare repo, like the Artifacts binding does in production. */
function reader(repo: string) {
	return async (sha: string): Promise<TreeEntry[]> =>
		git(repo, ['ls-tree', sha])
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const [meta, name] = line.split('\t');
				const [mode, , id] = meta.split(' ');
				return { mode: mode === '040000' ? MODE_TREE : mode, name, sha: id };
			});
}

const author = { name: 'Ada', email: 'ada@example.com', when: Date.UTC(2026, 10, 7, 12) };

describe('git objects', () => {
	it('hashes blobs like git hash-object', async () => {
		const repo = tempRepo();
		const blob = await makeBlob('hello world\n');
		expect(blob.sha).toBe(git(repo, ['hash-object', '--stdin'], new TextEncoder().encode('hello world\n')).trim());
	});

	it('sorts tree entries in git order (dirs as name/)', async () => {
		const blob = await makeBlob('x');
		const sub = await makeTree([{ mode: '100644', name: 'f', sha: blob.sha }]);
		const tree = await makeTree([
			{ mode: '100644', name: 'a.txt', sha: blob.sha },
			{ mode: MODE_TREE, name: 'a', sha: sub.sha },
			{ mode: '100644', name: 'a-b', sha: blob.sha },
		]);
		const repo = tempRepo();
		const body = await buildReceivePackRequest({
			refName: 'refs/heads/main',
			oldSha: null,
			newSha: (await makeCommit({ tree: tree.sha, parents: [], author, committer: author, message: 'x' })).sha,
			objects: [blob, sub, tree, await makeCommit({ tree: tree.sha, parents: [], author, committer: author, message: 'x' })],
		});
		expect(receivePack(repo, body)?.unpackOk).toBe(true);
		// mktree re-sorts canonically; the id must match ours.
		expect(git(repo, ['ls-tree', tree.sha]).split('\n').filter(Boolean).map((l) => l.split('\t')[1])).toEqual(['a-b', 'a.txt', 'a']);
		git(repo, ['fsck', '--strict']);
	});

	it('creates a branch, then fast-forwards it with an edited tree', async () => {
		const repo = tempRepo();
		const read = reader(repo);

		// Commit 1: two files in a nested dir.
		const a = await makeBlob('alpha\n');
		const b = await makeBlob(new Uint8Array([0, 1, 2, 255]));
		const t1 = await applyTreeChanges(read, null, new Map([
			['cad/part.step', { sha: a.sha }],
			['cad/sub/part.glb', { sha: b.sha }],
			['.gitattributes', { sha: a.sha }],
		]));
		const c1 = await makeCommit({ tree: t1.sha, parents: [], author, committer: author, message: 'v1\n\nOnshape-Version: abc' });
		let report = receivePack(repo, await buildReceivePackRequest({ refName: 'refs/heads/onshape', oldSha: null, newSha: c1.sha, objects: [a, b, ...t1.objects, c1] }));
		expect(report?.unpackOk).toBe(true);
		expect(report?.refResults).toEqual([{ refName: 'refs/heads/onshape', success: true }]);
		expect(git(repo, ['rev-parse', 'onshape']).trim()).toBe(c1.sha);
		expect(git(repo, ['show', 'onshape:cad/part.step'])).toBe('alpha\n');

		// Commit 2: change one file, delete the only file in cad/sub (dir disappears).
		const a2 = await makeBlob('alpha 2\n');
		const t2 = await applyTreeChanges(read, t1.sha, new Map([
			['cad/part.step', { sha: a2.sha }],
			['cad/sub/part.glb', null],
		]));
		const c2 = await makeCommit({ tree: t2.sha, parents: [c1.sha], author, committer: { ...author, when: author.when + 1000 }, message: 'v2' });
		const objects: GitObject[] = [a2, ...t2.objects, c2];
		report = receivePack(repo, await buildReceivePackRequest({ refName: 'refs/heads/onshape', oldSha: c1.sha, newSha: c2.sha, objects }));
		expect(report?.refResults[0].success).toBe(true);
		expect(git(repo, ['ls-tree', '-r', '--name-only', 'onshape']).trim().split('\n')).toEqual(['.gitattributes', 'cad/part.step']);
		expect(git(repo, ['log', '--format=%an <%ae> %at|%s', 'onshape']).trim().split('\n')).toEqual([
			`Ada <ada@example.com> ${author.when / 1000}|v2`,
			`Ada <ada@example.com> ${author.when / 1000}|v1`,
		]);
		git(repo, ['fsck', '--strict']);
	});

	it('is rejected as non-fast-forward when the old sha is stale', async () => {
		const repo = tempRepo();
		const blob = await makeBlob('x');
		const tree = await makeTree([{ mode: '100644', name: 'x', sha: blob.sha }]);
		const c1 = await makeCommit({ tree: tree.sha, parents: [], author, committer: author, message: 'one' });
		receivePack(repo, await buildReceivePackRequest({ refName: 'refs/heads/main', oldSha: null, newSha: c1.sha, objects: [blob, tree, c1] }));
		const c2 = await makeCommit({ tree: tree.sha, parents: [], author, committer: author, message: 'two' });
		const report = receivePack(repo, await buildReceivePackRequest({ refName: 'refs/heads/main', oldSha: null, newSha: c2.sha, objects: [c2] }));
		expect(report?.refResults[0].success).toBe(false);
	});
});
