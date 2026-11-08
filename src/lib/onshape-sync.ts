/**
 * Onshape → git sync. A repo linked to Onshape documents (onshape_links) gets
 * one commit per Onshape Version, holding every Part Studio and Assembly as
 * GLB / STEP / STL, stored as Git LFS objects in R2.
 *
 * New Versions are pulled in two ways only, to save Onshape API calls:
 *   - once a day, by the cron (CHECK_INTERVAL_MS after the last check)
 *   - "Pull latest" in the dashboard (POST /api/repos/:repo/onshape/sync)
 * The cron runs every 5 min, but between daily checks it only moves along
 * exports already started; it calls Onshape only while a version is exporting.
 * Each tick works through a small state machine per link, so nothing has to
 * finish in one invocation:
 *
 *   1. discover  (once a day, or on "Pull latest")
 *                list each document's Versions; new ones → onshape_versions
 *                `pending`. Costs ~1 Onshape call per document.
 *   2. export    for up to IN_FLIGHT versions, oldest first:
 *                pending   → list elements, queue one export per element×format
 *                exporting → start queued exports, poll the ones that are due,
 *                            download finished files into R2
 *                            (lfs/<repo_id>/<sha256>) + lfs_objects
 *                Every step is saved as it happens, so a tick that dies (CPU,
 *                memory, deploy) never repeats paid Onshape calls.
 *   3. commit    the OLDEST unfinished version, once all its exports settled:
 *                pointer files + onshape.json → new tree → commit → pushed to
 *                the link's branch on Artifacts (lib/git-objects.ts) under the
 *                repo's push lock. Commits therefore land in version order.
 *
 * Errors, by owner:
 *   - account (401/403 keys, 402 quota, 429 rate limit) → the whole link backs
 *     off (`retry_after`); no version loses attempts.
 *   - one export (5xx, network, translation FAILED) → that export backs off and
 *     fails after MAX_TASK_ERRORS; the version still commits, with the error in
 *     onshape.json and the commit message, and keeps the previous file.
 *   - one version (elements lookup, commit) → at most one attempt per tick;
 *     failed after MAX_ATTEMPTS. Later versions continue.
 *
 * Quota: Free/Standard Onshape plans allow 2,500 API calls a year. Discovery
 * is ~1 call per document per check; each export is start + polls + download.
 * Every call is counted into onshape_links.api_calls.
 */
import type { Env } from '../env.ts';
import { getArtifactsRemoteUrl } from './artifacts-url.ts';
import { audit } from './audit.ts';
import { matchesBranchFilter } from './branch-pattern.ts';
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
import { streamLfsObject } from './lfs-stream.ts';
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

/** Time between automatic checks for new Versions. "Pull latest" checks in between. */
export const CHECK_INTERVAL_MS = 24 * 3600_000;
/** Wall-clock budget for one tick (cron or "Pull latest"). */
export const TICK_BUDGET_MS = 25_000;
/** Versions exporting at the same time per link. */
const IN_FLIGHT = 3;
/** Version-level retries (elements lookup / commit errors) before it is marked failed. */
const MAX_ATTEMPTS = 5;
/** An export still ACTIVE after this many polls is failed. */
const MAX_POLLS = 40;
/** Transient errors (5xx, network) one export may hit before it is failed. */
const MAX_TASK_ERRORS = 5;
/** Download attempts per export: each is counted before it starts, so a download that kills the isolate still ends. */
const MAX_DOWNLOADS = 3;
/** Exports per version are capped to keep one version from eating the quota. */
const MAX_ELEMENTS = 30;
/**
 * Largest export we store. Downloads with a Content-Length stream into R2
 * (lib/lfs-stream.ts), so this is set by time and R2's ~5 GB upload cap, not
 * by the Worker's 128 MB of memory.
 */
export const MAX_EXPORT_BYTES = 2 * 1024 * 1024 * 1024;
/** A download without a Content-Length is held in memory, so it stays well under 128 MB. */
export const MAX_IN_MEMORY_BYTES = 40 * 1024 * 1024;
/**
 * Downloads over this wait for the cron (15 min per run). "Pull latest" runs
 * in waitUntil, which Cloudflare stops 30 s after the response.
 */
const MAX_FOREGROUND_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/**
 * Link lease: longer than any tick, including a cron run spent on a 2 GB
 * download (15 min max), so two ticks never work the same link.
 */
