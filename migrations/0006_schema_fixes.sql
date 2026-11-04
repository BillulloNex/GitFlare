-- ─── Schema fixes (Phase 2d) ────────────────────────────────────
--
-- ci_steps.logs           Truncated tail (last 50 lines) of a step's output,
--                         as a JSON array of {timestamp, stream, line}.
--                         Full logs live in R2 at ci-logs/{runId}/{ordinal}.json;
--                         that key is stored in ci_steps.stdout_url.
-- ci_steps.global_ordinal Position of the step across ALL jobs in a run.
--                         step_index restarts per job, so it can't identify a
--                         step within a run on its own.
--
-- PRODUCTION GUARD: SQLite has no `ADD COLUMN IF NOT EXISTS`, so this file
-- fails if a column already exists. Check scripts/2a-inspect-schema.sql
-- (PRAGMA table_info(ci_steps)) first:
--   * neither column exists → nothing to do, Wrangler applies this file
--   * both columns exist    → seed '0006_schema_fixes.sql' as applied in
--                             scripts/2c-seed-migrations.sql
--   * only `logs` exists    → split: seed this file as applied and move the
--                             global_ordinal ALTER (+ index) into a new 0007
--                             migration

ALTER TABLE ci_steps ADD COLUMN logs TEXT DEFAULT '[]';
ALTER TABLE ci_steps ADD COLUMN global_ordinal INTEGER;

CREATE INDEX IF NOT EXISTS idx_ci_steps_run_ordinal ON ci_steps(run_id, global_ordinal);
