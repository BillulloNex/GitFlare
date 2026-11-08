import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../src/lib/crypto.ts';
import {
	OnshapeClient,
	detectExtension,
	normalizeBaseUrl,
	parseDocumentRef,
	signRequest,
} from '../src/lib/onshape.ts';
import {
	assignFolders,
	buildManifest,
	elementFileNames,
	ensureLfsAttributes,
	newVersions,
	readCapped,
	runOnshapeSync,
	safeName,
	type ExportState,
} from '../src/lib/onshape-sync.ts';

// ─── Pure helpers ───────────────────────────────────────────────

describe('onshape helpers', () => {
	it('parses document URLs and ids', () => {
		const did = 'a1b2c3d4e5f6a1b2c3d4e5f6';
		expect(parseDocumentRef(did)).toEqual({ documentId: did });
		expect(parseDocumentRef(`https://cad.onshape.com/documents/${did}/w/0123456789abcdef01234567/e/0123456789abcdef01234567`)).toEqual({
			documentId: did,
			baseUrl: 'https://cad.onshape.com',
		});
		expect(parseDocumentRef(`https://acme.onshape.com/documents/${did}`)?.baseUrl).toBe('https://acme.onshape.com');
		expect(parseDocumentRef(`https://evil.example.com/documents/${did}`)).toBeNull();
		expect(parseDocumentRef('not a doc')).toBeNull();
	});

	it('only accepts https onshape.com origins', () => {
		expect(normalizeBaseUrl(undefined)).toBe('https://cad.onshape.com');
		expect(normalizeBaseUrl('acme.onshape.com')).toBe('https://acme.onshape.com');
		expect(normalizeBaseUrl('http://cad.onshape.com')).toBeNull();
		expect(normalizeBaseUrl('https://onshape.com.evil.io')).toBeNull();
		expect(normalizeBaseUrl('https://user:pw@cad.onshape.com')).toBeNull();
	});

	it('signs requests the way the Onshape docs describe', async () => {
		const url = new URL('https://cad.onshape.com/api/v17/documents/d/abc/versions?offset=0&limit=20');
		const date = 'Sat, 07 Nov 2026 12:00:00 GMT';
		const headers = await signRequest({ accessKey: 'ACCESS', secretKey: 'SECRET' }, 'GET', url, 'application/json', date, 'NonceNonceNonceNonce12345');
		const expected = createHmac('sha256', 'SECRET')
			.update(`get\nnoncenoncenoncenonce12345\nsat, 07 nov 2026 12:00:00 gmt\napplication/json\n/api/v17/documents/d/abc/versions\noffset=0&limit=20\n`)
			.digest('base64');
		expect(headers.Authorization).toBe(`On ACCESS:HmacSHA256:${expected}`);
		expect(headers['On-Nonce']).toBe('NonceNonceNonceNonce12345');
		expect(headers.Date).toBe(date);
	});

	it('names files safely and uniquely', () => {
		expect(safeName('Bracket / v2: final?', 'x')).toBe('Bracket - v2- final-');
		expect(safeName('..', 'fallback')).toBe('fallback');
		expect(safeName('.git', 'fallback')).toBe('git'); // leading dots are stripped
		const names = elementFileNames([
			{ id: 'aaaaaaaaaaaa', name: 'Part Studio 1' },
			{ id: 'bbbbbbbbbbbb', name: 'part studio 1' },
			{ id: 'cccccccccccc', name: 'Assembly' },
		]);
		expect([...names.values()]).toEqual(['Part Studio 1 (aaaaaa)', 'part studio 1 (bbbbbb)', 'Assembly']);
	});

	it('adds only missing LFS patterns to .gitattributes, scoped to the document folder', () => {
		const fresh = ensureLfsAttributes(null, 'Drone Frame')!;
		expect(fresh).toContain('Drone[[:space:]]Frame/*.glb filter=lfs diff=lfs merge=lfs -text\n');
		expect(fresh).not.toMatch(/^\*\.glb/m);
		expect(ensureLfsAttributes(fresh, 'Drone Frame')).toBeNull();
		const merged = ensureLfsAttributes('*.psd filter=lfs diff=lfs merge=lfs -text\n', 'parts')!;
		expect(merged.startsWith('*.psd')).toBe(true);
		expect(merged).toContain('parts/*.step filter=lfs');
		expect(merged).not.toMatch(/\n\*\.step/);
	});

	it('gives two documents with the same name different folders', () => {
		const [a, b] = assignFolders([
			{ id: 'aaaaaaaaaaaa', name: 'Untitled document' },
			{ id: 'bbbbbbbbbbbb', name: 'Untitled document' },
		]);
		expect(a.folder).toBe('Untitled document');
		expect(b.folder).toBe('Untitled document (bbbbbb)');
		expect(assignFolders([a, b]).map((d) => d.folder)).toEqual([a.folder, b.folder]);
	});

	it('keeps the previous file when an export fails', () => {
		const doc = { id: 'd', name: 'Frame', folder: 'Frame' };
		const version = { version_id: 'v2', version_name: 'v2', version_description: null, version_created_at: '2026-11-03T10:00:00Z', creator_name: null };
		const previous = buildManifest({ base_url: 'https://cad.onshape.com' }, doc, { ...version, version_id: 'v1', version_name: 'v1' }, {
			tasks: [{ elementId: 'e1', elementName: 'Arm', elementType: 'PARTSTUDIO', format: 'step', state: 'done', polls: 1, nextPollAt: 0, oid: 'abc', size: 4, ext: 'step' }],
		} satisfies ExportState, null);
		const next = buildManifest({ base_url: 'https://cad.onshape.com' }, doc, version, {
			tasks: [{ elementId: 'e1', elementName: 'Arm', elementType: 'PARTSTUDIO', format: 'step', state: 'failed', polls: 1, nextPollAt: 0, error: 'no solid' }],
		} satisfies ExportState, previous);
		expect(next.elements[0].files).toEqual([{ path: 'Arm.step', format: 'step', size: 4, oid: 'abc', from_version: 'v1' }]);
		expect(next.elements[0].errors).toEqual([{ format: 'step', error: 'no solid' }]);
	});

	it('stops reading a body that declares itself over the cap', async () => {
		const big = new Response(new Uint8Array(8), { headers: { 'Content-Length': '999999999' } });
		expect(await readCapped(big, 16)).toBeNull();
		const small = new Response(new Uint8Array([1, 2, 3]));
		expect([...(await readCapped(small, 16))!]).toEqual([1, 2, 3]);
	});

	it('picks new versions in creation order', () => {
		const v = (id: string, createdAt: string) => ({ id, name: id, createdAt });
		expect(newVersions([v('c', '2026-03-01'), v('a', '2026-01-01'), v('b', '2026-02-01')], new Set(['a'])).map((x) => x.id)).toEqual(['b', 'c']);
	});

	it('detects the exported file type', () => {
		const bytes = (s: string) => new TextEncoder().encode(s);
		expect(detectExtension('glb', bytes('glTF....'))).toBe('glb');
		expect(detectExtension('glb', bytes('{"asset":'))).toBe('gltf');
		expect(detectExtension('stl', bytes('PK\u0003\u0004'))).toBe('stl.zip');
		expect(detectExtension('step', bytes('ISO-10303-21;'))).toBe('step');
	});
});