const LEASE_MS = 16 * 60_000;
/** Back-off for the whole link after an account-level error. */
const AUTH_BACKOFF_MS = 3600_000;
const QUOTA_BACKOFF_MS = 24 * 3600_000;
const EXPORTABLE = new Set(['PARTSTUDIO', 'ASSEMBLY']);
const LFS_EXTENSIONS = ['glb', 'gltf', 'step', 'stl', 'zip'];
export const MANIFEST_NAME = 'onshape.json';
const COMMITTER = { name: 'GitFlare Onshape Sync', email: 'onshape-sync@gitflare.invalid' };

// ─── Types ──────────────────────────────────────────────────────

export interface LinkedDocument {
	id: string;
	name: string;
	/** Folder in the repo; unique per link (set when the document is linked). */
	folder?: string;
}

export interface OnshapeLinkRow {
	id: string;
	repo_id: string;
	repo_name: string;
	default_branch: string | null;
	base_url: string;
	access_key_encrypted: string;
	secret_key_encrypted: string;
	documents: string;
	branch: string;
	formats: string;
	backfill: 'latest' | 'all';
	next_check_at: string | null;
	retry_after: string | null;
	lfs_enabled?: number;
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
	/** queued: not started yet · active: running in Onshape · done / failed: settled */
	state: 'queued' | 'active' | 'done' | 'failed';
	translationId?: string;
	polls: number;
	/** Epoch ms: when to start (queued) or poll (active) next. */
	nextPollAt: number;
	/** Transient errors so far. */
	errors?: number;
	/** Download attempts so far. */
	downloads?: number;
	oid?: string;
	size?: number;
	ext?: string;
	error?: string;
}

export interface ExportState {
	tasks: ExportTask[];
	/** Elements beyond MAX_ELEMENTS that were not exported. */
	skippedElements?: string[];
}

