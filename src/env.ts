// ─── GitFlare Environment Bindings ──────────────────────────────
// All Cloudflare resource bindings available to the Worker

// ─── Artifacts Binding Types ────────────────────────────────────
// Cloudflare Artifacts: Git-native storage engine
// These types reflect the Artifacts API as documented in the 2026 beta

export interface ArtifactRepo {
	/** Repository name (e.g., "starship") */
	readonly name: string;
	/** Git remote URL for this artifact */
	readonly remote: string;
	info(): Promise<{ defaultBranch: string }>;
	log(options?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactCommit[]>;
	readTree(hash: string): Promise<ArtifactTreeEntry[] | null>;
	/** Raw bytes of a blob by object id; null if missing or not a blob. */
	readBlob(hash: string): Promise<Blob | null>;
	readCommit(hash: string): Promise<ArtifactCommit | null>;
	readFile(options: { ref: string; path: string }): Promise<Blob | null>;
	/** Create a scoped, short-lived token for Git CLI access */
	createToken(
		permission: "read" | "write" | "admin",
		ttlSeconds: number
	): Promise<string>;
}

export interface ArtifactTreeEntry {
	name: string;
	mode: string;
	hash: string;
	type: 'tree' | 'blob' | 'symlink' | 'gitlink' | 'exec';
}

export interface ArtifactCommit {
	hash: string;
	treeHash: string;
	message: string;
	author: { name: string; email: string };
	committer: { name: string; email: string };
	parents: string[];
	authoredAt: number;
	committedAt: number;
}

export interface ArtifactNamespace {
	/** Get an existing repository */
	get(name: string): Promise<ArtifactRepo | null>;
	/** Create a new repository, returns remote URL and initial admin token */
	create(name: string): Promise<{ remote: string; token: string }>;
	/** List all repositories in this namespace */
	list(): Promise<ArtifactRepo[]>;
	/** Delete a repository */
	delete(name: string): Promise<void>;
}

// ─── Worker Environment ─────────────────────────────────────────

export interface Env {
	// ── Git Storage ──
	REPOS: ArtifactNamespace;

	// ── Metadata Database ──
	DB: D1Database;

	// ── Large File / Build Artifact Storage ──
	STORAGE: R2Bucket;

	// ── Cache ──
	CACHE: KVNamespace;

	// ── Job Queues ──
	CI_QUEUE: Queue<CIJobMessage>;
	DEPLOY_QUEUE: Queue<DeployJobMessage>;
	// Consumers may still receive LegacyDeployJobMessage bodies (see below).
	/** GitHub mirror jobs (lib/github-mirror.ts). Runtime-guarded: falls back to inline sync if absent. */
	MIRROR_QUEUE: Queue<MirrorSyncMessage>;

	// ── Durable Objects ──
	/** Per-repo push locks (src/do/repo-coordinator.ts). */
	REPO_COORDINATOR: DurableObjectNamespace;
	/** Per-repo merge queue state machine (src/do/ticket-queue.ts). */
	TICKET_QUEUE: DurableObjectNamespace;

	// ── Secrets (set via `wrangler secret put`) ──
	/** Fallback Coolify credentials for deploy targets without their own (optional). */
	COOLIFY_API_KEY?: string;
	COOLIFY_BASE_URL?: string;
	/** Guards /api/bootstrap. */
	ADMIN_API_KEY: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	/** Session signing + legacy (pre-v1) secret decryption. Keep until every stored secret is `v1:`. */
	SESSION_SECRET: string;
	/** Key material for encryptSecret/decryptSecret (HKDF → AES-256-GCM, `v1:` format). */
	ENCRYPTION_KEY: string;
	/** GitFlare GitHub App credentials. Configure after registering the app. */
	GITHUB_APP_ID?: string;
	GITHUB_APP_SLUG?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
	GITHUB_APP_CLIENT_ID?: string;
	GITHUB_APP_CLIENT_SECRET?: string;

	// ── Vars (from wrangler.jsonc) ──
	GITFLARE_VERSION: string;
	/** Hard cap on a CI run before maintenance fails it (ms, as a string). */
	MAX_CI_DURATION_MS: string;
	/** Public origin of this Worker, e.g. https://git.example.com — CORS, OAuth redirect, runner callbacks. */
	APP_URL: string;
	/** Used to build Artifacts remote URLs (lib/artifacts-url.ts) and R2 S3 presigned URLs (lib/r2-presign.ts). */
	CLOUDFLARE_ACCOUNT_ID: string;

	// ── Git LFS (src/api/lfs.ts) ──
	/** Global per-object cap in bytes. Unset → 5 GiB with presigned transfers, 100 MB when proxied through the Worker. */
	LFS_MAX_OBJECT_BYTES?: string;
	/** Lifetime of transfer actions / presigned URLs in seconds (default 900). */
	LFS_URL_TTL_SECONDS?: string;
	/** R2 bucket behind the STORAGE binding; needed to build S3 URLs (default gitflare-storage). */
	R2_BUCKET_NAME?: string;
	/** R2 API token (secrets). When both are set, LFS bytes go straight to R2 via presigned URLs. */
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;

	// ── Runner (secrets) ──
	/** Base URL of the external runner service (packages/runner). */
	RUNNER_URL: string;
	/** Shared bearer secret between Worker and runner (both directions). */
	RUNNER_SECRET: string;

