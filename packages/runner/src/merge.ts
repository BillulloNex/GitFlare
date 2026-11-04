/**
 * Merge-queue git operations (B4.3). Results go to the Worker's
 * /api/internal/merge/callback.
 *
 *   merge         fetch base + agent branch → rebase the verified commit onto
 *                 the base tip → force-push the result to `resultBranch`
 *   fast-forward  check the base tip is still `baseSha` → non-force push of
 *                 `resultSha` to the base branch (Artifacts refuses anything
 *                 but a fast-forward) → delete `resultBranch` (best effort)
 *
 * These run git on the runner itself, in a scratch directory, because no
 * repository code is executed: no checkout hooks (hooksPath=/dev/null), no
 * system/global config, no submodules, no filters. Every git invocation is
 * an argv array (never a shell string); branch names and SHAs are validated
 * in protocol.ts before they get here. The Artifacts token reaches git only
 * through GIT_CONFIG_* environment variables — never argv, never .git/config.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import type { MergeCallback, MergeRequest } from './protocol.js';
import { sendCallback } from './worker-client.js';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

type Outcome = Omit<MergeCallback, 'ticketId' | 'attemptId' | 'op' | 'durationMs' | 'logs'>;

/** Token-masking, bounded output buffer. */
class MergeLog {
  private readonly lines: string[] = [];
  constructor(private readonly secret: string) {}

  push(line: string): void {
    let clean = line.length > 2000 ? `${line.slice(0, 2000)}…` : line;
    if (this.secret.length >= 6) clean = clean.split(this.secret).join('***');
    this.lines.push(clean);
    if (this.lines.length > 500) this.lines.shift();
  }

  tail(n: number): string[] {
    return this.lines.slice(-n);
  }
}

class DeadlineError extends Error {}

class Git {
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly cwd: string,
    home: string,
    req: MergeRequest,
    private readonly log: MergeLog,
    private readonly deadline: number
  ) {
    // Minimal environment: none of the runner's own secrets reach git.
    this.env = {
      PATH: process.env.PATH,
      HOME: home,
      LANG: 'C.UTF-8',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_EDITOR: 'true',
      GIT_SEQUENCE_EDITOR: 'true',
      GIT_COMMITTER_NAME: req.committer.name,
      GIT_COMMITTER_EMAIL: req.committer.email,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${req.token}`,
    };
  }

  /** Run `git <args>` in the scratch repo. Never rejects except on deadline. */
  run(args: string[], opts: { quiet?: boolean } = {}): Promise<GitResult> {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new DeadlineError('Merge operation exceeded its deadline'));
    const argv = [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false',
      '-c', 'protocol.file.allow=never',
      '-c', 'submodule.recurse=false',
      '-c', 'advice.detachedHead=false',
      ...args,
    ];
    if (!opts.quiet) this.log.push(`$ git ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const child = spawn('git', argv, { cwd: this.cwd, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, remaining);
      child.stdout.on('data', (c: Buffer) => (stdout = (stdout + c.toString()).slice(-256 * 1024)));
      child.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString()).slice(-256 * 1024)));
      const finish = (code: number) => {
        clearTimeout(timer);
        if (!opts.quiet) {
          for (const line of `${stdout}\n${stderr}`.split('\n')) if (line.trim()) this.log.push(line);
        }
        if (timedOut) reject(new DeadlineError(`git ${args[0]} exceeded the merge deadline`));
        else resolve({ code, stdout, stderr });
      };
      child.on('error', err => {
        stderr += `\n${err.message}`;
        finish(127);
      });
      child.on('close', code => finish(code ?? 128));
    });
  }

  /** Run and require exit 0; returns trimmed stdout. */
  async ok(args: string[], what: string): Promise<string> {
    const res = await this.run(args);
    if (res.code !== 0) throw new Error(`${what} failed (exit ${res.code}): ${lastLine(res.stderr)}`);
    return res.stdout.trim();
  }
}

function lastLine(text: string): string {
  return text.trim().split('\n').filter(Boolean).pop()?.slice(0, 500) ?? '';
}

const BASE_REF = 'refs/remotes/origin/base';
const BRANCH_REF = 'refs/remotes/origin/branch';
const RESULT_REF = 'refs/remotes/origin/result';

async function initRepo(git: Git, req: MergeRequest): Promise<void> {
  await git.ok(['init', '-q', '.'], 'git init');
  await git.ok(['remote', 'add', 'origin', req.repoUrl], 'git remote add');
}

// ─── merge ──────────────────────────────────────────────────────

