# GitFlare agent rules

These rules apply to every task in this repo. `CLAUDE.md` and `GEMINI.md` are symlinks to this file; edit only `AGENTS.md`.

## Version bump

Every commit that changes product code bumps the GitFlare version in the same commit. Bump the patch number by default: `1.1.3` becomes `1.1.4`. Bump the minor or major number only when the user names one.

Write the new number in all five places:

1. `wrangler.jsonc`: `vars.GITFLARE_VERSION`
2. `package.json`: `version`
3. `package-lock.json`: the two root entries (top-level `version` and `packages[""].version`)
4. `src/index.ts`: both `GITFLARE_VERSION ?? '…'` fallbacks
5. `src/dashboard/index.html`: the account-menu footer, `GitFlare v…`

Leave the CLI, MCP, client, and runner package versions alone unless those packages changed.

## Commit and push

When a task changes this repo, finish by committing and pushing; the user does not need to ask.

- Commit on the current branch and push to its upstream. On `main`, push to `origin/main`.
- Write the commit message as one sentence saying why, ending with a period. Pass it with a HEREDOC.
- After the push, watch the Deploy workflow (`gh run watch`) until it finishes. Report the result. On success, confirm the live version at `https://git.beenex.company/health`; on failure, name the failed step.
- Leave git config untouched. Use plain pushes and commits with hooks; force-push, hard-reset, or `--no-verify` only when the user explicitly asks.
- Keep secrets (`.env`, credentials, tokens) out of commits, and tell the user which files you left out.
- If the user says not to commit or not to push, stop there.
