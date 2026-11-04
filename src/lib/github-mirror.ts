/**
 * GitHub Mirror Engine for GitFlare
 *
 * Mirrors repository refs from Cloudflare Artifacts to a GitHub remote as a
 * disaster-recovery backup.
 *
 * ┌─ How a ref gets to GitHub ──────────────────────────────────────────────┐
 * │ PRIMARY PATH — pack push (Git Smart HTTP, no sandbox):                  │
 * │   1. info/refs on Artifacts (upload-pack) and GitHub (receive-pack)     │
 * │   2. POST git-upload-pack to Artifacts: `want` every target SHA, `have` │
 * │      every SHA GitHub already advertises, NO side-band → the response  │
 * │      is NAK/ACK pkt-lines followed by the raw packfile                  │
 * │   3. POST git-receive-pack to GitHub: `<github-sha> <artifacts-sha>     │
 * │      <ref>` commands + that packfile, streamed straight through (the    │
 * │      pack is never buffered in Worker memory)                           │
 * │   4. Parse GitHub's report-status per ref (HTTP 200 alone means little) │
 * │                                                                         │
 * │ FAST PATH — REST API ref update, ONLY when GitHub already has the       │
 * │   target object (the SHA is the tip of some ref GitHub advertises —     │
 * │   e.g. a branch reset to, or created at, an existing commit). The Git   │
 * │   Data API moves pointers only; it returns 422 for objects GitHub       │
 * │   doesn't have, so it can never be the general mechanism. A 422 falls   │
 * │   back to the pack push.                                                │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * SHAs always come from the live Artifacts ref advertisement at sync time —
 * never from the caller (git.ts may hand us `HEAD`/`unknown` placeholders, and
 * a queued job may run after newer pushes). Deleted refs are not mirrored.
 *
 * Async: work runs on the `gitflare-mirror-sync` queue (15 min wall clock per
 * invocation, retries + DLQ) instead of `waitUntil` (~30s after the response),
 * which large packs would blow through. `waitUntil` is only a fallback when
 * the queue binding is missing or `send()` fails.
 *
 * Design principles:
 *  - Mirror failures NEVER block the primary push
 *  - All operations are logged to mirror_sync_log
 *  - GitHub PATs are encrypted at rest (`v1:` AES-256-GCM, see crypto.ts) and
 *    never placed in queue messages
 */

import type { Env, MirrorSyncMessage } from '../env.ts';
import { getArtifactsRemoteUrl } from './artifacts-url.ts';
import { getArtifactRefs } from './artifact-reader.ts';
import { audit } from './audit.ts';
import { matchesBranchFilter } from './branch-pattern.ts';
import { decryptSecret, encryptSecret } from './crypto.ts';
import { encodePktLine, parseInfoRefs, parseReceivePackResponse, readPkt } from './git-protocol.ts';

const USER_AGENT = 'GitFlare-Mirror/1.0';
/** Cap on `have` lines sent to Artifacts (branches first, then tags). */
const MAX_HAVES = 2000;
const FLUSH = new TextEncoder().encode('0000');

// ─── Token Encryption ───────────────────────────────────────────
// New values are written as `v1:` (HKDF(ENCRYPTION_KEY) → AES-256-GCM).
// Reads also accept the legacy PBKDF2(SESSION_SECRET) format until
// scripts/2g-migrate-encryption.ts has converted every stored token
// (`node scripts/2g-migrate-encryption.ts --verify`).

export function encryptMirrorToken(env: Pick<Env, 'ENCRYPTION_KEY'>, token: string): Promise<string> {
	return encryptSecret(token, env.ENCRYPTION_KEY);
}

export function decryptMirrorToken(env: Pick<Env, 'ENCRYPTION_KEY' | 'SESSION_SECRET'>, stored: string): Promise<string> {
	return decryptSecret(stored, env.ENCRYPTION_KEY, env.SESSION_SECRET);
}

// ─── GitHub API Helpers ─────────────────────────────────────────

/**
 * Validate that a GitHub URL + token pair is working.
 * Uses the GitHub REST API to check repo access.
 */
