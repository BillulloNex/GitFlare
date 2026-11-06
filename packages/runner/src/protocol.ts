/**
 * Worker ↔ Runner wire protocol. MUST stay in lockstep with
 * src/lib/runner-protocol.ts in the Worker — bump both versions together.
 *
 * Every request in both directions carries `X-GitFlare-Runner-Protocol`.
 * The runner rejects a missing/mismatched version with 426 (the Worker
 * retries, so a rolling deploy of either side converges).
 */

export const PROTOCOL_VERSION = 3;
export const PROTOCOL_HEADER = 'x-gitflare-runner-protocol';

export type LogLine = { timestamp: string; stream: 'stdout' | 'stderr'; line: string };

export interface Checkout {
  url: string;
  token: string;
  branch: string;
  commitSha: string;
}

export interface CIStep {
  id: string;
  ordinal: number;
  jobName: string;
  name: string;
  command: string;
  env?: Record<string, string>;
  /** seconds */
  timeout?: number;
}

export interface CIRunRequest {
  protocolVersion: number;
  runId: string;
  repoName: string;
  checkout: Checkout;
  steps: CIStep[];
  maxDurationMs: number;
  callbackUrl: string;
  logsUrl: string;
}

export interface DeployRequest {
  protocolVersion: number;
  deploymentId: string;
  ciRunId: string | null;
  type: 'coolify' | 'cloudflare' | 'cloudrun';
  callbackUrl: string;
  deadlineMs: number;
  coolify?: { baseUrl: string; apiKey: string; appId: string };
  cloudflare?: { checkout: Checkout; repoName: string; wranglerConfig: string | null };
  /** Google Cloud Run source deploy. `serviceAccountKey` null → runner's GCP_SERVICE_ACCOUNT_KEY. */
  cloudrun?: {
    checkout: Checkout;
    repoName: string;
    projectId: string;
    region: string;
    service: string;
    serviceAccountKey: string | null;
  };
}

/** Merge-queue git operation (see src/lib/runner-protocol.ts RunnerMergeRequest). */
export interface MergeRequest {
  protocolVersion: number;
  op: 'merge' | 'fast-forward';
  ticketId: string;
  attemptId: string;
  repoName: string;
  repoUrl: string;
  token: string;
  branch: string;
  commitSha: string;
  baseBranch: string;
  baseSha?: string;
  resultBranch: string;
  resultSha?: string;
  committer: { name: string; email: string };
  callbackUrl: string;
  deadlineMs: number;
}

export interface MergeCallback {
  ticketId: string;
  attemptId: string;
  op: 'merge' | 'fast-forward';
  success: boolean;
  resultSha?: string;
  baseSha?: string;
  baseMoved?: boolean;
  conflicts?: string[];
  error?: string;
  durationMs: number;
  logs: string[];
}

export type StepStatus ='pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled';

export interface StepReport {
  id: string;
  ordinal: number;
  name: string;
  command: string;
  status: StepStatus;
  exit_code: number | null;
  duration_ms: number | null;
  started_at: string | null;
  finished_at: string | null;
  logs: LogLine[];
}

// ─── Validation ─────────────────────────────────────────────────

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Optional allowlist of Worker origins the runner will POST results (and RUNNER_SECRET) to. */
function allowedCallback(url: string, allowedOrigins: string[]): boolean {
  if (allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(new URL(url).origin);
}

function validateCheckout(c: any, path: string): string | null {
  if (!c || typeof c !== 'object') return `${path} is required`;
  if (!isHttpUrl(c.url)) return `${path}.url must be an http(s) URL`;
  if (typeof c.token !== 'string' || !c.token) return `${path}.token is required`;
  if (typeof c.branch !== 'string' || !c.branch || c.branch.startsWith('-')) return `${path}.branch is invalid`;
  if (typeof c.commitSha !== 'string' || !SHA_RE.test(c.commitSha)) return `${path}.commitSha must be a full SHA`;
  return null;
}

/** Wrangler config path: relative, no traversal, no leading dash. Mirrors the Worker's check. */
export function isValidWranglerConfig(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 200 &&
    /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(path) &&
    !path.split('/').some(seg => seg === '..' || seg === '')
  );
}

