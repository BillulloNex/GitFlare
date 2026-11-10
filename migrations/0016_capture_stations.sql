-- Browser capture stations paired to one repository. Tokens are stored only as
-- SHA-256 hashes. A pairing code is short-lived and can be claimed once.
CREATE TABLE capture_pairings (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code_hash TEXT NOT NULL UNIQUE,
    created_by_id TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    claimed_at TEXT
);
CREATE INDEX idx_capture_pairings_expiry ON capture_pairings(expires_at);

CREATE TABLE capture_stations (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    status_json TEXT NOT NULL DEFAULT '{}',
    revoked_at TEXT
);
CREATE INDEX idx_capture_stations_repo ON capture_stations(repo_id, revoked_at);

-- A station may generate multiple diary entries when a session exceeds the
-- diary's 40-media limit. These fields make retries idempotent.
ALTER TABLE diary_entries ADD COLUMN capture_session_id TEXT;
ALTER TABLE diary_entries ADD COLUMN capture_batch INTEGER;
CREATE UNIQUE INDEX idx_diary_capture_batch ON diary_entries(repo_id, capture_session_id, capture_batch)
    WHERE capture_session_id IS NOT NULL;
