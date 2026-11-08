/**
 * Onshape → git sync. A repo linked to Onshape documents (onshape_links) gets
 * one commit per Onshape Version, holding every Part Studio and Assembly as
 * GLB / STEP / STL, stored as Git LFS objects in R2.
 *
 * Driven by the cron (every 5 min) and by "Sync now". Each tick works through
 * a small state machine per link, so nothing has to finish in one invocation:
 *
 *   1. discover  (when due: every `interval_minutes`)
 *                list the document's Versions; new ones → onshape_versions
 *                `pending`. Costs ~1 Onshape call per document.
 *   2. export    for up to IN_FLIGHT versions, oldest first:
 *                pending   → list elements, start one export per element×format
 *                exporting → poll exports that are due; download finished
 *                            files into R2 (lfs/<repo_id>/<sha256>) + lfs_objects
 *   3. commit    the OLDEST unfinished version, once all its exports settled:
 *                pointer files + onshape.json → new tree → commit → pushed to
 *                the link's branch on Artifacts (lib/git-objects.ts) under the
 *                repo's push lock. Commits therefore land in version order.
 *
 * A failed export does not block its version: the commit records the error in
 * onshape.json and the commit message. Errors that stop the whole version
 * (auth, elements lookup) retry on later ticks and give up after MAX_ATTEMPTS.
 *
 * Quota: Free/Standard Onshape plans allow 2,500 API calls a year. Discovery
 * is ~1 call per document per check; each export is start + polls + download.
 * Every call is counted into onshape_links.api_calls.
 */
import type { Env } from '../env.ts';
import { getArtifactsRemoteUrl } from './artifacts-url.ts';
import { audit } from './audit.ts';
import { decryptSecret } from './crypto.ts';
import {
	MODE_TREE,
	applyTreeChanges,
	buildReceivePackRequest,
	makeBlob,
	makeCommit,
	sha256Hex,
	type GitObject,
	type TreeChanges,
	type TreeEntry,
} from './git-objects.ts';
import { parseInfoRefs, parseReceivePackResponse } from './git-protocol.ts';
import { triggerGitHubMirror } from './github-mirror.ts';
import { buildLfsPointer, lfsObjectKey } from './lfs.ts';
import {
	OnshapeClient,
	OnshapeError,
	detectExtension,
	documentUrl,
	type ExportFormat,
	type OnshapeVersion,
} from './onshape.ts';
import { acquirePushLock, releasePushLock } from './push-lock.ts';
import { mintToken } from './runner-client.ts';

// ─── Tunables ───────────────────────────────────────────────────

/** Wall-clock budget for one tick (cron or "Sync now"). */
export const TICK_BUDGET_MS = 25_000;
/** Versions exporting at the same time per link. */
const IN_FLIGHT = 3;
/** Version-level retries (auth / lookup errors) before it is marked failed. */
const MAX_ATTEMPTS = 5;
/** An export still ACTIVE after this many polls is failed. */
const MAX_POLLS = 40;
/** Exports per version are capped to keep one version from eating the quota. */
const MAX_ELEMENTS = 30;
/** Largest file we will pull into memory and store. */
export const MAX_EXPORT_BYTES = 100 * 1024 * 1024;
/** Link lease: longer than a tick, so two ticks never work the same link. */
const LEASE_MS = 3 * 60_000;
const EXPORTABLE = new Set(['PARTSTUDIO', 'ASSEMBLY']);
export const LFS_PATTERNS = ['*.glb', '*.gltf', '*.step', '*.stl', '*.zip'];
export const MANIFEST_NAME = 'onshape.json';
const COMMITTER = { name: 'GitFlare Onshape Sync', email: 'onshape-sync@gitflare.invalid' };

// ─── Types ──────────────────────────────────────────────────────

export interface LinkedDocument {
	id: string;
	name: string;
}

