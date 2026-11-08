-- Account-level credentials (src/api/secrets.ts). The owner can pick one when
-- connecting an integration, instead of pasting the key into every repository.
-- payload_encrypted is encryptSecret (v1:) of a JSON object. List responses
-- return name, kind and hint only.
--
-- onshape_links keeps its own encrypted copy. saved_secret_id only records
-- which saved secret that copy was last taken from, so deleting the saved
-- secret (or the user) does not stop a sync that is already connected.

CREATE TABLE IF NOT EXISTS saved_secrets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('onshape')),
    payload_encrypted TEXT NOT NULL,
    hint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, kind, name)
);
CREATE INDEX IF NOT EXISTS idx_saved_secrets_user ON saved_secrets(user_id, kind);

ALTER TABLE onshape_links ADD COLUMN saved_secret_id TEXT REFERENCES saved_secrets(id) ON DELETE SET NULL;