	// ── Login policy (optional) ──
	/** Comma-separated email domains allowed to sign in (e.g. "example.com,example.org"). Unset → anyone, as `viewer`. */
	ALLOWED_DOMAINS?: string;
	/** Comma-separated emails granted the `admin` role on login (verified emails only). */
	ADMIN_EMAILS?: string;

	// ── Diagnostics (optional) ──
	/** "1"/"true" → hex-dump git receive-pack request headers and Artifacts responses to the log (src/api/git.ts). */
	GIT_PROTOCOL_DEBUG?: string;
}

// ─── Queue Message Types ────────────────────────────────────────

export interface CIJobMessage {
	runId: string;
	repoId: string;
	repoName: string;
	branch: string;
	commitSha: string;
	config: CIPipelineConfig;
	/** `merge_queue`: CI gate on a merge-queue result branch (B4.3) — never deploys the result branch itself. */
	trigger: "push" | "pull_request" | "manual" | "schedule" | "merge_queue";
}

/**
 * Deploy queue message (B1.2). Carries ids only — never credentials. The
 * consumer loads the target from D1 and decrypts its Coolify key on use.
 */
export interface DeployJobMessage {
	/** deployments.id */
	deploymentId: string;
	/** deploy_targets.id */
	targetId: string;
	/** ci_runs.id that triggered this deploy (null for manual deploys) */
	ciRunId: string | null;
	repoId: string;
	repoName: string;
	branch: string;
	commitSha: string;
}

/**
 * Pre-B1 deploy message shape. Messages already sitting in the queue at
 * cutover look like this: `runId` is the deployments.id and `target` may hold
 * a PLAINTEXT Coolify key (which the consumer ignores — it re-reads from D1).
 */
export interface LegacyDeployJobMessage {
	runId: string;
	repoId: string;
	repoName: string;
	branch: string;
	commitSha: string;
	target: DeployTarget;
}

// ─── CI Pipeline Config (.gitflare/ci.yml) ──────────────────────

export interface CIPipelineConfig {
	name: string;
	/** Optional — omitted means "run on every push" (lib/ci-parser.ts shouldTrigger). */
	on?: CITriggerConfig;
	/** CI compute preference, optionally overridden by each job. */
	'runs-on'?: string | string[];
	env?: Record<string, string>;
	/**
	 * Checkout options. `lfs`: `auto` (default) pulls LFS objects when
	 * .gitattributes tracks any and git-lfs is in the job image; `true` fails
	 * the checkout if git-lfs is missing; `false` leaves pointer files.
	 */
	checkout?: { lfs?: 'auto' | boolean };
	jobs: Record<string, CIJobConfig>;
}

export interface CITriggerConfig {
	push?: { branches?: string[] };
	pull_request?: { branches?: string[] };
	schedule?: string; // cron expression
	manual?: boolean;
}

export interface CIJobConfig {
	name?: string;
	'runs-on'?: string | string[];
	needs?: string[];
	env?: Record<string, string>;
	steps: CIStepConfig[];
	// Deploys are not configured here: a passing run fans out to the repo's
	// deploy targets whose branch_filter matches (lib/deploy-targets.ts).
}

export interface CIStepConfig {
	name?: string;
	run?: string;
	env?: Record<string, string>;
	timeout?: number; // seconds
}

// ─── Deploy Target ──────────────────────────────────────────────

export interface DeployTarget {
	id: string;
	type: "coolify" | "cloudflare" | "cloudrun";
	coolifyAppId?: string;
	coolifyBaseUrl?: string;
	coolifyApiKey?: string;
	wranglerConfig?: string;
	gcpProjectId?: string;
	gcpRegion?: string;
	gcpService?: string;
	branchFilter?: string[];
}

// ─── API Response Types ─────────────────────────────────────────

export interface RepoRecord {
	id: string;
	owner_id?: string | null;
	name: string;
	description: string | null;
	default_branch: string;
	is_private: boolean;
	created_at: string;
	updated_at: string;
	/** 0/1 — whether LFS uploads are accepted (downloads always work). */
	lfs_enabled?: number;
	/** Per-repo LFS object cap; null → the Worker's global default. */
	lfs_max_object_bytes?: number | null;
}

export interface ApiKey {
	id: string;
	name: string;
	repo_id: string | null; // null = all repos
	user_id: string | null;
	permissions: string; // "read" | "write" | "admin"
	created_at: string;
	expires_at: string | null;
}

// ─── User Types ─────────────────────────────────────────────────

export interface UserRecord {
    id: string;
    google_id: string | null;
    email: string;
    name: string;
    avatar_url: string | null;
    /** viewer → read, user → write, admin → admin */
    role: 'viewer' | 'user' | 'admin';
    created_at: string;
    updated_at: string;
}

// ─── GitHub Mirror Types ────────────────────────────────────────

/**
 * `gitflare-mirror-sync` queue message (B3.6). Carries ids and ref names only —
 * never the GitHub URL or token (the consumer re-reads and decrypts the
 * current mirror config from D1) and never SHAs (resolved from Artifacts at
 * run time, so a delayed job mirrors the latest state).
 */
export interface MirrorSyncMessage {
    repoId: string;
    repoName: string;
    /** Bare branch names (`main`, as git.ts sends) or full refs (`refs/tags/v1`). */
    refs: string[];
    trigger: 'push' | 'manual';
    /** ISO timestamp of when the sync was requested. */
    requestedAt: string;
}
