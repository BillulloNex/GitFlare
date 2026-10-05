// ─── GitFlare API Client Types ──────────────────────────────────

export interface GitFlareConfig {
  baseUrl: string;
  apiKey: string;
}

// ─── Repo Types ─────────────────────────────────────────────────

export interface Repo {
  id: string;
  name: string;
  description: string | null;
  default_branch: string;
  is_private: number;
  artifact_name: string;
  created_at: string;
  updated_at: string;
  remote?: string | null;
}

export interface CreateRepoInput {
  name: string;
  description?: string;
  is_private?: boolean;
  default_branch?: string;
}

// ─── API Key Types ──────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  repo_id: string | null;
  user_id: string | null;
  permissions: 'read' | 'write' | 'admin';
  created_at: string;
  expires_at: string | null;
  last_used_at?: string | null;
}

export interface CreateKeyInput {
  name: string;
  permissions?: 'read' | 'write' | 'admin';
  repo_id?: string;
  expires_in_days?: number;
}

export interface CreatedKey extends ApiKey {
  key: string;
  message: string;
}

// ─── CI Types ───────────────────────────────────────────────────

export interface CIRun {
  id: string;
  repo_id: string;
  branch: string;
  commit_sha: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
  trigger: string;
  config?: unknown;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface CIJob {
  id: string;
  run_id: string;
  name: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
}

export interface CIJobLog {
  id: string;
  job_id: string;
  step_name: string;
  output: string;
  exit_code: number;
  duration_ms: number;
}

export interface TriggerCIInput {
  branch?: string;
  commit_sha?: string;
}

// ─── File Types ─────────────────────────────────────────────────

export interface TreeEntry {
  name: string;
  type: 'tree' | 'blob';
  path: string;
  size?: number;
}

export interface BlobContent {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  size: number;
}

// ─── Deploy Types ───────────────────────────────────────────────

export interface DeployTarget {
  id: string;
  repo_id: string;
  name: string;
  type: 'coolify' | 'cloudflare';
  coolify_app_id?: string;
  coolify_base_url?: string;
  branch_filter: string[];
  created_at: string;
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
  is_enabled: boolean;
  branch_filter: string[] | null;
  last_sync_at: string | null;
  last_sync_status: 'success' | 'failed' | 'pending' | null;
  last_sync_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SetupMirrorInput {
  github_url: string;
  github_token?: string;
  branch_filter?: string[];
}

// ─── Commit Types ───────────────────────────────────────────────

export interface Commit {
  sha: string;
  message: string;
  author: string;
  date: string;
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
    const msg = typeof body === 'object' && body && 'error' in body
      ? (body as { error: string }).error
      : statusText;
    super(`GitFlare API error ${status}: ${msg}`);
    this.name = 'GitFlareError';
  }
}
