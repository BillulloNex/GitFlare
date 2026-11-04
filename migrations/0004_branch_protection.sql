-- ─── Branch Protection ──────────────────────────────────────────
-- Protected branches can only be pushed to via the merge queue.
-- Direct pushes are rejected by the git-receive-pack handler.

CREATE TABLE IF NOT EXISTS protected_branches (
	id TEXT PRIMARY KEY,
	repo_id TEXT NOT NULL,
	branch_pattern TEXT NOT NULL,  -- exact name ("main") or glob ("release/*")
	enforce_merge_queue INTEGER NOT NULL DEFAULT 1,  -- require ticket queue
	allow_force_push INTEGER NOT NULL DEFAULT 0,
	allow_deletion INTEGER NOT NULL DEFAULT 0,
	bypass_actors TEXT,  -- JSON array of api_key IDs that can bypass protection
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE,
	UNIQUE(repo_id, branch_pattern)
);
CREATE INDEX IF NOT EXISTS idx_protected_branches_repo ON protected_branches(repo_id);

-- Auto-protect main for all existing repos
INSERT OR IGNORE INTO protected_branches (id, repo_id, branch_pattern)
SELECT 
	lower(hex(randomblob(16))),
	id,
	'main'
FROM repositories;