// ─── End to end: fake Onshape + real git ────────────────────────
//
// D1 → node:sqlite with the real migration; Artifacts → a bare repo driven
// by `git receive-pack --stateless-rpc`; R2 → a Map; Onshape → an in-memory
// fake that checks every request's signature.

const DID = 'd0c0d0c0d0c0d0c0d0c0d0c0';
const ACCOUNT = 'acct';
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

function git(cwd: string, args: string[], input?: Uint8Array): Buffer {
	return execFileSync('git', args, { cwd, input, env: GIT_ENV });
}

function fakeD1(db: DatabaseSync) {
	const stmt = (sql: string, params: unknown[] = []) => ({
		bind: (...p: unknown[]) => stmt(sql, p),
		first: async <T>() => (db.prepare(sql).get(...(params as never[])) as T) ?? null,
		all: async <T>() => ({ results: db.prepare(sql).all(...(params as never[])) as T[] }),
		run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) } }),
	});
	return {
		prepare: (sql: string) => stmt(sql),
		batch: async (stmts: { run: () => Promise<unknown> }[]) => {
			for (const s of stmts) await s.run();
			return [];
		},
	};
}

interface FakeVersion {
	id: string;
	name: string;
	description?: string;
	createdAt: string;
	creator: { name: string };
	parent: string | null;
	elements: { id: string; name: string; elementType: string }[];
	/** element:format combinations whose export fails */
	failing?: string[];
}

