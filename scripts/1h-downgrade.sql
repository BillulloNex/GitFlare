-- ════════════════════════════════════════════════════════════════════
-- Phase 1h — Role / key downgrade after enabling the login policy
-- ════════════════════════════════════════════════════════════════════
--
-- ROLLOUT ORDER (do not reorder):
--   0. Set ALLOWED_DOMAINS / ADMIN_EMAILS on the Worker if you want them
--      (`npx wrangler secret put ADMIN_EMAILS`, or dashboard vars).
--   1. Deploy the Phase 1 code FIRST (new auth.ts + middleware that reads
--      users.role: admin → admin, user → write, viewer → read).
--   2. Run the role downgrade (Section A or B — pick ONE).
--   3. Run the API key downgrade (matching Section A or B).
--   4. Optionally audit those keys (Section C).
--   5. Purge sessions (Section D) — forces everyone to re-login under the
--      new rules.
--
-- No schema change is needed: users.role is TEXT with no CHECK constraint,
-- so 'viewer' is valid as-is.
--
-- Run manually, one statement at a time:
--
--   npx wrangler d1 execute gitflare-db --remote --command "<statement>"
--
-- Placeholders — replace before running:
--   <ADMIN_EMAILS_SQL_LIST>  e.g.  'alice@example.com', 'bob@example.com'
--                            (lowercase; must match the ADMIN_EMAILS env var.
--                             If ADMIN_EMAILS is empty, use  ''  )
--   <ALLOWED_DOMAIN>         e.g.  example.com
--                            (one domain; for several, add one
--                             `AND lower(email) NOT LIKE '%@other.com'` per domain)

-- ── Preview: who is affected ───────────────────────────────────────
-- SELECT id, email, role FROM users ORDER BY role, email;


-- ════════════════════════════════════════════════════════════════════
-- SECTION A — ALLOWED_DOMAINS **is set**
-- ════════════════════════════════════════════════════════════════════

-- A.2 Role downgrade: out-of-domain non-admin users → viewer
-- UPDATE users
--    SET role = 'viewer', updated_at = datetime('now')
--  WHERE role = 'user'
--    AND lower(email) NOT IN (<ADMIN_EMAILS_SQL_LIST>)
--    AND lower(email) NOT LIKE '%@<ALLOWED_DOMAIN>';

-- A.3 Keys: DELETE all keys owned by viewers. Read keys can still read private
--     repos until Phase 3 (repo_members), so deletion is safer than downgrading.
--     Preview first:
-- SELECT k.id, k.name, k.key_prefix, k.permissions, u.email
--   FROM api_keys k JOIN users u ON u.id = k.user_id
--  WHERE u.role = 'viewer';
--
-- DELETE FROM api_keys
--  WHERE user_id IN (SELECT id FROM users WHERE role = 'viewer');


-- ════════════════════════════════════════════════════════════════════
-- SECTION B — ALLOWED_DOMAINS **is unset**
-- ════════════════════════════════════════════════════════════════════

-- B.2 Role downgrade: every non-admin user → viewer
-- UPDATE users
--    SET role = 'viewer', updated_at = datetime('now')
--  WHERE role = 'user'
--    AND lower(email) NOT IN (<ADMIN_EMAILS_SQL_LIST>);

-- B.3 Keys: downgrade viewer-owned keys to read
--     Preview first:
-- SELECT k.id, k.name, k.key_prefix, k.permissions, u.email
--   FROM api_keys k JOIN users u ON u.id = k.user_id
--  WHERE u.role = 'viewer' AND k.permissions != 'read';
--
-- UPDATE api_keys
--    SET permissions = 'read'
--  WHERE user_id IN (SELECT id FROM users WHERE role = 'viewer')
--    AND permissions != 'read';


-- ════════════════════════════════════════════════════════════════════
-- SECTION C — (optional) audit the affected keys for misuse (same as 1a)
-- ════════════════════════════════════════════════════════════════════
-- Run BEFORE A.3 if you plan to delete keys, since their ids are needed here.
--
-- SELECT a.actor, a.action, a.repo_id, a.details, a.created_at
--   FROM audit_log a
--  WHERE a.actor IN (
--        SELECT k.id FROM api_keys k
--          JOIN users u ON u.id = k.user_id
--         WHERE u.role = 'viewer')
--  ORDER BY a.created_at DESC;


-- ════════════════════════════════════════════════════════════════════
-- SECTION D — Purge sessions (always, last)
-- ════════════════════════════════════════════════════════════════════
-- DELETE FROM sessions;
