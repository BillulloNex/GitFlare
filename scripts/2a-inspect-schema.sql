-- ════════════════════════════════════════════════════════════════════
-- Phase 2a — Inspect the production D1 schema (READ-ONLY)
-- ════════════════════════════════════════════════════════════════════
--
-- Run BEFORE 2c (seeding d1_migrations). The answers decide which rows the
-- seed inserts. Every statement here is read-only.
--
-- Run one statement at a time and keep the output:
--
--   npx wrangler d1 execute gitflare-db --remote --command "<statement>"
--
-- Or all at once:
--
--   npx wrangler d1 execute gitflare-db --remote --file=scripts/2a-inspect-schema.sql
--
-- What the seed in scripts/2c-seed-migrations.sql ASSUMES (prior audit):
--   * every table from 0001–0005 exists
--   * api_keys.user_id exists
--   * ci_steps.logs and ci_steps.global_ordinal do NOT exist
--   * no d1_migrations table exists yet
-- If any check below disagrees, adjust 2c before running it (see the
-- decision table at the bottom).

-- ── 1. Is Wrangler already tracking migrations? ────────────────────
-- Expect: no rows. If d1_migrations exists, inspect its contents
-- (SELECT * FROM d1_migrations) before seeding — names will be the OLD
-- duplicate-prefix filenames and must be rewritten, not appended to.
SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations';

-- ── 2. Which tables exist? ─────────────────────────────────────────
-- Expect all of:
--   0001: repositories, api_keys, ci_runs, ci_steps, deploy_targets,
--         deployments, webhooks, audit_log
--   0002: users, sessions, repo_members
--   0003: tickets, merge_queue_log
--   0004: protected_branches
--   0005: github_mirrors, mirror_sync_log
SELECT name FROM sqlite_master
 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
 ORDER BY name;

-- ── 3. api_keys — does user_id exist? (0002's ALTER) ───────────────
PRAGMA table_info(api_keys);

-- ── 4. ci_steps — do logs / global_ordinal exist? (0006) ──────────
PRAGMA table_info(ci_steps);

-- ── 5. deploy_targets — coolify_api_key_encrypted present? ─────────
PRAGMA table_info(deploy_targets);

-- ── 6. Indexes (sanity check that the migrations ran to completion) ─
SELECT tbl_name, name FROM sqlite_master
 WHERE type = 'index' AND name LIKE 'idx_%'
 ORDER BY tbl_name, name;

-- ── 7. Encryption formats currently stored (input for 2g) ──────────
-- v1 = already migrated, ghtoken = plaintext GitHub PAT (MCP-created),
-- other = presumably legacy AES-GCM base64 (REST-created).
SELECT
	CASE
		WHEN github_token_encrypted LIKE 'v1:%' THEN 'v1'
		WHEN github_token_encrypted LIKE 'ghp\_%' ESCAPE '\'
		  OR github_token_encrypted LIKE 'github\_pat\_%' ESCAPE '\'
		  OR github_token_encrypted LIKE 'gho\_%' ESCAPE '\'
		  OR github_token_encrypted LIKE 'ghu\_%' ESCAPE '\'
		  OR github_token_encrypted LIKE 'ghs\_%' ESCAPE '\'
		  OR github_token_encrypted LIKE 'ghr\_%' ESCAPE '\' THEN 'ghtoken'
		ELSE 'other'
	END AS format,
	COUNT(*) AS n
FROM github_mirrors
GROUP BY format;

-- ════════════════════════════════════════════════════════════════════
-- Decision table for 2c
-- ════════════════════════════════════════════════════════════════════
--
--  Finding                                   → Change to 2c seed
--  ─────────────────────────────────────────────────────────────────
--  A 0001–0005 table is missing              → remove that file's row from
--                                              the seed so Wrangler applies it
--                                              (all statements are IF NOT EXISTS
--                                              except 0002's ALTER — see next)
--  api_keys.user_id missing                  → DO NOT seed 0002; Wrangler will
--                                              run it (CREATE IF NOT EXISTS +
--                                              ALTER are then both safe)
--  ci_steps.logs AND global_ordinal exist    → also seed 0006_schema_fixes.sql
--  ci_steps.logs exists, global_ordinal not  → split 0006 (see header of
--                                              migrations/0006_schema_fixes.sql)
--  d1_migrations already exists              → stop; inspect it first