export interface OnshapeLinkRow {
	id: string;
	repo_id: string;
	repo_name: string;
	base_url: string;
	access_key_encrypted: string;
	secret_key_encrypted: string;
	documents: string;
	branch: string;
	formats: string;
	interval_minutes: number;
	backfill: 'latest' | 'all';
	next_check_at: string | null;
}

interface VersionRow {
	id: string;
	document_id: string;
	version_id: string;
	version_name: string;
	version_description: string | null;
	version_created_at: string;
	creator_name: string | null;
	status: 'pending' | 'exporting';
	exports: string | null;
	attempts: number;
}

export interface ExportTask {
	elementId: string;
	elementName: string;
	elementType: string;
	format: ExportFormat;
	state: 'active' | 'done' | 'failed';
	translationId?: string;
	polls: number;
	/** Epoch ms. */
	nextPollAt: number;
	oid?: string;
	size?: number;
	ext?: string;
	error?: string;
}

interface ExportState {
	tasks: ExportTask[];
	/** Elements beyond MAX_ELEMENTS that were not exported. */
	skippedElements?: string[];
}

export interface ManifestFile {
	path: string;
	format: ExportFormat;
	size: number;
	oid: string;
}

export interface Manifest {
	document: { id: string; name: string; url: string };
	version: { id: string; name: string; description: string | null; created_at: string; creator: string | null; url: string };
	elements: {
		id: string;
		name: string;
		type: string;
		files: ManifestFile[];
		errors: { format: ExportFormat; error: string }[];
	}[];
	skipped_elements?: string[];
}

// ─── Pure helpers (exported for tests) ──────────────────────────

/** A file/folder name from an Onshape name: no slashes or control chars, never empty. */
export function safeName(name: string, fallback: string): string {
	const cleaned = name
		.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '')
		.slice(0, 100)
		.trim();
	return cleaned && cleaned !== '.git' ? cleaned : fallback;
}

/** Element id → base file name, unique within the document (duplicates get an id suffix). */
export function elementFileNames(elements: { id: string; name: string }[]): Map<string, string> {
	const counts = new Map<string, number>();
	for (const e of elements) {
		const n = safeName(e.name, e.id).toLowerCase();
		counts.set(n, (counts.get(n) ?? 0) + 1);
	}
	const names = new Map<string, string>();
	for (const e of elements) {
		const base = safeName(e.name, e.id);
		names.set(e.id, (counts.get(base.toLowerCase()) ?? 0) > 1 ? `${base} (${e.id.slice(0, 6)})` : base);
	}
	return names;
}

/** `.gitattributes` with our LFS patterns added (existing lines kept). */
export function ensureLfsAttributes(existing: string | null): string | null {
	const lines = (existing ?? '').split('\n');
	const tracked = new Set(
		lines
			.map((l) => l.trim().split(/\s+/))
			.filter((parts) => parts.includes('filter=lfs'))
			.map((parts) => parts[0])
	);
	const missing = LFS_PATTERNS.filter((p) => !tracked.has(p));
	if (missing.length === 0) return null;
	const base = (existing ?? '').replace(/\n*$/, '');
	const added = missing.map((p) => `${p} filter=lfs diff=lfs merge=lfs -text`).join('\n');
	return `${base ? `${base}\n` : ''}${added}\n`;
}

/**
 * Which listed versions are new. `known` are version ids already recorded,
 * in creation order. Onshape lists versions oldest first; the first entry of
 * an incremental page (offset = known − 1) must therefore be a known version,
 * otherwise the caller rescans everything.
 */
