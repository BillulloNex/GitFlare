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
  /** Only present on `repos.get`: Git LFS policy and usage. */
  lfs?: LfsSummary;
}

// ─── Git LFS Types ──────────────────────────────────────────────

/** `GET /api/repos/:repo/lfs` — everything a client needs to handle large files in a repo. */
export interface LfsSummary {
  enabled: boolean;
  /** presigned = bytes go straight to R2 (up to 5 GiB); proxy = through the Worker (zone body limit, 100 MB on Free/Pro). */
  transfer_mode: 'presigned' | 'proxy';
  max_object_bytes: number;
  object_count: number;
  total_bytes: number;
  pending_count: number;
  /** Patterns with `filter=lfs` in .gitattributes on the default branch. */
  tracked_patterns: string[];
  /** The LFS server URL git-lfs derives from the clone URL. */
  endpoint: string;
  docs_url: string;
  note: string;
}

export interface LfsObject {
  oid: string;
  size: number;
  state: 'pending' | 'ready';
  created_at: string;
}

export interface LfsObjectPage {
  data: LfsObject[];
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface LfsToken {
  token: string;
  scope: 'read' | 'write';
  expires_at: string;
  endpoint: string;
  usage: string;
}

/** Present on a blob that is a Git LFS pointer. */
export interface LfsBlobInfo {
  oid: string;
  /** Size of the real object (from the pointer), not of the pointer text. */
  size: number;
  state: 'ready' | 'pending' | 'missing';
  download_url: string;
  note: string;
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
  /** True when `content` is a Git LFS pointer; see `lfs` for the real object. */
  is_lfs?: boolean;
  lfs?: LfsBlobInfo;
  latest_commit: LatestCommit;
}

// ─── Deploy Types ───────────────────────────────────────────────

export type DeployTargetType = 'coolify' | 'cloudflare' | 'cloudrun';

/** A row of `deploy_targets` (stored secrets are never returned). */
export interface DeployTarget {
  id: string;
  repo_id: string;
  name: string;
  type: DeployTargetType;
  is_active: number;
  coolify_app_id: string | null;
  coolify_base_url: string | null;
  /** Cloudflare: path to the wrangler config file, or null for the default. */
  wrangler_config: string | null;
  /** Cloud Run: GCP project id, region and service name. */
  gcp_project_id: string | null;
  gcp_region: string | null;
  gcp_service: string | null;
  /** JSON-encoded array of branch patterns; null = all branches. */
  branch_filter: string | null;
  has_coolify_api_key: boolean;
  has_gcp_service_account_key: boolean;
  created_at: string;
  updated_at: string;
  [column: string]: unknown;
}

export interface CreateDeployInput {
  name: string;
  type: DeployTargetType;
  /** Coolify */
  coolify_app_id?: string;
  coolify_base_url?: string;
  coolify_api_key?: string;
  /** Cloudflare */
  wrangler_config?: string;
  /** Cloud Run (project, region and service are required for `cloudrun`). */
  gcp_project_id?: string;
  gcp_region?: string;
  gcp_service?: string;
  /** Service-account JSON key; omit to use the runner's GCP_SERVICE_ACCOUNT_KEY. */
  gcp_service_account_key?: string;
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

// ─── Diary ──────────────────────────────────────────────────────

/** A photo or video on a diary entry. `url` is repo-relative; fetch it with the same credentials. */
export interface DiaryMedia {
  id: string;
  kind: 'image' | 'video';
  filename: string;
  content_type: string;
  size: number;
  status: 'pending' | 'ready';
  url: string;
}

/** One diary post: text plus media at the moment it happened. */
export interface DiaryEntry {
  id: string;
  text: string;
  /** ISO-8601 UTC. */
  happened_at: string;
  author: string;
  author_id: string | null;
  created_at: string;
  updated_at: string;
  media: DiaryMedia[];
}

export interface DiaryPage {
  data: DiaryEntry[];
  /** Pass as `cursor` for the next page; null at the end. */
  next_cursor: string | null;
  total: number;
}

export interface CreateDiaryEntryInput {
  text?: string;
  /** ISO-8601 with a time zone. Defaults to now. */
  happened_at?: string;
  /** Ids from `diary.upload`, in display order. */
  media_ids?: string[];
}

// ─── AI Traces ──────────────────────────────────────────────────

/** One message or tool call in an agent session. */
export interface TraceStep {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  /** Tool name, for role = tool. */
  name?: string;
  at?: string;
}

export interface TraceRefs {
  commits?: string[];
  branch?: string;
  ci_run_id?: string;
}

/** One AI agent session logged on a repo. `steps` is present on get/create, not in lists. */
export interface Trace {
  id: string;
  session_id: string | null;
  agent: string;
  model: string | null;
  title: string;
  summary: string;
  started_at: string;
  ended_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  refs: TraceRefs | null;
  step_count: number;
  author: string;
  author_id: string | null;
  created_at: string;
  updated_at: string;
  steps?: TraceStep[];
}

export interface TraceUsage {
  count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface TracePage {
  data: Trace[];
  next_cursor: string | null;
  /** Whole repo, regardless of filters. */
  totals: TraceUsage & { by_agent: (TraceUsage & { agent: string })[] };
}

export interface LogTraceInput {
  /** Re-posting the same session_id replaces that trace. */
  session_id?: string;
  agent: string;
  model?: string;
  title: string;
  summary?: string;
  /** ISO-8601 with a time zone. Defaults to now. */
  started_at?: string;
  ended_at?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  refs?: TraceRefs;
  steps?: TraceStep[];
}

// ─── Tables ─────────────────────────────────────────────────────

/** A data table: `tables/<name>.csv` on a branch. Every cell is text. */
export interface TableSummary {
  name: string;
  path: string;
  /** Git blob id of the CSV; pass as `base_blob` when saving. */
  blob: string;
  last_change: { sha: string; message: string; author: string; date: string } | null;
}

export interface TableList {
  ref: string;
  commit: string | null;
  tables: TableSummary[];
}

export interface Table {
  name: string;
  path: string;
  ref: string;
  /** Commit the table was read at. */
  commit: string;
  blob: string;
  columns: string[];
  rows: string[][];
}

export interface SaveTableInput {
  /** Default: the repo's default branch. */
  branch?: string;
  columns?: string[];
  rows?: (string | number | boolean | null)[][];
  /** CSV text instead of columns + rows (header row first). */
  csv?: string;
  message?: string;
  /** Blob you loaded (409 if the table changed since); null = create only; omit = overwrite. */
  base_blob?: string | null;
  rename_to?: string;
}

export interface SavedTable {
  name: string;
  path: string;
  branch: string;
  commit: string;
  blob: string | null;
  unchanged: boolean;
}

export interface TableHistoryEntry {
  sha: string;
  parent: string | null;
  message: string;
  author: { name: string; email: string };
  date: string;
  changes: { table: string; kind: 'added' | 'modified' | 'deleted' | 'renamed'; from?: string; blob: string | null }[];
}

export interface TableHistory {
  ref: string;
  head: string | null;
  truncated: boolean;
  commits: TableHistoryEntry[];
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
