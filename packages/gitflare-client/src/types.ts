// ─── GitFlare API Client Types ──────────────────────────────────
// These mirror the payloads the REST API actually returns (after the client
// strips the `{ data: ... }` / `{ repos: ... }` / `{ keys: ... }` envelopes).

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitFlareConfig {
  baseUrl: string;
  apiKey: string;
  /**
   * Optional fetch implementation. Defaults to the global `fetch`.
   * The Worker's `/mcp` route injects one that dispatches in-process.
   */
  fetch?: FetchLike;
  /**
   * Extra headers sent on every request. When set, `apiKey` may be empty and
   * the caller is responsible for authentication (e.g. forwarding a session
   * cookie). `Authorization` here overrides the one derived from `apiKey`.
   */
  headers?: Record<string, string>;
}

export type PermissionLevel = 'read' | 'write' | 'admin';

// ─── Repo Types ─────────────────────────────────────────────────

export interface Repo {
  id: string;
  name: string;
  description: string | null;
  default_branch: string;
  /** D1 stores booleans as 0/1. */
  is_private: number;
  artifact_name: string;
  created_at: string;
  updated_at: string;
  /** Only present on `repos.get`. */
  remote?: string | null;
}

export interface CreateRepoInput {
  name: string;
  description?: string;
  is_private?: boolean;
  default_branch?: string;
}

export interface CreatedRepo {
  id: string;
  name: string;
}

// ─── API Key Types ──────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  repo_id: string | null;
  user_id: string | null;
  permissions: PermissionLevel;
  created_at: string;
  expires_at: string | null;
  last_used_at?: string | null;
}

export interface CreateKeyInput {
  name: string;
  permissions?: PermissionLevel;
  repo_id?: string;
  expires_in_days?: number;
}

/** `POST /api/keys` — the raw key is only ever returned here. */
export interface CreatedKey {
  id: string;
  key: string;
  key_prefix: string;
  permissions: PermissionLevel;
  repo_id: string | null;
  user_id: string | null;
  expires_at: string | null;
  message: string;
}

// ─── CI Types ───────────────────────────────────────────────────

export type CIStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
export type CIStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'cancelled' | 'skipped';

export interface CommitAuthor {
  name: string;
  email: string;
  avatar?: string;
}

/** A row of `ci_runs`. */
export interface CIRunRecord {
  id: string;
  repo_id: string;
  branch: string;
  commit_sha: string;
  status: CIStatus;
  trigger: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  [column: string]: unknown;
}

/** `GET /ci/runs` item: the run row enriched with commit metadata. */
export interface CIRun extends CIRunRecord {
  short_sha: string;
  commit_message: string;
  author: CommitAuthor;
  duration_ms: number;
  duration_text: string;
  time_ago: string;
}