export function validateCIRequest(p: any, allowedOrigins: string[]): string | null {
  if (!p || typeof p !== 'object') return 'Body must be a JSON object';
  if (p.protocolVersion !== PROTOCOL_VERSION) return `protocolVersion must be ${PROTOCOL_VERSION}`;
  if (typeof p.runId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(p.runId)) return 'runId is invalid';
  if (typeof p.repoName !== 'string' || !p.repoName) return 'repoName is required';
  for (const key of ['callbackUrl', 'logsUrl'] as const) {
    if (!isHttpUrl(p[key])) return `${key} must be an http(s) URL`;
    if (!allowedCallback(p[key], allowedOrigins)) return `${key} origin is not allowed`;
  }
  if (typeof p.maxDurationMs !== 'number' || p.maxDurationMs <= 0) return 'maxDurationMs must be positive';
  const checkoutError = validateCheckout(p.checkout, 'checkout');
  if (checkoutError) return checkoutError;
  if (!Array.isArray(p.steps) || p.steps.length === 0 || p.steps.length > 500) return 'steps must be a non-empty array (≤500)';
  for (const [i, step] of p.steps.entries()) {
    if (!step || typeof step !== 'object') return `steps[${i}] must be an object`;
    if (typeof step.id !== 'string' || !step.id) return `steps[${i}].id is required`;
    if (typeof step.ordinal !== 'number') return `steps[${i}].ordinal is required`;
    if (typeof step.name !== 'string' || typeof step.command !== 'string' || !step.command) {
      return `steps[${i}] must have string name and command`;
    }
    if (step.timeout !== undefined && (typeof step.timeout !== 'number' || step.timeout <= 0)) {
      return `steps[${i}].timeout must be a positive number of seconds`;
    }
    if (step.env !== undefined) {
      if (typeof step.env !== 'object' || step.env === null || Array.isArray(step.env)) return `steps[${i}].env must be an object`;
      for (const [k, v] of Object.entries(step.env)) {
        if (!ENV_KEY_RE.test(k)) return `steps[${i}].env key "${k}" is invalid`;
        if (typeof v !== 'string') return `steps[${i}].env.${k} must be a string`;
      }
    }
  }
  return null;
}

/**
 * Branch name safe to put in a refspec argument: git-check-ref-format rules
 * (mirrors the Worker's isValidRefName) plus no leading `-` and no `refs/`
 * prefix — the runner builds `refs/heads/<name>` itself.
 */
export function isSafeBranchName(ref: unknown): ref is string {
  if (typeof ref !== 'string' || !ref || ref.length > 255 || ref === '@') return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false;
  if (ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref.startsWith('-') || ref.startsWith('refs/')) return false;
  return ref.split('/').every(c => !c.startsWith('.') && !c.endsWith('.lock'));
}

function isSafeIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f<>]/.test(value);
}

