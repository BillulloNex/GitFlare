-- Ideas (src/api/ideas.ts): a place to jot ideas on a repo and log the work
-- done exploring them, by people or agents. Access follows the repo.
--
-- idea_logs is append-only. Status changes add a log entry (kind = 'status').

CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'exploring', 'done', 'dropped')),
    created_by TEXT NOT NULL,          -- display name of the user or API key
    created_by_id TEXT,                -- users.id or api_keys.id
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ideas_repo ON ideas(repo_id, status, updated_at);

CREATE TABLE IF NOT EXISTS idea_logs (
    id TEXT PRIMARY KEY,
    idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'status')),
    author TEXT NOT NULL,
    author_id TEXT,
    text TEXT NOT NULL,
    refs TEXT,                         -- JSON: { commits?: string[], branch?: string, ci_run_id?: string }
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_idea_logs_idea ON idea_logs(idea_id, created_at);
