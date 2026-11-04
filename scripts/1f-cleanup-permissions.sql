-- ════════════════════════════════════════════════════════════════════
-- Phase 1f — Normalise api_keys.permissions to the allowlist
-- ════════════════════════════════════════════════════════════════════
--
-- The Phase 1 middleware rejects (403) any key whose permissions value is not
-- exactly 'read', 'write' or 'admin'. Previously /api/bootstrap/keys accepted
-- any string. Run this BEFORE deploying the Phase 1 Worker, otherwise those
-- keys start failing.
--
-- Run manually, one statement at a time:
--
--   npx wrangler d1 execute gitflare-db --remote --command "<statement>"

-- ── Step 1: See what will change ───────────────────────────────────
-- SELECT id, name, key_prefix, permissions, user_id, created_at, last_used_at
--   FROM api_keys
--  WHERE permissions IS NULL OR permissions NOT IN ('read', 'write', 'admin');

-- ── Step 2: Downgrade unknown values to read ───────────────────────
-- (`NOT IN` is false for NULL, so NULLs are handled explicitly.)
-- UPDATE api_keys
--    SET permissions = 'read'
--  WHERE permissions IS NULL OR permissions NOT IN ('read', 'write', 'admin');

-- ── Step 3: Verify ─────────────────────────────────────────────────
-- SELECT permissions, COUNT(*) AS n FROM api_keys GROUP BY permissions;
-- Expect only: read, write, admin
