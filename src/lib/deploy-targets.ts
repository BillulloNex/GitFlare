/**
 * Deploy target helpers shared by the REST API, MCP, the CI callback and the
 * deploy queue consumer.
 */
import type { DeployJobMessage, Env } from '../env.ts';
import { getArtifactRefs } from './artifact-reader.ts';
import { matchesBranchFilter } from './branch-pattern.ts';
import { decryptSecret, encryptSecret, legacyDecryptToken } from './crypto.ts';

// ─── Coolify API key storage ────────────────────────────────────

/** Encrypt a Coolify API key for `deploy_targets.coolify_api_key_encrypted`. */
export function encryptCoolifyApiKey(env: Env, plaintext: string): Promise<string> {
	return encryptSecret(plaintext, env.ENCRYPTION_KEY);
}

/**
 * TOLERANT reader — B1.2 step 1 of the two-step Coolify key rollout.
 *
 * Stored values are currently mixed: `v1:` (written by this batch), legacy
 * AES-GCM (none known, but possible), and PLAINTEXT (everything written by
 * deploy.ts / MCP before B1). Order: `v1:` → legacy → plaintext.
 *
 * Once scripts/b1-migrate-coolify-keys.ts --verify reports every row as v1,
 * switch this to strict `decryptSecret` (step 2) and delete the fallbacks.
 */
export async function readCoolifyApiKey(env: Env, stored: string | null | undefined): Promise<string | null> {
	if (!stored) return null;
	if (stored.startsWith('v1:')) {
		// A v1 value that fails to decrypt is a real error (wrong ENCRYPTION_KEY) — don't mask it.
		return decryptSecret(stored, env.ENCRYPTION_KEY);
	}
	if (env.SESSION_SECRET) {
		try {
			return await legacyDecryptToken(stored, env.SESSION_SECRET);
		} catch {
			// not legacy ciphertext — fall through
		}
	}
	// TODO(B1.2 step 2): remove once all rows are v1.
	return stored;
}

// ─── Google Cloud Run service-account key storage ───────────────

/** Encrypt a GCP service-account key (JSON) for `deploy_targets.gcp_service_account_key_encrypted`. */
export function encryptGcpServiceAccountKey(env: Env, plaintext: string): Promise<string> {
	return encryptSecret(plaintext, env.ENCRYPTION_KEY);
}

/** Strict reader: Cloud Run targets were introduced after `v1:` encryption, so there is no legacy shape. */
export async function readGcpServiceAccountKey(env: Env, stored: string | null | undefined): Promise<string | null> {
	if (!stored) return null;
	return decryptSecret(stored, env.ENCRYPTION_KEY);
}

/**
 * A service-account key must be a JSON object of `type: "service_account"`
 * with the fields gcloud needs. Returns the normalised JSON or null.
 */
export function normaliseGcpServiceAccountKey(raw: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const key = parsed as Record<string, unknown>;
	if (key.type !== 'service_account') return null;
	for (const field of ['project_id', 'client_email', 'private_key']) {
		if (typeof key[field] !== 'string' || !key[field]) return null;
	}
	return JSON.stringify(key);
}

// ─── Validation ─────────────────────────────────────────────────

/** GCP project id: 6–30 chars, lowercase letters, digits, hyphens; starts with a letter. */
export function isValidGcpProjectId(value: string): boolean {
	return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
}

/** Cloud Run region, e.g. `us-central1`, `europe-west4`, `asia-northeast1`. */
export function isValidGcpRegion(value: string): boolean {
	return /^[a-z]+-[a-z]+[0-9]$/.test(value) && value.length <= 40;
}

/** Cloud Run service name: 1–49 chars, lowercase letters, digits, hyphens; starts with a letter, no trailing hyphen. */
export function isValidCloudRunService(value: string): boolean {
	return /^[a-z]([a-z0-9-]{0,47}[a-z0-9])?$/.test(value);
}

/**
 * Wrangler config path: relative, no traversal, no leading dash (would be read
 * as a flag), conservative charset. The runner passes it as a separate argv
 * entry (never through a shell) and re-validates.
 */
