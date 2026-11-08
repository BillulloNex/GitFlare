# GitFlare

**Git hosting, CI/CD and a merge queue for agents — on Cloudflare.**

Git repositories live in Cloudflare Artifacts and are served over Git Smart
HTTP by a Worker. CI runs in Docker containers on a self-hosted runner
(`packages/runner`), deployments go to Coolify, Cloudflare or Google Cloud Run, and a per-repo
merge queue lets many agents land branches safely. Repositories can be
mirrored to GitHub.

## Architecture

```
 Developer / Agent  (git, REST API, MCP, gitflare CLI)
        │
        ▼
 ┌──────────────────────── Cloudflare Worker (Hono) ────────────────────────┐
 │  /git/*  Smart HTTP  ─────► Artifacts (git storage)                       │
 │  /api/*  REST        ─────► D1 (metadata)   R2 (CI logs, D1 backups)      │
 │  /mcp    MCP (HTTP)         KV (CI config cache)                          │
 │                                                                            │
 │  Durable Objects:  RepoCoordinator — per-repo push locks                  │
 │                    TicketQueue     — per-repo merge queue state machine    │
 │                                                                            │
 │  Queues:  gitflare-ci-jobs ──┐   gitflare-deploy-jobs ──┐                  │
 │           gitflare-mirror-sync → GitHub (pack push)      │                  │
 │  Cron (*/5): fail stuck runs/deployments, purge sessions │                  │
 └──────────────────────────────┼───────────────────────────┼─────────────────┘
                                ▼                           ▼
                 Runner (packages/runner, Docker host)  ── HTTPS, RUNNER_SECRET ──
                   • CI jobs in throwaway containers
                   • merge-queue rebase / fast-forward
                   • deploys: Coolify API, `wrangler deploy` or `gcloud run deploy`
                   • results + logs → /api/internal/{ci,deploy,merge}/*
```

- **Auth:** Google OAuth sessions for the dashboard; API keys (`gf_…`, stored
  as SHA-256 hashes) for the REST API, MCP and `git` (key as the password).
  Per-repo access via `repo_members`, `is_private` and repo-scoped keys.
- **Secrets at rest** (GitHub mirror tokens, Coolify keys) are encrypted with
  `ENCRYPTION_KEY` (HKDF → AES-256-GCM, `v1:` prefix).
- **Errors:** every response carries `X-Request-Id`; unhandled errors return
  `{ "error": "Internal Server Error", "request_id": "…" }` and the details
  are only logged.

### Packages

| Path | What |
| --- | --- |
| `src/` | The Worker (API, git protocol, queue consumers, DOs, dashboard) |
| `packages/runner` | CI / merge / deploy runner (Node, Docker) |
| `packages/gitflare-client` | Typed REST client |
| `packages/gitflare-cli` | `gitflare` CLI |
| `packages/gitflare-mcp` | MCP server (stdio and Streamable HTTP) wrapping the client |

## Configuration

### Worker vars (`wrangler.jsonc` → `vars`)

| Name | Purpose |
| --- | --- |
| `APP_URL` | Public origin of the Worker, e.g. `https://git.example.com`. Used for CORS, the OAuth redirect and runner callback URLs. **Required.** |
| `CLOUDFLARE_ACCOUNT_ID` | Builds Artifacts remote URLs (`src/lib/artifacts-url.ts`). **Required.** |
| `MAX_CI_DURATION_MS` | Runs older than this (plus grace) are failed by the cron. Default `900000`. |
| `GITFLARE_VERSION` | Reported by `/health`. |

Also update the custom-domain `routes` entry in `wrangler.jsonc` to match `APP_URL`.

### Worker secrets (`wrangler secret put`, locally `.dev.vars`)

