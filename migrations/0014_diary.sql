-- Diary (src/api/diary.ts): a per-repo build log. Each entry is a moment —
-- text plus photos/videos — with the time it happened. Access follows the repo.
--
-- Media bytes live in R2 under diary/<repo_id>/<media_id>/<filename>. A media
-- row starts `pending` while its multipart upload runs, becomes `ready` once
-- completed, and is attached to an entry when the entry is posted. Unattached
-- rows older than a day are purged by the maintenance cron.

CREATE TABLE IF NOT EXISTS diary_entries (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    body TEXT NOT NULL DEFAULT '',
    happened_at TEXT NOT NULL,         -- ISO-8601 UTC; when the moment happened (editable)
    author TEXT NOT NULL,              -- display name of the user or API key
    author_id TEXT,                    -- users.id or api_keys.id
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diary_entries_repo ON diary_entries(repo_id, happened_at, id);

CREATE TABLE IF NOT EXISTS diary_media (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    entry_id TEXT REFERENCES diary_entries(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    r2_key TEXT NOT NULL,
    upload_id TEXT,                    -- R2 multipart upload id while pending
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
    size INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
    created_by_id TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diary_media_entry ON diary_media(entry_id, position);
CREATE INDEX IF NOT EXISTS idx_diary_media_orphans ON diary_media(entry_id, created_at);
