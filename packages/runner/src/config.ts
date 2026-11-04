import { hostname } from 'node:os';

function num(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export const config = {
  port: num('PORT', 7654),
  runnerSecret: process.env.RUNNER_SECRET ?? '',
  /** Labels every container/volume this runner creates, so startup cleanup only touches its own. */
  runnerId: (process.env.RUNNER_ID || hostname()).replace(/[^A-Za-z0-9_.-]/g, '-'),
  /** If set, callback/log URLs must be on one of these origins (e.g. https://git.example.com). */
  allowedCallbackOrigins: list('ALLOWED_CALLBACK_ORIGINS'),

  // ── Job containers ──
  /** Image for CI jobs and Cloudflare deploys. Must contain `git` and `sh`. */
  ciImage: process.env.CI_IMAGE || 'node:22-bookworm',
  /** uid:gid steps run as inside the job container (never root). */
  jobUser: process.env.CI_USER || '1000:1000',
  jobMemory: process.env.CI_MEMORY || '4g',
  jobCpus: process.env.CI_CPUS || '2',
  jobPidsLimit: num('CI_PIDS_LIMIT', 1024),
  /** Docker network for job containers. Must allow egress for clone/install. */
  jobNetwork: process.env.CI_NETWORK || 'bridge',
  maxConcurrentJobs: num('MAX_CONCURRENT_JOBS', 2),
  /** Merge-queue git ops run on the runner itself (no repo code executes); cap them separately. */
  maxConcurrentMerges: num('MAX_CONCURRENT_MERGES', 4),

  // ── Limits ──
  defaultStepTimeoutS: num('CI_STEP_TIMEOUT_S', 600),
  /** Hard cap on a CI run regardless of what the Worker asks for. */
  maxRunMs: num('CI_RUN_TIMEOUT_MS', 60 * 60 * 1000),
  /** Per-step log cap (characters); oldest lines are dropped beyond this. */
  maxStepLogChars: num('CI_MAX_STEP_LOG_CHARS', 1024 * 1024),
  logFlushIntervalMs: num('CI_LOG_FLUSH_MS', 5000),
  coolifyPollIntervalMs: num('COOLIFY_POLL_INTERVAL_MS', 5000),

  // ── Deploy credentials (never exposed to CI steps) ──
  // Coolify credentials come per-target from the Worker in each deploy request.
  /** Injected ONLY into the `wrangler deploy` exec of Cloudflare deploys. */
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN || '',
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
};
