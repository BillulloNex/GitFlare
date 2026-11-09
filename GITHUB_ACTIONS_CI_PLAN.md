# GitHub Actions as CI compute: Plan

> Status: initial implementation in GitFlare v1.1.12. Account-owned organization connections, top-level `runs-on`, GitHub/Blacksmith CI dispatch, OIDC callbacks, and merge-queue dispatch are implemented. The limitations in the README remain follow-up work; an instance GitHub App must be registered and configured before live use. Companion to `IMPLEMENTATION_PLAN.md` and `LFS_IMPLEMENTATION_PLAN.md`.
> Goal: let every GitFlare user bring their own GitHub account(s) as free CI compute. GitFlare stays the home of the code and decides where work runs. GitHub runs tests and the merge queue. The self-hosted runner stays as a second option.

## Glossary

Plain-language definitions for terms used throughout this doc.

- **Runner**: GitFlare's own Docker machine (`packages/runner`). Today it does all CI, merge-queue git work and deploys.
- **CI**: running a repo's tests (`.gitflare/ci.yml`) after a push.
- **Rebase**: replay a branch's changes on top of the newest `main`, as if the work had started there. Fails with a *conflict* when both sides edited the same lines.
- **Merge queue**: GitFlare's line of branches waiting to land on `main`. For each one: rebase onto the latest `main`, test the combined result, then move `main` to it. Prevents "both changes passed alone, broke together".
- **Fast-forward**: move `main` to point at the tested result. Only allowed if `main` has not moved since the rebase.
- **Mirror repo**: a copy of a GitFlare repo on GitHub, created so GitHub Actions has code to run on.
- **GitHub App**: one app, owned by GitFlare, that each user installs on their own GitHub accounts. Gives GitFlare short-lived, per-account access without personal tokens.
- **OIDC token**: a signed note GitHub hands a running job ("I am run 123 of repo X at commit Y"). GitFlare verifies it with GitHub's public keys, so no GitFlare secret ever lives in GitHub.
- **Connection**: a compute source a GitFlare user has added: a GitHub account (installation) or a runner.

## Key decisions

1. **Bring your own GitHub.** Each GitFlare user connects their own GitHub accounts. Thomas connects `BillulloNex` (org, Team plan) and `ThomasVuNguyen` (personal). Bob connects his. Nobody uses anyone else's accounts.
2. **One GitHub App named "GitFlare"**, owned by BillulloNex, installed by each user on their own accounts (the Vercel/Netlify model). `github.com/apps/gitflare` was unclaimed on 2026-11-07.
3. **The repo owner pays.** CI for a repo always runs on the repo owner's connections, whoever pushed. Same as GitHub. Requires a new `repositories.owner_id`.
4. **Configuration lives in code.** `.gitflare/ci.yml` says *where* a job runs (`runs-on`), like GitHub Actions. No per-repo settings form.
5. **Private code never reaches a public-only account.** Enforced by GitFlare at dispatch time, not by the YAML.
6. **Merge queue runs fully on GitHub (option b).** A user with only GitHub connected gets CI *and* the merge queue. No runner required.
7. **Runner stays.** It becomes a connection owned by a user (Thomas's runner is Thomas's), selectable with `runs-on: runner`, and usable as a fallback.
8. **Deploys are out of scope for v1.** They stay on the owner's runner. Moving deploys to GitHub is a later phase (see Deferred).
9. **Within GitHub's terms.** Every account only runs CI for its owner's own projects. No account farming, no shared CI repo building unrelated projects, no general compute.

---

## User experience

### Connecting GitHub (each user, once per account)

`Account ▸ Connections`:

```
┌─────────────────────────────────────────────────────────┐
│ ● BillulloNex      org · Team   412 / 3,000 min         │
│   Private repos: allowed                                │
│ ● ThomasVuNguyen   personal     unlimited (public)      │
│   Private repos: off                                    │
│ ● my-runner        self-hosted · online                 │
│ [ + Connect GitHub ]  [ + Add runner ]                  │
└─────────────────────────────────────────────────────────┘
```

1. **Connect GitHub** opens GitHub's install page for the GitFlare app. The user picks an account (org or personal) and approves.
2. GitHub redirects back. GitFlare also has the user authorize the app with their GitHub login and confirms the installation appears in *their* `GET /user/installations`. **Required:** the `installation_id` in the redirect URL is user-controlled; without this check Bob could claim BillulloNex.
3. The account appears as a card. Default "Private repos": **allowed** for orgs, **off** for personal accounts. The user can toggle it.

One-time setup for the instance (Thomas): create the app via GitHub's app-manifest flow from an admin page. GitFlare posts a prefilled manifest (permissions, webhook URL), Thomas clicks Create on GitHub with BillulloNex as owner, and GitHub returns the app id, private key and webhook secret, which GitFlare stores encrypted.

### Configuring a repo (`.gitflare/ci.yml`)

```yaml
runs-on: github                # default for every job

jobs:
  test:
    steps: [...]

  gpu-bench:
    runs-on: runner            # needs the owner's runner
    steps: [...]

  release:
    runs-on: [github, runner]  # try GitHub, fall back to the runner
    steps: [...]
```