function fakeOnshape(versions: FakeVersion[]) {
	const calls: string[] = [];
	const translations = new Map<string, { did: string; vid: string; eid: string; format: string; polled: number }>();
	let tid = 0;

	async function handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		// Every call must carry a valid-looking signature.
		const auth = req.headers.get('Authorization') ?? '';
		if (!/^On ACCESS:HmacSHA256:[A-Za-z0-9+/=]+$/.test(auth) || !req.headers.get('On-Nonce') || !req.headers.get('Date')) {
			return new Response('unauthorized', { status: 401 });
		}
		const p = url.pathname.replace('/api/v17', '');
		calls.push(`${req.method} ${p}${url.search}`);
		let m: RegExpMatchArray | null;

		if ((m = p.match(/^\/documents\/d\/(\w+)\/versions$/))) {
			const offset = Number(url.searchParams.get('offset'));
			const limit = Number(url.searchParams.get('limit'));
			return Response.json(versions.slice(offset, offset + limit).map(({ elements, failing, ...v }) => v));
		}
		if ((m = p.match(/^\/documents\/d\/(\w+)\/v\/(\w+)\/elements$/))) {
			const v = versions.find((x) => x.id === m![2]);
			return Response.json([...(v?.elements ?? []), { id: 'drawing00000', name: 'Drawing 1', elementType: 'DRAWING' }]);
		}
		if ((m = p.match(/^\/(partstudios|assemblies)\/d\/(\w+)\/v\/(\w+)\/e\/(\w+)\/(export\/gltf|export\/step|translations)$/)) && req.method === 'POST') {
			const body = (await req.json()) as { storeInDocument?: boolean; formatName?: string };
			expect(body.storeInDocument).toBe(false);
			const format = m[5] === 'export/gltf' ? 'glb' : m[5] === 'export/step' ? 'step' : body.formatName!.toLowerCase();
			const id = `t${++tid}`;
			translations.set(id, { did: m[2], vid: m[3], eid: m[4], format, polled: 0 });
			return Response.json({ id, requestState: 'ACTIVE' });
		}
		if ((m = p.match(/^\/translations\/(\w+)$/))) {
			const t = translations.get(m[1])!;
			t.polled++;
			const v = versions.find((x) => x.id === t.vid)!;
			if (v.failing?.includes(`${t.eid}:${t.format}`)) return Response.json({ id: m[1], requestState: 'FAILED', failureReason: 'Part has no solid bodies' });
			return Response.json({ id: m[1], requestState: 'DONE', resultExternalDataIds: [`f-${m[1]}`] });
		}
		if ((m = p.match(/^\/documents\/d\/(\w+)\/externaldata\/f-(\w+)$/))) {
			// Downloads redirect once, like the real API; the follow-up must be re-signed.
			return new Response(null, { status: 307, headers: { Location: `https://cad.onshape.com/api/v17/blobs/${m[2]}?sig=1` } });
		}
		if ((m = p.match(/^\/blobs\/(\w+)$/))) {
			const t = translations.get(m[1])!;
			const content = `${t.format}:${t.vid}:${t.eid}`;
			const bytes = t.format === 'glb' ? `glTF${content}` : content;
			return new Response(bytes);
		}
		return new Response(`no route ${p}`, { status: 404 });
	}
	return { calls, handle };
}

