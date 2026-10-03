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
	/** Create a scoped, short-lived token for Git CLI access */
	createToken(
		permission: "read" | "write" | "admin",
		ttlSeconds: number
	): Promise<string>;
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

// ─── Sandbox Binding Types ──────────────────────────────────────
// Cloudflare Sandboxes: Isolated container execution

export type SandboxTier =
	| "lite"
	| "basic"
	| "standard-1"
	| "standard-2"
	| "standard-3"
	| "standard-4";

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface SandboxInstance {
	/** Execute a command in the sandbox */
	exec(command: string, options?: { timeout?: number; env?: Record<string, string>; cwd?: string }): Promise<ExecResult>;
	/** Get a WebSocket connection to the sandbox terminal */
	terminal(): WebSocket;
	/** Mount an Artifacts repo into the sandbox filesystem */
	mount(artifact: ArtifactRepo, path: string): Promise<void>;
	/** Destroy the sandbox instance */
	destroy(): Promise<void>;
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

	// ── Durable Objects ──
	REPO_COORDINATOR: DurableObjectNamespace;
	CI_SESSION: DurableObjectNamespace;

	// ── AI ──
	AI: Ai;

	// ── Secrets (set via `wrangler secret put`) ──
	JWT_SECRET: string;
	COOLIFY_API_KEY: string;
	COOLIFY_BASE_URL: string;
	ADMIN_API_KEY: string;

	// ── Vars (from wrangler.jsonc) ──
	GITFLARE_VERSION: string;
	DEFAULT_SANDBOX_TIER: string;
	MAX_CI_DURATION_MS: string;
	RUNNER_URL: string;
	RUNNER_SECRET: string;
}

// ─── Queue Message Types ────────────────────────────────────────

export interface CIJobMessage {
	runId: string;
	repoId: string;
	repoName: string;
	branch: string;
	commitSha: string;
	config: CIPipelineConfig;
	trigger: "push" | "pull_request" | "manual" | "schedule";
}

export interface DeployJobMessage {
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
	on: CITriggerConfig;
	env?: Record<string, string>;
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
	sandbox?: SandboxTier;
	needs?: string[];
	env?: Record<string, string>;
	steps: CIStepConfig[];
	deploy?: {
		target: "coolify" | "cloudflare";
		app_id?: string;
		branch_filter?: string[];
	};
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
	type: "coolify" | "cloudflare";
	coolifyAppId?: string;
	coolifyBaseUrl?: string;
	coolifyApiKey?: string;
	wranglerConfig?: string;
	branchFilter?: string[];
}

// ─── API Response Types ─────────────────────────────────────────

export interface RepoRecord {
	id: string;
	name: string;
	description: string | null;
	default_branch: string;
	is_private: boolean;
	created_at: string;
	updated_at: string;
}

export interface CIRunRecord {
	id: string;
	repo_id: string;
	branch: string;
	commit_sha: string;
	status: "queued" | "running" | "passed" | "failed" | "cancelled";
	trigger: string;
	started_at: string | null;
	finished_at: string | null;
	created_at: string;
}

export interface APIKeyRecord {
	id: string;
	name: string;
	repo_id: string | null; // null = all repos
	permissions: string; // "read" | "write" | "admin"
	created_at: string;
	expires_at: string | null;
}

/** Alias for downstream modules that import as ApiKey */
export type ApiKey = APIKeyRecord;