| Name | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | yes | Google OAuth login |
| `ENCRYPTION_KEY` | yes | Encrypts stored secrets. `openssl rand -base64 32`. Changing it makes stored `v1:` secrets unreadable. |
| `SESSION_SECRET` | yes | Session signing; also decrypts legacy (pre-`v1:`) secrets |
| `RUNNER_URL` | yes | Base URL of the runner |
| `RUNNER_SECRET` | yes | Shared bearer secret, Worker ⇄ runner (both directions) |
| `ADMIN_API_KEY` | yes | Only for `POST /api/bootstrap` (first admin key); disabled once an admin key exists |
| `COOLIFY_BASE_URL`, `COOLIFY_API_KEY` | no | Fallback for Coolify deploy targets without their own credentials |
| `ALLOWED_DOMAINS` | no | Comma-separated email domains allowed to sign in (in-domain users get `user`). Unset → anyone verified, as `viewer`. |
| `ADMIN_EMAILS` | no | Comma-separated emails granted `admin` on login |
| `GIT_PROTOCOL_DEBUG` | no | `1` → hex-dump receive-pack traffic to the log. Leave unset normally. |

See `.dev.vars.example` for a template.

### Runner (`packages/runner/docker-compose.yml`)

| Name | Purpose |
| --- | --- |
| `RUNNER_SECRET` | Same value as the Worker secret. **Required.** |
| `ALLOWED_CALLBACK_ORIGINS` | Comma-separated origins the runner may call back to — set to the Worker's `APP_URL`. **Required.** |
| `RUNNER_ID` | Labels this runner's containers so restarts only clean up their own |
| `CI_IMAGE`, `CI_USER`, `CI_MEMORY`, `CI_CPUS`, `CI_NETWORK`, `CI_PIDS_LIMIT` | Job container settings |
| `MAX_CONCURRENT_JOBS`, `MAX_CONCURRENT_MERGES` | Concurrency caps |
| `CI_STEP_TIMEOUT_S`, `CI_RUN_TIMEOUT_MS`, `CI_MAX_STEP_LOG_CHARS` | Limits |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Only for Cloudflare deploy targets; injected into `wrangler deploy`, never into CI steps |
| `GCP_SERVICE_ACCOUNT_KEY` | Fallback service-account JSON key for Cloud Run targets without their own; injected into the `gcloud` exec only |
| `CLOUDRUN_IMAGE` | Job image for Cloud Run deploys (default `google/cloud-sdk:slim`); must contain `git` and `gcloud` |

### CLI / MCP

`gitflare` and `gitflare-mcp` need `GITFLARE_URL` (your `APP_URL`) and
`GITFLARE_API_KEY`. The CLI can store them via `gitflare auth login`. The HTTP MCP
server takes the API key per request (`Authorization: Bearer …`) instead.

## Setup

Prerequisites: Node.js 22+, a Cloudflare account on Workers Paid with
Artifacts access, and a Docker host for the runner.

```bash
npm install
npx wrangler login

# Resources — put the returned IDs into wrangler.jsonc
npx wrangler d1 create gitflare-db
npx wrangler r2 bucket create gitflare-storage
npx wrangler kv namespace create CACHE
for q in gitflare-ci-jobs gitflare-ci-dlq gitflare-deploy-jobs gitflare-deploy-dlq \
         gitflare-mirror-sync gitflare-mirror-dlq; do npx wrangler queues create $q; done

# Edit wrangler.jsonc: APP_URL, CLOUDFLARE_ACCOUNT_ID, routes

# Secrets (see table above)
npx wrangler secret put GOOGLE_CLIENT_ID   # …and the rest

npm run db:migrate:remote
npm run deploy

# First admin API key
curl -X POST "$APP_URL/api/bootstrap" -H "Authorization: Bearer $ADMIN_API_KEY"
```

Runner: on the Docker host, `cd packages/runner && RUNNER_SECRET=… ALLOWED_CALLBACK_ORIGINS=$APP_URL docker compose up -d --build`,
then point the Worker's `RUNNER_URL` at it. Worker and runner share a
protocol version (`src/lib/runner-protocol.ts`); deploy them together when it
changes.

### Local development

```bash
cp .dev.vars.example .dev.vars   # fill in values
npm run db:migrate:local
npm run dev                      # http://localhost:8787
npm run typecheck && npm test
```

## Database migrations

Schema changes live in `migrations/` as `NNNN_description.sql` with unique,
sequential prefixes. Wrangler records applied files in the `d1_migrations`
table and only runs new ones.

```bash
npm run db:migrations:create -- <description>   # new numbered file
npm run db:migrate:local                         # apply locally
npm run db:migrations:list                       # show unapplied (remote)
npm run db:export:remote                         # manual backup
```

