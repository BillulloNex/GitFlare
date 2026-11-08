/**
 * Write git objects from the Worker: blobs, trees, commits, packfiles, and a
 * receive-pack request that pushes one new commit to an Artifacts branch.
 *
 * Used by integrations that create commits server-side (lib/onshape-sync.ts)
 * without a runner or a git binary. Only what that needs is implemented:
 * undeltified objects (pack v2), SHA-1 object ids, and a push with
 * `report-status` and no side-band.
 *
 * References:
 * - https://git-scm.com/book/en/v2/Git-Internals-Git-Objects
 * - https://git-scm.com/docs/pack-format
 * - https://git-scm.com/docs/pack-protocol (receive-pack)
 */
import { encodePktLine, ZERO_SHA } from './git-protocol.ts';

const encoder = new TextEncoder();

export type GitObjectType = 'commit' | 'tree' | 'blob';

export interface GitObject {
	type: GitObjectType;
	sha: string;
	/** Object content without the `<type> <size>\0` header. */
	content: Uint8Array;
}

/** A tree entry as git stores it. `mode` is git's octal string ("100644", "40000", …). */
export interface TreeEntry {
	mode: string;
	name: string;
	sha: string;
}

export const MODE_FILE = '100644';
export const MODE_EXEC = '100755';
export const MODE_SYMLINK = '120000';
export const MODE_TREE = '40000';
export const MODE_GITLINK = '160000';

// ─── Bytes helpers ──────────────────────────────────────────────

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

function toHex(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += b.toString(16).padStart(2, '0');
	return s;
}

