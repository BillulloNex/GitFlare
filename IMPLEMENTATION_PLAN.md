# GitFlare: Complete Implementation Plan (Draft 6)

> Revised after five review rounds (79 + 54 + 15 + 3 + 1 blocking + 14 should-fix). All issues resolved.

## Key Decisions (from review feedback)
1. **Mirror primary path:** Pack push is primary. API sync is a fast-path shortcut only when GitHub already has the SHA.
2. **Runner isolation:** Steps run inside throwaway Docker containers via Docker socket. If Docker unavailable, fail closed (no silent fallback to bare spawn). `config_yaml` restricted to admin keys.
3. **Migration safety:** Rename files first, then seed `d1_migrations` with renamed filenames. Never replay.
4. **Encryption switchover:** Phase 1 uses existing `encryptToken(…, SESSION_SECRET)`. Phase 2g does a single switchover to `ENCRYPTION_KEY` with HKDF. Runtime `decryptSecret` tries: `v1:` new format → otherwise attempt legacy AES-GCM decrypt (existing `encryptToken` writes plain base64 of IV+ciphertext, no prefix) → if AES-GCM auth check or `atob` fails → **throw**. Plaintext fallback exists ONLY in migration scripts (2g, B1.2). Add `v1:` prefix to all new ciphertext.
5. **Dashboard auth:** Cookie-only. No API key in localStorage.
6. **MCP:** Delete inline `src/api/mcp.ts` tool implementations. The `/mcp` route survives but proxies to REST API with auth headers. `packages/gitflare-mcp/` also stays as the external MCP server.
7. **Force push:** Only block deletions for now. Ancestry-based detection deferred.
8. **Domain allowlist:** When `ALLOWED_DOMAINS` is unset, new Google users get `read` access. Requires new `viewer` role in `users` table + middleware update.
9. **Keys without `user_id`:** Bootstrap/system keys get global access. `permissions` is the only gate.
10. **Deploy path:** All deploys go through runner. Delete BOTH Worker-side Coolify fallbacks (`ci-consumer.ts:124-148` AND `ci-consumer.ts:191-200`).
11. **Merge queue CI:** Run CI on merge result branch BEFORE fast-forwarding main. Alarm timeout = `MAX_CI_DURATION_MS` + 5 min buffer. Fresh write token minted after CI passes.

---

## Phase 0: Shared Helpers + Workspace Setup
**Creates:** `src/lib/crypto.ts`, `src/lib/artifacts-url.ts`, `src/lib/branch-pattern.ts`, `src/lib/repo-validation.ts`, `src/lib/access.ts`
**Edits:** `package.json` (workspaces)

