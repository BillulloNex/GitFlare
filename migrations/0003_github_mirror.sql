-- ─── GitHub Mirror Configuration ────────────────────────────────
-- One mirror per repo: stores GitHub URL, encrypted PAT, sync status.
-- Mirror pushes are triggered asynchronously after each successful push.

CREATE TABLE IF NOT EXISTS github_mirrors (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL UNIQUE,          -- one mirror per repo
    github_url TEXT NOT NULL,              -- e.g. https://github.com/user/repo.git
    github_token_encrypted TEXT NOT NULL,  -- PAT encrypted with AES-256-GCM
    is_enabled INTEGER NOT NULL DEFAULT 1,
    branch_filter TEXT,                    -- JSON array of branches, NULL = all
    last_sync_at TEXT,
    last_sync_status TEXT,                 -- 'success' | 'failed' | 'pending'
    last_sync_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_github_mirrors_repo ON github_mirrors(repo_id);

-- ─── Mirror Sync Log ───────────────────────────────────────────
-- History of every mirror sync attempt (push-triggered or manual).

CREATE TABLE IF NOT EXISTS mirror_sync_log (
    id TEXT PRIMARY KEY,
    mirror_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    status TEXT NOT NULL,                  -- 'success' | 'failed'
    error_message TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mirror_id) REFERENCES github_mirrors(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mirror_sync_log ON mirror_sync_log(mirror_id, created_at DESC);