export async function testGitHubConnection(
	githubUrl: string,
	token: string
): Promise<{ ok: boolean; error?: string; repoFullName?: string }> {
	try {
		// Parse the GitHub URL to extract owner/repo
		const parsed = parseGitHubUrl(githubUrl);
		if (!parsed) {
			return { ok: false, error: 'Invalid GitHub URL. Expected format: https://github.com/owner/repo.git' };
		}

		// Test with the GitHub REST API
		const response = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
			headers: githubApiHeaders(token),
		});

		if (response.status === 401) {
			return { ok: false, error: 'Invalid GitHub token — authentication failed' };
		}
		if (response.status === 403) {
			return { ok: false, error: 'Token lacks permission to access this repository' };
		}
		if (response.status === 404) {
			return { ok: false, error: 'Repository not found — check the URL and token permissions' };
		}
		if (!response.ok) {
			return { ok: false, error: `GitHub API error: ${response.status} ${response.statusText}` };
		}

		const data = (await response.json()) as { full_name: string; permissions?: { push?: boolean } };

		// Check push permission
		if (data.permissions && !data.permissions.push) {
			return { ok: false, error: 'Token does not have push permission to this repository' };
		}

		return { ok: true, repoFullName: data.full_name };
	} catch (err) {
		console.error('GitHub connection test failed:', err);
		return { ok: false, error: 'Connection test failed: could not reach the GitHub API' };
	}
}

/**
 * Strict GitHub repo URL: `https://github.com/<owner>/<repo>[.git]`, anchored
 * at both ends so nothing like `https://evil.example/github.com/a/b` or
 * `https://github.com.evil.example/a/b` slips through (SSRF). Owner follows
 * GitHub's username rules; repo names may contain dots (e.g. `my.app`).
 */
const GITHUB_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/;

/**
 * Parse a GitHub URL into owner/repo plus a canonical clone URL built only
 * from the parsed parts. Always use `canonicalUrl` for storage and fetches,
 * never the user's input.
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string; canonicalUrl: string } | null {
	const match = GITHUB_URL_RE.exec(url.trim());
	if (!match) return null;
	const [, owner, repo] = match;
	if (repo === '.' || repo === '..') return null;
	return { owner, repo, canonicalUrl: `https://github.com/${owner}/${repo}.git` };
}

function githubApiHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'User-Agent': USER_AGENT,
		'X-GitHub-Api-Version': '2022-11-28',
	};
}

function githubGitHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Basic ${btoa(`x-access-token:${token}`)}`,
		'User-Agent': USER_AGENT,
	};
}

// ─── Branch Filter ──────────────────────────────────────────────

/** Parse `github_mirrors.branch_filter` (JSON array of globs, NULL = all). Throws on malformed JSON. */
export function parseBranchFilter(raw: string | null): string[] | null {
	if (raw == null) return null;
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === 'string')) {
		throw new Error('branch_filter must be a JSON array of strings');
	}
	return parsed;
}

/**
 * Does `name` pass the mirror's branch filter? The filter governs branches
 * only: `refs/tags/*` always pass, other non-branch refs never do. Bare names
 * (git.ts passes `main`, not `refs/heads/main`) are treated as branches.
 */
export function refPassesFilter(name: string, patterns: string[] | null): boolean {
	if (name.startsWith('refs/tags/')) return true;
	if (name.startsWith('refs/') && !name.startsWith('refs/heads/')) return false;
	if (!patterns) return true;
	return matchesBranchFilter(patterns, name);
}

// ─── Mirror Push Engine ─────────────────────────────────────────

export interface MirrorRefResult {
	/** Name as requested (bare branch name from git.ts, or a full ref name). */
	name: string;
	/** Fully-qualified ref the name resolved to in Artifacts. */
	refName: string | null;
	/** Artifacts SHA that was (or should have been) pushed. */
	sha: string | null;
	status: 'success' | 'failed' | 'skipped';
	/** noop = already in sync, api = REST fast path, pack = Smart HTTP push. */
	method?: 'noop' | 'api' | 'pack';
	error?: string;
	/** Transient failure — worth retrying the whole job. */
	retryable?: boolean;
}

interface PlannedUpdate {
	name: string;
	refName: string;
	newSha: string;
	/** GitHub's current SHA for the ref; null if GitHub doesn't have the ref. */
	oldSha: string | null;
}

interface Advertisement {
	refs: Map<string, string>;
	capabilities: string[];
}

class MirrorError extends Error {
	readonly retryable: boolean;
	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = 'MirrorError';
		this.retryable = retryable;
	}
}

