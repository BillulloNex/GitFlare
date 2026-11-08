-- Rename idea statuses: open → created, exploring → in_progress,
-- dropped → abandoned (done stays). SQLite can't alter a CHECK constraint,
-- so both tables are rebuilt. idea_logs is copied aside and dropped first,
-- so dropping `ideas` can't cascade-delete any log rows.

CREATE TABLE idea_logs_backup AS SELECT * FROM idea_logs;
DROP TABLE idea_logs;

CREATE TABLE ideas_new (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'in_progress', 'done', 'abandoned')),
    created_by TEXT NOT NULL,
    created_by_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO ideas_new (id, repo_id, title, body, status, created_by, created_by_id, created_at, updated_at)
SELECT id, repo_id, title, body,
       CASE status WHEN 'open' THEN 'created' WHEN 'exploring' THEN 'in_progress' WHEN 'dropped' THEN 'abandoned' ELSE status END,
       created_by, created_by_id, created_at, updated_at
  FROM ideas;
DROP TABLE ideas;
ALTER TABLE ideas_new RENAME TO ideas;
CREATE INDEX IF NOT EXISTS idx_ideas_repo ON ideas(repo_id, status, updated_at);

CREATE TABLE idea_logs (
    id TEXT PRIMARY KEY,
    idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'status')),
    author TEXT NOT NULL,
    author_id TEXT,
    text TEXT NOT NULL,
    refs TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO idea_logs (id, idea_id, kind, author, author_id, text, refs, created_at)
SELECT id, idea_id, kind, author, author_id, text, refs, created_at FROM idea_logs_backup;
DROP TABLE idea_logs_backup;
CREATE INDEX IF NOT EXISTS idx_idea_logs_idea ON idea_logs(idea_id, created_at);

-- Old status-change entries read "Status: open → exploring". Use the new labels.
UPDATE idea_logs SET text =
    replace(replace(replace(replace(replace(replace(replace(replace(text,
        'Status: open →', 'Status: Created →'),
        'Status: exploring →', 'Status: In progress →'),
        'Status: done →', 'Status: Done →'),
        'Status: dropped →', 'Status: Abandoned →'),
        '→ open', '→ Created'),
        '→ exploring', '→ In progress'),
        '→ done', '→ Done'),
        '→ dropped', '→ Abandoned')
 WHERE kind = 'status';