Production migrations run in the deploy workflow
(`.github/workflows/deploy.yml`): typecheck and tests, verify critical
secrets, export a D1 backup to R2, `wrangler d1 migrations apply --remote`,
then deploy. Migrations run before the new code ships, so they must stay
compatible with the code that is currently live (add columns/tables; don't
drop or rename in the same release that stops using them).

> **One-time, existing production DB:** production was migrated by hand
> before Wrangler tracking existed. Before the first deploy with the migration
> step, run `scripts/2a-inspect-schema.sql` and then
> `scripts/2c-seed-migrations.sql` so Wrangler does not replay 0001–0005.

Durable Object class changes are migrated separately, via the `migrations`
block in `wrangler.jsonc` (tag `v3` deletes the unused `CISession` class).

## Usage

```bash
# Create a repository
curl -X POST "$APP_URL/api/repos" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"name": "my-app", "is_private": true}'

# Create a scoped API key (capped at your own access level)
curl -X POST "$APP_URL/api/keys" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "ci-bot", "repo_id": "REPO_ID", "permissions": "write", "expires_in_days": 90}'

# Push (any username, API key as password)
git remote add gitflare "$APP_URL/git/my-app"
git push gitflare main
```

The default branch is protected on creation: pushes to it go through the
merge queue (`POST /api/repos/:repo/tickets`, then move the ticket to
review). The queue rebases the branch on the runner, runs CI on the result,
and fast-forwards the base branch only if CI passes.

### Large files (Git LFS)

Artifacts caps a git blob at 32 MB. Bigger files go through Git LFS and are
stored in R2 (`STORAGE` bucket, `lfs/<repoId>/<oid>`), indexed in D1
`lfs_objects`. Stock `git lfs` works against `$APP_URL/git/<repo>.git`
with no extra configuration:

```bash
git lfs install
git lfs track "*.psd"
git add .gitattributes
git push gitflare main          # LFS objects upload first, then the commits
```

A push containing a blob over 32 MB is rejected before it reaches Artifacts
with a copy-pasteable `git lfs track` recipe (see `/docs/lfs`). Transfer
mode is **presigned** (bytes go straight to R2, objects up to 5 GiB) when
the `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` secrets are set, otherwise
**proxy** (through the Worker, 100 MB cap on Free/Pro zones).
`LFS_MAX_OBJECT_BYTES` lowers the global cap; a repo can lower its own via
`PATCH /api/repos/:repo` (`lfs_enabled`, `lfs_max_object_bytes`).

- API: `GET /api/repos/:repo/lfs` (policy + usage), `GET …/lfs/objects`,
  `GET …/lfs/objects/:oid` (download), `POST …/lfs/token`.
- CLI: `gitflare lfs status|ls|token`, `gitflare files cat --download`.
- MCP: `gitflare_lfs_status`, `gitflare_lfs_list`; `gitflare_files_read`
  returns a structured `lfs` object for pointer files.
- CI: `checkout.lfs: auto|true|false` in `.gitflare/ci.yml`. With `CI_IMAGE`
  unset the runner builds `gitflare-ci:node22` (node + git-lfs, from
  `packages/runner/ci-image`) locally at startup; a custom `CI_IMAGE` must
  include `git-lfs` for LFS checkouts.
- End-to-end check: `scripts/lfs-e2e.sh`.

### CAD from Onshape