function isRetryableStatus(status: number): boolean {
	return status === 0 || status === 408 || status === 429 || status >= 500;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

async function artifactsReadToken(env: Env, repoName: string): Promise<string> {
	const repo = await env.REPOS.get(repoName);
	if (!repo) throw new MirrorError('Artifacts repo not found', false);
	// Only needs to outlive the start of the upload-pack request.
	const token: unknown = await repo.createToken('read', 300);
	return typeof token === 'string' ? token : (token as { plaintext?: string } | null)?.plaintext ?? String(token);
}

async function fetchAdvertisement(url: string, headers: Record<string, string>, label: string): Promise<Advertisement> {
	const res = await fetch(url, { headers });
	if (!res.ok) {
		throw new MirrorError(`${label} ref discovery failed: HTTP ${res.status}`, isRetryableStatus(res.status));
	}
	return parseInfoRefs(await res.arrayBuffer());
}

/** Resolve a requested name to a ref Artifacts advertises (branches win over same-named tags). */
function resolveRef(name: string, refs: Map<string, string>): string | null {
	if (name.startsWith('refs/')) return refs.has(name) ? name : null;
	for (const candidate of [`refs/heads/${name}`, `refs/tags/${name}`]) {
		if (refs.has(candidate)) return candidate;
	}
	return null;
}

/**
 * Push the given refs from Artifacts to GitHub. `names` may be bare branch
 * names (`main`) or full ref names (`refs/tags/v1`). Never throws.
 */
export async function pushRefsToGitHub(
	env: Env,
	repoName: string,
	githubUrl: string,
	githubToken: string,
	names: string[]
): Promise<MirrorRefResult[]> {
	const unique = [...new Set(names)];
	const failAll = (error: string, retryable: boolean): MirrorRefResult[] =>
		unique.map((name) => ({ name, refName: null, sha: null, status: 'failed', error, retryable }));

	// Rebuild the remote from parsed parts — never fetch a stored URL verbatim
	// (rows written before URL validation was anchored may point anywhere).
	const parsed = parseGitHubUrl(githubUrl);
	if (!parsed) return failAll('Invalid GitHub URL', false);
	const githubRemote = parsed.canonicalUrl;
	const ghHeaders = githubGitHeaders(githubToken);

	let artifactsToken: string;
	let artifactsRemote: string;
	let artifactsAdv: Advertisement;
	let githubAdv: Advertisement;
	try {
		artifactsToken = await artifactsReadToken(env, repoName);
		artifactsRemote = getArtifactsRemoteUrl(env, repoName);
		[artifactsAdv, githubAdv] = await Promise.all([
			fetchAdvertisement(
				`${artifactsRemote}/info/refs?service=git-upload-pack`,
				{ Authorization: `Bearer ${artifactsToken}` },
				'Artifacts'
			),
			fetchAdvertisement(`${githubRemote}/info/refs?service=git-receive-pack`, ghHeaders, 'GitHub'),
		]);
	} catch (err) {
		return failAll(errorMessage(err), err instanceof MirrorError ? err.retryable : true);
	}

	// ── Plan: resolve every name to Artifacts' advertised SHA ──
	const results: MirrorRefResult[] = [];
	const updates: PlannedUpdate[] = [];
	const planned = new Set<string>();
	for (const name of unique) {
		const refName = resolveRef(name, artifactsAdv.refs);
		if (!refName) {
			results.push({
				name,
				refName: null,
				sha: null,
				status: 'skipped',
				error: 'Ref not present in Artifacts (deleted or never pushed) — deletions are not mirrored',
			});
			continue;
		}
		if (planned.has(refName)) continue; // `main` and `refs/heads/main` in the same job
		planned.add(refName);

		const newSha = artifactsAdv.refs.get(refName)!;
		const oldSha = githubAdv.refs.get(refName) ?? null;
		if (oldSha === newSha) {
			results.push({ name, refName, sha: newSha, status: 'success', method: 'noop' });
			continue;
		}
		updates.push({ name, refName, newSha, oldSha });
	}

	// ── Fast path: REST ref update, only for objects GitHub provably has ──
	const githubHas = new Set(githubAdv.refs.values());
	const needPack: PlannedUpdate[] = [];
	for (const update of updates) {
		if (!githubHas.has(update.newSha)) {
			needPack.push(update);
			continue;
		}
		const api = await updateRefViaAPI(parsed, githubToken, update);
		if (api.ok) {
			results.push({ name: update.name, refName: update.refName, sha: update.newSha, status: 'success', method: 'api' });
		} else if (api.status === 422) {
			needPack.push(update); // GitHub doesn't have the object after all → transfer it
		} else {
			results.push({
				name: update.name,
				refName: update.refName,
				sha: update.newSha,
				status: 'failed',
				method: 'api',
				error: api.error,
				retryable: isRetryableStatus(api.status),
			});
		}
	}

	// ── Primary path: pack push ──
	if (needPack.length > 0) {
		results.push(
			...(await pushPack({
				artifactsRemote,
				artifactsToken,
				artifactsCaps: artifactsAdv.capabilities,
				githubRemote,
				ghHeaders,
				githubAdv,
				updates: needPack,
			}))
		);
	}

	return results;
}

/**
 * REST fast path. Only valid when GitHub already has `newSha` — the Git Data
 * API moves ref pointers and does not transfer objects (422 otherwise).
 */
async function updateRefViaAPI(
	gh: { owner: string; repo: string },
	token: string,
	update: PlannedUpdate
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
	const api = `https://api.github.com/repos/${gh.owner}/${gh.repo}/git`;
	const headers = { ...githubApiHeaders(token), 'Content-Type': 'application/json' };
	const method = update.oldSha ? 'PATCH' : 'POST';
	try {
		const res = update.oldSha
			? // Ref exists on GitHub — move it (force, since this is a mirror)
				await fetch(`${api}/refs/${update.refName.slice('refs/'.length).split('/').map(encodeURIComponent).join('/')}`, {
					method,
					headers,
					body: JSON.stringify({ sha: update.newSha, force: true }),
				})
			: await fetch(`${api}/refs`, {
					method,
					headers,
					body: JSON.stringify({ ref: update.refName, sha: update.newSha }),
				});
		if (res.ok) return { ok: true };
		const body = await res.text();
		let message = body.slice(0, 200);
		try {
			message = (JSON.parse(body) as { message?: string }).message ?? message;
		} catch {
			// Non-JSON error body — keep the raw text
		}
		return { ok: false, status: res.status, error: `${method} ${res.status}: ${message}` };
	} catch (err) {
		return { ok: false, status: 0, error: `${method} failed: ${errorMessage(err)}` };
	}
}

/**
 * Smart HTTP transfer: upload-pack from Artifacts → receive-pack to GitHub,
 * streaming the packfile through without buffering it.
 */
async function pushPack(opts: {
	artifactsRemote: string;
	artifactsToken: string;
	artifactsCaps: string[];
	githubRemote: string;
	ghHeaders: Record<string, string>;
	githubAdv: Advertisement;
	updates: PlannedUpdate[];
}): Promise<MirrorRefResult[]> {
	const { artifactsCaps, githubAdv, updates } = opts;
	const githubCaps = githubAdv.capabilities;
	const failAll = (error: string, retryable: boolean): MirrorRefResult[] =>
		updates.map((u) => ({ name: u.name, refName: u.refName, sha: u.newSha, status: 'failed', method: 'pack', error, retryable }));

	if (!githubCaps.includes('report-status')) {
		return failAll('GitHub did not advertise report-status — refusing to push blind', false);
	}

	// ── 1. upload-pack request to Artifacts ──
	// No side-band/side-band-64k: the response is then NAK/ACK + raw PACK and
	// can be piped straight into the receive-pack body. ofs-delta only if
	// GitHub accepts it too, since the pack is forwarded unmodified.
	const uploadCaps: string[] = [];
	if (artifactsCaps.includes('ofs-delta') && githubCaps.includes('ofs-delta')) uploadCaps.push('ofs-delta');
	if (artifactsCaps.includes('no-progress')) uploadCaps.push('no-progress');
	if (artifactsCaps.some((c) => c.startsWith('agent='))) uploadCaps.push(`agent=${USER_AGENT}`);

	const wants = [...new Set(updates.map((u) => u.newSha))];
	// `have` everything GitHub already has so Artifacts sends only the delta.
	// Unknown haves are ignored by upload-pack, so GitHub-only commits are harmless.
	const haves = [...githubAdv.refs.entries()]
		.sort(([a], [b]) => Number(b.startsWith('refs/heads/')) - Number(a.startsWith('refs/heads/')))
		.map(([, sha]) => sha)
		.filter((sha, i, all) => !/^0+$/.test(sha) && all.indexOf(sha) === i)
		.slice(0, MAX_HAVES);

	const uploadRequest = concatBytes([
		...wants.map((sha, i) =>
			encodePktLine(i === 0 && uploadCaps.length > 0 ? `want ${sha} ${uploadCaps.join(' ')}\n` : `want ${sha}\n`)
		),
		FLUSH,
		...haves.map((sha) => encodePktLine(`have ${sha}\n`)),
		encodePktLine('done\n'),
	]);

	let packRes: Response;
	try {
		packRes = await fetch(`${opts.artifactsRemote}/git-upload-pack`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${opts.artifactsToken}`,
				'Content-Type': 'application/x-git-upload-pack-request',
				Accept: 'application/x-git-upload-pack-result',
			},
			body: uploadRequest,
		});
	} catch (err) {
		return failAll(`Artifacts upload-pack request failed: ${errorMessage(err)}`, true);
	}
	if (!packRes.ok || !packRes.body) {
		return failAll(`Artifacts upload-pack failed: HTTP ${packRes.status}`, isRetryableStatus(packRes.status));
	}

	// ── 2. receive-pack request to GitHub: commands + streamed pack ──
	// Old SHA = what GitHub actually has now (compare-and-swap), zeros to create.
	const pushCaps = ['report-status'];
	if (githubCaps.includes('quiet')) pushCaps.push('quiet');
	if (githubCaps.some((c) => c.startsWith('agent='))) pushCaps.push(`agent=${USER_AGENT}`);
	const commands = concatBytes([
		...updates.map((u, i) => {
			const oldSha = u.oldSha ?? '0'.repeat(u.newSha.length);
			const caps = i === 0 ? `\0${pushCaps.join(' ')}` : '';
			return encodePktLine(`${oldSha} ${u.newSha} ${u.refName}${caps}\n`);
		}),
		FLUSH,
	]);

	let pumpError: unknown = null;
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const pump = (async () => {
		const writer = writable.getWriter();
		await writer.write(commands);
		writer.releaseLock();
		await packRes.body!.pipeThrough(createPackfileExtractor()).pipeTo(writable);
	})().catch((err) => {
		pumpError = err;
	});

	let pushRes: Response;
	let responseBody: Uint8Array;
	try {
		pushRes = await fetch(`${opts.githubRemote}/git-receive-pack`, {
			method: 'POST',
			headers: {
				...opts.ghHeaders,
				'Content-Type': 'application/x-git-receive-pack-request',
				Accept: 'application/x-git-receive-pack-result',
			},
			body: readable,
		});
		responseBody = new Uint8Array(await pushRes.arrayBuffer());
	} catch (err) {
		await pump;
		return failAll(
			pumpError ? `Pack transfer failed: ${errorMessage(pumpError)}` : `GitHub receive-pack request failed: ${errorMessage(err)}`,
			true
		);
	}
	await pump;

	if (pumpError) {
		return failAll(`Pack transfer failed: ${errorMessage(pumpError)}`, true);
	}
	if (!pushRes.ok) {
		const text = new TextDecoder().decode(responseBody.subarray(0, 200));
		return failAll(`GitHub receive-pack failed: HTTP ${pushRes.status} ${text}`, isRetryableStatus(pushRes.status));
	}

	// ── 3. GitHub's verdict is in the report-status body, not the HTTP status ──
	const report = parseReceivePackResponse(responseBody);
	if (!report) {
		return failAll('GitHub returned no report-status — push outcome unknown', true);
	}
	if (!report.unpackOk) {
		return failAll(`GitHub could not unpack the packfile: ${report.unpackError ?? 'unknown error'}`, true);
	}

	const byRef = new Map(report.refResults.map((r) => [r.refName, r]));
	return updates.map((u): MirrorRefResult => {
		const r = byRef.get(u.refName);
		if (!r) {
			return { name: u.name, refName: u.refName, sha: u.newSha, status: 'failed', method: 'pack', error: 'GitHub reported no status for this ref', retryable: true };
		}
		if (r.success) {
			return { name: u.name, refName: u.refName, sha: u.newSha, status: 'success', method: 'pack' };
		}
		const reason = r.error ?? 'rejected';
		return {
			name: u.name,
			refName: u.refName,
			sha: u.newSha,
			status: 'failed',
			method: 'pack',
			error: `GitHub rejected ${u.refName}: ${reason}`,
			// Lost a race with another writer — the next run re-reads GitHub's SHA.
			retryable: /stale|lock|incorrect old value/i.test(reason),
		};
	});
}

/**
 * Streaming transform: git-upload-pack response → raw packfile bytes.
 *
 * Handles both response shapes so the pack is never buffered:
 *  - no side-band (what we request): `NAK` / `ACK <sha>` / `shallow …`
 *    pkt-lines, then raw `PACK…` bytes, passed through untouched
 *  - side-band(-64k) (if the server ignores our capabilities): band-1
 *    payloads forwarded, band-2 dropped, band-3 aborts with the message
 * `ERR` pkt-lines abort too. Errors if no well-formed pack arrives.
 *
 * Pkt-line decoding is shared with git-protocol.ts (`readPkt`); the buffered
 * `demuxSideband` there is the non-streaming equivalent of the sideband branch.
 */
export function createPackfileExtractor(): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	let mode: 'preamble' | 'raw' | 'sideband' | 'done' = 'preamble';
	let pending: Uint8Array = new Uint8Array(0);
	let header: number[] = []; // first 4 emitted bytes, checked against "PACK"
	let emitted = 0;

	const emit = (bytes: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) => {
		if (bytes.length === 0) return;
		for (let i = 0; header.length < 4 && i < bytes.length; i++) {
			header.push(bytes[i]);
			if (header.length === 4 && String.fromCharCode(...header) !== 'PACK') {
				throw new Error('upload-pack response did not contain a valid packfile');
			}
		}
		emitted += bytes.length;
		controller.enqueue(bytes);
	};

	const isPack = (buf: Uint8Array) => buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x41 && buf[2] === 0x43 && buf[3] === 0x4b;

	const drain = (controller: TransformStreamDefaultController<Uint8Array>) => {
		while (true) {
			if (mode === 'raw') {
				const out = pending;
				pending = new Uint8Array(0);
				emit(out, controller);
				return;
			}
			if (mode === 'done' || pending.length < 4) return;
			if (mode === 'preamble' && isPack(pending)) {
				mode = 'raw';
				continue;
			}

			// Wait until the whole pkt-line is buffered, then decode it with readPkt.
			const len = parseInt(decoder.decode(pending.subarray(0, 4)), 16);
			if (!Number.isNaN(len) && len >= 4 && pending.length < len) return;
			const read = readPkt(pending, 0); // throws on a malformed length header
			if (!read) return;
			const pkt = read.pkt;
			const rest = pending.subarray(read.next);

			if (pkt.type !== 'data') {
				if (pkt.type === 'flush' && mode === 'sideband') mode = 'done';
				pending = rest;
				continue;
			}

			const band = pkt.payload[0];
			const isBand = band === 1 || band === 2 || band === 3;
			if (mode === 'preamble' && !isBand) {
				const line = decoder.decode(pkt.payload).replace(/\n$/, '');
				if (line.startsWith('ERR ')) throw new Error(`upload-pack: ${line.slice(4)}`);
				pending = rest; // NAK / ACK <sha> / shallow <sha> — negotiation noise
				continue;
			}

			mode = 'sideband';
			if (band === 1) emit(pkt.payload.slice(1), controller); // copy: `pending` is re-sliced
			else if (band === 3) throw new Error(`upload-pack: ${decoder.decode(pkt.payload.subarray(1)).trim()}`);
			else if (!isBand) throw new Error(`Unknown sideband band ${band} in upload-pack response`);
			pending = rest;
		}
	};

	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			if (pending.length === 0) {
				pending = chunk;
			} else {
				const merged = new Uint8Array(pending.length + chunk.length);
				merged.set(pending, 0);
				merged.set(chunk, pending.length);
				pending = merged;
			}
			drain(controller);
		},
		flush(controller) {
			drain(controller);
			// 12-byte header + 20-byte SHA-1 trailer is the smallest valid pack.
			if (emitted < 32) throw new Error('upload-pack response ended before a complete packfile arrived');
		},
	});
}

// ─── Job Execution ──────────────────────────────────────────────

/**
 * Run one mirror job: load the current mirror config, push, record results.
 * Returns whether a retry is worthwhile. Never throws for push failures.
 */
export async function runMirrorSync(
	env: Env,
	job: MirrorSyncMessage
): Promise<{ results: MirrorRefResult[]; retryable: boolean }> {
	const { DB } = env;
	const mirror = await DB.prepare(
		'SELECT id, github_url, github_token_encrypted FROM github_mirrors WHERE repo_id = ? AND is_enabled = 1'
	)
		.bind(job.repoId)
		.first<{ id: string; github_url: string; github_token_encrypted: string }>();
	if (!mirror) return { results: [], retryable: false }; // removed/disabled since enqueue

	const startedAt = Date.now();
	let results: MirrorRefResult[];
	try {
		const githubToken = await decryptMirrorToken(env, mirror.github_token_encrypted);
		results = await pushRefsToGitHub(env, job.repoName, mirror.github_url, githubToken, job.refs);
	} catch (err) {
		// Decrypt failure — retrying won't help; the token must be re-entered.
		console.error(`mirror: could not decrypt GitHub token for ${job.repoName}:`, err);
		results = job.refs.map((name) => ({
			name,
			refName: null,
			sha: null,
			status: 'failed' as const,
			error: 'Could not decrypt the stored GitHub token — re-enter it in the mirror settings',
			retryable: false,
		}));
	}

	try {
		await recordMirrorResults(env, job, mirror, results, Date.now() - startedAt);
	} catch (err) {
		console.error(`Failed to record mirror results for ${job.repoName}:`, errorMessage(err));
	}

	return { results, retryable: results.some((r) => r.status === 'failed' && r.retryable) };
}

async function recordMirrorResults(
	env: Env,
	job: MirrorSyncMessage,
	mirror: { id: string; github_url: string },
	results: MirrorRefResult[],
	durationMs: number
): Promise<void> {
	const { DB } = env;
	const now = new Date().toISOString();
	const failed = results.filter((r) => r.status === 'failed');
	const lastError = failed.length > 0 ? failed.map((r) => `${r.name}: ${r.error}`).join('; ').slice(0, 2000) : null;

	const statements = results.map((r) =>
		DB.prepare(
			'INSERT INTO mirror_sync_log (id, mirror_id, branch, commit_sha, status, error_message, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
		).bind(crypto.randomUUID(), mirror.id, r.name, r.sha ?? 'unknown', r.status, r.error ?? null, durationMs, now)
	);
	statements.push(
		DB.prepare(
			'UPDATE github_mirrors SET last_sync_at = ?, last_sync_status = ?, last_sync_error = ?, updated_at = ? WHERE id = ?'
		).bind(now, failed.length > 0 ? 'failed' : 'success', lastError, now, mirror.id)
	);
	await DB.batch(statements);

	await audit(DB, {
		repoId: job.repoId,
		actor: 'system',
		action: failed.length > 0 ? 'mirror.sync.failed' : 'mirror.sync.success',
		details: {
			github_url: mirror.github_url,
			trigger: job.trigger,
			duration_ms: durationMs,
			results: results.map((r) => ({ ref: r.refName ?? r.name, sha: r.sha, status: r.status, method: r.method, error: r.error })),
		},
	});

	if (failed.length > 0) {
		console.error(`Mirror sync failed for ${job.repoName} → ${mirror.github_url}: ${lastError}`);
	} else {
		console.log(`Mirror sync ok: ${job.repoName} → ${mirror.github_url} (${results.map((r) => `${r.name}:${r.method ?? r.status}`).join(', ')})`);
	}
}

/**
 * Hand a job to the mirror queue. Falls back to running it now (via
 * `waitUntil` if given, else awaited) when the queue is unavailable — note
 * `waitUntil` only buys ~30s after the response, too little for big packs.
 */
export async function enqueueMirrorSync(
	env: Env,
	job: MirrorSyncMessage,
	waitUntil?: (promise: Promise<unknown>) => void
): Promise<{ queued: boolean }> {
	const now = new Date().toISOString();
	await env.DB.prepare("UPDATE github_mirrors SET last_sync_status = 'pending', updated_at = ? WHERE repo_id = ? AND is_enabled = 1")
		.bind(now, job.repoId)
		.run();

	if (env.MIRROR_QUEUE) {
		try {
			await env.MIRROR_QUEUE.send(job);
			return { queued: true };
		} catch (err) {
			console.error(`Mirror queue send failed for ${job.repoName}, running inline:`, errorMessage(err));
		}
	}

	const run = runMirrorSync(env, job).catch((err) => {
		console.error(`Inline mirror sync failed for ${job.repoName}:`, errorMessage(err));
	});
	if (waitUntil) waitUntil(run);
	else await run;
	return { queued: false };
}

// ─── Entry Points ───────────────────────────────────────────────

/**
 * Trigger GitHub mirror after a successful push (called from git.ts inside
 * `waitUntil`). Applies the branch filter and enqueues — the actual transfer
 * happens in the queue consumer.
 *
 * `_commitShas` is accepted for call-site compatibility but ignored: SHAs are
 * resolved from the Artifacts ref advertisement when the job runs.
 */
export async function triggerGitHubMirror(
	env: Env,
	repoId: string,
	repoName: string,
	branches: string[],
	_commitShas?: Map<string, string>
): Promise<void> {
	try {
		const mirror = await env.DB.prepare('SELECT id, branch_filter FROM github_mirrors WHERE repo_id = ? AND is_enabled = 1')
			.bind(repoId)
			.first<{ id: string; branch_filter: string | null }>();
		if (!mirror) return; // No mirror configured or disabled

		const patterns = parseBranchFilter(mirror.branch_filter);
		const refs = branches.filter((b) => refPassesFilter(b, patterns));
		if (refs.length === 0) return; // None of the pushed refs match the filter

		await enqueueMirrorSync(env, { repoId, repoName, refs, trigger: 'push', requestedAt: new Date().toISOString() });
	} catch (err) {
		// Mirror failures must never propagate into the push path.
		console.error(`Mirror trigger error for ${repoName}:`, errorMessage(err));
		try {
			await audit(env.DB, { repoId, actor: 'system', action: 'mirror.sync.error', details: { error: errorMessage(err), branches } });
		} catch {
			console.error('Failed to audit log mirror error');
		}
	}
}

export type ManualSyncResult =
	| { ok: true; queued: boolean; refs: Record<string, string> }
	| { ok: false; status: 404 | 409 | 500 | 502; error: string };

/**
 * Manual full sync (REST `POST /mirror/sync` and MCP `gitflare_mirror_sync`):
 * every branch passing the filter plus every tag, at the SHAs Artifacts
 * currently advertises (never `HEAD`).
 */
export async function requestManualMirrorSync(
	env: Env,
	repo: { id: string; name: string },
	waitUntil?: (promise: Promise<unknown>) => void
): Promise<ManualSyncResult> {
	const mirror = await env.DB.prepare('SELECT id, branch_filter FROM github_mirrors WHERE repo_id = ? AND is_enabled = 1')
		.bind(repo.id)
		.first<{ id: string; branch_filter: string | null }>();
	if (!mirror) return { ok: false, status: 404, error: 'No active mirror configured' };

	let patterns: string[] | null;
	try {
		patterns = parseBranchFilter(mirror.branch_filter);
	} catch (err) {
		return { ok: false, status: 500, error: `Mirror branch_filter is invalid: ${errorMessage(err)}` };
	}

	let artifactRefs: Map<string, string>;
	try {
		artifactRefs = await getArtifactRefs(env, repo.name);
	} catch (err) {
		console.error(`mirror: could not read Artifacts refs for ${repo.name}:`, err);
		return { ok: false, status: 502, error: 'Could not read refs from repository storage' };
	}

	const refs: Record<string, string> = {};
	for (const [refName, sha] of artifactRefs) {
		if ((refName.startsWith('refs/heads/') || refName.startsWith('refs/tags/')) && refPassesFilter(refName, patterns)) {
			refs[refName] = sha;
		}
	}
	if (Object.keys(refs).length === 0) {
		return { ok: false, status: 409, error: 'Nothing to sync — the repository has no branches or tags matching the mirror filter' };
	}

	const { queued } = await enqueueMirrorSync(
		env,
		{ repoId: repo.id, repoName: repo.name, refs: Object.keys(refs), trigger: 'manual', requestedAt: new Date().toISOString() },
		waitUntil
	);
	return { ok: true, queued, refs };
}

/**
 * Queue consumer for `gitflare-mirror-sync`. Jobs for the same repo in one
 * batch are merged (one upload-pack + one receive-pack). Transient failures
 * retry with backoff; after max_retries the message lands in the DLQ.
 */
export async function handleMirrorSyncBatch(batch: MessageBatch<MirrorSyncMessage>, env: Env): Promise<void> {
	const byRepo = new Map<string, { job: MirrorSyncMessage; messages: Message<MirrorSyncMessage>[] }>();

	for (const message of batch.messages) {
		const body = message.body;
		if (!body || typeof body.repoId !== 'string' || typeof body.repoName !== 'string' || !Array.isArray(body.refs)) {
			console.error(`Dropping malformed mirror message ${message.id}`);
			message.ack();
			continue;
		}
		const entry = byRepo.get(body.repoId);
		if (entry) {
			entry.job.refs = [...new Set([...entry.job.refs, ...body.refs])];
			if (body.trigger === 'manual') entry.job.trigger = 'manual';
			entry.messages.push(message);
		} else {
			byRepo.set(body.repoId, { job: { ...body, refs: [...body.refs] }, messages: [message] });
		}
	}

	for (const { job, messages } of byRepo.values()) {
		try {
			const { retryable } = await runMirrorSync(env, job);
			if (retryable) {
				const attempts = Math.max(...messages.map((m) => m.attempts));
				const delaySeconds = Math.min(600, 30 * 2 ** Math.max(0, attempts - 1));
				for (const m of messages) m.retry({ delaySeconds });
			} else {
				for (const m of messages) m.ack();
			}
		} catch (err) {
			console.error(`Mirror job for ${job.repoName} crashed:`, errorMessage(err));
			for (const m of messages) m.retry();
		}
	}
}
