/**
 * Runner client — delegates CI step execution to the external Runner service
 * (packages/runner) over HTTP. The runner accepts work with a 202 and reports
 * the outcome asynchronously to `callbackUrl` (see /api/internal/ci/callback).
 */

export type SandboxTier = 'micro' | 'small' | 'medium' | 'large';

export interface SandboxInstance {
  id: string;
  tier: SandboxTier;
  image: string;
  ready: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunnerStep {
  name: string;
  command: string;
  env?: Record<string, string>;
  /** Timeout in seconds */
  timeout?: number;
}

export interface RunCIStepsPayload {
  runId: string;
  repoName: string;
  branch: string;
  commitSha: string;
  steps: RunnerStep[];
  callbackUrl: string;
}

export interface RunCIStepsResult {
  accepted: boolean;
  error?: string;
}

/** How long to wait for the runner to acknowledge (not complete) a job. */
const RUNNER_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Submit CI steps to the Runner service (`POST {runnerUrl}/webhook/ci`).
 *
 * Resolves `{ accepted: true }` only on HTTP 202. Any other status, a network
 * failure, or a timeout resolves `{ accepted: false, error }` — this function
 * never throws, so callers can fall back to other behaviour.
 */
export async function runCISteps(
  runnerUrl: string,
  runnerSecret: string,
  payload: RunCIStepsPayload
): Promise<RunCIStepsResult> {
  if (!runnerUrl) return { accepted: false, error: 'RUNNER_URL is not configured' };
  if (!runnerSecret) return { accepted: false, error: 'RUNNER_SECRET is not configured' };
  if (payload.steps.length === 0) return { accepted: false, error: 'No steps to run' };

  const endpoint = `${runnerUrl.replace(/\/+$/, '')}/webhook/ci`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${runnerSecret}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RUNNER_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? `timed out after ${RUNNER_REQUEST_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { accepted: false, error: `Runner unreachable at ${endpoint}: ${reason}` };
  }

  if (response.status === 202) {
    return { accepted: true };
  }

  let detail = '';
  try {
    detail = (await response.text()).slice(0, 500);
  } catch {
    // body unreadable — status alone is enough
  }
  return {
    accepted: false,
    error: `Runner returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
  };
}

/**
 * @deprecated Sandboxes are no longer provisioned in-worker. Use {@link runCISteps}
 * to hand steps to the Runner service. Always throws.
 */
export async function createSandbox(tier: SandboxTier, image: string = 'gitflare-runner'): Promise<SandboxInstance> {
  throw new Error(
    `createSandbox(${tier}, ${image}) is deprecated: CI execution is delegated to the Runner service via runCISteps()`
  );
}

/**
 * @deprecated Steps are executed by the Runner service, which reports results via
 * callback. Use {@link runCISteps}. Always throws (previously returned simulated results).
 */
export async function runInSandbox(
  sandbox: SandboxInstance,
  commands: RunnerStep[]
): Promise<{ results: (ExecResult & { name: string })[], allPassed: boolean }> {
  throw new Error(
    `runInSandbox(${sandbox.id}, ${commands.length} commands) is deprecated: use runCISteps() to execute via the Runner service`
  );
}

/**
 * @deprecated Tier selection is the Runner service's concern. Returns `defaultTier` unchanged.
 */
export function getSandboxTierForRepo(repoName: string, defaultTier: SandboxTier): SandboxTier {
  return defaultTier;
}