function fakeArtifacts(bare: string) {
	const readTree = async (sha: string) =>
		git(bare, ['ls-tree', sha])
			.toString()
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const [meta, name] = line.split('\t');
				const [mode, type, hash] = meta.split(' ');
				return { name, mode, hash, type: type as 'tree' | 'blob' };
			});
	const repo = {
		name: 'cad',
		remote: '',
		createToken: async () => 'artifacts-token',
		info: async () => ({ defaultBranch: 'main' }),
		log: async () => [],
		readTree,
		readCommit: async (hash: string) => {
			const text = git(bare, ['cat-file', '-p', hash]).toString();
			const blank = text.indexOf('\n\n');
			return { hash, treeHash: text.match(/^tree (\w+)/)![1], message: blank === -1 ? '' : text.slice(blank + 2) } as never;
		},
		readFile: async ({ ref, path }: { ref: string; path: string }) => {
			try {
				return new Blob([git(bare, ['show', `${ref}:${path}`])]);
			} catch {
				return null;
			}
		},
	};
	async function handle(req: Request): Promise<Response> {
		expect(req.headers.get('Authorization')).toBe('Bearer artifacts-token');
		const url = new URL(req.url);
		if (url.pathname.endsWith('/info/refs')) {
			return new Response(git(bare, ['receive-pack', '--stateless-rpc', '--advertise-refs', bare]));
		}
		if (url.pathname.endsWith('/git-receive-pack')) {
			const body = new Uint8Array(await req.arrayBuffer());
			return new Response(git(bare, ['receive-pack', '--stateless-rpc', bare], body));
		}
		return new Response('not found', { status: 404 });
	}
	return { repo, handle };
}