### 0a. `src/lib/crypto.ts`
- `hashKey(key: string): Promise<string>` — SHA-256, extracted from 7 copies
- `safeTimingEqual(a: string, b: string): Promise<boolean>` — hash both sides first (handles length mismatch), uses `crypto.subtle.timingSafeEqual`
- `encryptSecret(plaintext: string, encryptionKey: string): Promise<string>` — AES-256-GCM via HKDF (not PBKDF2), returns `v1:<base64>` prefixed ciphertext
- `decryptSecret(ciphertext: string, encryptionKey: string): Promise<string>` — `v1:` prefix → AES-256-GCM decrypt with HKDF-derived key. Otherwise → attempt legacy AES-GCM decrypt using `SESSION_SECRET` (existing `encryptToken` writes plain base64 of IV+ciphertext, no prefix). If both fail (GCM auth check or `atob` fails) → **throw**. No plaintext fallback in runtime — plaintext handling is migration-script-only per 2g/B1.2.
- **Note:** Runner package uses `node:crypto.timingSafeEqual` directly (can't import Worker code)

### 0b. `src/lib/artifacts-url.ts`
- First: verify whether `REPOS.get(name)` returns an object with `.remote` property (check `mcp.ts:62` vs `git.ts:53-57`)
- If yes: `getArtifactsRemoteUrl(repo: ArtifactRepo): string` using `repo.remote`
- If no: `getArtifactsRemoteUrl(env: Env, repoName: string): string` using `env.CLOUDFLARE_ACCOUNT_ID`
- Either way: replaces 4 hardcoded account ID + namespace references

### 0c. `src/lib/branch-pattern.ts`
- `matchesBranchFilter(patterns: string[], branch: string): boolean` — glob support (`main`, `release/*`, `feature/**`)
- Used by: CI triggers (B2), branch protection (B2), deploy filters (B1), merge queue (B4)

### 0d. `src/lib/repo-validation.ts`
- `isValidRepoName(name: string): boolean` — regex `^[A-Za-z0-9._-]{1,100}$`
- `isValidRefName(ref: string): boolean` — git ref format rules (no `..`, no control chars, etc.)

### 0e. `src/lib/access.ts`
- `checkRepoAccess(principal: { userId?: string, keyId?: string, repoScope?: string, permissions: string }, repoId: string, repoIsPrivate: boolean, requiredLevel: 'read'|'write'|'admin', db: D1Database): Promise<boolean>`
- Checks: permission level, key repo scope, `repo_members` membership (if user_id exists), `is_private`
- For keys without `user_id` (bootstrap/system keys): only `permissions` is checked (global access)
- Single function used by REST middleware, `git.ts`, and MCP tools

### 0f. Add npm workspaces to root `package.json`
- Add `"workspaces": ["packages/*"]`
- Add `prepare` script to `packages/gitflare-client`
- Fix `file:` links → workspace references
- Regenerate root `package-lock.json`
- **Keep** `packages/runner/package-lock.json` — runner's Docker build context is `packages/runner/`, so removing its lockfile would leave `npm install` unpinned inside the container. Only remove lockfiles from non-Docker packages.

### 0g. Add `tsc --noEmit` gate to `.github/workflows/deploy.yml`
- Add typecheck step BEFORE deploy (safe to add now — tsc passes today)
- Do NOT add migrations to deploy workflow yet (that's Phase 2)

### 0h. Export `parseInfoRefs` and replace `getArtifactBranches` → `getArtifactRefs`
- Export `parseInfoRefs` from `github-mirror.ts` into `src/lib/git-protocol.ts` (shared parser)
- **Replace** the existing `getArtifactBranches(env, name, defaultBranch)` at `src/lib/artifact-reader.ts:71` (which only returns the default branch in an array) with `getArtifactRefs(env, repoName): Promise<Map<string, string>>` — returns real branch→SHA map using exported parseInfoRefs
- Update `src/api/files.ts:16` (the only caller of old `getArtifactBranches`) to use `getArtifactRefs` instead
- Needed by B1.2 (resolve HEAD), B2 (push handling), B3.4 (mirror), B4.2 (verify SHA), B6.3 (branch picker)
- **Note:** B6.3 must NOT re-add this function — it was moved here from B6.3 to avoid duplication

---

## Phase 1: Emergency Security (sequential)
**Files touched in order:** D1 remote → `src/dashboard/index.html` → `src/api/mcp.ts` → `src/api/git.ts` → `src/api/internal.ts` + `src/api/internal-ci.ts` + `src/api/internal-merge.ts` → `src/middleware/auth.ts` + `src/api/keys.ts` → `src/api/bootstrap.ts` → `src/api/auth.ts` → `packages/runner/src/index.ts`

### 1a. Revoke leaked API key (D1 remote)
- Step 1: `SELECT id, permissions, last_used_at, created_at FROM api_keys WHERE key_prefix = 'gf_2d61a'` — record what it was
- Step 2: `SELECT * FROM audit_log WHERE actor = '<id from step 1>'` — check for misuse
- Step 3: `DELETE FROM api_keys WHERE id = '<id>'`

### 1b. Switch dashboard to cookie-only auth
- In `src/dashboard/index.html`: remove `apiKey` variable, remove Bearer header from all fetch calls
- All API calls use same-origin session cookie (already set by OAuth login)
- On 401 response, redirect to `/auth/login`
- Remove `localStorage` key storage (stealable through XSS)

### 1c. Lock down `/mcp` route
- In `src/api/mcp.ts`: pass auth principal into tool handlers
- Require `admin` for: `key_create`, `key_revoke`, `key_list`, `repo_delete`, `deploy_add`, `mirror_setup`
- Require `write` for: `repo_create`, `ci_trigger`, `mirror_sync`
- Require `read` for: all read-only tools
- Respect `key.repo_id` scope — reject tool calls targeting a different repo
- Fix `gitflare_mirror_setup`: encrypt token using EXISTING `encryptToken(…, SESSION_SECRET)` helper (NOT new crypto.ts yet — switchover happens in Phase 2g)
- **Note:** `ci_trigger` and `mirror_sync` functional fixes (actually sending to queue) are deferred to B5 since B5.1 deletes this code anyway. Phase 1c is security-only (permission checks).

### 1d. Fix git auth
- In `src/api/git.ts:17-50`:
  - Wrap `atob` in try-catch (prevents 500 on bad base64)
  - Check `key.permissions` — reject push if `read`
  - Check `key.repo_id` — if scoped, reject if doesn't match target repo
  - Phase 1 only: skip `is_private` enforcement (needs `repo_members` from Phase 3)
- Delete `X-GitFlare-Internal` bypass at `git.ts:248` entirely (nothing legitimately sends it)

### 1e. Make RUNNER_SECRET fail closed
- **First:** split `src/api/internal.ts` into `src/api/internal-ci.ts` and `src/api/internal-merge.ts`, update route registration in `src/index.ts`
- In `src/api/internal-ci.ts` and `src/api/internal-merge.ts`: `if (!env.RUNNER_SECRET) return c.json({ error: 'Not configured' }, 503)`
- Use `safeTimingEqual` from crypto.ts for Bearer comparison
- In `packages/runner/src/index.ts`: `if (!RUNNER_SECRET) { res.writeHead(503); return; }` — use `node:crypto.timingSafeEqual`
- No "startup warning" — Workers have no startup hook with access to `env`. 503 is enough.

### 1f. Permission allowlist
- `const VALID_PERMISSIONS = ['read', 'write', 'admin'] as const`
- **First:** run cleanup: `UPDATE api_keys SET permissions = 'read' WHERE permissions NOT IN ('read', 'write', 'admin')` — must run BEFORE deploying middleware that rejects unknown permissions (otherwise existing bad keys start getting 403s)
- In `src/middleware/auth.ts`: reject requests from keys with unknown permissions (403)
- In `src/api/keys.ts`: validate on creation, reject if not in allowlist
- In `src/api/bootstrap.ts`: same validation on `POST /keys`

### 1g. Bootstrap lockdown
- Check `SELECT COUNT(*) FROM api_keys WHERE permissions = 'admin'` — if > 0, return 403
- Lock all three endpoints (`/bootstrap`, `/bootstrap/keys` GET, `/bootstrap/keys` POST)
- Reject expired keys in `/bootstrap/keys`
- Use `safeTimingEqual` for key comparison

### 1h. Google OAuth domain restriction + `ADMIN_EMAILS`
- Add `ALLOWED_DOMAINS` env var — when set, reject non-matching domains
- When `ALLOWED_DOMAINS` is unset, new users default to `read` access:
  - Add `viewer` role to `users` table (alongside `user` and `admin`)
  - Update `middleware/auth.ts:133` to read `users.role` and map: `admin` → admin, `user` → write, `viewer` → read (currently hardcodes all session users to write)
  - New users without domain match get `viewer` role
- **Login checks run on EVERY login (existing AND new users):**
  - `auth.ts` has separate branches for existing/new users — the verified-email, domain, and ADMIN_EMAILS checks must run BEFORE the upsert, on every login path
  - Check `verified_email` FIRST — unverified email must NOT get `admin` even if it matches `ADMIN_EMAILS`
  - Order: verify email → check domain (reject if `ALLOWED_DOMAINS` is set and domain doesn't match) → check `ADMIN_EMAILS` → assign/update role
  - Existing users on `ADMIN_EMAILS` list get promoted to `admin` on next login
  - Existing out-of-domain users get rejected when `ALLOWED_DOMAINS` is set
- Add `ADMIN_EMAILS` env var — matching emails get `admin` role on login
- Implement in `src/api/auth.ts:92-120`
- **Rollout order:** deploy code FIRST (new auth.ts + middleware), THEN run the SQL downgrades, THEN purge sessions:
  1. Deploy the code with new `auth.ts` and `middleware/auth.ts` (so new logins use new rules and middleware reads `users.role`)
  2. Run role downgrade:
     - If `ALLOWED_DOMAINS` is set: `UPDATE users SET role = 'viewer' WHERE role = 'user' AND email NOT IN (ADMIN_EMAILS) AND email NOT LIKE '%@alloweddomain.com'`
     - If `ALLOWED_DOMAINS` is unset: `UPDATE users SET role = 'viewer' WHERE role = 'user' AND email NOT IN (ADMIN_EMAILS)`
  3. Downgrade API keys:
     - If `ALLOWED_DOMAINS` is set: **DELETE** keys for out-of-domain users entirely (`DELETE FROM api_keys WHERE user_id IN (SELECT id FROM users WHERE role = 'viewer')`) — read keys still allow reading private repos until Phase 3, so deletion is safer
     - If `ALLOWED_DOMAINS` is unset: downgrade to read: `UPDATE api_keys SET permissions = 'read' WHERE user_id IN (SELECT id FROM users WHERE role = 'viewer') AND permissions != 'read'`
  4. Optionally: check `audit_log` for those keys (same pattern as 1a) to see if any were misused
  5. `DELETE FROM sessions` — force re-login under new rules
- **Cap key creation at role level** (add to `keys.ts` POST, alongside 1f allowlist):
  - Session users: `viewer` → can only create `read` keys, `user` → up to `write`, `admin` → up to `admin`
  - This prevents a viewer from creating a write key after the downgrade
- Add both to `.dev.vars.example`

---

## Phase 2: Database & Migrations
**Files:** `migrations/`, `package.json`, `.dev.vars.example`, `wrangler.jsonc`, `README.md`

### 2a. Inspect production schema
- `PRAGMA table_info(api_keys)` — check if `user_id` exists
- `PRAGMA table_info(ci_steps)` — check existing columns
- `PRAGMA table_info(deploy_targets)` — check `coolify_api_key_encrypted`
- Check if `tickets`, `merge_queue_log`, `protected_branches`, `github_mirrors`, `mirror_sync_log` tables exist

### 2b. Renumber migration files FIRST
- Rename to unique sequential prefixes: `0001_initial.sql`, `0002_users_auth.sql`, `0003_ticket_queue.sql`, `0004_branch_protection.sql`, `0005_github_mirror.sql`
- In `0002_users_auth.sql:42`: UNCOMMENT the `ALTER TABLE api_keys ADD COLUMN user_id` (safe in production because 2c marks it as already applied; needed for fresh local DBs where 0001 lacks the column)

### 2c. Seed `d1_migrations` table with renamed filenames
- Create tracking table using Wrangler's exact schema: `CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`
- Insert rows for every migration already applied in production (based on 2a findings), using the RENAMED filenames from 2b
- This prevents `wrangler d1 migrations apply` from replaying them
- Update `package.json` scripts to use `wrangler d1 migrations apply`
- Update `README.md:67-83`

### 2d. Create `0006_schema_fixes.sql`
- **Guard:** Phase 2a checks if `ci_steps.logs` already exists in production. If it does, mark `0006` as applied in the `d1_migrations` seed (Phase 2c) so Wrangler skips it. If only `logs` exists but `global_ordinal` doesn't, split into two migration files.
```sql
ALTER TABLE ci_steps ADD COLUMN logs TEXT DEFAULT '[]';
ALTER TABLE ci_steps ADD COLUMN global_ordinal INTEGER;
```

### 2e. Log storage strategy
- Store full logs in R2 (`STORAGE` binding) at key `ci-logs/{runId}/{stepIndex}.json`
- Store R2 keys in `stdout_url`/`stderr_url` columns (already exist)
- Keep truncated tail (last 50 lines) in `logs` column for quick API display
- Add full-log endpoint: `GET /api/repos/:repo/ci/runs/:id/logs/:stepIndex` reads from R2

### 2f. Create `.dev.vars.example`
```
# Required
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
ENCRYPTION_KEY=
SESSION_SECRET=
RUNNER_URL=http://localhost:7654
RUNNER_SECRET=
ADMIN_API_KEY=
APP_URL=http://localhost:8787
CLOUDFLARE_ACCOUNT_ID=

# Can be removed after 2g migration confirms all values are v1:
# SESSION_SECRET=  (move here once confirmed)

# Optional
COOLIFY_BASE_URL=
COOLIFY_API_KEY=
ALLOWED_DOMAINS=
ADMIN_EMAILS=
```

### 2g. Single encryption switchover
- Add `ENCRYPTION_KEY` to `src/env.ts`, `wrangler.jsonc` secrets, and production secrets
- Keep `SESSION_SECRET` in production (needed for legacy runtime decrypt path) and `.dev.vars.example`
- **Runtime `decryptSecret`** in crypto.ts tries in order: `v1:` new format → legacy AES-GCM decrypt with `SESSION_SECRET` (existing `encryptToken` writes plain base64, no prefix). If both fail → **throw**.
- **Migration script only:** the one-off migration has a plaintext fallback for MCP-created mirrors that were stored unencrypted. After migration, all values are `v1:` format.
- **Rollout order:** deploy code FIRST (new `decryptSecret` with legacy fallback), THEN run migration. Migrating first would break the live `decryptToken` for every mirror created through the REST API. Plaintext mirrors created through MCP already fail today (`atob` throws on `_` in `ghp_`), so deploying first costs nothing.
- Update call sites: `mirrors.ts:89` and `github-mirror.ts:632` → use new crypto.ts helpers
- Migration script: read all mirrors, try decrypt with each method, re-encrypt with new `v1:` format
  - MCP-created mirrors have PLAINTEXT tokens (not old-format ciphertext) — migration handles this
  - REST-created mirrors have old legacy AES-GCM ciphertext — migration handles this
- After migration: all tokens are `v1:` format. Legacy AES-GCM path kept as runtime fallback for safety until confirmed. Once migration confirms every value is `v1:`, `SESSION_SECRET` can be removed from production and the legacy path deleted in a follow-up.

### 2h. Add migrations to deploy workflow
- Add `wrangler d1 migrations apply gitflare-db --remote` to `.github/workflows/deploy.yml`
- Add D1 export step before migration (rollback safety)
- Place AFTER 2c has seeded `d1_migrations`

---

## Phase 3: Access Control
**Files:** `src/middleware/auth.ts`, `src/api/repos.ts`, `src/index.ts`, `src/api/ci.ts`, `src/api/deploy.ts`, `src/api/tickets.ts`, `src/api/files.ts`, `src/api/mirrors.ts`, `src/dashboard/index.html`

### 3a. Repo access middleware
- Register on `/api/repos/:repo` AND `/api/repos/:repo/*` in `src/index.ts`
- Use `checkRepoAccess` from `src/lib/access.ts`
- For private repos: check `repo_members` for user/key access
- For public repos: require membership for ALL write operations (not just reads)
- Attach `repoRecord` to context

### 3b. Populate `repo_members`
- On repo create (REST AND MCP): add creator as `admin` member
- Call `isValidRepoName` on repo create (both REST `repos.ts:27` and MCP `mcp.ts:38`)
- **Backfill script** (must run before 3a to avoid locking users out of private repos):
  - For each repo, find `audit_log` row with `action='repo.create'` matching that repo
  - If `actor` is a `users.id` → insert that user as `admin` member
  - If `actor` is an `api_keys.id` that has a non-null `user_id` → insert that key's user as `admin` member
  - If `actor` is an `api_keys.id` with NO `user_id` (e.g. bootstrap key), OR no audit row exists (e.g. MCP-created repos), OR `actor` is `'system'` → insert every `ADMIN_EMAILS` user as `admin` member
  - **Note:** `ADMIN_EMAILS` users can only be added if they already have a row in `users` (i.e. they've logged in at least once). Ensure admins log in before running backfill, OR have the script look up by email in `users` and log a warning for unmatched emails.
  - If `ADMIN_EMAILS` is unset AND no creator found → log warning, skip repo (it will have no members — flag for manual review)
- Add member management endpoints: `POST/DELETE /api/repos/:repo/members`
- Fix `repos.ts:175-181`: don't silently ignore Artifacts delete errors (return 500)

### 3c. Fix IDORs
- `ci.ts:176,247,334`: add `AND repo_id = ?`
- `ci.ts:194`: add repo filter to deployment query (currently matches across repos via `commit_sha`)
- `deploy.ts:47-88`: scope all queries to repo
- `tickets.ts:112,297`: scope to repo
- `mirrors.ts:18,271`: add permission checks
- MCP `ci_status` and `ci_logs`: scope to repo

### 3d. Permission checks on all write endpoints
- `ci.ts`: trigger (write), rerun (write), cancel (write)
- `deploy.ts`: CRUD targets (admin), trigger deploy (write)
- `deploy.ts` GET: strip `coolify_api_key_encrypted` from response (admin-only full view)
- `tickets.ts`: create (write), PATCH/retry/DELETE (write)
- `repos.ts`: PATCH `is_private` (admin)
- Filter private repos from `GET /api/repos` listing
- Restrict `config_yaml` in CI trigger to admin keys only (prevents arbitrary code exec)

### 3e. Coolify API key security
- **Read-side only:** Strip `coolify_api_key_encrypted` from `deploy.ts` GET responses (admin-only full view)
- All write-side encryption and `target_id` queue changes are in B1.2 (which owns `deploy.ts` writes and `ci-consumer.ts`). Do NOT duplicate here.

### 3f. Fix XSS
- Replace `innerHTML` with `textContent` for user data
- Escape `'` in template strings — replace inline `onclick` handlers with `data-*` attributes + event delegation
- Sanitize markdown: protocol allowlist (http/https only), `rel="noopener"` on links
- Fix: `<option>` list (1386), diff view (1690), deploy cards (1975-1988)

### 3g. Fix raw file serving
- Force `Content-Type: text/plain` except allowlisted image types
- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: sandbox; default-src 'none'`
- `Content-Disposition: attachment` for HTML/SVG

### 3h. Fix SSRF
- Anchor regex: `^https://github\.com/[^/]+/[^/]+(?:\.git)?$`
- Store canonical URL built from parsed parts (not user input)
- Fix `parseGitHubUrl` to accept repo names with dots

### 3i. Fix CORS + CSRF
- Restrict CORS origin to `APP_URL`
- Check `Origin` header on cookie-authenticated writes (sibling subdomain CSRF)

---

## Batch B1: CI + Deploy + Runner
**Files:** `src/api/internal-ci.ts`, `src/queue/ci-consumer.ts`, `src/api/ci.ts`, `src/api/deploy.ts`, `packages/runner/src/index.ts`, `packages/runner/Dockerfile`, `packages/runner/docker-compose.yml`, `src/index.ts` (cron), `wrangler.jsonc` (cron), `src/env.ts`

### B1.1. Fix callback handler (`internal-ci.ts`)
- Accept both `'success'` and `'passed'`
- Store per-step results: iterate `body.steps[]`, UPDATE each with `WHERE id = ? AND status IN ('pending', 'running')` — check `meta.changes`
- Store full logs in R2, truncated tail in `logs` column
- After CI passes: query deploy targets (with branch filters using glob matcher), enqueue via `DEPLOY_QUEUE`
- Skip deploy if run was cancelled
- Set `deployments.ci_run_id`
- Add separate `/internal/deploy/callback` — updates `deployments` table

### B1.2. Fix CI consumer (`ci-consumer.ts`)
- Resolve `HEAD` to actual branch tip SHA: query Artifacts refs
- Create step IDs + global ordinals before dispatch, send to runner, runner echoes back
- Claim run: `UPDATE ci_runs SET status = 'running' WHERE id = ? AND status = 'queued'` — check `meta.changes` before dispatching (prevents double-dispatch on retry)
- On runner reject/unreachable: mark `'failed'` and use `message.retry()` for transient failures
- Don't swallow errors — remove catch-all so DLQ works
- Fix `INSERT INTO deployments`: include `branch`, `commit_sha`, `ci_run_id`
- Delete inline Coolify fallback (`ci-consumer.ts:124-148`). All deploys go through runner.
- Also delete second Coolify inline path (`ci-consumer.ts:191-200` in handleDeployJob)
- Send `target_id` in deploy messages (not plaintext Coolify key). Decrypt in consumer on use.
- **Coolify key encryption — two-step deploy:**
  1. **Step 1 deploy:** Ship B1 with a *tolerant* Coolify key reader: try `v1:` → legacy AES-GCM → plaintext. This keeps live deploys working while keys are mixed format.
  2. **Run migration:** Re-encrypt all `deploy_targets.coolify_api_key_encrypted` values to `v1:` format. Migration is idempotent (values already `v1:` pass through).
  3. **Step 2 deploy:** Switch to strict `decryptSecret` (throws on unknown format). Ship once migration confirms all values are `v1:`.
- Encrypt Coolify API keys on write (`deploy.ts` create/update AND `mcp.ts` `deploy_add`): use `encryptSecret`. Both paths must encrypt — otherwise MCP-created targets stay plaintext and the strict consumer throws on them.
- Runner posts deploy results to `/internal/deploy/callback` (NOT CI callback)
- Non-Coolify targets: use actual target type from DB (not hardcoded `cloudflare`)
- Include `wranglerConfig` in deploy messages
- Sanitize shell arguments (prevent command injection from `wranglerConfig`)

### B1.3. Fix runner execution
- **Container isolation:** Each CI job runs inside a throwaway Docker container
  - Runner mounts Docker socket (`/var/run/docker.sock` in `docker-compose.yml`)
  - Use named Docker volume for workspace: `docker volume create gitflare-run-{runId}`, clone repo into it, mount into job container
  - Job container runs as non-root user
  - If Docker socket unavailable: FAIL CLOSED with error "Docker required for CI execution" (no silent fallback to bare spawn)
  - Add `docker-compose.yml` to file list — mount socket with mapped group
- **Repo checkout:** Receive Artifacts remote URL + short-lived read token from Worker
  - Clone INSIDE the job container (not runner's own filesystem — paths resolve on host)
  - Use `git init` + `git -c http.extraHeader="Authorization: Bearer <token>" fetch` (don't put token in `.git/config` or step env)
- **Dockerfile:** Add `RUN apk add --no-cache git docker-cli`, non-root USER, HEALTHCHECK
- **Run cancellation:** Maintain `runId → container` map, add `POST /webhook/ci/cancel` — `docker kill` the container
- **Incremental logs:** POST partial results periodically to `/internal/ci/logs` (new endpoint in `internal-ci.ts`)
- **Echoed step IDs:** Runner receives and returns step IDs for matching
- **Env allowlist:** Job containers get only: `PATH`, `HOME`, `LANG`, `TMPDIR`, `CI=true`, `GITFLARE_*`, plus step-specific env

### B1.4. Fix deploy flow
- All deploys go through runner's `/webhook/deploy`
- Runner posts results to `/internal/deploy/callback` (not CI callback)
- Fix Coolify status mapping: `queued`/`in_progress` = running, `finished` = success
- Add poll deadline (10 min default)
- Handle `undefined` deploymentUuid
- Each deploy target uses its own base URL and API key
- Manual deploy: accept `branch` and `commit_sha` from request body
- `deploy.ts` PUT: don't wipe key when field omitted
- Inject Cloudflare credentials only into deploy step (not all steps)

### B1.5. Fix CI cancel
- Cancel endpoint: POST to runner's `/webhook/ci/cancel`
- Callback handler: don't overwrite `cancelled` status
- Runner: kill process group on cancel

### B1.6. Scheduled handler
- Add `scheduled()` in `src/index.ts`, add cron to `wrangler.jsonc`
- Fail runs stuck in `running` > `MAX_CI_DURATION_MS`
- Fail stuck deployments
- Clean expired sessions (`cleanExpiredSessions()`)

### B1.7. Runner + Worker lockstep deploy
- Worker and runner protocol changes deploy together
- Runner deploy: build Docker image, push to registry, redeploy via Coolify
- Add backward compatibility check or version header

---

## Batch B2: Git Push Path
**Files:** `src/api/git.ts`, `src/lib/git-protocol.ts`, `src/do/repo-coordinator.ts`, `src/lib/ci-parser.ts`

### B2.1. Fix sideband parsing (two-step deploy)
- **Deploy 1:** Add hex-dump logging of real Artifacts push response. Keep fallback in place.
- Confirm actual format in production logs.
- **Deploy 2:** Fix demux: concatenate band-1 payloads, parse as pkt-lines. Share parser with github-mirror.ts. Remove fallback.
- Also fix request-side parsing (commit a2bb796 shows it fails in production too)

### B2.2. Fix push result handling
- Remove `main@HEAD` fallback — if no refs succeeded, push failed. No CI, no mirror, no audit.
- Remove earlier fallbacks at `git.ts:391-407`
- Handle deletions: skip CI/mirror on delete (SHA is all zeros)
- Handle tags: carry full ref name, don't strip `refs/tags/` inconsistently

### B2.3. Branch protection
- Fail closed on parse error — reject push
- Use `matchesBranchFilter` from branch-pattern.ts (not separate regex)
- Regex-escape protection patterns
- Block deletions. State plainly: force-push detection deferred (needs ancestry walk)
- Read `allow_force_push` and `allow_deletion` from rules

### B2.4. Trigger filtering
- Call `shouldTrigger` in git.ts push handler
- Use optional chaining: `config.on?.push` — default: no `on` block means run on every push
- Glob matching via branch-pattern.ts
- Never apply to manual runs or reruns

### B2.5. Push lock
- Align TTL with token lifetime (300s)
- When lock fails, reject push (don't proceed)
- Use DO storage for persistence

### B2.6. Minor fixes
- `.replace(/\.git$/, '')` — only strip trailing
- Forward `Git-Protocol` header
- Use repo's `default_branch` in: `files.ts`, `commits.ts`, `ci.ts`, `deploy.ts`, `tickets.ts`, `mcp.ts` (~15 places)
- Add default `protected_branches` row on repo create (REST + MCP)

---

## Batch B3: GitHub Mirror
**Files:** `src/lib/github-mirror.ts`, `src/api/mirrors.ts`

### B3.1. Fix pack transfer
- Don't request `side-band-64k` from Artifacts — response is then `NAK` + raw pack, just strip NAK
- Share demux parser with git-protocol.ts for cases where sideband IS needed
- Send `have` lines from GitHub's current refs (minimize pack size, reduce memory)

### B3.2. Fix push to GitHub
- Use advertised SHA from Artifacts refs (not `HEAD`/`unknown`)
- Use actual current GitHub SHA as old SHA (not all-zeros)
- Parse GitHub's receive-pack response body for success/failure (not just HTTP status)

### B3.3. Primary path: pack push. API sync as fast-path only.
- Pack push is primary (new commits always need object transfer)
- `mirrorSyncViaAPI` only called when GitHub already has the target SHA (returns 422 on unknown objects)
- Document this clearly in code comments

### B3.4. Fix manual sync
- Resolve `HEAD` to actual SHA from Artifacts refs

### B3.5. Fix remaining MCP mirror bugs
- Verify all mirror tokens are now `v1:` format (2g should have handled this)
- Fix `gitflare_mirror_sync` in REST to actually call sync (if not already done in 1c)

### B3.6. Memory + async
- Use queue-based async sync for large repos (use `MirrorSyncMessage` type from env.ts)
- Create mirror queue: `wrangler queues create gitflare-mirror-sync`
- Add queue binding to `wrangler.jsonc`, wire into `queue()` handler in `src/index.ts`
- Add to `src/env.ts` types
- Consider `waitUntil` time limits

---

## Batch B4: Merge Queue
**Files:** `src/api/tickets.ts`, `src/do/ticket-queue.ts`, `src/api/internal-merge.ts`, `src/api/internal-ci.ts` (merge-queue CI callback), `packages/runner/src/index.ts` (merge endpoint)

### B4.1. Fix route shadowing
- Move `/tickets/queue` BEFORE `/tickets/:ticketId`

### B4.2. Fix ticket state machine
- Validate SHA before writing status (swap order)
- Don't use user-supplied `agent_id` as audit actor (spoofable) — use authenticated principal
- Validate branch names with `isValidRefName`
- Cancel: handle DO's 409 response
- `merging` tickets should be cancellable
- Verify agent's `commit_sha` against actual branch tip using `getArtifactRefs` from Phase 0h

### B4.3. Implement merge execution
- **Core bug:** `processNext()` only sets alarm, never calls merge. This is THE reason no merge ever happens.
- Fix: call `executeMerge(env, ...)` directly from DO alarm handler
- Add repoId, repoName, baseBranch to queue entry payload
- Runner: add `POST /webhook/merge` — use argument arrays (not shell strings) for git commands
- Use 300-second tokens for initial merge (current code at `internal-merge.ts` uses 120s — change to 300s)
- **Merges push directly to Artifacts** using an Artifacts token (`internal-merge.ts`, was `internal.ts:73` before 1e split), NOT through `git.ts`. This means B2.6's default branch protection on main won't block the merge queue. Do NOT "fix" this by routing merges through `git.ts`.
- **CI gate:** After merge succeeds on result branch, enqueue CI. DO alarm timeout = `MAX_CI_DURATION_MS` + 5 min buffer (not 120s or 300s)
- After CI passes: mint fresh write token, fast-forward main
- After fast-forward: trigger mirror, write audit entry
- `internal-ci.ts`: when CI callback reports merge-queue run, notify TicketQueue DO to proceed with fast-forward

### B4.4. Fix stuck queue
- On timeout/failure: remove head entry, `deleteAlarm()`, process next
- Use attempt IDs — late callbacks ignored
- Update D1 ticket status on failure

---

## Batch B5: MCP + Client + CLI
**Files:** `src/api/mcp.ts`, `packages/gitflare-client/`, `packages/gitflare-cli/`, `packages/gitflare-mcp/`

### B5.1. Consolidate MCP
- Delete inline tool implementations in `src/api/mcp.ts`
- Keep `packages/gitflare-mcp/` as the only MCP server
- In `src/api/mcp.ts`: proxy MCP requests to REST API with proper auth headers
- Add authentication to `packages/gitflare-mcp/src/http.ts` (currently no auth)
- Fix shared transport bug in http.ts

### B5.2. Fix client response unwrapping
- Unwrap `{data: ...}` in all methods
- Fix `commits.list`: send `branch` (not `ref`), server ignores `limit` — fix server too (`commits.ts:14`)
- Fix `mirror sync` response shape
- Fix types in `types.ts`
- Update `packages/gitflare-mcp/src/server.ts`

### B5.3. Fix CI logs
- Full-log endpoint already added in 2e (`GET /ci/runs/:id/logs/:stepIndex` reads from R2)
- Client method calls this for full logs, truncated tail from existing endpoint for quick view

### B5.4. Fix CLI
- `mirror setup`: add `--github-token` option with `GITHUB_TOKEN` env fallback
- `auth login`/`whoami`: call protected endpoint (e.g., `GET /api/repos`)
- Config: save with `0600`, directory with `0700`, `chmod` existing files
- Clone: use `GIT_ASKPASS` for credentials (not URL-embedded key)
- `repo create`: default to private

---

## Batch B6: Dashboard
**Files:** `src/dashboard/index.html`, `src/lib/artifact-reader.ts`

### B6.1. Remove all fake data
- Remove fake `starship` repo (`:1334,1369-1378,1074`)
- Remove fake latest-commit strip (`:1146-1152`)
- Remove hardcoded badge counts (`:1108,1113`)
- Remove fake deploy target (`:1963-1971`)
- Remove invented log lines (`:1894-1899`)
- Remove `grok.beenex.org` URLs
- Remove server-side fake deployment in `ci.ts:221-229` — return `deployment: null` when none exists

### B6.2. Cookie-only auth (carried from 1b — verify complete)

### B6.3. Implement missing UI
- `cancelWorkflow`: calls cancel API
- Branch picker: real dropdown from new branch-list endpoint (uses `getArtifactRefs` from Phase 0h — do NOT re-implement here)
- Add branch-list API route

### B6.4. Add unit tests
- pkt-line and sideband parser (using hex dump fixtures from B2.1)
- `branch-pattern` matcher
- `encryptSecret`/`decryptSecret` round-trip
- Permission matrix: key level × repo scope × private flag
- Client response unwrapping

---

## Phase Final: Cleanup

### F1. Delete `src/lib/repo-store.ts`
- Move needed types to `src/types.ts`, delete file (800+ lines dead data)

### F2. Replace hardcoded values
- Account ID → `artifacts-url.ts` helper
- `git.beenex.company` → `APP_URL` env var (6 files)
- All other hardcoded URLs → env vars or target config

### F3. Deduplicate + remove dead code
- SHA-256 → crypto.ts everywhere
- Merge `timeAgo` functions, fix "1 minutes ago"
- Delete deprecated sandbox stubs
- Remove conflicting `SandboxTier` from env.ts
- Remove unused types, imports, bindings
- Remove `AI` from wrangler.jsonc, `JWT_SECRET` from README

### F4. Fix Durable Objects
- Use `ctx.getWebSockets()` for hibernation
- Add authenticated WebSocket routes or remove WebSocket code

### F5. Error handling
- Global `app.onError` with request ID
- Remove `err.message` leaks
- Input validation on `c.req.json()` calls

### F6. Update README
- Document current env vars, migration process
- Remove references to unused features
- Update architecture description

---

## Execution Order

```
Phase 0 (helpers + workspaces)
    ↓
Phase 1 (emergency security) — deploy immediately
    ↓
Phase 2 (migrations) — inspect prod DB first, seed d1_migrations, then deploy
    ↓
Phase 3 (access control) — deploy
    ↓
B1 (CI + Deploy + Runner) — deploy Worker + Runner in lockstep
    ↓
B2 (Git Push) — two-step deploy (hex dump first, then fix)
    ↓
B3 (Mirror) — deploy
    ↓
B4 (Merge Queue) — deploy with runner (sequential after B3, NOT parallel)
    ↓
B5 (MCP + Client + CLI) — deploy
    ↓
B6 (Dashboard + Tests) — deploy
    ↓
Phase Final (Cleanup) — deploy
```

**Verification after each phase:**
1. `tsc --noEmit`
2. `vitest run` (once tests exist in B6)
3. Grep-based acceptance checks (e.g., no `Math.random`, no hardcoded account IDs)
4. For B2: verify with production hex dumps before removing fallbacks

**Safety:**
- D1 export before each migration
- Runner + Worker deploy in lockstep for protocol changes
- No staging environment yet — consider adding preview environment for Phase 2+