- `github`: GitFlare picks one of the **repo owner's** GitHub connections:
  - Private repo: an account with "Private repos: allowed".
  - Public repo: prefer a personal account, where public minutes are unlimited.
- `github:<account>`: a specific account, which must still be one of the owner's connections. The visibility rule still applies.
- `runner`: the owner's runner.
- A list: try in order. Move on when the account is out of minutes, GitHub is down, or the job is not picked up within N minutes.
- Omitted: `github` if the owner has a GitHub connection, otherwise the owner's runner. Existing repos (owned by Thomas, who has a runner) keep working unchanged.
- Nothing usable: the run fails with "Connect GitHub or a runner in Account ▸ Connections."

### What users see

- Every CI run shows where it ran: `GitHub · BillulloNex ↗` (links to the GitHub run) or `Runner`, with the reason on fallbacks (`fell back: BillulloNex at 3,000/3,000 min`).
- Step status updates live. Full logs are copied to R2 when the run ends, so the dashboard looks the same for both backends.
- Changing visibility:
  - Private → public: CI can move to a personal account.
  - Public → private: CI stops using public-only accounts, and the user is told the old public mirror still exists, with a delete button.

---

## Architecture

### Mirror repos

- GitFlare creates `gf-<repo>` on the chosen GitHub account the first time it is needed (installation token, `POST /orgs/:org/repos` or `/user/repos`). Visibility matches the GitFlare repo.
- Code is pushed with the existing pack-push code (`pushRefsToGitHub` in `src/lib/github-mirror.ts`), authenticated with an installation token instead of a PAT.
- CI mirrors are separate from the existing user-configured GitHub mirror feature. A repo can have both.
- Each mirror holds one tiny workflow stub, written once at creation, that calls the shared workflow. GitFlare never needs the sensitive `workflow` permission afterwards.

### Shared workflow: `BillulloNex/gitflare-ci` (public)

It must be public: repos on personal accounts cannot call reusable workflows in a private org repo. Two entry points:

- `ci`: check out `sha`, parse `.gitflare/ci.yml`, run the jobs selected for GitHub in dependency order inside **one** GitHub job (GitHub bills each job rounded up to a whole minute), and report each step.
- `merge`: see below.

Triggered by `repository_dispatch` with `{ run_id | ticket_id, sha, ... }`. `concurrency` cancels superseded runs.

### Reporting back

- The job requests an OIDC token (`permissions: id-token: write`) and calls `POST /api/internal/github/*`.
- The Worker verifies the token against GitHub's public keys (`token.actions.githubusercontent.com`) and checks:
  - the `repository` claim matches the repo's mirror;
  - the `sha` and run id match a pending dispatch.
- A `workflow_run` webhook from the app is the backstop for cancelled or crashed runs.
- Logs: `GET /repos/:o/:r/actions/runs/:id/logs` (zip) → R2 after completion.

### Merge queue on GitHub (option b)

Today (`src/api/internal-merge.ts`):
1. The runner rebases.
2. The runner pushes the result to `gitflare/merge-queue/<ticket>`.
3. CI runs on that branch.
4. The runner fast-forwards the base branch.

The runner pushes with Artifacts tokens, which can write to **any** branch, so those must never be given to GitHub.

New flow when the owner's compute is GitHub:

1. **Dispatch.** The `TicketQueue` DO pushes the base and agent branches to the mirror and dispatches `merge` with `{ ticket_id, base_sha, head_sha }`.
2. **Rebase on GitHub.** The job rebases `head_sha` onto `base_sha`. A conflict is reported back like today's runner conflict.
3. **Scoped push key.** The job exchanges its OIDC token for a **GitFlare merge token**, a new credential minted by the Worker like the existing `lfs1.` tokens:
   - it is scoped to one repo and one ref, `gitflare/merge-queue/<ticket>`;
   - it expires in about 10 minutes.

   `src/api/git.ts` accepts it for that ref only. The job pushes the result branch through GitFlare's normal git endpoint.
4. **CI.** CI runs on the result branch exactly as today (trigger `merge_queue`), routed by `runs-on`, so it also lands on GitHub.
5. **Fast-forward by the Worker itself.** It needs no new objects, only a ref update from `base_sha` to `result_sha` with an empty pack, via `buildReceivePackRequest` in `src/lib/git-objects.ts`, under the repo push lock. If `main` moved, the attempt is retried, as today. This also removes the runner from step 5 for runner-backed repos.

The DO state machine (`dispatch → ci-dispatch → ff-dispatch → complete`) keeps its shape. Only the executor behind `dispatch` changes, and `ff-dispatch` becomes a Worker call. A later optimization can merge steps 2–4 into one GitHub job to save a job's startup time.

### Data model (new migration)