async function runMerge(git: Git, req: MergeRequest): Promise<Outcome> {
  await initRepo(git, req);
  await git.ok(
    ['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${req.baseBranch}:${BASE_REF}`, `+refs/heads/${req.branch}:${BRANCH_REF}`],
    'fetch'
  );
  const baseSha = await git.ok(['rev-parse', '--verify', `${BASE_REF}^{commit}`], 'resolve base');

  // Merge exactly the commit the Worker verified, not whatever the branch is now.
  const exists = await git.run(['cat-file', '-e', `${req.commitSha}^{commit}`]);
  if (exists.code !== 0) return { success: false, baseSha, error: `Commit ${req.commitSha.slice(0, 12)} is not on branch '${req.branch}'` };
  await git.ok(['checkout', '-q', '--detach', req.commitSha], 'checkout');

  const upToDate = await git.run(['merge-base', '--is-ancestor', baseSha, 'HEAD']);
  if (upToDate.code !== 0) {
    const rebase = await git.run(['rebase', '--no-autosquash', baseSha]);
    if (rebase.code !== 0) {
      const unmerged = await git.run(['diff', '--name-only', '--diff-filter=U']);
      const conflicts = unmerged.stdout.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 100);
      await git.run(['rebase', '--abort']);
      return {
        success: false,
        baseSha,
        conflicts,
        error: conflicts.length
          ? `Rebase onto ${req.baseBranch} (${baseSha.slice(0, 12)}) has conflicts in: ${conflicts.join(', ')}`
          : `Rebase onto ${req.baseBranch} failed: ${lastLine(rebase.stderr) || `exit ${rebase.code}`}`,
      };
    }
  }

  const resultSha = await git.ok(['rev-parse', '--verify', 'HEAD^{commit}'], 'resolve result');
  // The result branch belongs to the queue; a previous attempt may have left one.
  await git.ok(['push', '--force', '--quiet', 'origin', `${resultSha}:refs/heads/${req.resultBranch}`], 'push result branch');
  return { success: true, resultSha, baseSha };
}

// ─── fast-forward ───────────────────────────────────────────────

async function runFastForward(git: Git, req: MergeRequest): Promise<Outcome> {
  const resultSha = req.resultSha!;
  const expectedBase = req.baseSha!;
  await initRepo(git, req);
  await git.ok(
    ['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${req.baseBranch}:${BASE_REF}`, `+refs/heads/${req.resultBranch}:${RESULT_REF}`],
    'fetch'
  );
  const baseSha = await git.ok(['rev-parse', '--verify', `${BASE_REF}^{commit}`], 'resolve base');

  if (baseSha === resultSha) return { success: true, resultSha, baseSha };
  if (baseSha !== expectedBase) {
    return { success: false, baseSha, baseMoved: true, error: `Base branch '${req.baseBranch}' moved (${expectedBase.slice(0, 12)} → ${baseSha.slice(0, 12)})` };
  }
  const exists = await git.run(['cat-file', '-e', `${resultSha}^{commit}`]);
  if (exists.code !== 0) return { success: false, baseSha, error: `Merge result ${resultSha.slice(0, 12)} not found` };
  const ff = await git.run(['merge-base', '--is-ancestor', baseSha, resultSha]);
  if (ff.code !== 0) return { success: false, baseSha, error: 'Merge result is not a fast-forward of the base branch' };

  // Non-force: rejected unless it is a fast-forward of the CURRENT remote tip.
  const push = await git.run(['push', '--quiet', 'origin', `${resultSha}:refs/heads/${req.baseBranch}`]);
  if (push.code !== 0) {
    const remote = await git.run(['ls-remote', 'origin', `refs/heads/${req.baseBranch}`], { quiet: true });
    const tip = remote.stdout.split(/\s+/)[0] ?? '';
    if (tip === resultSha) return { success: true, resultSha, baseSha };
    if (tip && tip !== expectedBase) {
      return { success: false, baseSha: tip, baseMoved: true, error: `Base branch '${req.baseBranch}' moved during fast-forward` };
    }
    return { success: false, baseSha, error: `Fast-forward push failed: ${lastLine(push.stderr) || `exit ${push.code}`}` };
  }

  const cleanup = await git.run(['push', '--quiet', '--delete', 'origin', `refs/heads/${req.resultBranch}`]);
  if (cleanup.code !== 0) console.warn(`merge ${req.ticketId}: could not delete ${req.resultBranch}: ${lastLine(cleanup.stderr)}`);
  return { success: true, resultSha, baseSha };
}

// ─── Entry ──────────────────────────────────────────────────────

const activeMerges = new Set<string>();

function key(req: Pick<MergeRequest, 'attemptId' | 'op'>): string {
  return `${req.attemptId}:${req.op}`;
}

/** True if this exact attempt + op is already running (redelivered dispatch). */
export function isMergeKnown(req: Pick<MergeRequest, 'attemptId' | 'op'>): boolean {
  return activeMerges.has(key(req));
}

export function mergeCapacityAvailable(): boolean {
  return activeMerges.size < config.maxConcurrentMerges;
}

export async function executeMerge(req: MergeRequest): Promise<void> {
  const k = key(req);
  activeMerges.add(k);
  const started = Date.now();
  const log = new MergeLog(req.token);
  const label = `merge ${req.ticketId} (${req.op}, attempt ${req.attemptId.slice(0, 8)})`;
  let dir: string | null = null;
  let outcome: Outcome;

  try {
    dir = await mkdtemp(join(tmpdir(), 'gitflare-merge-'));
    const work = join(dir, 'repo');
    const home = join(dir, 'home');
    await Promise.all([mkdir(work), mkdir(home)]);
    const git = new Git(work, home, req, log, started + req.deadlineMs);
    console.log(`${label} started`);
    outcome = req.op === 'merge' ? await runMerge(git, req) : await runFastForward(git, req);
  } catch (err) {
    outcome = { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(err => console.error(`${label}: cleanup failed`, err));
    activeMerges.delete(k);
  }

  if (outcome.error) log.push(`[runner] ${outcome.error}`);
  console.log(`${label} finished: ${outcome.success ? `ok ${outcome.resultSha?.slice(0, 12)}` : `failed (${outcome.error})`}`);
  const body: MergeCallback = {
    ticketId: req.ticketId,
    attemptId: req.attemptId,
    op: req.op,
    ...outcome,
    durationMs: Date.now() - started,
    logs: log.tail(50),
  };
  await sendCallback(req.callbackUrl, body, label);
}
