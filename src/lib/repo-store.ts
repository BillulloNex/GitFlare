/**
 * Repository Data Store for GitFlare
 * Provides GitHub-style tree browsing, file contents, commit history, and diffs.
 */

export interface CommitAuthor {
  name: string;
  email: string;
  avatar?: string;
}

export interface CommitSummary {
  sha: string;
  short_sha: string;
  message: string;
  description?: string;
  author: CommitAuthor;
  date: string;
  time_ago: string;
  ci_status?: 'passed' | 'failed' | 'running' | 'queued' | null;
  ci_run_id?: string | null;
  stats: {
    additions: number;
    deletions: number;
    total: number;
    files_changed: number;
  };
}

export interface CommitFileDiff {
  filename: string;
  status: 'modified' | 'added' | 'deleted';
  additions: number;
  deletions: number;
  patch: string;
}

export interface CommitDetail extends CommitSummary {
  parent_sha: string | null;
  parent_short_sha: string | null;
  files: CommitFileDiff[];
  /** Files past the inline diff limit. They are counted in stats.files_changed. */
  omitted_files?: number;
}

export interface TreeEntry {
  name: string;
  type: 'tree' | 'blob';
  path: string;
  size?: number;
  message: string;
  updated_at: string;
}

export interface Breadcrumb {
  name: string;
  path: string;
}

export interface TreeResult {
  repo: string;
  ref: string;
  path: string;
  breadcrumbs: Breadcrumb[];
  latest_commit: {
    sha: string;
    short_sha: string;
    message: string;
    author: CommitAuthor;
    date: string;
    time_ago: string;
  } | null;
  entries: TreeEntry[];
  readme?: {
    name: string;
    content: string;
  } | null;
}

export interface BlobResult {
  repo: string;
  ref: string;
  path: string;
  name: string;
  size: number;
  lines: number;
  content: string;
  is_binary: boolean;
  latest_commit: {
    sha: string;
    short_sha: string;
    message: string;
    author: CommitAuthor;
    date: string;
  };
}

// Commit, tree, and blob payloads are read from Cloudflare Artifacts.
// This module only defines the API shapes. It does not ship sample commits.