A repo can follow Onshape documents (dashboard **CAD** tab, or
`PUT /api/repos/:repo/onshape`). Each new Onshape *Version* becomes one
commit, oldest first, holding every Part Studio and Assembly as GLB (opens in
the dashboard's 3D viewer), STEP and/or STL, stored in Git LFS, plus an
`onshape.json` manifest per document. The commit's author and date are the
Version's; trailers carry `Onshape-Document`, `Onshape-Version` and
`Onshape-Url`.

- Keys: an Onshape API key pair with read access (dev-portal.onshape.com/keys),
  encrypted at rest with `ENCRYPTION_KEY`. Enterprise `*.onshape.com` hosts work.
- Branch: `onshape`, unless the default branch is empty and not protected.
  A merge-queue branch is refused. The Worker writes the commit
  (`src/lib/git-objects.ts`) under the repo push lock and applies the same
  protection check as `git.ts`. CI does not run on these commits.
- Each document gets its own folder. Two documents with the same name do not
  share one. Adding a document requires entering the API keys again.
- Pulling new Versions happens two ways only: once a day (the `*/5` cron checks
  a link 24 h after its last check), or **Pull latest** in the CAD tab, at most
  once a minute. In between, the cron only moves exports that already started
  along. Saving the Onshape settings also checks once. A failed export does not block its version and does not delete the
  previous file: the error goes into `onshape.json` and the commit message.
- Quota: Onshape Free/Standard plans allow 2,500 API calls a year. A check is
  ~1 call per document. Each exported version costs a start, polls, and a
  download per element and format, so a large document can use hundreds of
  calls. Calls are counted in `onshape_links.api_calls` and shown in the
  dashboard.
- Live preview: the CAD tab can render one Part Studio or Assembly of a
  document's main workspace in 3D before any Version exists
  (`src/lib/onshape-preview.ts`). It exports a GLB on demand and caches it in
  R2 under `onshape-preview/<repo_id>/…/<microversion>`, so an unchanged tab
  costs 2 calls and a fresh render about 5–10. Previews are not committed.
- API: `GET|PUT|DELETE /api/repos/:repo/onshape`, `POST …/onshape/sync`,
  `POST …/onshape/versions/:id/retry`, `POST …/onshape/preview`,
  `POST …/onshape/preview/poll`, `GET …/onshape/preview/file`.

### Deploy targets

```bash
curl -X POST "$APP_URL/api/repos/my-app/deploys" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "production",
    "type": "coolify",
    "coolify_app_id": "APP_UUID",
    "coolify_base_url": "https://coolify.example.com",
    "coolify_api_key": "…",
    "branch_filter": ["main"]
  }'
```

When a CI run passes, every active target whose `branch_filter` matches the
branch is deployed. `type: "cloudflare"` targets run `wrangler deploy` on the
runner (`wrangler_config` selects the config file).

`type: "cloudrun"` targets run `gcloud run deploy --source .` on the runner:
Cloud Build builds the checkout (Dockerfile or buildpacks) and rolls out the
revision. The service URL is recorded on the deployment.

```bash
curl -X POST "$APP_URL/api/repos/my-app/deploys" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile key sa.json '{
    name: "production",
    type: "cloudrun",
    gcp_project_id: "my-project",
    gcp_region: "us-central1",
    gcp_service: "my-app",
    gcp_service_account_key: $key,
    branch_filter: ["main"]
  }')"
# or: gitflare deploy add my-app --name production --type cloudrun \
#       --gcp-project my-project --gcp-region us-central1 --gcp-service my-app \
#       --gcp-key-file sa.json --branch-filter main
```

The service account needs Cloud Run Admin, Cloud Build Editor, Artifact
Registry Writer, Storage Admin (for the source upload bucket) and Service
Account User on the Cloud Run runtime account. Omit `gcp_service_account_key`
to use the runner's `GCP_SERVICE_ACCOUNT_KEY` instead. Keys are stored
encrypted and never returned by the API. Cloud Run deploys get a 25 minute
budget (Coolify and Cloudflare: 10).

### GitHub mirror

`POST /api/repos/:repo/mirror` with `github_url` and a `github_token` that has
push access. Pushes and merge-queue merges are mirrored via the
`gitflare-mirror-sync` queue; `POST …/mirror/sync` forces a full sync.

### CI configuration

Add `.gitflare/ci.yml` to the repo:

```yaml
name: My Pipeline

on:                       # omit to run on every push
  push:
    branches: [main, "release/*"]

env:
  NODE_ENV: test

jobs:
  test:
    steps:
      - name: Install
        run: npm ci
      - name: Test
        run: npm test
        timeout: 600      # seconds

  build:
    needs: [test]
    steps:
      - run: npm run build
```

Each run executes in a fresh container (`CI_IMAGE`) on the runner. Logs
stream back to the Worker and are stored in R2. See
`examples/starship.ci.yml` for a larger example.

## License

Private.
