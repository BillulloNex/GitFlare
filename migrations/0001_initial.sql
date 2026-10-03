-- ─── GitFlare D1 Schema ─────────────────────────────────────────
-- Metadata database for repositories, CI runs, deploy targets, etc.
-- Git object storage is handled by Cloudflare Artifacts (not D1).

-- ─── Repositories ───────────────────────────────────────────────
-- Maps to Artifacts namespaces. D1 stores metadata only.
CREATE TABLE IF NOT EXISTS repositories (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	description TEXT,
	default_branch TEXT NOT NULL DEFAULT 'main',
	is_private INTEGER NOT NULL DEFAULT 1,
	artifact_name TEXT NOT NULL, -- name in Artifacts namespace
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_repos_name ON repositories(name);

-- ─── API Keys ───────────────────────────────────────────────────
-- For git operations (clone/push) and API access
CREATE TABLE IF NOT EXISTS api_keys (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	key_hash TEXT NOT NULL UNIQUE, -- SHA-256 hash of the key
	key_prefix TEXT NOT NULL,      -- first 8 chars for identification
	repo_id TEXT,                  -- NULL = access to all repos
	permissions TEXT NOT NULL DEFAULT 'read', -- read | write | admin
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	expires_at TEXT,
	last_used_at TEXT,
	FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- ─── CI Runs ────────────────────────────────────────────────────
-- Each push/PR/manual trigger creates a CI run
CREATE TABLE IF NOT EXISTS ci_runs (
	id TEXT PRIMARY KEY,
	repo_id TEXT NOT NULL,
	branch TEXT NOT NULL,
	commit_sha TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'queued', -- queued | running | passed | failed | cancelled
	trigger TEXT NOT NULL DEFAULT 'push',  -- push | pull_request | manual | schedule
	config_snapshot TEXT,                  -- JSON snapshot of .gitflare/ci.yml at this commit
	sandbox_tier TEXT,
	started_at TEXT,
	finished_at TEXT,
	duration_ms INTEGER,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ci_runs_repo ON ci_runs(repo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ci_runs_status ON ci_runs(status);

-- ─── CI Steps ───────────────────────────────────────────────────
-- Individual steps within a CI run
CREATE TABLE IF NOT EXISTS ci_steps (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL,
	job_name TEXT NOT NULL,
	step_index INTEGER NOT NULL,
	name TEXT,
	command TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending', -- pending | running | passed | failed | skipped
	exit_code INTEGER,
	stdout_url TEXT, -- R2 key for stdout log
	stderr_url TEXT, -- R2 key for stderr log
	started_at TEXT,
	finished_at TEXT,
	duration_ms INTEGER,
	FOREIGN KEY (run_id) REFERENCES ci_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ci_steps_run ON ci_steps(run_id, step_index);

-- ─── Deploy Targets ─────────────────────────────────────────────
-- Where to deploy after CI passes (Coolify, Cloudflare Workers, etc.)
CREATE TABLE IF NOT EXISTS deploy_targets (
	id TEXT PRIMARY KEY,
	repo_id TEXT NOT NULL,
	name TEXT NOT NULL,
	type TEXT NOT NULL, -- coolify | cloudflare
	is_active INTEGER NOT NULL DEFAULT 1,
	branch_filter TEXT, -- JSON array of branch patterns, NULL = all branches
	-- Coolify-specific
	coolify_app_id TEXT,
	coolify_base_url TEXT,
	coolify_api_key_encrypted TEXT,
	-- Cloudflare-specific
	wrangler_config TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_deploy_targets_repo ON deploy_targets(repo_id);

-- ─── Deployments ────────────────────────────────────────────────
-- History of deployment attempts
CREATE TABLE IF NOT EXISTS deployments (
	id TEXT PRIMARY KEY,
	repo_id TEXT NOT NULL,
	target_id TEXT NOT NULL,
	ci_run_id TEXT,
	branch TEXT NOT NULL,
	commit_sha TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending', -- pending | deploying | success | failed | rolled_back
	coolify_deployment_id TEXT,
	error_message TEXT,
	started_at TEXT,
	finished_at TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE,
	FOREIGN KEY (target_id) REFERENCES deploy_targets(id) ON DELETE CASCADE,
	FOREIGN KEY (ci_run_id) REFERENCES ci_runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_deployments_repo ON deployments(repo_id, created_at DESC);

-- ─── Webhooks ───────────────────────────────────────────────────
-- Outbound webhook subscriptions (beyond deploy targets)
CREATE TABLE IF NOT EXISTS webhooks (
	id TEXT PRIMARY KEY,
	repo_id TEXT NOT NULL,
	url TEXT NOT NULL,
	events TEXT NOT NULL, -- JSON array: ["push", "ci.passed", "ci.failed", "deploy.success"]
	secret TEXT,
	is_active INTEGER NOT NULL DEFAULT 1,
	last_triggered_at TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_webhooks_repo ON webhooks(repo_id);

-- ─── Audit Log ──────────────────────────────────────────────────
-- Everything gets logged (user's requirement: "all logged")
CREATE TABLE IF NOT EXISTS audit_log (
	id TEXT PRIMARY KEY,
	repo_id TEXT,
	actor TEXT NOT NULL, -- api key ID or "system"
	action TEXT NOT NULL, -- e.g., "repo.create", "push", "ci.trigger", "deploy.start"
	details TEXT,        -- JSON with action-specific details
	ip_address TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_repo ON audit_log(repo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, created_at DESC);