function fromHex(hex: string): Uint8Array {
	if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`invalid object id: ${hex}`);
	const out = new Uint8Array(20);
	for (let i = 0; i < 20; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

async function sha1(data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-1', data));
}

export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
	return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

/** zlib (RFC 1950) deflate — what git uses for loose and packed objects. */
async function deflate(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ─── Objects ────────────────────────────────────────────────────

export async function makeObject(type: GitObjectType, content: Uint8Array): Promise<GitObject> {
	const header = encoder.encode(`${type} ${content.length}\0`);
	const sha = toHex(await sha1(concatBytes([header, content])));
	return { type, sha, content };
}

export function makeBlob(content: Uint8Array | string): Promise<GitObject> {
	return makeObject('blob', typeof content === 'string' ? encoder.encode(content) : content);
}

/**
 * Git's tree order: byte-wise by name, where a tree's name sorts as if it
 * ended in "/". (Names are compared as UTF-8 bytes.)
 */
function treeSortKey(e: TreeEntry): Uint8Array {
	return encoder.encode(e.mode === MODE_TREE ? `${e.name}/` : e.name);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
}

export function makeTree(entries: TreeEntry[]): Promise<GitObject> {
	const seen = new Set<string>();
	for (const e of entries) {
		if (!e.name || e.name.includes('/') || e.name.includes('\0') || e.name === '.' || e.name === '..' || e.name === '.git') {
			throw new Error(`invalid tree entry name: ${JSON.stringify(e.name)}`);
		}
		if (seen.has(e.name)) throw new Error(`duplicate tree entry: ${e.name}`);
		seen.add(e.name);
	}
	const sorted = [...entries].sort((a, b) => compareBytes(treeSortKey(a), treeSortKey(b)));
	const parts: Uint8Array[] = [];
	for (const e of sorted) {
		parts.push(encoder.encode(`${e.mode} ${e.name}\0`), fromHex(e.sha));
	}
	return makeObject('tree', concatBytes(parts));
}

export interface Signature {
	name: string;
	email: string;
	/** Epoch milliseconds. */
	when: number;
}

function formatSignature(s: Signature): string {
	// Strip characters git forbids in identities.
	const clean = (v: string) => v.replace(/[<>\n\r\0]/g, '').trim();
	const name = clean(s.name) || 'Unknown';
	const email = clean(s.email) || 'unknown@localhost';
	return `${name} <${email}> ${Math.floor(s.when / 1000)} +0000`;
}

export function makeCommit(opts: {
	tree: string;
	parents: string[];
	author: Signature;
	committer: Signature;
	message: string;
}): Promise<GitObject> {
	const lines = [`tree ${opts.tree}`];
	for (const p of opts.parents) lines.push(`parent ${p}`);
	lines.push(`author ${formatSignature(opts.author)}`, `committer ${formatSignature(opts.committer)}`, '');
	const message = opts.message.replace(/\0/g, '').replace(/\r\n/g, '\n').trimEnd() + '\n';
	return makeObject('commit', encoder.encode(lines.join('\n') + '\n' + message));
}

// ─── Tree editing ───────────────────────────────────────────────

/** Reads an existing tree's entries (e.g. through the Artifacts binding). */
export type TreeReader = (sha: string) => Promise<TreeEntry[]>;

/** path → new blob, or null to delete. Paths are `/`-separated, no leading slash. */
export type TreeChanges = Map<string, { sha: string; mode?: string } | null>;

/**
 * Apply `changes` to the tree `rootSha` (null = empty tree). Returns the new
 * root tree id and every tree object that had to be written. Unchanged
 * subtrees are reused by id, so only the paths that changed are rewritten.
 * Directories left empty by deletions are removed, as git does.
 */
export async function applyTreeChanges(
	readTree: TreeReader,
	rootSha: string | null,
	changes: TreeChanges
): Promise<{ sha: string; objects: GitObject[] }> {
	const objects: GitObject[] = [];

	interface Node {
		files: Map<string, { sha: string; mode?: string } | null>;
		dirs: Map<string, Node>;
	}
	const root: Node = { files: new Map(), dirs: new Map() };
	for (const [path, change] of changes) {
		const parts = path.split('/');
		if (parts.some((p) => !p)) throw new Error(`invalid path: ${path}`);
		let node = root;
		for (const dir of parts.slice(0, -1)) {
			let next = node.dirs.get(dir);
			if (!next) node.dirs.set(dir, (next = { files: new Map(), dirs: new Map() }));
			node = next;
		}
		node.files.set(parts[parts.length - 1], change);
	}

	async function write(treeSha: string | null, node: Node): Promise<string | null> {
		const entries = new Map<string, TreeEntry>();
		if (treeSha) for (const e of await readTree(treeSha)) entries.set(e.name, e);

		for (const [name, change] of node.files) {
			if (change === null) entries.delete(name);
			else entries.set(name, { name, mode: change.mode ?? MODE_FILE, sha: change.sha });
		}
		for (const [name, child] of node.dirs) {
			const existing = entries.get(name);
			const childSha = await write(existing?.mode === MODE_TREE ? existing.sha : null, child);
			if (childSha === null) entries.delete(name);
			else entries.set(name, { name, mode: MODE_TREE, sha: childSha });
		}
		if (entries.size === 0) return null;
		const tree = await makeTree([...entries.values()]);
		objects.push(tree);
		return tree.sha;
	}

	const sha = (await write(rootSha, root)) ?? (await makeTree([])).sha;
	if (objects.length === 0) objects.push(await makeTree([]));
	return { sha, objects };
}

// ─── Packfile ───────────────────────────────────────────────────

const PACK_TYPE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3 };

function packObjectHeader(type: GitObjectType, size: number): Uint8Array {
	const bytes: number[] = [];
	let byte = (PACK_TYPE[type] << 4) | (size & 0x0f);
	size = Math.floor(size / 16);
	while (size > 0) {
		bytes.push(byte | 0x80);
		byte = size & 0x7f;
		size = Math.floor(size / 128);
	}
	bytes.push(byte);
	return Uint8Array.from(bytes);
}

/** A version-2 packfile holding `objects` undeltified (duplicates dropped). */
export async function buildPack(objects: GitObject[]): Promise<Uint8Array> {
	const unique = new Map<string, GitObject>();
	for (const o of objects) unique.set(o.sha, o);

	const header = new Uint8Array(12);
	header.set(encoder.encode('PACK'), 0);
	const view = new DataView(header.buffer);
	view.setUint32(4, 2);
	view.setUint32(8, unique.size);

	const parts: Uint8Array[] = [header];
	for (const o of unique.values()) {
		parts.push(packObjectHeader(o.type, o.content.length), await deflate(o.content));
	}
	const body = concatBytes(parts);
	return concatBytes([body, await sha1(body)]);
}

// ─── receive-pack ───────────────────────────────────────────────

/**
 * Body of a smart-HTTP git-receive-pack request updating one ref.
 * `oldSha` null = create the ref. Capabilities: report-status only, so the
 * response is a plain (non-side-band) report.
 */
export async function buildReceivePackRequest(opts: {
	refName: string;
	oldSha: string | null;
	newSha: string;
	objects: GitObject[];
}): Promise<Uint8Array> {
	const command = `${opts.oldSha ?? ZERO_SHA} ${opts.newSha} ${opts.refName}\0report-status agent=gitflare\n`;
	return concatBytes([encodePktLine(command), encoder.encode('0000'), await buildPack(opts.objects)]);
}