export function validateMergeRequest(p: any, allowedOrigins: string[]): string | null {
  if (!p || typeof p !== 'object') return 'Body must be a JSON object';
  if (p.protocolVersion !== PROTOCOL_VERSION) return `protocolVersion must be ${PROTOCOL_VERSION}`;
  if (p.op !== 'merge' && p.op !== 'fast-forward') return "op must be 'merge' or 'fast-forward'";
  for (const key of ['ticketId', 'attemptId'] as const) {
    if (typeof p[key] !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(p[key])) return `${key} is invalid`;
  }
  if (typeof p.repoName !== 'string' || !p.repoName) return 'repoName is required';
  if (!isHttpUrl(p.repoUrl)) return 'repoUrl must be an http(s) URL';
  if (typeof p.token !== 'string' || !p.token) return 'token is required';
  if (!isHttpUrl(p.callbackUrl)) return 'callbackUrl must be an http(s) URL';
  if (!allowedCallback(p.callbackUrl, allowedOrigins)) return 'callbackUrl origin is not allowed';
  if (typeof p.deadlineMs !== 'number' || p.deadlineMs <= 0) return 'deadlineMs must be positive';
  for (const key of ['branch', 'baseBranch', 'resultBranch'] as const) {
    if (!isSafeBranchName(p[key])) return `${key} is not a valid branch name`;
  }
  if (p.resultBranch === p.baseBranch || p.resultBranch === p.branch) return 'resultBranch must differ from branch and baseBranch';
  if (typeof p.commitSha !== 'string' || !SHA_RE.test(p.commitSha)) return 'commitSha must be a full SHA';
  if (p.op === 'fast-forward') {
    if (typeof p.baseSha !== 'string' || !SHA_RE.test(p.baseSha)) return 'baseSha must be a full SHA';
    if (typeof p.resultSha !== 'string' || !SHA_RE.test(p.resultSha)) return 'resultSha must be a full SHA';
  }
  if (!p.committer || !isSafeIdentity(p.committer.name) || !isSafeIdentity(p.committer.email)) {
    return 'committer.name and committer.email are required';
  }
  return null;
}

/** Mirror the Worker's GCP identifier checks (src/lib/deploy-targets.ts). */
export function isValidGcpProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
}
export function isValidGcpRegion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && /^[a-z]+-[a-z]+[0-9]$/.test(value);
}
export function isValidCloudRunService(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]([a-z0-9-]{0,47}[a-z0-9])?$/.test(value);
}

export function validateDeployRequest(p: any, allowedOrigins: string[]): string | null {
  if (!p || typeof p !== 'object') return 'Body must be a JSON object';
  if (p.protocolVersion !== PROTOCOL_VERSION) return `protocolVersion must be ${PROTOCOL_VERSION}`;
  if (typeof p.deploymentId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(p.deploymentId)) return 'deploymentId is invalid';
  if (!isHttpUrl(p.callbackUrl)) return 'callbackUrl must be an http(s) URL';
  if (!allowedCallback(p.callbackUrl, allowedOrigins)) return 'callbackUrl origin is not allowed';
  if (typeof p.deadlineMs !== 'number' || p.deadlineMs <= 0) return 'deadlineMs must be positive';
  if (p.type === 'coolify') {
    const c = p.coolify;
    if (!c || !isHttpUrl(c.baseUrl) || typeof c.apiKey !== 'string' || !c.apiKey || typeof c.appId !== 'string' || !c.appId) {
      return 'coolify.baseUrl, coolify.apiKey and coolify.appId are required';
    }
  } else if (p.type === 'cloudflare') {
    const cf = p.cloudflare;
    if (!cf || typeof cf !== 'object') return 'cloudflare is required';
    const checkoutError = validateCheckout(cf.checkout, 'cloudflare.checkout');
    if (checkoutError) return checkoutError;
    if (cf.wranglerConfig != null && (typeof cf.wranglerConfig !== 'string' || !isValidWranglerConfig(cf.wranglerConfig))) {
      return 'cloudflare.wranglerConfig is invalid';
    }
  } else if (p.type === 'cloudrun') {
    const cr = p.cloudrun;
    if (!cr || typeof cr !== 'object') return 'cloudrun is required';
    const checkoutError = validateCheckout(cr.checkout, 'cloudrun.checkout');
    if (checkoutError) return checkoutError;
    if (!isValidGcpProjectId(cr.projectId)) return 'cloudrun.projectId is invalid';
    if (!isValidGcpRegion(cr.region)) return 'cloudrun.region is invalid';
    if (!isValidCloudRunService(cr.service)) return 'cloudrun.service is invalid';
    if (cr.serviceAccountKey != null && (typeof cr.serviceAccountKey !== 'string' || !cr.serviceAccountKey)) {
      return 'cloudrun.serviceAccountKey must be a non-empty string or null';
    }
  } else {
    return "type must be 'coolify', 'cloudflare' or 'cloudrun'";
  }
  return null;
}
