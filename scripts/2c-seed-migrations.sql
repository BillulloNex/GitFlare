-- ════════════════════════════════════════════════════════════════════
-- Phase 2c — Seed Wrangler's d1_migrations table (PRODUCTION, ONE-OFF)
-- ════════════════════════════════════════════════════════════════════
--
-- Production was migrated by hand with `wrangler d1 execute --file=...`, so
-- Wrangler has no record of what has run. Without this seed, the first
-- `wrangler d1 migrations apply --remote` would replay every file from 0001.
-- Most statements are IF NOT EXISTS, but 0002's `ALTER TABLE api_keys ADD
-- COLUMN user_id` would fail on a duplicate column.
--
-- Prerequisites:
--   1. Run scripts/2a-inspect-schema.sql and check the results against the
--      assumptions below.
--   2. Migration files are already renamed (Phase 2b): 0001–0005 have
--      unique sequential prefixes.
--   3. Take a backup first:
--        npx wrangler d1 export gitflare-db --remote --output=pre-2c-backup.sql
--
-- Run ONCE, BEFORE the first deploy that includes the Phase 2h workflow
-- (which runs `wrangler d1 migrations apply --remote`):
--
--   npx wrangler d1 execute gitflare-db --remote --file=scripts/2c-seed-migrations.sql
--
-- Assumptions (from the prior audit, confirm with 2a):
--   * all tables from 0001–0005 exist in production
--   * api_keys.user_id exists (added by hand before tracking existed)
--   * ci_steps.logs / ci_steps.global_ordinal do NOT exist → 0006 is NOT
--     seeded, so Wrangler applies it on the next deploy
--
-- Safe to re-run: CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE on the
-- UNIQUE name column.

-- Wrangler's exact DDL (copied from wrangler 4.x getCreateMigrationsTableQuery)
-- so Wrangler's own CREATE IF NOT EXISTS is a no-op afterwards.
CREATE TABLE IF NOT EXISTS d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Names must match the files in migrations/ exactly (Wrangler compares by
-- filename, including the .sql extension). Inserted in order so id order
-- matches filename order.
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_initial.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0002_users_auth.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0003_ticket_queue.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0004_branch_protection.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0005_github_mirror.sql');

-- ── 0006: ONLY if 2a showed ci_steps.logs AND ci_steps.global_ordinal ──
-- already exist in production. Otherwise leave this commented out and let
-- Wrangler apply 0006 normally. (If only `logs` exists, split 0006 instead —
-- see the header of migrations/0006_schema_fixes.sql.)
-- INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0006_schema_fixes.sql');

-- ── Verify ─────────────────────────────────────────────────────────
-- SELECT id, name, applied_at FROM d1_migrations ORDER BY id;
-- Then (expects only 0006_schema_fixes.sql as unapplied):
--   npx wrangler d1 migrations list gitflare-db --remote
