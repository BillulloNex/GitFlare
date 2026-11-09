-- Account-owned GitHub compute connections. Existing repositories belong to
-- their earliest admin member; system-created repositories remain unassigned.
ALTER TABLE repositories ADD COLUMN owner_id TEXT REFERENCES users(id);
UPDATE repositories SET owner_id = (
  SELECT u.id FROM audit_log a JOIN users u ON u.id = a.actor
  WHERE a.repo_id = repositories.id AND a.action = 'repo.create'
  ORDER BY a.created_at ASC LIMIT 1
);
UPDATE repositories SET owner_id = (
  SELECT rm.user_id FROM repo_members rm
  WHERE rm.repo_id = repositories.id AND rm.role = 'admin'
  ORDER BY rm.created_at ASC, rm.user_id ASC LIMIT 1
) WHERE owner_id IS NULL;
-- The current production instance has a single admin and legacy repos made
-- through system keys. Assign those only when there is exactly one admin.
UPDATE repositories SET owner_id = (SELECT id FROM users WHERE role = 'admin' LIMIT 1)
WHERE owner_id IS NULL AND (SELECT COUNT(*) FROM users WHERE role = 'admin') = 1;
CREATE INDEX idx_repositories_owner ON repositories(owner_id);

CREATE TABLE github_compute_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  allow_private INTEGER NOT NULL DEFAULT 0,
  blacksmith_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_github_compute_user ON github_compute_connections(user_id);

CREATE TABLE github_ci_mirrors (
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES github_compute_connections(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  is_private INTEGER NOT NULL,
  workflow_sha TEXT NOT NULL,
  PRIMARY KEY (repo_id, connection_id)
);

CREATE TABLE github_merge_run_bindings (
  attempt_id TEXT PRIMARY KEY,
  github_run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE ci_runs ADD COLUMN backend TEXT;
ALTER TABLE ci_runs ADD COLUMN connection_id TEXT;
ALTER TABLE ci_runs ADD COLUMN github_run_id TEXT;
ALTER TABLE ci_runs ADD COLUMN github_workflow_sha TEXT;
ALTER TABLE ci_runs ADD COLUMN fallback_reason TEXT;
ALTER TABLE ci_runs ADD COLUMN error_message TEXT;