```sql
ALTER TABLE repositories ADD COLUMN owner_id TEXT REFERENCES users(id);
-- backfill: creator from audit log where known, otherwise Thomas

CREATE TABLE github_app (            -- one row: the instance's app
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_id TEXT NOT NULL, slug TEXT NOT NULL,
  private_key_encrypted TEXT NOT NULL,
  webhook_secret_encrypted TEXT NOT NULL,
  client_id TEXT NOT NULL, client_secret_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE compute_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('github', 'runner')),
  github_installation_id TEXT UNIQUE,
  github_account TEXT,               -- login, e.g. BillulloNex
  github_account_type TEXT,          -- 'Organization' | 'User'
  allow_private INTEGER NOT NULL DEFAULT 0,
  runner_url TEXT,                   -- for kind = 'runner'
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE github_ci_mirrors (
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES compute_connections(id) ON DELETE CASCADE,
  github_full_name TEXT NOT NULL,    -- BillulloNex/gf-my-app
  is_private INTEGER NOT NULL,
  PRIMARY KEY (repo_id, connection_id)
);

ALTER TABLE ci_runs ADD COLUMN backend TEXT;           -- 'runner' | 'github'
ALTER TABLE ci_runs ADD COLUMN connection_id TEXT;
ALTER TABLE ci_runs ADD COLUMN github_run_id TEXT;
ALTER TABLE ci_runs ADD COLUMN fallback_reason TEXT;
```

### Worker pieces

- `src/lib/github-app.ts`: sign the app JWT (RS256 via WebCrypto); exchange it for and cache installation tokens; manifest and installation callbacks; OAuth user check.
- `src/lib/compute-router.ts`: resolve `runs-on` + owner + visibility → connection, plus the fallback order. Pure function, unit-tested.
- `src/lib/github-oidc.ts`: fetch and cache GitHub's public keys; verify tokens and claims.
- `src/api/connections.ts`: connect, list, toggle and remove connections.
- `src/api/internal-github.ts`: status/log callbacks, the merge-token exchange, and the webhook.
- `src/lib/ci-parser.ts`: add `runs-on` at the top level and per job.
- `src/api/git.ts`: accept merge tokens, limited to their single ref.

### Minutes

- Show minutes on the Connections card from GitHub's billing API when the app's permissions allow; otherwise from GitFlare's own `ci_runs` durations.
- Before sending a private job to an account, skip the account if it is near its quota.
- Recommend that users set their Actions spending limit to $0 so overage can never bill them.

---

## Phases

0. **Spike (about half a day, behind a flag)**
   - Create the app through the manifest flow.
   - Install it on BillulloNex, including the verified-owner check.
   - Push one commit to a `gf-` mirror with an installation token.
   - Send one `repository_dispatch` and accept one OIDC callback in the Worker.
   - Confirm an empty-pack fast-forward against Artifacts works.
1. **Connections:** migration, app setup, connect flow, `owner_id` backfill, and the Connections page.
2. **CI on GitHub:** `runs-on` parsing, compute router, mirror creation, `gitflare-ci` workflow (`ci`), status/log callbacks, webhook backstop, and run labels in the dashboard.
3. **Merge queue on GitHub:** `merge` entry point, merge tokens in `git.ts`, Worker-side fast-forward, and the DO executor switch.
4. **Fallbacks and minutes:** list fallback, pickup timeout, quota check, and minutes on the cards.
5. **CLI/MCP:** `gitflare connections ls`, run backend shown in `ci` output, and docs.

## Deferred

- **Deploys on GitHub.** Today deploys run on the owner's runner, so a GitHub-only user cannot deploy. Later: deploy from GitHub Actions using OIDC trust (GCP Workload Identity for Cloud Run, a stored token for Cloudflare). Needs its own design pass.
- **GitFlare orgs.** A shared team repo is owned by one person, whose minutes pay. Later, an org could own repos and connections. Keep `owner_id` easy to point at an org.
- **Runners for other users.** v1 keeps Thomas's runner as his connection. Others adding their own runners comes later.
- **Live log streaming** from GitHub jobs.

## Open questions

- Which GitHub App permissions read Actions usage for orgs and for personal accounts? Decide in the spike.
- Is GitHub's announced per-minute charge for self-hosted runners in effect? Only matters if anyone registers a runner with GitHub.
- How long should GitFlare wait for GitHub to pick up a job before falling back? Start at 5 minutes.

## Risks

- **Account suspension** if usage looks like abuse. Keep strictly to each owner's own projects, and keep the visibility rule.
- **Installation spoofing.** Mitigated by the OAuth `/user/installations` check.
- **Leaked push keys.** GitHub never receives Artifacts tokens. Merge tokens are single-ref and short-lived.
- **GitHub outages or slow pickup.** Use the `runs-on` list fallback and the pickup timeout.
- **Latency.** Mirror push, dispatch and runner startup add roughly 20–60 seconds per merge-queue attempt.

## Reference facts (verify before relying on them; pricing changes)

- Public repos: standard GitHub-hosted runners are free with no minute cap.
- Private repos: about 2,000 min/month (Free) and 3,000 (Pro/Team). BillulloNex is on Team with 3 seats (checked 2026-11-07).
- Linux bills 1x, Windows about 2x, macOS about 10x. Each job is rounded up to the minute.
- Free plan: 20 concurrent jobs; 6 h per job; 10 GB cache per repo.
