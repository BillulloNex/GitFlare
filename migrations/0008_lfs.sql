-- Git LFS objects stored in R2 (src/api/lfs.ts, src/lib/lfs.ts).
-- One row per (repo, oid). R2 key: lfs/<repo_id>/<oid>.
--   pending: an upload action was issued; the bytes may or may not be in R2 yet
--   ready:   bytes are in R2 and verified (sha256 == oid)
CREATE TABLE IF NOT EXISTS lfs_objects (
	repo_id    TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
	oid        TEXT NOT NULL,
	size       INTEGER NOT NULL,
	state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready')),
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (repo_id, oid)
);
CREATE INDEX IF NOT EXISTS idx_lfs_objects_repo_state ON lfs_objects(repo_id, state);

-- Per-repo LFS policy. lfs_max_object_bytes NULL = the Worker's global default.
ALTER TABLE repositories ADD COLUMN lfs_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repositories ADD COLUMN lfs_max_object_bytes INTEGER;