export function newVersions(listed: OnshapeVersion[], known: Set<string>): OnshapeVersion[] {
	return listed
		.filter((v) => !known.has(v.id))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Poll backoff: 4s, 8s, 16s … capped at 2 min. */
export function nextPollDelayMs(polls: number): number {
	return Math.min(120_000, 4_000 * 2 ** Math.min(polls, 5));
}

export function commitMessage(version: VersionRow, doc: LinkedDocument, manifest: Manifest, baseUrl: string): string {
	const lines = [version.version_name.trim() || 'Onshape version'];
	const description = version.version_description?.trim();
	if (description) lines.push('', description);

	const exported = manifest.elements
		.filter((e) => e.files.length > 0)
		.map((e) => `${e.name} (${e.files.map((f) => f.format).join(', ')})`);
	const failed = manifest.elements.flatMap((e) => e.errors.map((x) => `${e.name} ${x.format}: ${x.error}`));
	lines.push('', `Onshape document "${doc.name}"`);
	if (exported.length) lines.push(`Exported: ${exported.join('; ')}`);
	if (failed.length) lines.push(`Failed: ${failed.join('; ')}`);
	if (manifest.skipped_elements?.length) lines.push(`Not exported (over ${MAX_ELEMENTS} elements): ${manifest.skipped_elements.join(', ')}`);

	lines.push(
		'',
		`Onshape-Document: ${doc.id}`,
		`Onshape-Version: ${version.version_id}`,
		`Onshape-Url: ${documentUrl(baseUrl, doc.id, version.version_id)}`
	);
	return lines.join('\n');
}

// ─── Entry point ────────────────────────────────────────────────

/**
 * One sync tick over every enabled link (or just `linkId`). Never throws:
 * errors are recorded on the link / version rows.
 */
export async function runOnshapeSync(env: Env, opts: { linkId?: string; budgetMs?: number } = {}): Promise<void> {
	const deadline = Date.now() + (opts.budgetMs ?? TICK_BUDGET_MS);
	let links: OnshapeLinkRow[];
	try {
		const where = opts.linkId ? 'l.id = ?' : 'l.is_enabled = 1';
		const stmt = env.DB.prepare(
			`SELECT l.id, l.repo_id, r.name AS repo_name, l.base_url, l.access_key_encrypted, l.secret_key_encrypted,
			        l.documents, l.branch, l.formats, l.interval_minutes, l.backfill, l.next_check_at
			 FROM onshape_links l JOIN repositories r ON r.id = l.repo_id
			 WHERE ${where}
			 ORDER BY l.next_check_at IS NOT NULL, l.next_check_at`
		);
		links = (await (opts.linkId ? stmt.bind(opts.linkId) : stmt).all<OnshapeLinkRow>()).results ?? [];
	} catch (err) {
		// Table missing (migration not applied yet) or D1 hiccup: nothing to do this tick.
		console.error('[onshape] could not load links:', errorMessage(err));
		return;
	}

	for (const link of links) {
		if (Date.now() >= deadline - 2_000) break;
		if (!(await acquireLease(env, link.id))) continue;
		try {
			await syncLink(env, link, deadline);
		} catch (err) {
			console.error(`[onshape] sync of ${link.repo_name} crashed:`, err);
			await setLinkStatus(env, link.id, 'error', errorMessage(err)).catch(() => {});
		} finally {
			await env.DB.prepare('UPDATE onshape_links SET lease_until = NULL WHERE id = ?').bind(link.id).run().catch(() => {});
		}
	}
}

async function acquireLease(env: Env, linkId: string): Promise<boolean> {
	const now = new Date();
	const res = await env.DB.prepare(
		`UPDATE onshape_links SET lease_until = ?
		 WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)`
	)
		.bind(new Date(now.getTime() + LEASE_MS).toISOString(), linkId, now.toISOString())
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

async function setLinkStatus(env: Env, linkId: string, status: 'ok' | 'error', error: string | null): Promise<void> {
	await env.DB.prepare('UPDATE onshape_links SET last_status = ?, last_error = ?, updated_at = ? WHERE id = ?')
		.bind(status, error, new Date().toISOString(), linkId)
		.run();
}

async function syncLink(env: Env, link: OnshapeLinkRow, deadline: number): Promise<void> {
	let client: OnshapeClient;
	try {
		client = new OnshapeClient({
			baseUrl: link.base_url,
			accessKey: await decryptSecret(link.access_key_encrypted, env.ENCRYPTION_KEY, env.SESSION_SECRET),
			secretKey: await decryptSecret(link.secret_key_encrypted, env.ENCRYPTION_KEY, env.SESSION_SECRET),
		});
	} catch (err) {
		await setLinkStatus(env, link.id, 'error', `Could not decrypt the stored Onshape keys: ${errorMessage(err)}`);
		return;
	}

	const documents = parseJson<LinkedDocument[]>(link.documents, []);
	const formats = parseJson<ExportFormat[]>(link.formats, ['glb', 'step']);

	try {
		// ── 1. Discover ──
		const due = !link.next_check_at || Date.parse(link.next_check_at) <= Date.now();
		if (due) {
			let nextCheckMs = link.interval_minutes * 60_000;
			try {
				for (const doc of documents) await discover(env, client, link, doc);
				await setLinkStatus(env, link.id, 'ok', null);
			} catch (err) {
				await setLinkStatus(env, link.id, 'error', errorMessage(err));
				if (err instanceof OnshapeError && err.quotaExhausted) nextCheckMs = Math.max(nextCheckMs, 24 * 3600_000);
				else if (err instanceof OnshapeError && err.rateLimited) nextCheckMs = Math.max((err.retryAfter ?? 300) * 1000, 60_000);
				else nextCheckMs = Math.min(nextCheckMs, 3600_000); // other errors: try again within the hour
			}
			const now = new Date();
			await env.DB.prepare('UPDATE onshape_links SET last_check_at = ?, next_check_at = ? WHERE id = ?')
				.bind(now.toISOString(), new Date(now.getTime() + nextCheckMs).toISOString(), link.id)
				.run();
		}

		// ── 2 + 3. Export and commit, oldest first ──
		while (Date.now() < deadline - 2_000) {
			const { results: active } = await env.DB.prepare(
				`SELECT id, document_id, version_id, version_name, version_description, version_created_at, creator_name, status, exports, attempts
				 FROM onshape_versions WHERE link_id = ? AND status IN ('pending', 'exporting')
				 ORDER BY version_created_at, id LIMIT ?`
			)
				.bind(link.id, IN_FLIGHT)
				.all<VersionRow>();
			if (!active || active.length === 0) break;

			let progressed = false;
			for (const version of active) {
				if (Date.now() >= deadline - 2_000) break;
				progressed = (await advanceExports(env, client, link, version, formats)) || progressed;
			}

			const oldest = active[0];
			const fresh = await env.DB.prepare('SELECT status, exports, attempts FROM onshape_versions WHERE id = ?')
				.bind(oldest.id)
				.first<{ status: string; exports: string | null; attempts: number }>();
			if (fresh?.status === 'exporting') {
				const state = parseJson<ExportState>(fresh.exports, { tasks: [] });
				if (state.tasks.every((t) => t.state !== 'active')) {
					const doc = documents.find((d) => d.id === oldest.document_id) ?? { id: oldest.document_id, name: oldest.document_id };
					// Not committed (lock busy, Artifacts error): leave it for the next tick rather than spin.
					if (!(await commitVersion(env, link, { ...oldest, exports: fresh.exports, attempts: fresh.attempts }, doc, state))) break;
					progressed = true;
				}
			}

			if (!progressed) {
				// Everything is waiting on Onshape. Sleep until the next poll is due if it fits in this tick.
				const wait = await msUntilNextPoll(env, link.id);
				if (wait === null || Date.now() + wait >= deadline - 3_000) break;
				await sleep(Math.max(wait, 500));
			}
		}
	} finally {
		if (client.calls > 0) {
			await env.DB.prepare('UPDATE onshape_links SET api_calls = api_calls + ? WHERE id = ?').bind(client.calls, link.id).run();
		}
	}
}

// ─── Discovery ──────────────────────────────────────────────────

async function discover(env: Env, client: OnshapeClient, link: OnshapeLinkRow, doc: LinkedDocument): Promise<void> {
	const { results } = await env.DB.prepare(
		'SELECT version_id FROM onshape_versions WHERE link_id = ? AND document_id = ? ORDER BY version_created_at, id'
	)
		.bind(link.id, doc.id)
		.all<{ version_id: string }>();
	const knownIds = (results ?? []).map((r) => r.version_id);
	const known = new Set(knownIds);
	const firstSync = knownIds.length === 0;

	async function listFrom(offset: number): Promise<OnshapeVersion[]> {
		const all: OnshapeVersion[] = [];
		for (let page = 0; page < 50; page++) {
			const batch = await client.versions(doc.id, offset + all.length);
			all.push(...batch);
			if (batch.length < 20) break;
		}
		return all;
	}

	let listed: OnshapeVersion[];
	if (firstSync) {
		listed = await listFrom(0);
	} else {
		// Incremental: start at the last version we know as an anchor.
		listed = await listFrom(knownIds.length - 1);
		if (listed.length === 0 || !known.has(listed[0].id)) listed = await listFrom(0);
	}

	const fresh = newVersions(listed, known);
	if (fresh.length === 0) return;

	const latest = fresh[fresh.length - 1];
	const stmts = fresh.map((v) => {
		// The empty "Start" version every document begins with has nothing to export.
		const isStart = !(v as { parent?: string | null }).parent && v.name === 'Start';
		const skip = isStart || (firstSync && link.backfill === 'latest' && v.id !== latest.id);
		return env.DB.prepare(
			`INSERT OR IGNORE INTO onshape_versions
			   (id, link_id, repo_id, document_id, version_id, version_name, version_description, version_created_at, creator_name, status)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).bind(
			crypto.randomUUID(),
			link.id,
			link.repo_id,
			doc.id,
			v.id,
			v.name ?? 'Untitled version',
			v.description ?? null,
			v.createdAt,
			v.creator?.name ?? null,
			skip ? 'skipped' : 'pending'
		);
	});
	await env.DB.batch(stmts);
}

// ─── Exports ────────────────────────────────────────────────────

/** Returns true if anything changed. */
async function advanceExports(env: Env, client: OnshapeClient, link: OnshapeLinkRow, version: VersionRow, formats: ExportFormat[]): Promise<boolean> {
	const now = Date.now();
	try {
		if (version.status === 'pending') {
			const elements = (await client.elements(version.document_id, version.version_id)).filter((e) => EXPORTABLE.has(e.elementType));
			const state: ExportState = { tasks: [] };
			if (elements.length > MAX_ELEMENTS) state.skippedElements = elements.slice(MAX_ELEMENTS).map((e) => e.name);
			for (const element of elements.slice(0, MAX_ELEMENTS)) {
				for (const format of formats) {
					const task: ExportTask = {
						elementId: element.id,
						elementName: element.name,
						elementType: element.elementType,
						format,
						state: 'active',
						polls: 0,
						nextPollAt: now + nextPollDelayMs(0),
					};
					try {
						const t = await client.startExport(version.document_id, version.version_id, element, format);
						task.translationId = t.id;
						if (!t.id) Object.assign(task, { state: 'failed', error: 'Onshape did not return an export id' });
						else if (t.requestState === 'FAILED') Object.assign(task, { state: 'failed', error: t.failureReason || 'Export failed' });
					} catch (err) {
						if (err instanceof OnshapeError && (err.unauthorized || err.quotaExhausted || err.rateLimited)) throw err;
						Object.assign(task, { state: 'failed', error: errorMessage(err) });
					}
					state.tasks.push(task);
				}
			}
			await saveExports(env, version.id, 'exporting', state);
			return true;
		}

		// exporting: poll what is due, download what finished.
		const state = parseJson<ExportState>(version.exports, { tasks: [] });
		let changed = false;
		for (const task of state.tasks) {
			if (task.state !== 'active' || task.nextPollAt > Date.now() || !task.translationId) continue;
			const t = await client.translation(task.translationId);
			task.polls++;
			changed = true;
			if (t.requestState === 'ACTIVE') {
				if (task.polls >= MAX_POLLS) Object.assign(task, { state: 'failed', error: 'Export did not finish in time' });
				else task.nextPollAt = Date.now() + nextPollDelayMs(task.polls);
			} else if (t.requestState === 'FAILED') {
				Object.assign(task, { state: 'failed', error: t.failureReason || 'Export failed' });
			} else {
				const fileId = t.resultExternalDataIds?.[0];
				if (!fileId) {
					Object.assign(task, { state: 'failed', error: 'Export finished without a file' });
				} else {
					try {
						const bytes = await client.download(version.document_id, fileId);
						if (bytes.length > MAX_EXPORT_BYTES) throw new Error(`file is ${bytes.length} bytes, over the ${MAX_EXPORT_BYTES}-byte limit`);
						const oid = await storeLfsObject(env, link.repo_id, bytes);
						Object.assign(task, { state: 'done', oid, size: bytes.length, ext: detectExtension(task.format, bytes) });
					} catch (err) {
						if (err instanceof OnshapeError && (err.unauthorized || err.quotaExhausted || err.rateLimited)) throw err;
						Object.assign(task, { state: 'failed', error: `Download failed: ${errorMessage(err)}` });
					}
				}
			}
			await saveExports(env, version.id, 'exporting', state); // persist each step: downloads are expensive
		}
		return changed;
	} catch (err) {
		// Quota / rate limits are the account's state, not this version's fault: they don't use up attempts.
		const transient = err instanceof OnshapeError && (err.quotaExhausted || err.rateLimited);
		const attempts = version.attempts + (transient ? 0 : 1);
		const giveUp = attempts >= MAX_ATTEMPTS;
		await env.DB.prepare('UPDATE onshape_versions SET attempts = ?, error = ?, status = ?, updated_at = ? WHERE id = ?')
			.bind(attempts, errorMessage(err), giveUp ? 'failed' : version.status, new Date().toISOString(), version.id)
			.run();
		await setLinkStatus(env, link.id, 'error', `${version.version_name}: ${errorMessage(err)}`);
		if (err instanceof OnshapeError && (err.unauthorized || err.quotaExhausted || err.rateLimited)) throw err;
		return giveUp;
	}
}

async function saveExports(env: Env, versionId: string, status: string, state: ExportState): Promise<void> {
	await env.DB.prepare('UPDATE onshape_versions SET status = ?, exports = ?, updated_at = ? WHERE id = ?')
		.bind(status, JSON.stringify(state), new Date().toISOString(), versionId)
		.run();
}

async function msUntilNextPoll(env: Env, linkId: string): Promise<number | null> {
	const { results } = await env.DB.prepare("SELECT exports FROM onshape_versions WHERE link_id = ? AND status = 'exporting'")
		.bind(linkId)
		.all<{ exports: string | null }>();
	let next = Infinity;
	for (const row of results ?? []) {
		for (const t of parseJson<ExportState>(row.exports, { tasks: [] }).tasks) if (t.state === 'active') next = Math.min(next, t.nextPollAt);
	}
	return next === Infinity ? null : Math.max(0, next - Date.now());
}

/** Put the bytes in R2 under the LFS layout and mark the object ready. Returns the sha256 oid. */
export async function storeLfsObject(env: Pick<Env, 'STORAGE' | 'DB'>, repoId: string, bytes: Uint8Array): Promise<string> {
	const oid = await sha256Hex(bytes);
	const key = lfsObjectKey(repoId, oid);
	if (!(await env.STORAGE.head(key))) {
		await env.STORAGE.put(key, bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
	}
	await env.DB.prepare(
		`INSERT INTO lfs_objects (repo_id, oid, size, state) VALUES (?, ?, ?, 'ready')
		 ON CONFLICT(repo_id, oid) DO UPDATE SET state = 'ready'`
	)
		.bind(repoId, oid, bytes.length)
		.run();
	return oid;
}

// ─── Commit ─────────────────────────────────────────────────────

export function buildManifest(link: Pick<OnshapeLinkRow, 'base_url'>, doc: LinkedDocument, version: VersionRow, state: ExportState): Manifest {
	const elements = new Map<string, Manifest['elements'][number]>();
	const names = elementFileNames(
		[...new Map(state.tasks.map((t) => [t.elementId, { id: t.elementId, name: t.elementName }])).values()]
	);
	for (const t of state.tasks) {
		let e = elements.get(t.elementId);
		if (!e) elements.set(t.elementId, (e = { id: t.elementId, name: t.elementName, type: t.elementType, files: [], errors: [] }));
		if (t.state === 'done' && t.oid && t.ext && t.size !== undefined) {
			e.files.push({ path: `${names.get(t.elementId)}.${t.ext}`, format: t.format, size: t.size, oid: t.oid });
		} else {
			e.errors.push({ format: t.format, error: t.error ?? 'Export failed' });
		}
	}
	return {
		document: { id: doc.id, name: doc.name, url: documentUrl(link.base_url, doc.id) },
		version: {
			id: version.version_id,
			name: version.version_name,
			description: version.version_description,
			created_at: version.version_created_at,
			creator: version.creator_name,
			url: documentUrl(link.base_url, doc.id, version.version_id),
		},
		elements: [...elements.values()],
		...(state.skippedElements?.length ? { skipped_elements: state.skippedElements } : {}),
	};
}

/** Returns true once the version is committed; false = try again on a later tick. */
async function commitVersion(env: Env, link: OnshapeLinkRow, version: VersionRow, doc: LinkedDocument, state: ExportState): Promise<boolean> {
	const refName = `refs/heads/${link.branch}`;
	const lock = await acquirePushLock(env, link.repo_id, 'onshape-sync', [refName]);
	if ('error' in lock) return false; // someone is pushing; next tick

	try {
		const artifact = await env.REPOS.get(link.repo_name);
		if (!artifact) throw new Error(`Repository ${link.repo_name} not found in Artifacts`);
		const remote = getArtifactsRemoteUrl(env, link.repo_name);
		const token = await mintToken(env, link.repo_name, 'write', 300);

		// Current branch tip, straight from Artifacts.
		const refsRes = await fetch(`${remote}/info/refs?service=git-receive-pack`, { headers: { Authorization: `Bearer ${token}` } });
		if (!refsRes.ok) throw new Error(`Artifacts info/refs failed: HTTP ${refsRes.status}`);
		const head = parseInfoRefs(await refsRes.arrayBuffer()).refs.get(refName) ?? null;
		const parentTree = head ? (await artifact.readCommit(head))?.treeHash ?? null : null;
		if (head && !parentTree) throw new Error(`Could not read commit ${head}`);

		const readFile = async (path: string): Promise<string | null> => {
			if (!head) return null;
			const blob = await artifact.readFile({ ref: head, path }).catch(() => null);
			return blob ? await blob.text() : null;
		};

		const docDir = safeName(doc.name, doc.id);
		const manifest = buildManifest(link, doc, version, state);
		const objects: GitObject[] = [];
		const changes: TreeChanges = new Map();
		const put = async (path: string, content: string) => {
			const blob = await makeBlob(content);
			objects.push(blob);
			changes.set(path, { sha: blob.sha });
		};

		// Files from this version's exports (LFS pointers)…
		const newPaths = new Set<string>();
		for (const e of manifest.elements) {
			for (const f of e.files) {
				const path = `${docDir}/${f.path}`;
				newPaths.add(path);
				await put(path, buildLfsPointer(f.oid, f.size));
			}
		}
		// …and drop the previous version's files that this version no longer has.
		const previous = parseJson<Manifest | null>(await readFile(`${docDir}/${MANIFEST_NAME}`), null);
		for (const e of previous?.elements ?? []) {
			for (const f of e.files ?? []) {
				const path = `${docDir}/${f.path}`;
				if (!newPaths.has(path)) changes.set(path, null);
			}
		}
		await put(`${docDir}/${MANIFEST_NAME}`, `${JSON.stringify(manifest, null, 2)}\n`);
		const attributes = ensureLfsAttributes(await readFile('.gitattributes'));
		if (attributes !== null) await put('.gitattributes', attributes);

		const readTree = async (sha: string): Promise<TreeEntry[]> =>
			((await artifact.readTree(sha)) ?? []).map((e) => ({
				name: e.name,
				sha: e.hash,
				mode: e.type === 'tree' ? MODE_TREE : normalizeMode(e.mode, e.type),
			}));
		const tree = await applyTreeChanges(readTree, parentTree, changes);
		objects.push(...tree.objects);

		const createdAt = Date.parse(version.version_created_at) || Date.now();
		const commit = await makeCommit({
			tree: tree.sha,
			parents: head ? [head] : [],
			author: { name: version.creator_name || 'Onshape', email: 'onshape@users.gitflare.invalid', when: createdAt },
			committer: { ...COMMITTER, when: Date.now() },
			message: commitMessage(version, doc, manifest, link.base_url),
		});
		objects.push(commit);

		const body = await buildReceivePackRequest({ refName, oldSha: head, newSha: commit.sha, objects });
		const pushRes = await fetch(`${remote}/git-receive-pack`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/x-git-receive-pack-request',
				Accept: 'application/x-git-receive-pack-result',
			},
			body,
		});
		const report = parseReceivePackResponse(new Uint8Array(await pushRes.arrayBuffer()));
		if (!pushRes.ok) throw new Error(`Artifacts receive-pack failed: HTTP ${pushRes.status}`);
		if (!report?.unpackOk) throw new Error(`Artifacts could not unpack the commit: ${report?.unpackError ?? 'no report-status'}`);
		const result = report.refResults.find((r) => r.refName === refName);
		if (!result?.success) throw new Error(`Artifacts rejected ${refName}: ${result?.error ?? 'unknown'}`);

		await env.DB.prepare("UPDATE onshape_versions SET status = 'committed', commit_sha = ?, error = NULL, updated_at = ? WHERE id = ?")
			.bind(commit.sha, new Date().toISOString(), version.id)
			.run();
		await audit(env.DB, {
			repoId: link.repo_id,
			actor: 'onshape-sync',
			action: 'onshape.commit',
			details: { branch: link.branch, commit: commit.sha, document: doc.id, version: version.version_id, name: version.version_name },
		}).catch(() => {});
		await triggerGitHubMirror(env, link.repo_id, link.repo_name, [link.branch]);
		return true;
	} catch (err) {
		const attempts = version.attempts + 1;
		await env.DB.prepare('UPDATE onshape_versions SET attempts = ?, error = ?, status = ?, updated_at = ? WHERE id = ?')
			.bind(attempts, `Commit failed: ${errorMessage(err)}`, attempts >= MAX_ATTEMPTS ? 'failed' : 'exporting', new Date().toISOString(), version.id)
			.run();
		await setLinkStatus(env, link.id, 'error', `${version.version_name}: commit failed: ${errorMessage(err)}`);
		return false;
	} finally {
		await releasePushLock(env, link.repo_id, lock.lockId);
	}
}

function normalizeMode(mode: string, type: string): string {
	const m = String(mode).replace(/^0+/, '');
	if (/^1[0-7]{5}$/.test(m) || m === '160000') return m;
	if (type === 'exec') return '100755';
	if (type === 'symlink') return '120000';
	if (type === 'gitlink') return '160000';
	return '100644';
}

// ─── Misc ───────────────────────────────────────────────────────

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
