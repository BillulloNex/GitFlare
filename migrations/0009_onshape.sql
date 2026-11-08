-- ─── Onshape sync (src/lib/onshape-sync.ts, src/api/onshape.ts) ─────────
-- A repo can be linked to Onshape documents with the user's Onshape API keys.
-- The cron checks each link for new Onshape Versions, exports every Part
-- Studio and Assembly (GLB / STEP / STL), stores the files in R2 as Git LFS
-- objects and commits them, one commit per Onshape Version.

CREATE TABLE IF NOT EXISTS onshape_links (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL UNIQUE REFERENCES repositories(id) ON DELETE CASCADE,
    base_url TEXT NOT NULL DEFAULT 'https://cad.onshape.com',
    access_key_encrypted TEXT NOT NULL,     -- encryptSecret (v1:)
    secret_key_encrypted TEXT NOT NULL,     -- encryptSecret (v1:)
    access_key_hint TEXT NOT NULL,          -- last 4 chars, for display
    documents TEXT NOT NULL,                -- JSON [{ "id": "<did>", "name": "…" }]
    branch TEXT NOT NULL,                   -- branch the commits go to
    formats TEXT NOT NULL,                  -- JSON ["glb","step","stl"]
    interval_minutes INTEGER NOT NULL DEFAULT 1440,  -- daily: Free/Standard Onshape plans get 2,500 API calls a year
    backfill TEXT NOT NULL DEFAULT 'latest' CHECK (backfill IN ('latest', 'all')),
    is_enabled INTEGER NOT NULL DEFAULT 1,
    next_check_at TEXT,                     -- ISO; NULL = due now
    retry_after TEXT,                       -- ISO; whole link paused (auth, quota, rate limit, protected branch)
    last_check_at TEXT,
    last_status TEXT,                       -- 'ok' | 'error'
    last_error TEXT,
    lease_until TEXT,                       -- ISO; one tick works a link at a time
    api_calls INTEGER NOT NULL DEFAULT 0,   -- Onshape calls made (they count against the account's annual allowance)
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per Onshape Version seen. Versions are committed oldest first.
--   pending    → found, not started
--   exporting  → translations started; `exports` holds their state
--   committed  → in git at commit_sha
--   failed     → gave up after retries (error says why); later versions continue
--   skipped    → existed before the link was made and backfill = 'latest'
CREATE TABLE IF NOT EXISTS onshape_versions (
    id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL REFERENCES onshape_links(id) ON DELETE CASCADE,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    version_name TEXT NOT NULL,
    version_description TEXT,
    version_created_at TEXT NOT NULL,
    creator_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'exporting', 'committed', 'failed', 'skipped')),
    exports TEXT,
    commit_sha TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (link_id, document_id, version_id)
);
CREATE INDEX IF NOT EXISTS idx_onshape_versions_queue ON onshape_versions(link_id, status, version_created_at);
