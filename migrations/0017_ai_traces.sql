-- AI traces (src/api/traces.ts): a per-repo log of AI agent sessions — which
-- agent and model, what it was asked, what it did, tokens, cost, and the
-- commits it made. Agents write them through MCP (gitflare_trace_log).
-- Access follows the repo.
--
-- A client-chosen session_id makes logging idempotent: posting the same
-- session again replaces the trace, so an agent or hook can re-send it as the
-- session grows.

CREATE TABLE IF NOT EXISTS ai_traces (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    session_id TEXT,
    agent TEXT NOT NULL,               -- e.g. claude-code, cursor, codex
    model TEXT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,          -- ISO-8601 UTC
    ended_at TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    refs TEXT,                         -- JSON: { commits?: string[], branch?: string, ci_run_id?: string }
    steps TEXT NOT NULL DEFAULT '[]',  -- JSON: [{ role, content, name?, at? }]
    step_count INTEGER NOT NULL DEFAULT 0,
    author TEXT NOT NULL,              -- display name of the user or API key
    author_id TEXT,                    -- users.id or api_keys.id
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_traces_repo ON ai_traces(repo_id, started_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_traces_session ON ai_traces(repo_id, session_id) WHERE session_id IS NOT NULL;