export function isValidWranglerConfig(path: string): boolean {
	return (
		path.length > 0 &&
		path.length <= 200 &&
		/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(path) &&
		!path.split('/').some((seg) => seg === '..' || seg === '')
	);
}

export const DEPLOY_TARGET_TYPES = ['coolify', 'cloudflare', 'cloudrun'] as const;
export type DeployTargetType = (typeof DEPLOY_TARGET_TYPES)[number];

export function isDeployTargetType(value: unknown): value is DeployTargetType {
	return typeof value === 'string' && (DEPLOY_TARGET_TYPES as readonly string[]).includes(value);
}

/** Parse deploy_targets.branch_filter (JSON array or NULL). NULL → all branches. */
export function parseBranchFilter(raw: unknown): string[] | null {
	if (raw == null || raw === '') return null;
	try {
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === 'string');
	} catch {
		// fall through
	}
	// Unparseable filter: match nothing rather than deploying everywhere.
	return [];
}

export function targetMatchesBranch(branchFilterRaw: unknown, branch: string): boolean {
	const filter = parseBranchFilter(branchFilterRaw);
	return filter === null || matchesBranchFilter(filter, branch);
}

// ─── Commit resolution ──────────────────────────────────────────

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

export function isFullSha(value: string | null | undefined): boolean {
	return !!value && FULL_SHA_RE.test(value);
}

/**
 * Resolve `HEAD` (or an empty/short value) to the branch tip SHA via the
 * Artifacts refs advertisement. Returns null if the branch doesn't exist.
 * Throws if Artifacts is unreachable (callers treat that as transient).
 */
export async function resolveCommitSha(env: Env, repoName: string, branch: string, commitSha?: string | null): Promise<string | null> {
	if (commitSha && isFullSha(commitSha)) return commitSha.toLowerCase();
	const refs = await getArtifactRefs(env, repoName);
	const tip = refs.get(`refs/heads/${branch}`) ?? null;
	if (!tip) return null;
	// A short SHA is only accepted if it is a prefix of the branch tip.
	if (commitSha && commitSha !== 'HEAD' && !tip.startsWith(commitSha.toLowerCase())) return null;
	return tip;
}

// ─── Post-CI deploy fan-out ─────────────────────────────────────

/**
 * After a CI run passes: create a `deployments` row for every active target
 * whose branch filter matches, and enqueue it on DEPLOY_QUEUE. Messages carry
 * only ids — credentials are read from D1 (and decrypted) by the consumer.
 *
 * Idempotent per (ci_run_id, target_id).
 */
export async function enqueueDeploysForRun(
	env: Env,
	run: { id: string; repo_id: string; branch: string; commit_sha: string },
	repoName: string
): Promise<string[]> {
	const { DB, DEPLOY_QUEUE } = env;
	const { results: targets } = await DB.prepare('SELECT id, branch_filter FROM deploy_targets WHERE repo_id = ? AND is_active = 1')
		.bind(run.repo_id)
		.all<{ id: string; branch_filter: string | null }>();

	const matching = targets.filter((t) => targetMatchesBranch(t.branch_filter, run.branch));
	if (matching.length === 0) return [];

	const now = new Date().toISOString();
	const messages: DeployJobMessage[] = [];
	for (const target of matching) {
		const deploymentId = crypto.randomUUID();
		const inserted = await DB.prepare(
			`INSERT INTO deployments (id, repo_id, target_id, ci_run_id, branch, commit_sha, status, created_at)
			 SELECT ?, ?, ?, ?, ?, ?, 'queued', ?
			 WHERE NOT EXISTS (SELECT 1 FROM deployments WHERE ci_run_id = ? AND target_id = ?)`
		)
			.bind(deploymentId, run.repo_id, target.id, run.id, run.branch, run.commit_sha, now, run.id, target.id)
			.run();
		if (!inserted.meta.changes) continue;
		messages.push({
			deploymentId,
			targetId: target.id,
			ciRunId: run.id,
			repoId: run.repo_id,
			repoName,
			branch: run.branch,
			commitSha: run.commit_sha,
		});
	}

	if (messages.length > 0) {
		await DEPLOY_QUEUE.sendBatch(messages.map((body) => ({ body })));
	}
	return messages.map((m) => m.deploymentId);
}