export interface ManifestFile {
	path: string;
	format: ExportFormat;
	size: number;
	oid: string;
	/** Set when this version's export failed and the file is carried over from an earlier version. */
	from_version?: string;
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

/** An error that is about the Onshape account, not one version: the link backs off. */
function isAccountError(err: unknown): err is OnshapeError {
	return err instanceof OnshapeError && (err.unauthorized || err.quotaExhausted || err.rateLimited);
}

function accountBackoffMs(err: OnshapeError): number {
	if (err.quotaExhausted) return QUOTA_BACKOFF_MS;
	if (err.rateLimited) return Math.max((err.retryAfter ?? 300) * 1000, 60_000);
	return AUTH_BACKOFF_MS;
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

/**
 * Folder per document, unique within the link (case-insensitive). Documents
 * that already have a folder keep it — it is where their history lives.
 */
export function assignFolders(docs: LinkedDocument[]): LinkedDocument[] {
	const used = new Set(docs.filter((d) => d.folder).map((d) => d.folder!.toLowerCase()));
	return docs.map((d) => {
		if (d.folder) return d;
		let folder = safeName(d.name, d.id);
		if (used.has(folder.toLowerCase())) folder = `${folder} (${d.id.slice(0, 6)})`;
		used.add(folder.toLowerCase());
		return { ...d, folder };
	});
}

export function documentFolder(doc: LinkedDocument): string {
	return doc.folder ?? safeName(doc.name, doc.id);
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

/** A path as a literal .gitattributes pattern (git lfs track writes spaces as [[:space:]]). */
export function gitattributesPattern(path: string): string {
	return path
		.replace(/[\\[\]*?]/g, (c) => `\\${c}`)
		.replace(/\s/g, '[[:space:]]')
		.replace(/^([#!])/, '\\$1');
}

/**
 * `.gitattributes` with LFS patterns for one synced folder added (existing
 * lines kept). Scoped to the folder so files elsewhere on the branch are
 * never re-classified. Returns null when nothing is missing.
 */
export function ensureLfsAttributes(existing: string | null, folder: string): string | null {
	const tracked = new Set(
		(existing ?? '')
			.split('\n')
			.map((l) => l.trim().split(/\s+/))
			.filter((parts) => parts.includes('filter=lfs'))
			.map((parts) => parts[0])
	);
	const prefix = gitattributesPattern(folder);
	const missing = LFS_EXTENSIONS.map((ext) => `${prefix}/*.${ext}`).filter((p) => !tracked.has(p));
	if (missing.length === 0) return null;
	const base = (existing ?? '').replace(/\n*$/, '');
	const added = missing.map((p) => `${p} filter=lfs diff=lfs merge=lfs -text`).join('\n');
	return `${base ? `${base}\n` : ''}${added}\n`;
}

/**
 * Which listed versions are new. `known` are version ids already recorded.
 * Onshape lists versions oldest first; the first entry of an incremental page
 * (offset = known − 1) must therefore be a known version, otherwise the
 * caller rescans everything.
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

/** Back-off after a transient error on one export: 1, 2, 4, 8 … min, capped at 30. */
function errorDelayMs(errors: number): number {
	return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, errors - 1));
}

export function commitMessage(version: VersionRow, doc: LinkedDocument, manifest: Manifest, baseUrl: string): string {
	const lines = [version.version_name.trim() || 'Onshape version'];
	const description = version.version_description?.trim();
	if (description) lines.push('', description);

	const exported = manifest.elements
		.map((e) => ({ name: e.name, fresh: e.files.filter((f) => !f.from_version) }))
		.filter((e) => e.fresh.length > 0)
		.map((e) => `${e.name} (${e.fresh.map((f) => f.format).join(', ')})`);
	const failed = manifest.elements.flatMap((e) => e.errors.map((x) => `${e.name} ${x.format}: ${x.error}`));
	lines.push('', `Onshape document "${doc.name}"`);
	if (exported.length) lines.push(`Exported: ${exported.join('; ')}`);
	if (failed.length) lines.push(`Failed (previous file kept where there was one): ${failed.join('; ')}`);
	if (manifest.skipped_elements?.length) lines.push(`Not exported (over ${MAX_ELEMENTS} elements): ${manifest.skipped_elements.join(', ')}`);

	lines.push(
		'',
		`Onshape-Document: ${doc.id}`,
		`Onshape-Version: ${version.version_id}`,
		`Onshape-Url: ${documentUrl(baseUrl, doc.id, version.version_id)}`
	);
	return lines.join('\n');
}

/**
 * The manifest for this version. Exports that failed keep the previous
 * version's file for the same element and format (marked `from_version`),
 * so a flaky export never deletes geometry from the branch.
 */
export function buildManifest(
	link: Pick<OnshapeLinkRow, 'base_url'>,
	doc: LinkedDocument,
	version: Pick<VersionRow, 'version_id' | 'version_name' | 'version_description' | 'version_created_at' | 'creator_name'>,
	state: ExportState,
	previous: Manifest | null
): Manifest {
	const elements = new Map<string, Manifest['elements'][number]>();
	const names = elementFileNames([...new Map(state.tasks.map((t) => [t.elementId, { id: t.elementId, name: t.elementName }])).values()]);
	const previousFiles = new Map<string, ManifestFile>();
	for (const e of previous?.elements ?? []) for (const f of e.files ?? []) previousFiles.set(`${e.id}:${f.format}`, { ...f, from_version: f.from_version ?? previous!.version.id });

	for (const t of state.tasks) {
		let e = elements.get(t.elementId);
		if (!e) elements.set(t.elementId, (e = { id: t.elementId, name: t.elementName, type: t.elementType, files: [], errors: [] }));
		if (t.state === 'done' && t.oid && t.ext && t.size !== undefined) {
			e.files.push({ path: `${names.get(t.elementId)}.${t.ext}`, format: t.format, size: t.size, oid: t.oid });
		} else {
			e.errors.push({ format: t.format, error: t.error ?? 'Export failed' });
			const carried = previousFiles.get(`${t.elementId}:${t.format}`);
			if (carried) e.files.push(carried);
		}
	}
	// Two elements must never claim the same path (a carried file vs a renamed element).
	const seen = new Set<string>();
	for (const e of elements.values()) {
		e.files = e.files.filter((f) => {
			const key = f.path.toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
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

/**
 * Would a protection rule refuse this push? The Worker writes straight to
 * Artifacts, so it applies the same rule as git.ts itself: a branch matched by
 * an `enforce_merge_queue` rule only accepts its very first commit when it is
 * the repo's default branch.
 */
export async function branchIsProtected(
	db: Pick<D1Database, 'prepare'>,
	repoId: string,
	branch: string,
	opts: { isCreate: boolean; defaultBranch: string }
): Promise<boolean> {
	const { results } = await db
		.prepare('SELECT branch_pattern, enforce_merge_queue FROM protected_branches WHERE repo_id = ?')
		.bind(repoId)
		.all<{ branch_pattern: string; enforce_merge_queue: number }>();
	for (const rule of results ?? []) {
		if (!matchesBranchFilter([rule.branch_pattern], branch) || !rule.enforce_merge_queue) continue;
		if (opts.isCreate && branch === opts.defaultBranch) continue;
		return true;
	}
	return false;
}

// ─── Entry point ────────────────────────────────────────────────

/**
 * One sync tick over every enabled link (or just `linkId`, for "Pull latest").
 * Never throws: errors are recorded on the link / version rows.
 */
export async function runOnshapeSync(env: Env, opts: { linkId?: string; budgetMs?: number } = {}): Promise<void> {
	const deadline = Date.now() + (opts.budgetMs ?? TICK_BUDGET_MS);
	let links: OnshapeLinkRow[];
	try {
		const where = opts.linkId ? 'l.id = ? AND l.is_enabled = 1' : 'l.is_enabled = 1';
		const stmt = env.DB.prepare(
			`SELECT l.id, l.repo_id, r.name AS repo_name, r.default_branch, l.base_url, l.access_key_encrypted, l.secret_key_encrypted,
			        l.documents, l.branch, l.formats, l.backfill, l.next_check_at, l.retry_after, r.lfs_enabled
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

	for (let i = 0; i < links.length; i++) {
		const now = Date.now();
		if (now >= deadline - 2_000) break;
		const link = links[i];
		// Share what is left of the tick between the remaining links.
		const linkDeadline = now + (deadline - now) / (links.length - i);
		const lease = await acquireLease(env, link.id);
		if (!lease) continue;
		try {
			// linkId: "Pull latest" / save / retry, running in waitUntil (30 s). Otherwise the cron.
			await syncLink(env, link, linkDeadline, { mayWait: Boolean(opts.linkId), cron: !opts.linkId });
		} catch (err) {
			console.error(`[onshape] sync of ${link.repo_name} crashed:`, err);
			await setLinkStatus(env, link.id, 'error', errorMessage(err)).catch(() => {});
		} finally {
			// Only our own lease: a tick that outlived it must not free a newer tick's lease.
			await env.DB.prepare('UPDATE onshape_links SET lease_until = NULL WHERE id = ? AND lease_until = ?').bind(link.id, lease).run().catch(() => {});
		}
	}
}

/** Returns the lease token, or null if another tick holds the link. */
async function acquireLease(env: Env, linkId: string): Promise<string | null> {
	const now = new Date();
	// `<expiry ISO>#<uuid>` still compares by expiry as a string, and is unique per tick.
	const token = `${new Date(now.getTime() + LEASE_MS).toISOString()}#${crypto.randomUUID()}`;
	const res = await env.DB.prepare(
		`UPDATE onshape_links SET lease_until = ?
		 WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)`
	)
		.bind(token, linkId, now.toISOString())
		.run();
	return (res.meta?.changes ?? 0) > 0 ? token : null;
}

async function setLinkStatus(env: Env, linkId: string, status: 'ok' | 'error', error: string | null): Promise<void> {
	await env.DB.prepare('UPDATE onshape_links SET last_status = ?, last_error = ?, updated_at = ? WHERE id = ?')
		.bind(status, error, new Date().toISOString(), linkId)
		.run();
}

/** Account-level error: record it and pause the whole link until it can be retried. */
async function backOffLink(env: Env, linkId: string, err: unknown, ms: number): Promise<void> {
	await env.DB.prepare('UPDATE onshape_links SET last_status = ?, last_error = ?, retry_after = ?, updated_at = ? WHERE id = ?')
		.bind('error', errorMessage(err), new Date(Date.now() + ms).toISOString(), new Date().toISOString(), linkId)
		.run();
}

async function syncLink(env: Env, link: OnshapeLinkRow, deadline: number, opts: { mayWait: boolean; cron: boolean }): Promise<void> {
	if (link.retry_after && Date.parse(link.retry_after) > Date.now()) return;
	// A protected branch accepts at most its first commit. The sync writes many,
	// so it stays off those branches entirely — including before any export starts.
	if (await branchIsProtected(env.DB, link.repo_id, link.branch, { isCreate: false, defaultBranch: link.default_branch || 'main' })) {
		await backOffLink(
			env,
			link.id,
			`Branch "${link.branch}" is protected (merge queue only). Pick another branch in the Onshape settings or remove the protection rule.`,
			AUTH_BACKOFF_MS
		);
		return;
	}
	if (link.lfs_enabled === 0) {
		await setLinkStatus(env, link.id, 'error', 'Git LFS is turned off for this repository; the Onshape sync stores its files in LFS');
		return;
	}
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

	const documents = assignFolders(parseJson<LinkedDocument[]>(link.documents, []));
	const formats = parseJson<ExportFormat[]>(link.formats, ['glb', 'step']);

	try {
		// ── 1. Discover ──
		const due = !link.next_check_at || Date.parse(link.next_check_at) <= Date.now();
		if (due) {
			const docErrors: string[] = [];
			for (const doc of documents) {
				try {
					await discover(env, client, link, doc);
				} catch (err) {
					if (isAccountError(err)) throw err;
					// One deleted or unshared document must not stop the others.
					docErrors.push(`${doc.name}: ${errorMessage(err)}`);
				}
			}
			const now = new Date();
			// Next automatic check in a day, errors or not: "Pull latest" retries sooner.
			const nextMs = CHECK_INTERVAL_MS;
			await env.DB.prepare('UPDATE onshape_links SET last_check_at = ?, next_check_at = ? WHERE id = ?')
				.bind(now.toISOString(), new Date(now.getTime() + nextMs).toISOString(), link.id)
				.run();
			await setLinkStatus(env, link.id, docErrors.length ? 'error' : 'ok', docErrors.length ? docErrors.join(' · ') : null);
		}

		// ── 2 + 3. Export and commit, oldest first ──
		const triedThisTick = new Set<string>(); // versions that hit a version-level error: once per tick
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
				if (triedThisTick.has(version.id)) continue;
				const outcome = await advanceVersion(env, client, link, version, formats, deadline, opts.cron);
				if (outcome === 'error') triedThisTick.add(version.id);
				progressed = progressed || outcome === 'progress';
			}

			const oldest = active[0];
			if (!triedThisTick.has(oldest.id)) {
				const fresh = await env.DB.prepare('SELECT status, exports, attempts FROM onshape_versions WHERE id = ?')
					.bind(oldest.id)
					.first<{ status: string; exports: string | null; attempts: number }>();
				if (fresh?.status === 'exporting') {
					const state = parseJson<ExportState>(fresh.exports, { tasks: [] });
					if (state.tasks.every((t) => t.state === 'done' || t.state === 'failed')) {
						const doc = documents.find((d) => d.id === oldest.document_id) ?? { id: oldest.document_id, name: oldest.document_id };
						const result = await commitVersion(env, link, { ...oldest, exports: fresh.exports, attempts: fresh.attempts }, doc, state);
						if (result === 'blocked') break; // lock busy / branch protected: next tick
						if (result === 'error') triedThisTick.add(oldest.id);
						else progressed = true;
					}
				}
			}

			if (!progressed) {
				// Only "Pull latest" waits for Onshape inside the tick; the cron moves on to other links.
				if (!opts.mayWait) break;
				const wait = await msUntilNextStep(env, link.id);
				if (wait === null || Date.now() + wait >= deadline - 3_000) break;
				await sleep(Math.max(wait, 500));
			}
		}
	} catch (err) {
		if (!isAccountError(err)) throw err;
		await backOffLink(env, link.id, err, accountBackoffMs(err));
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
		// Incremental: start at the last version we know, as an anchor.
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

type StepOutcome = 'progress' | 'idle' | 'error';

/**
 * Move one version along: queue its exports, start queued ones, poll the ones
 * that are due, download finished files. Account errors are rethrown (the
 * link backs off); anything else is recorded and never retried in this tick.
 */
async function advanceVersion(
	env: Env,
	client: OnshapeClient,
	link: OnshapeLinkRow,
	version: VersionRow,
	formats: ExportFormat[],
	deadline: number,
	cron: boolean
): Promise<StepOutcome> {
	if (version.status === 'pending') {
		let elements;
		try {
			elements = (await client.elements(version.document_id, version.version_id)).filter((e) => EXPORTABLE.has(e.elementType));
		} catch (err) {
			if (isAccountError(err)) throw err;
			await recordVersionError(env, link, version, errorMessage(err));
			return 'error';
		}
		const state: ExportState = { tasks: [] };
		if (elements.length > MAX_ELEMENTS) state.skippedElements = elements.slice(MAX_ELEMENTS).map((e) => e.name);
		for (const element of elements.slice(0, MAX_ELEMENTS)) {
			for (const format of formats) {
				state.tasks.push({
					elementId: element.id,
					elementName: element.name,
					elementType: element.elementType,
					format,
					state: 'queued',
					polls: 0,
					nextPollAt: 0,
				});
			}
		}
		// Saved before any export starts: from here on every paid call is persisted as it happens.
		await saveExports(env, version.id, 'exporting', state);
		version = { ...version, status: 'exporting', exports: JSON.stringify(state) };
	}

	const state = parseJson<ExportState>(version.exports, { tasks: [] });
	let changed = false;
	for (const task of state.tasks) {
		if (Date.now() >= deadline - 2_000) break;
		if ((task.state !== 'queued' && task.state !== 'active') || task.nextPollAt > Date.now()) continue;
		try {
			if (task.state === 'queued') await startTask(client, version, task);
			else await pollTask(env, client, link, version, task, () => saveExports(env, version.id, 'exporting', state), cron);
		} catch (err) {
			if (isAccountError(err)) {
				await saveExports(env, version.id, 'exporting', state);
				throw err;
			}
			// 5xx / network: back this export off; it fails after MAX_TASK_ERRORS.
			task.errors = (task.errors ?? 0) + 1;
			if (task.errors >= MAX_TASK_ERRORS) Object.assign(task, { state: 'failed', error: errorMessage(err) });
			else task.nextPollAt = Date.now() + errorDelayMs(task.errors);
		}
		changed = true;
		await saveExports(env, version.id, 'exporting', state);
	}
	return changed ? 'progress' : 'idle';
}

async function startTask(client: OnshapeClient, version: VersionRow, task: ExportTask): Promise<void> {
	const t = await client.startExport(version.document_id, version.version_id, { id: task.elementId, elementType: task.elementType }, task.format);
	if (!t.id) Object.assign(task, { state: 'failed', error: 'Onshape did not return an export id' });
	else if (t.requestState === 'FAILED') Object.assign(task, { state: 'failed', translationId: t.id, error: t.failureReason || 'Export failed' });
	else Object.assign(task, { state: 'active', translationId: t.id, nextPollAt: Date.now() + nextPollDelayMs(0) });
}

async function pollTask(
	env: Env,
	client: OnshapeClient,
	link: OnshapeLinkRow,
	version: VersionRow,
	task: ExportTask,
	persist: () => Promise<void>,
	cron = true
): Promise<void> {
	if (!task.translationId) {
		Object.assign(task, { state: 'failed', error: 'Export has no id' });
		return;
	}
	const t = await client.translation(task.translationId);
	task.polls++;
	if (t.requestState === 'ACTIVE') {
		if (task.polls >= MAX_POLLS) Object.assign(task, { state: 'failed', error: 'Export did not finish in time' });
		else task.nextPollAt = Date.now() + nextPollDelayMs(task.polls);
		return;
	}
	if (t.requestState === 'FAILED') {
		Object.assign(task, { state: 'failed', error: t.failureReason || 'Export failed' });
		return;
	}
	const fileId = t.resultExternalDataIds?.[0];
	if (!fileId) {
		Object.assign(task, { state: 'failed', error: 'Export finished without a file' });
		return;
	}
	// Count the attempt BEFORE downloading: if the download kills the isolate, the count still moves.
	task.downloads = (task.downloads ?? 0) + 1;
	if (task.downloads > MAX_DOWNLOADS) {
		Object.assign(task, { state: 'failed', error: 'Download kept failing' });
		return;
	}
	await persist();
	const res = await client.downloadResponse(version.document_id, fileId);
	const declared = Number(res.headers.get('Content-Length'));

	if (res.body && Number.isFinite(declared) && declared > 0) {
		if (declared > MAX_EXPORT_BYTES) {
			await res.body.cancel().catch(() => {});
			Object.assign(task, { state: 'failed', error: `File is ${formatMb(declared)}, over the ${formatMb(MAX_EXPORT_BYTES)} sync limit` });
			return;
		}
		if (!cron && declared > MAX_FOREGROUND_DOWNLOAD_BYTES) {
			// Too big to finish inside waitUntil's 30 s: leave it for the next cron run, without spending an attempt.
			await res.body.cancel().catch(() => {});
			task.downloads--;
			task.nextPollAt = Date.now() + 60_000;
			return;
		}
		const { oid, head } = await streamLfsObject(env.STORAGE, link.repo_id, res.body, declared);
		await markLfsObjectReady(env, link.repo_id, oid, declared);
		Object.assign(task, { state: 'done', oid, size: declared, ext: detectExtension(task.format, head) });
		return;
	}

	const bytes = await readCapped(res, MAX_IN_MEMORY_BYTES);
	if (!bytes) {
		Object.assign(task, { state: 'failed', error: `File has no announced size and is over the ${formatMb(MAX_IN_MEMORY_BYTES)} limit for those` });
		return;
	}
	const oid = await storeLfsObject(env, link.repo_id, bytes);
	Object.assign(task, { state: 'done', oid, size: bytes.length, ext: detectExtension(task.format, bytes) });
}

function formatMb(bytes: number): string {
	return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 / 1024)} MB`;
}

/** Read a body up to `cap` bytes; null (and the stream cancelled) if it is bigger. */
export async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
	const declared = Number(res.headers.get('Content-Length'));
	if (Number.isFinite(declared) && declared > cap) {
		await res.body?.cancel().catch(() => {});
		return null;
	}
	if (!res.body) return new Uint8Array(0);
	const reader = res.body.getReader();
	// Known length → one buffer, no copy at the end.
	const exact = Number.isFinite(declared) && declared > 0 ? new Uint8Array(declared) : null;
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (total + value.length > cap || (exact && total + value.length > exact.length)) {
			await reader.cancel().catch(() => {});
			return exact && total + value.length <= cap ? null : null;
		}
		if (exact) exact.set(value, total);
		else chunks.push(value);
		total += value.length;
	}
	if (exact) return total === exact.length ? exact : exact.subarray(0, total);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

async function recordVersionError(env: Env, link: OnshapeLinkRow, version: Pick<VersionRow, 'id' | 'attempts' | 'version_name' | 'status'>, message: string): Promise<void> {
	const attempts = version.attempts + 1;
	await env.DB.prepare('UPDATE onshape_versions SET attempts = ?, error = ?, status = ?, updated_at = ? WHERE id = ?')
		.bind(attempts, message, attempts >= MAX_ATTEMPTS ? 'failed' : version.status, new Date().toISOString(), version.id)
		.run();
	await setLinkStatus(env, link.id, 'error', `${version.version_name}: ${message}`);
}

async function saveExports(env: Env, versionId: string, status: string, state: ExportState): Promise<void> {
	await env.DB.prepare('UPDATE onshape_versions SET status = ?, exports = ?, updated_at = ? WHERE id = ?')
		.bind(status, JSON.stringify(state), new Date().toISOString(), versionId)
		.run();
}

async function msUntilNextStep(env: Env, linkId: string): Promise<number | null> {
	const { results } = await env.DB.prepare("SELECT exports FROM onshape_versions WHERE link_id = ? AND status = 'exporting'")
		.bind(linkId)
		.all<{ exports: string | null }>();
	let next = Infinity;
	for (const row of results ?? []) {
		for (const t of parseJson<ExportState>(row.exports, { tasks: [] }).tasks) {
			if (t.state === 'active' || t.state === 'queued') next = Math.min(next, t.nextPollAt);
		}
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
	await markLfsObjectReady(env, repoId, oid, bytes.length);
	return oid;
}

async function markLfsObjectReady(env: Pick<Env, 'DB'>, repoId: string, oid: string, size: number): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO lfs_objects (repo_id, oid, size, state) VALUES (?, ?, ?, 'ready')
		 ON CONFLICT(repo_id, oid) DO UPDATE SET state = 'ready'`
	)
		.bind(repoId, oid, size)
		.run();
}

// ─── Commit ─────────────────────────────────────────────────────

type CommitOutcome = 'committed' | 'blocked' | 'error';

async function commitVersion(env: Env, link: OnshapeLinkRow, version: VersionRow, doc: LinkedDocument, state: ExportState): Promise<CommitOutcome> {
	// Never move a document backwards: if a newer version of it is already in git
	// (e.g. this one was retried), committing this one would roll the files back.
	const newer = await env.DB.prepare(
		`SELECT version_name FROM onshape_versions
		 WHERE link_id = ? AND document_id = ? AND status = 'committed' AND version_created_at > ? LIMIT 1`
	)
		.bind(link.id, version.document_id, version.version_created_at)
		.first<{ version_name: string }>();
	if (newer) {
		await env.DB.prepare("UPDATE onshape_versions SET status = 'skipped', error = ?, updated_at = ? WHERE id = ?")
			.bind(`Not committed: the newer version "${newer.version_name}" is already in the repository`, new Date().toISOString(), version.id)
			.run();
		return 'committed';
	}

	const refName = `refs/heads/${link.branch}`;
	const lock = await acquirePushLock(env, link.repo_id, 'onshape-sync', [refName]);
	if ('error' in lock) return 'blocked'; // someone is pushing; next tick

	try {
		const artifact = await env.REPOS.get(link.repo_name);
		if (!artifact) throw new Error(`Repository ${link.repo_name} not found in Artifacts`);
		const remote = getArtifactsRemoteUrl(env, link.repo_name);
		const token = await mintToken(env, link.repo_name, 'write', 300);

		// Current branch tip, straight from Artifacts.
		const refsRes = await fetch(`${remote}/info/refs?service=git-receive-pack`, { headers: { Authorization: `Bearer ${token}` } });
		if (!refsRes.ok) throw new Error(`Artifacts info/refs failed: HTTP ${refsRes.status}`);
		const head = parseInfoRefs(await refsRes.arrayBuffer()).refs.get(refName) ?? null;

		if (await branchIsProtected(env.DB, link.repo_id, link.branch, { isCreate: false, defaultBranch: link.default_branch || 'main' })) {
			await backOffLink(
				env,
				link.id,
				`Branch "${link.branch}" is protected (merge queue only). Pick another branch in the Onshape settings or remove the protection rule.`,
				AUTH_BACKOFF_MS
			);
			return 'blocked';
		}

		const headCommit = head ? await artifact.readCommit(head) : null;
		if (head && !headCommit) throw new Error(`Could not read commit ${head}`);

		// Already pushed by an earlier tick whose D1 update was lost: just record it.
		if (headCommit?.message?.includes(`\nOnshape-Version: ${version.version_id}\n`)) {
			await markCommitted(env, version.id, head!);
			return 'committed';
		}

		const readFile = async (path: string): Promise<string | null> => {
			if (!head) return null;
			// By branch name, like the rest of the codebase; we hold the push lock, so the tip is `head`.
			const blob = await artifact.readFile({ ref: link.branch, path }).catch(() => null);
			return blob ? await blob.text() : null;
		};

		const docDir = documentFolder(doc);
		const previous = parseJson<Manifest | null>(await readFile(`${docDir}/${MANIFEST_NAME}`), null);
		const manifest = buildManifest(link, doc, version, state, previous?.document?.id === doc.id ? previous : null);
		const objects: GitObject[] = [];
		const changes: TreeChanges = new Map();
		const put = async (path: string, content: string) => {
			const blob = await makeBlob(content);
			objects.push(blob);
			changes.set(path, { sha: blob.sha });
		};

		// This version's files (LFS pointers; carried-over files are rewritten unchanged)…
		const newPaths = new Set<string>();
		for (const e of manifest.elements) {
			for (const f of e.files) {
				const path = `${docDir}/${f.path}`;
				newPaths.add(path);
				await put(path, buildLfsPointer(f.oid, f.size));
			}
		}
		// …and the previous version's files this version no longer has (deleted elements).
		if (previous?.document?.id === doc.id) {
			for (const e of previous.elements ?? []) {
				for (const f of e.files ?? []) {
					const path = `${docDir}/${f.path}`;
					if (!newPaths.has(path)) changes.set(path, null);
				}
			}
		}
		await put(`${docDir}/${MANIFEST_NAME}`, `${JSON.stringify(manifest, null, 2)}\n`);
		const attributes = ensureLfsAttributes(await readFile('.gitattributes'), docDir);
		if (attributes !== null) await put('.gitattributes', attributes);

		const readTree = async (sha: string): Promise<TreeEntry[]> =>
			((await artifact.readTree(sha)) ?? []).map((e) => ({
				name: e.name,
				sha: e.hash,
				mode: e.type === 'tree' ? MODE_TREE : normalizeMode(e.mode, e.type),
			}));
		const tree = await applyTreeChanges(readTree, headCommit?.treeHash ?? null, changes);
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

		await markCommitted(env, version.id, commit.sha);
		await audit(env.DB, {
			repoId: link.repo_id,
			actor: 'onshape-sync',
			action: 'onshape.commit',
			details: { branch: link.branch, commit: commit.sha, document: doc.id, version: version.version_id, name: version.version_name },
		}).catch(() => {});
		await triggerGitHubMirror(env, link.repo_id, link.repo_name, [link.branch]);
		return 'committed';
	} catch (err) {
		await recordVersionError(env, link, version, `Commit failed: ${errorMessage(err)}`);
		return 'error';
	} finally {
		await releasePushLock(env, link.repo_id, lock.lockId);
	}
}

async function markCommitted(env: Env, versionId: string, sha: string): Promise<void> {
	await env.DB.prepare("UPDATE onshape_versions SET status = 'committed', commit_sha = ?, error = NULL, updated_at = ? WHERE id = ?")
		.bind(sha, new Date().toISOString(), versionId)
		.run();
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
