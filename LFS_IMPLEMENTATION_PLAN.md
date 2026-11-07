# Git LFS on R2: Implementation Plan

> Status: proposal, not started. Companion to `IMPLEMENTATION_PLAN.md`.
> Goal: let any repo on GitFlare hold files larger than the Artifacts caps (32 MB per blob, 1 GB per repo) by storing them in R2 behind the standard Git LFS protocol, so stock `git lfs` clients, the CI runner, the dashboard, the CLI and MCP agents all work without custom tooling.

## Key decisions

1. **Standard Git LFS protocol, nothing bespoke.** Clients discover the server at `<remote>/info/lfs`, which for `https://git.beenex.company/git/<repo>.git` lands inside the existing Basic-Auth middleware in `src/api/git.ts`. No `.lfsconfig`, no client flags.
2. **R2 is the object store.** Existing `STORAGE` binding (`gitflare-storage`), today used only for CI logs. Keys: `lfs/<repoId>/<oid>`. No cross-repo dedup: one key per repo keeps access control trivial and repo deletion a prefix delete.
3. **Two transfer modes behind one batch endpoint.**
   - `proxy`: bytes stream through the Worker into `STORAGE.put(key, body, { sha256: oid })`. R2 rejects a hash mismatch, so integrity is free. Capped by the Worker request-body limit (100 MB on Free/Pro zones, 200 MB Business). Works in `wrangler dev`.
   - `presigned`: Worker signs S3-API PUT/GET URLs with `aws4fetch`; bytes never touch the Worker; single PUT up to 5 GiB. Needs two new secrets (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`). Enabled automatically when the secrets exist; proxy is the fallback and the local-dev path.
   - Both modes share key layout, D1 rows, and auth, so switching is a config change.
4. **D1 is the index.** `lfs_objects(repo_id, oid, size, state, created_at)` answers "does it exist", powers per-repo totals and future GC. R2 is never listed on the hot path.
5. **CI gets its own LFS credential.** The runner clones from the Artifacts remote with an Artifacts token, which the Worker's LFS endpoint cannot verify. The Worker mints a short-lived HMAC token (`lfs1.<repoId>.<scope>.<exp>.<sig>`) alongside the checkout token; the batch endpoint accepts `Basic` (API key) or `Bearer` (minted token).
6. **Push guard with an actionable error.** A push whose pack contains a blob over 32 MB fails in Artifacts with an opaque error. The receive-pack handler already parses the pack; add a size check and reply over sideband with the exact `git lfs track` recipe. This is the single most important "AI experience" item: an agent that hits the limit gets a fix it can execute.
7. **No GC in v1.** Orphaned objects (upload succeeded, push failed) are rare and cheap. Record them; add reachability GC later. Repo delete does remove the R2 prefix.
8. **Locks API skipped.** `git lfs lock` is for binary-asset teams on shared branches; GitFlare's model is branch-per-task. Return 404 so clients fall back cleanly.

---

## User experience

### Developer, first large file

```
$ git lfs install                      # once per machine
$ git lfs track "*.psd" "models/*.bin"
$ git add .gitattributes assets/hero.psd
$ git commit -m "Add hero artwork"
$ git push
Uploading LFS objects: 100% (1/1), 184 MB | 41 MB/s
To https://git.beenex.company/git/design.git
   3f2a1c0..8e71bd4  main -> main
```

- Nothing to configure: `git lfs` discovers `https://git.beenex.company/git/design.git/info/lfs` and reuses the same API key from the credential helper.
- Upload goes to R2 directly (presigned) or via the Worker (proxy). The developer cannot tell which.
- A second push of the same file is a no-op: batch reports the oid as already present.

### Developer, forgot to track

```
$ git push
remote: error: assets/hero.psd is 184 MB; GitFlare stores blobs over 32 MB in Git LFS.
remote: To fix:
remote:   git lfs install
remote:   git lfs track "*.psd"
remote:   git add .gitattributes
remote:   git commit --amend --no-edit
remote:   git push
remote: Docs: https://git.beenex.company/docs/lfs
 ! [remote rejected] main -> main (pre-receive hook declined)
```

- The guard runs before the pack is forwarded to Artifacts, so the repo is never left half-updated.
- If the oversized blob is deeper in history (not the tip commit), the message says so and points at `git lfs migrate import --include="*.psd"`.

### Clone and pull

```
$ gitflare clone design          # or plain git clone
Cloning into 'design'...
Downloading LFS objects: 100% (12/12), 2.1 GB | 88 MB/s
```

- `gitflare clone` checks for `git-lfs` on PATH when the repo reports `lfs.object_count > 0` and prints a one-line install hint if missing. Plain `git clone` without git-lfs still succeeds; the working tree contains pointer files, which is standard LFS behaviour.
- Downloads use presigned R2 GET URLs valid for 15 minutes, so a large clone never ties up a Worker invocation.

### Dashboard

- **File viewer:** a pointer file renders as a card instead of pointer text: `Stored in Git LFS · 184 MB · image/vnd.adobe.photoshop · [Download]`. Download goes through `GET /api/repos/:repo/lfs/objects/:oid` with cookie auth; the Worker redirects to a presigned GET (or streams in proxy mode). Images under 20 MB with an allowlisted type preview inline, same rules as `/raw`.
- **Repo header / settings:** `LFS: 37 objects · 2.1 GB` next to the existing repo stats. Repo settings gains "Max LFS object size" (default from `LFS_MAX_OBJECT_BYTES`) and "Allow LFS uploads" (default on; off makes batch return 403 with a readable reason).
- **Delete repo:** the confirm dialog states how many LFS objects and bytes go with it.

### CI

```yaml
# .gitflare/ci.yml (or wherever CI_CONFIG_PATH points)
checkout:
  lfs: auto        # auto | true | false  (default auto)
```

- `auto`: the runner runs `git lfs pull` when `.gitattributes` contains `filter=lfs` and `git-lfs` is in the job image. Otherwise it logs one warning line in the setup step and continues with pointer files.
- `true`: same, but a missing `git-lfs` fails the setup step with a message naming the fix (`CI_IMAGE=ghcr.io/.../gitflare-ci:node22-lfs` or `apt-get install git-lfs`).
- The runner authenticates LFS with the minted bearer token via `http.<lfs-url>.extraHeader`, scoped to the Worker's LFS URL so it is never sent to Artifacts or GitHub.
- A reference CI image (`packages/runner/ci-image/Dockerfile`: `node:22-bookworm` + `git-lfs`) ships with the runner; it becomes the documented default.

### GitHub mirror

- Unchanged. Pointer files are ~130-byte text blobs and mirror like any file. Binaries stay in R2 only; the mirror settings page says so in one sentence so nobody expects GitHub to hold them.

---

## AI experience

The agents that use GitFlare today reach it three ways: `git` CLI with an API key, the `gitflare` CLI, and the MCP server (`packages/gitflare-mcp`, plus the `/mcp` proxy route). LFS has to be legible through all three, and every failure has to carry its own fix.

### Via git (Claude Code, Codex, any agent with a shell)

- Stock `git lfs` works with the API key the agent already holds, so an agent that already knows LFS needs nothing new.
- The push guard (decision 6) is the teaching moment: the rejection message is a copy-pasteable recipe, the first line names the file and size, and it ends with a stable docs URL. Agents reliably act on this form of error; they do not act on "pack exceeds limit".
- `gitflare clone` prints `This repo uses Git LFS (37 objects, 2.1 GB).` so the agent learns the fact before it reads a pointer file by mistake.

### Via MCP tools

- `gitflare_files_read` on a pointer file returns structured data instead of the pointer text:
  ```json
  { "path": "assets/hero.psd", "lfs": true, "oid": "sha256:…", "size": 192937472,
    "content_type": "image/vnd.adobe.photoshop", "download_url": "https://git.beenex.company/api/repos/design/lfs/objects/…",
    "note": "Large file stored in Git LFS. Use download_url to fetch bytes; do not edit the pointer." }
  ```
  The `note` field is deliberate: it is the sentence the model reads.
- New `gitflare_lfs_status(repo)`: object count, total bytes, max object size, tracked patterns parsed from `.gitattributes` on the default branch, and `transfer_mode`. Agents call this before deciding whether to commit a large artifact or upload it elsewhere.
- New `gitflare_lfs_list(repo, { limit, cursor })`: oids with size and first-seen date, for cleanup and audit tasks.
- `gitflare_repo_info` gains `lfs: { enabled, object_count, total_bytes, max_object_bytes }`.
- Tool descriptions mention the 32 MB Artifacts cap explicitly so the planner knows the rule without hitting it.

### Via the gitflare CLI

- `gitflare files cat` on a pointer prints the LFS card and exits 0 with the pointer on stdout; `--download <out>` fetches the bytes. The non-zero-surprise rule: never emit 180 MB to a terminal by default.
- `gitflare lfs status <repo>` and `gitflare lfs ls <repo>` mirror the MCP tools.
- `gitflare lfs token <repo> [--ttl 15m]` mints a bearer token for scripts that need LFS without an API key (same minting path as CI).

### Agent guidance text

- `README.md` gets a "Large files" section; `examples/*.ci.yml` show `checkout.lfs`.
- MCP server instructions (the string the server returns on initialize) gain one line: "Files over 32 MB must be committed through Git LFS; GitFlare rejects oversized blobs with a fix recipe."

---

## Architecture

```
git lfs client ──POST /git/:repo.git/info/lfs/objects/batch──► Worker (src/api/lfs.ts)
                                                               │  auth: Basic api key | Bearer lfs token
                                                               │  access: denyGitAccess(read|write)
                                                               │  index: D1 lfs_objects
                                                               ▼
                       ┌── presigned: { href: https://<acct>.r2.cloudflarestorage.com/…?X-Amz-… }
                       │                client PUT/GET straight to R2
                       └── proxy:     { href: https://git.beenex.company/git/:repo.git/info/lfs/objects/<oid> }
                                        Worker streams body ⇄ STORAGE with sha256 check
```

### Routes (all under the existing `/git/:repo` Basic-Auth app)

| Method | Path | Mode | Purpose |
|---|---|---|---|
| POST | `/:repo/info/lfs/objects/batch` | both | LFS batch API: `{operation, objects[], transfers?, ref?}` → `{transfer, objects[]}` |
| PUT | `/:repo/info/lfs/objects/:oid` | proxy | Upload one object. `Content-Length` required. `STORAGE.put(..., { sha256: oid })`. |
| GET | `/:repo/info/lfs/objects/:oid` | proxy | Download one object, streamed from R2. |
| POST | `/:repo/info/lfs/objects/verify` | both | Confirms `head(key)` exists with the declared size; flips `state` to `ready`. |
| * | `/:repo/info/lfs/locks*` | – | 404 JSON `{ message: "Locks not supported" }`. |

Dashboard/API routes under the existing `repoAccess` middleware (`/api/repos`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/:repo/lfs` | Stats + tracked patterns (feeds MCP `gitflare_lfs_status`). |
| GET | `/:repo/lfs/objects` | Paginated list. |
| GET | `/:repo/lfs/objects/:oid` | Cookie/API-key download: 302 to presigned GET or stream. |
| POST | `/:repo/lfs/token` | Mint a read (or write, for admins) bearer token. |

### Batch response rules

- `download`: every oid present in D1 with `state='ready'` gets an action; missing ones get `{ error: { code: 404 } }` per object, not a top-level failure.
- `upload`: oids already `ready` are returned with no `actions` (client skips). New oids over `max_object_bytes` get `{ error: { code: 422, message } }`. Others get `upload` (+ `verify`) actions and an `lfs_objects` row in `state='pending'`.
- Write access required for `upload`, read for `download`, via `denyGitAccess`. Private repo + no read → 404 so names do not leak (same rule as git routes).
- `transfer` is always `basic`.
- Action `expires_in`: 900 s. Presigned URLs are signed for the same window.

### Presigned mode details

- `aws4fetch` `AwsClient` with `service: 's3'`, endpoint `https://<account>.r2.cloudflarestorage.com/<bucket>`.
- Upload integrity: the batch response includes `header: { "x-amz-checksum-sha256": base64(oid) }` on the upload action and that header is in the signed header set, so a client cannot upload different bytes under the oid. **Spike item 0b confirms R2 enforces it**; if it does not, the `verify` step hashes by streaming the object once (acceptable, happens only on upload).
- Download: presigned GET with `response-content-disposition` so browser downloads keep the filename.

### D1 migration `0008_lfs.sql`

```sql
CREATE TABLE lfs_objects (
  repo_id    TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  oid        TEXT NOT NULL,                 -- lowercase hex sha256
  size       INTEGER NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo_id, oid)
);
CREATE INDEX idx_lfs_objects_repo_state ON lfs_objects(repo_id, state);
ALTER TABLE repositories ADD COLUMN lfs_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repositories ADD COLUMN lfs_max_object_bytes INTEGER;  -- NULL = global default
```

### Tokens

- `src/lib/lfs-token.ts`: `mintLfsToken(env, { repoId, scope: 'read'|'write', ttlSeconds })` and `verifyLfsToken(env, token)`. HMAC-SHA256 over `repoId.scope.exp` with a key derived from `ENCRYPTION_KEY` via HKDF (reusing `crypto.ts` helpers). Format `lfs1.<repoId>.<scope>.<exp>.<b64sig>`.
- The git Basic-Auth middleware is widened to: `Basic` → existing API-key path; `Bearer lfs1.…` → verified token becomes a synthetic principal with the token's scope, limited to that repo. Git smart-HTTP routes reject Bearer (they need a real key) to keep today's behaviour.

### Config

| Name | Kind | Default | Purpose |
|---|---|---|---|
| `LFS_MAX_OBJECT_BYTES` | var | `5368709120` (5 GiB) presigned, `104857600` (100 MB) proxy | Global cap; repo setting can lower it. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | secret | unset | Enables presigned mode. |
| `R2_BUCKET_NAME` | var | `gitflare-storage` | For S3 URL construction. |
| `LFS_URL_TTL_SECONDS` | var | `900` | Presigned URL and action expiry. |

---

## Phases

### Phase 0: Spikes (half a day)
- **0a** Confirm `git lfs` discovers `/git/<repo>.git/info/lfs` behind Basic Auth with the credential helper, against `wrangler dev`.
- **0b** Confirm R2 rejects a presigned PUT whose body does not match a signed `x-amz-checksum-sha256`. Decides whether `verify` must hash.
- **0c** Capture the exact Artifacts error for a >32 MB blob push through the current receive-pack path, to make sure the guard fires first and the fallback message is sane.
- **0d** Check the zone plan for the Worker body limit (100 vs 200 MB) and record it in `LFS_MAX_OBJECT_BYTES` comments.

### Phase 1: Core server, proxy mode (1–2 days)
- **Creates:** `src/api/lfs.ts`, `src/lib/lfs.ts` (pointer parse, oid validation, key layout, batch types), `src/lib/lfs-token.ts`, `migrations/0008_lfs.sql`, `test/lfs.test.ts`, `test/lfs-token.test.ts`, `scripts/lfs-e2e.sh`.
- **Edits:** `src/api/git.ts` (mount LFS routes, Bearer auth branch), `src/env.ts` (vars/secrets types), `wrangler.jsonc` (vars), `src/api/repos.ts` (delete repo → `STORAGE.delete` of listed prefix in batches of 1000 via `waitUntil`).
- Batch, PUT, GET, verify, locks-404.
- `scripts/lfs-e2e.sh`: creates a repo, tracks a 40 MB random file, pushes, clones elsewhere, compares checksums. Runs against `wrangler dev` and, with `GITFLARE_URL`, against production after deploy.
- Unit tests stay in the Node vitest project (pure modules); the e2e script covers the binding-dependent path.

### Phase 2: Presigned mode (1 day)
- Add `aws4fetch`; `src/lib/r2-presign.ts`; batch chooses mode from config; `verify` logic per spike 0b.
- Download redirect in `/api/repos/:repo/lfs/objects/:oid`.
- Set the two secrets in production, re-run `scripts/lfs-e2e.sh` with a 300 MB file.

### Phase 3: Push guard (half a day)
- In `git-receive-pack` handler: after `parseReceivePackRequest`, scan pack object headers for blobs with uncompressed size > 32 MiB (header only; no inflate of the body). On hit, respond via `buildSidebandError` with the recipe from the UX section and do not forward to Artifacts.
- Note thin packs and deltas: a delta object has no final size in its header; let those through (Artifacts still enforces) and keep the opaque-error fallback text helpful.
- Unit test with a crafted pack in `test/git-protocol.test.ts`.

### Phase 4: CI runner (1 day)
- `src/queue/ci-consumer.ts` and deploy dispatch: mint an LFS read token with the checkout token; add `lfs: { url, token }` to `RunnerCheckout` (`src/lib/runner-protocol.ts`, bump `RUNNER_PROTOCOL_VERSION`; runner tolerates absence).
- `packages/runner/src/docker.ts` `cloneInJob`: after checkout, if `checkout.lfs` and `.gitattributes` has `filter=lfs` (or `lfs: true`), run `git lfs install --local && git lfs pull` with `GIT_CONFIG_*` entries for `lfs.url` and `http.<lfs.url>.extraHeader`.
- `src/lib/ci-parser.ts`: `checkout.lfs: auto|true|false`.
- `packages/runner/ci-image/Dockerfile` + build/push in `.github/workflows/deploy.yml`; set `CI_IMAGE` on the runner.
- Merge-queue CI inherits this through the same dispatch path.

### Phase 5: Dashboard and API surfaces (1 day)
- `src/lib/artifact-reader.ts`: `getArtifactBlob` detects a pointer (`version https://git-lfs.github.com/spec/v1`, `oid sha256:`, `size`) and returns `{ is_lfs, lfs: { oid, size } }`; joins `lfs_objects` for `state`.
- `src/api/files.ts` `/blob` and `/raw`: pointer-aware (raw of a pointer returns the pointer text; download is the explicit LFS route).
- `/api/repos/:repo/lfs*` routes; repo info includes `lfs` block.
- `src/dashboard/index.html`: LFS card in the file viewer, stats in the repo header, settings fields, delete-confirm text.

### Phase 6: AI and CLI surfaces (half a day)
- `packages/gitflare-client`: `lfs.status`, `lfs.list`, `lfs.token`, `files.blob` typed with the `lfs` block.
- `packages/gitflare-mcp`: `gitflare_lfs_status`, `gitflare_lfs_list`; `gitflare_files_read` returns the structured LFS object; server instructions updated. Mirror the tool list in `src/api/mcp.ts` proxy if it enumerates tools.
- `packages/gitflare-cli`: `lfs status|ls|token`, `files cat --download`, `clone` LFS hint.
- Docs: README "Large files" section, `examples/` CI snippets, `/docs/lfs` page (static route in the Worker so the push-guard URL resolves).

### Phase 7: Rollout
1. Push Phases 1 and 3 together (proxy mode works with zero new secrets). Deploy, run `scripts/lfs-e2e.sh` against production.
2. Set R2 secrets, deploy Phase 2, re-run e2e with a 300 MB file.
3. Phases 4–6 in any order; each is independently deployable.
4. Real-repo validation from `CLOUDFLARE_VIABILITY_RESEARCH.md`: Galileo-Microscope (27.7 MB CAD blob, just under the cap) and t3code (48.4 MB historical blob, needs `git lfs migrate import`). Both importing cleanly is the acceptance test.

---

## Non-goals (v1)

- Locks API.
- Reachability-based garbage collection of orphaned or history-rewritten objects.
- Cross-repo deduplication.
- Multipart (>5 GiB) uploads; LFS `basic` transfer is one PUT per object.
- Mirroring LFS objects to GitHub.

## Risks and mitigations

- **Worker body limit in proxy mode.** Documented cap; presigned mode is the real answer and is Phase 2, not "later".
- **Zombie `pending` rows.** Upload action issued, client never uploaded. Harmless; a weekly cron (`src/lib/maintenance.ts`) deletes `pending` rows older than 24 h after `head()` confirms absence.
- **Pointer detection false positives.** A text file that happens to start with the LFS header line is treated as a pointer only if all three required lines parse and size < 1 KB (spec limit).
- **Token leakage in CI logs.** The runner passes the LFS token via `GIT_CONFIG_*` env, never on a command line, and the existing log redaction for the checkout token is extended to it.
- **Artifacts adds native LFS.** The research note says not to assume it. If it lands, `lfs_objects` and the R2 layout stay; only the batch handler changes.
