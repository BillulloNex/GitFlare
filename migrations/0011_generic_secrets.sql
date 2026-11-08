-- Saved secrets are any named credential, not only an Onshape key pair.
-- `text` stores { "value" }. `onshape` remains so a pair saved before this
-- migration can still be read. Names are unique per user.
--
-- foreign_keys is off for this transaction so the table can be rebuilt while
-- onshape_links.saved_secret_id still references it. D1 applies a migration
-- file as one transaction, and PRAGMA foreign_keys lasts for that transaction.

PRAGMA foreign_keys = off;

CREATE TABLE saved_secrets_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'onshape')),
    payload_encrypted TEXT NOT NULL,
    hint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, name)
);
INSERT INTO saved_secrets_new (id, user_id, name, kind, payload_encrypted, hint, created_at, updated_at)
SELECT id, user_id, name, kind, payload_encrypted, hint, created_at, updated_at FROM saved_secrets;
DROP TABLE saved_secrets;
ALTER TABLE saved_secrets_new RENAME TO saved_secrets;
CREATE INDEX IF NOT EXISTS idx_saved_secrets_user ON saved_secrets(user_id);

-- Which saved secret was copied into the Onshape signing key. saved_secret_id
-- is the one copied into the access key. Both are plain references: deleting
-- the saved secret does not remove the copy on the link.
ALTER TABLE onshape_links ADD COLUMN secret_key_secret_id TEXT REFERENCES saved_secrets(id) ON DELETE SET NULL;

PRAGMA foreign_keys = on;