describe('Onshape sync end to end', () => {
	let dir: string;
	let bare: string;
	let db: DatabaseSync;
	let env: any;
	let versions: FakeVersion[];
	let onshape: ReturnType<typeof fakeOnshape>;
	let r2: Map<string, Uint8Array>;
	let now = Date.UTC(2026, 10, 7, 12, 0, 0);

	const element = (id: string, name: string, elementType = 'PARTSTUDIO') => ({ id: id.padEnd(24, '0'), name, elementType });
	const tick = async () => {
		// Date is frozen during a tick, so a 5 s budget never sleeps for polls: each tick does what is due and returns.
		await runOnshapeSync(env, { budgetMs: 5_000 });
	};
	const advance = (ms: number) => {
		now += ms;
		vi.setSystemTime(now);
	};

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
		dir = mkdtempSync(join(tmpdir(), 'gitflare-onshape-'));
		bare = join(dir, 'cad.git');
		git(dir, ['init', '-q', '--bare', '-b', 'main', bare]);

		db = new DatabaseSync(':memory:');
		db.exec(`
			CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT, default_branch TEXT, lfs_enabled INTEGER NOT NULL DEFAULT 1);
			CREATE TABLE lfs_objects (repo_id TEXT, oid TEXT, size INTEGER, state TEXT, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (repo_id, oid));
			CREATE TABLE audit_log (id TEXT, repo_id TEXT, actor TEXT, action TEXT, details TEXT, ip_address TEXT, created_at TEXT);
			CREATE TABLE github_mirrors (id TEXT, repo_id TEXT, branch_filter TEXT, is_enabled INTEGER);
			INSERT INTO repositories (id, name, default_branch) VALUES ('repo1', 'cad', 'main');
		`);
		db.exec(readFileSync(join(__dirname, '../migrations/0009_onshape.sql'), 'utf8'));
		db.exec(`CREATE TABLE protected_branches (
			id TEXT PRIMARY KEY,
			repo_id TEXT NOT NULL,
			branch_pattern TEXT NOT NULL,
			enforce_merge_queue INTEGER NOT NULL DEFAULT 1
		);`);

		const key = 'test-encryption-key-0123456789abcdef';
		db.prepare(
			`INSERT INTO onshape_links (id, repo_id, base_url, access_key_encrypted, secret_key_encrypted, access_key_hint, documents, branch, formats, backfill)
			 VALUES ('link1', 'repo1', 'https://cad.onshape.com', ?, ?, 'CESS', ?, 'main', '["glb","step"]', 'latest')`
		).run(await encryptSecret('ACCESS', key), await encryptSecret('SECRET', key), JSON.stringify([{ id: DID, name: 'Drone Frame' }]));

		versions = [
			{ id: 'v0'.padEnd(24, '0'), name: 'Start', createdAt: '2026-11-01T10:00:00Z', creator: { name: 'Thomas' }, parent: null, elements: [] },
			{ id: 'v1'.padEnd(24, '0'), name: 'First cut', createdAt: '2026-11-02T10:00:00Z', creator: { name: 'Thomas' }, parent: 'v0', elements: [element('e1', 'Arm')] },
			{
				id: 'v2'.padEnd(24, '0'),
				name: 'Thicker arms',
				description: 'Arms 4 → 6 mm',
				createdAt: '2026-11-03T10:00:00Z',
				creator: { name: 'Thomas' },
				parent: 'v1',
				elements: [element('e1', 'Arm'), element('e2', 'Frame', 'ASSEMBLY')],
			},
		];
		onshape = fakeOnshape(versions);
		const artifacts = fakeArtifacts(bare);
		r2 = new Map();

		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const req = new Request(input, init);
			const host = new URL(req.url).hostname;
			if (host === 'cad.onshape.com') return onshape.handle(req);
			if (host === `${ACCOUNT}.artifacts.cloudflare.net`) return artifacts.handle(req);
			throw new Error(`unexpected fetch ${req.url}`);
		});

		env = {
			DB: fakeD1(db),
			ENCRYPTION_KEY: key,
			SESSION_SECRET: 'unused',
			CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
			REPOS: { get: async (name: string) => (name === 'cad' ? artifacts.repo : null) },
			STORAGE: {
				head: async (k: string) => (r2.has(k) ? {} : null),
				put: async (k: string, v: Uint8Array) => void r2.set(k, v),
			},
			REPO_COORDINATOR: {
				idFromName: (n: string) => n,
				get: () => ({ fetch: async (r: Request) => Response.json(new URL(r.url).pathname === '/lock' ? { lock_id: 'lock' } : {}) }),
			},
		};
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	});

	const files = () => git(bare, ['ls-tree', '-r', '--name-only', 'main']).toString().trim().split('\n');
	const show = (path: string) => git(bare, ['show', `main:${path}`]).toString();
	const statuses = () =>
		Object.fromEntries((db.prepare('SELECT version_name, status FROM onshape_versions ORDER BY version_created_at').all() as { version_name: string; status: string }[]).map((r) => [r.version_name, r.status]));

	it('commits the latest version first, then each new version, as LFS files', async () => {
		// Tick 1: discover (backfill = latest → only "Thicker arms"), start 4 exports.
		await tick();
		expect(statuses()).toEqual({ Start: 'skipped', 'First cut': 'skipped', 'Thicker arms': 'exporting' });

		// Tick 2: polls are due; exports finish, files land in R2, the version is committed.
		advance(5 * 60_000);
		await tick();
		expect(statuses()['Thicker arms']).toBe('committed');
		expect(files()).toEqual([
			'.gitattributes',
			'Drone Frame/Arm.glb',
			'Drone Frame/Arm.step',
			'Drone Frame/Frame.glb',
			'Drone Frame/Frame.step',
			'Drone Frame/onshape.json',
		]);

		// Binaries are LFS pointers whose objects are in R2 and marked ready.
		const pointer = show('Drone Frame/Arm.glb');
		const oid = pointer.match(/oid sha256:(\w+)/)![1];
		expect(pointer).toMatch(/^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:\w{64}\nsize \d+\n$/);
		expect(new TextDecoder().decode(r2.get(`lfs/repo1/${oid}`))).toBe(`glTFglb:${versions[2].id}:${'e1'.padEnd(24, '0')}`);
		expect(db.prepare("SELECT COUNT(*) AS n FROM lfs_objects WHERE state = 'ready'").get()).toEqual({ n: 4 });
		expect(show('.gitattributes')).toContain('Drone[[:space:]]Frame/*.step filter=lfs diff=lfs merge=lfs -text');

		const log = git(bare, ['log', '--format=%an|%aI|%B', 'main']).toString();
		expect(log).toContain('Thomas|2026-11-03T10:00:00Z|Thicker arms');
		expect(log).toContain('Arms 4 → 6 mm');
		expect(log).toContain(`Onshape-Version: ${versions[2].id}`);
		expect(JSON.parse(show('Drone Frame/onshape.json')).version.name).toBe('Thicker arms');

		// Nothing new: the next check is a single cheap call (incremental, anchored on the last known version).
		const before = onshape.calls.length;
		advance(25 * 3600_000);
		await tick();
		expect(onshape.calls.slice(before)).toEqual([`GET /documents/d/${DID}/versions?offset=2&limit=20`]);

		// A new version: Arm deleted, Frame STEP fails.
		versions.push({
			id: 'v3'.padEnd(24, '0'),
			name: 'Unibody',
			createdAt: '2026-11-08T10:00:00Z',
			creator: { name: 'Thomas' },
			parent: 'v2',
			elements: [element('e2', 'Frame', 'ASSEMBLY')],
			failing: [`${'e2'.padEnd(24, '0')}:step`],
		});
		advance(25 * 3600_000);
		await tick();
		advance(5 * 60_000);
		await tick();
		expect(statuses().Unibody).toBe('committed');
		expect(files()).toEqual(['.gitattributes', 'Drone Frame/Frame.glb', 'Drone Frame/Frame.step', 'Drone Frame/onshape.json']);
		const manifest = JSON.parse(show('Drone Frame/onshape.json'));
		expect(manifest.elements[0].errors).toEqual([{ format: 'step', error: 'Part has no solid bodies' }]);
		expect(manifest.elements[0].files.find((f: { format: string }) => f.format === 'step').from_version).toBe(versions[2].id);
		const message = git(bare, ['log', '-1', '--format=%B', 'main']).toString();
		expect(message).toContain('Failed (previous file kept where there was one): Frame step: Part has no solid bodies');
		expect(git(bare, ['rev-list', '--count', 'main']).toString().trim()).toBe('2');
		git(bare, ['fsck', '--strict']);

		// Every 2xx/3xx Onshape call was counted.
		const counted = (db.prepare('SELECT api_calls FROM onshape_links').get() as { api_calls: number }).api_calls;
		expect(counted).toBe(onshape.calls.length);
	});

	it('backfills every version in order when asked', async () => {
		db.exec("UPDATE onshape_links SET backfill = 'all'");
		await tick();
		for (let i = 0; i < 4; i++) {
			advance(5 * 60_000);
			await tick();
		}
		expect(statuses()).toEqual({ Start: 'skipped', 'First cut': 'committed', 'Thicker arms': 'committed' });
		expect(git(bare, ['log', '--format=%s', 'main']).toString().trim().split('\n')).toEqual(['Thicker arms', 'First cut']);
	});

	it('records a bad key on the link without touching versions', async () => {
		db.prepare('UPDATE onshape_links SET access_key_encrypted = ?').run(await encryptSecret('WRONG', env.ENCRYPTION_KEY));
		await tick();
		const link = db.prepare('SELECT last_status, last_error, retry_after FROM onshape_links').get() as Record<string, string>;
		expect(link.last_status).toBe('error');
		expect(link.last_error).toContain('401');
		expect(Date.parse(link.retry_after) - now).toBe(3600_000);
		expect(db.prepare('SELECT COUNT(*) AS n FROM onshape_versions').get()).toEqual({ n: 0 });
	});

	it('does not export or push when the branch is protected', async () => {
		db.exec("INSERT INTO protected_branches (id, repo_id, branch_pattern, enforce_merge_queue) VALUES ('p1', 'repo1', 'main', 1)");
		await tick();
		const link = db.prepare('SELECT last_error, retry_after FROM onshape_links').get() as Record<string, string>;
		expect(link.last_error).toContain('protected');
		expect(Date.parse(link.retry_after) - now).toBe(3600_000);
		expect(db.prepare('SELECT COUNT(*) AS n FROM onshape_versions').get()).toEqual({ n: 0 });
		expect(onshape.calls).toEqual([]);
		expect(() => git(bare, ['rev-parse', '--verify', 'refs/heads/main'])).toThrow();
	});
});