export interface LogLine {
  timestamp: string;
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface CIStep {
  id: string;
  name: string;
  command: string;
  status: CIStepStatus;
  duration: string;
  exit_code: number | null;
  started_at: string | null;
  finished_at: string | null;
  /** Truncated tail (last ~50 lines). Use `ci.stepLog` for the full log. */
  logs: LogLine[];
}

export interface CIJob {
  id: string;
  name: string;
  sandbox: string | null;
  status: CIStatus;
  duration: string;
  steps: CIStep[];
}

/** A row of `ci_steps` as stored. `logs` is the JSON-encoded tail. */
export interface CIRawStep {
  id: string;
  run_id: string;
  job_name: string | null;
  step_index: number;
  global_ordinal: number | null;
  name: string | null;
  command: string;
  status: CIStepStatus;
  exit_code: number | null;
  logs: string | null;
  [column: string]: unknown;
}

export interface CIRunDeployment {
  id: string;
  target_id: string;
  target_name: string | null;
  target_type: string | null;
  coolify_app_id: string | null;
  coolify_deployment_id: string | null;
  /** pending | deploying | success | failed | rolled_back */
  status: string;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
}

/** `GET /ci/runs/:id` */
export interface CIRunDetail extends CIRun {
  /** The deployment recorded for this run, or null if none was made. */
  deployment: CIRunDeployment | null;
  jobs: CIJob[];
  raw_steps: CIRawStep[];
}

/** One step's log tail, flattened across jobs (`ci.logs`). */
export interface CIStepLogTail {
  /** Run-wide step index — pass to `ci.stepLog` for the full log. */
  index: number;
  job_name: string;
  name: string;
  status: CIStepStatus;
  exit_code: number | null;
  logs: LogLine[];
}

/** `GET /ci/runs/:id/logs/:stepIndex` — full log from R2 (or the tail if R2 has none yet). */
export interface CIStepLog {
  run_id: string;
  step_id: string;
  step_index: number;
  job_name: string;
  name: string;
  status: CIStepStatus;
  source: 'r2' | 'tail';
  /** false when only the inline tail was available. */
  complete: boolean;
  line_count: number;
  logs: LogLine[];
}

export interface TriggerCIInput {
  branch?: string;
  commit_sha?: string;
  /** Inline CI config. Requires admin access to the repository. */
  config_yaml?: string;
}

export interface TriggeredRun {
  id: string;
  status: 'queued';
  branch: string;
  commitSha: string;
}

export interface CancelledRun {
  id: string;
  status: 'cancelled';
  runner: { notified: boolean; error?: string };
}

// ─── File Types ─────────────────────────────────────────────────

export interface TreeEntry {
  name: string;
  type: 'tree' | 'blob';
  path: string;
  size?: number;
  message: string;
  updated_at: string;
}

export interface LatestCommit {
  sha: string;
  short_sha: string;
  message: string;
  author: CommitAuthor;
  date: string;
  time_ago?: string;
}

export interface Tree {
  repo: string;
  ref: string;
  path: string;
  breadcrumbs: { name: string; path: string }[];
  latest_commit: LatestCommit | null;
  entries: TreeEntry[];
  readme?: { name: string; content: string } | null;
}

export interface BlobContent {
  repo: string;
  ref: string;
  path: string;
  name: string;
  size: number;
  lines: number;
  content: string;
  is_binary: boolean;
  latest_commit: LatestCommit;
}

// ─── Deploy Types ───────────────────────────────────────────────

/** A row of `deploy_targets` (the Coolify API key is never returned). */
export interface DeployTarget {
  id: string;
  repo_id: string;
  name: string;
  type: 'coolify' | 'cloudflare';
  is_active: number;
  coolify_app_id: string | null;
  coolify_base_url: string | null;
  /** JSON-encoded array of branch patterns; null = all branches. */
  branch_filter: string | null;
  has_coolify_api_key: boolean;
  created_at: string;
  updated_at: string;
  [column: string]: unknown;
}

export interface CreateDeployInput {
  name: string;
  type: 'coolify' | 'cloudflare';
  coolify_app_id?: string;
  coolify_base_url?: string;
  coolify_api_key?: string;
  branch_filter?: string[];
}

// ─── Mirror Types ───────────────────────────────────────────────

export interface Mirror {
  id: string;
  repo_id: string;
  github_url: string;
  /** D1 stores booleans as 0/1. */
  is_enabled: number;
  branch_filter: string[] | null;
  last_sync_at: string | null;
  last_sync_status: 'success' | 'failed' | 'pending' | null;
  last_sync_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SetupMirrorInput {
  github_url: string;
  github_token: string;
  branch_filter?: string[];
  is_enabled?: boolean;
}

export interface MirrorSetupResult {
  id: string;
  github_url: string;
  github_repo: string;
  message: string;
}

/** `POST /mirror/sync` (202). */
export interface MirrorSyncResult {
  message: string;
  /** true when handed to the mirror queue, false when run inline via waitUntil. */
  queued: boolean;
  /** Ref name → SHA being pushed. */
  refs: Record<string, string>;
}

// ─── Commit Types ───────────────────────────────────────────────

export interface Commit {
  sha: string;
  short_sha: string;
  message: string;
  description?: string;
  author: CommitAuthor;
  date: string;
  time_ago: string;
  ci_status?: 'passed' | 'failed' | 'running' | 'queued' | null;
  ci_run_id?: string | null;
  stats: { additions: number; deletions: number; total: number; files_changed: number };
}

// ─── Health ─────────────────────────────────────────────────────

export interface HealthResponse {
  service: string;
  status: string;
  version: string;
}

// ─── API Error ──────────────────────────────────────────────────

export class GitFlareError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: unknown,
  ) {
    let msg = statusText;
    if (typeof body === 'object' && body && 'error' in body) {
      const b = body as { error: unknown; details?: unknown };
      msg = String(b.error);
      if (typeof b.details === 'string' && b.details) msg += `: ${b.details}`;
    } else if (typeof body === 'string' && body) {
      msg = body;
    }
    super(`GitFlare API error ${status}: ${msg}`);
    this.name = 'GitFlareError';
  }
}
