# Ideas: Plan

> GitFlare is for exploratory, experimental work. Ideas show up at random times.
> They need a place to land, and agents need a place to explore them and log what they did.

## Model

Two tables. Every idea belongs to a repo and uses that repo's access rules (`checkRepoAccess`).

**Idea**
| Field | Notes |
|---|---|
| `id` | short random id |
| `repo_id` | required |
| `title` | |
| `body` | markdown: the raw thought |
| `status` | `created` → `in_progress` → `done` \| `abandoned` |
| `created_by` | user or API key / agent name |
| `created_at`, `updated_at` | |

**Log entry** (append-only)
| Field | Notes |
|---|---|
| `id`, `idea_id` | |
| `author` | user or agent name |
| `text` | markdown: "tried X, got Y, next Z" |
| `refs` | optional JSON: `{ commits: [], branch, ci_run_id }` |
| `created_at` | |

Commits link to an idea when a log entry mentions them. No trailers or push-time parsing.

## Rules
- Access follows the repo: `read` can view, `write` can create, log, and change status.
- Log entries can't be edited or deleted. Fix a mistake by adding another entry.
- Status can move in any direction (an `abandoned` idea can be picked up again). Each status change also writes a log entry automatically.
- When an agent picks up an idea, it sets `in_progress`. There are no locks or leases.

## Phase 1: API + notes UI
- `migrations/0012_ideas.sql`: `ideas`, `idea_logs`
- `src/api/ideas.ts`, mounted at `/api/repos`:
  - `GET    /:repo/ideas?status=`
  - `POST   /:repo/ideas`
  - `GET    /:repo/ideas/:id` (includes log)
  - `PATCH  /:repo/ideas/:id` (title, body, status)
  - `POST   /:repo/ideas/:id/log`
- Dashboard: an **Ideas** tab on each repo
  - Quick-capture box at the top (title + optional body, saved with Enter)
  - List filtered by status
  - Idea page: body, status switcher, log timeline, add-note box
- Tests: access control, status changes write a log entry, log is append-only

## Phase 2: Agents (CLI + MCP)
- `packages/gitflare-client`: idea methods
- `packages/gitflare-cli`: `gitflare idea add|list|show|status|log`
- `packages/gitflare-mcp` + `/mcp`: `idea_create`, `idea_list`, `idea_get`, `idea_update`, `idea_log`
- Tool descriptions tell agents to set `in_progress` when they start, log each attempt with commit refs, and finish with `done` or `abandoned` plus a summary.

## Phase 3: ChatGPT / Claude connectors
- OAuth on `/mcp`, because their custom connectors don't accept Bearer API keys. This is the only significant new work in the plan.

## Not included (until needed)
Tags, sub-ideas, claims/leases, outcome field, linking ideas to tickets, ideas without a repo, ideas stored as files in the repo.
