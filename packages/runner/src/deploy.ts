/**
 * Deploy execution. Results go to the Worker's /api/internal/deploy/callback.
 *
 * Coolify:     trigger → report the deployment UUID → poll until a terminal
 *              status or the deadline.
 * Cloudflare:  job container → clone → install (no credentials) →
 *              `wrangler deploy` with CLOUDFLARE_* injected into that one exec.
 * Cloud Run:   job container (gcloud image) → clone → `gcloud run deploy
 *              --source .` with the service-account key injected into that one
 *              exec (written to a temp file for `gcloud auth`, removed after).
 */
import { config } from './config.js';
import { cloneInJob, createJobContainer, dockerAvailable, execInJob, killJob, LogCollector, removeJob, type JobContainer } from './docker.js';
import type { DeployRequest } from './protocol.js';
import { jobSlots, sendCallback } from './worker-client.js';

type Outcome = { status: 'success' | 'failed'; error?: string; coolifyDeploymentId?: string; serviceUrl?: string };

// ─── Coolify ────────────────────────────────────────────────────

/** Coolify deployment statuses → our view. Unknown statuses keep polling. */
export function mapCoolifyStatus(status: unknown): 'running' | 'success' | 'failed' | 'unknown' {
  switch (String(status ?? '').toLowerCase()) {
    case 'queued':
    case 'in_progress':
    case 'in-progress':
      return 'running';
    case 'finished':
    case 'success':
      return 'success';
    case 'failed':
    case 'error':
    case 'cancelled':
    case 'canceled':
    case 'cancelled-by-user':
      return 'failed';
    default:
      return 'unknown';
  }
}

function coolifyHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' };
}

async function runCoolify(req: DeployRequest, logs: LogCollector): Promise<Outcome> {
  const { baseUrl, apiKey, appId } = req.coolify!;
  const base = baseUrl.replace(/\/+$/, '');
  const deadline = Date.now() + req.deadlineMs;

  const triggerUrl = `${base}/api/v1/deploy?uuid=${encodeURIComponent(appId)}&force=false`;
  let res: Response;
  try {
    res = await fetch(triggerUrl, { method: 'POST', headers: coolifyHeaders(apiKey), signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    return { status: 'failed', error: `Coolify unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 500);
    return { status: 'failed', error: `Coolify deploy trigger failed: HTTP ${res.status} ${detail}`.trim() };
  }
  const data = (await res.json().catch(() => null)) as any;
  const uuid: unknown = data?.deployments?.[0]?.deployment_uuid ?? data?.deployment_uuid ?? data?.uuid;
  if (typeof uuid !== 'string' || !uuid) {
    return { status: 'failed', error: 'Coolify accepted the deploy but returned no deployment UUID' };
  }
  logs.note(`Coolify deployment ${uuid} started for app ${appId}`);
  await sendCallback(req.callbackUrl, { deploymentId: req.deploymentId, status: 'running', coolifyDeploymentId: uuid }, `deploy ${req.deploymentId}`);

  let lastStatus = 'unknown';
  let consecutiveErrors = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, config.coolifyPollIntervalMs));
    try {
      const poll = await fetch(`${base}/api/v1/deployments/${encodeURIComponent(uuid)}`, {
        headers: coolifyHeaders(apiKey),
        signal: AbortSignal.timeout(20_000),
      });
      if (!poll.ok) throw new Error(`HTTP ${poll.status}`);
      const body = (await poll.json()) as any;
      consecutiveErrors = 0;
      if (body?.status !== lastStatus) {
        lastStatus = String(body?.status);
        logs.note(`Coolify status: ${lastStatus}`);
      }
      const mapped = mapCoolifyStatus(body?.status);
      if (mapped === 'success') return { status: 'success', coolifyDeploymentId: uuid };
      if (mapped === 'failed') return { status: 'failed', coolifyDeploymentId: uuid, error: `Coolify deployment ${lastStatus}` };
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
        logs.note(`Polling Coolify failed (${consecutiveErrors}x): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return {
    status: 'failed',
    coolifyDeploymentId: uuid,
    error: `Coolify deployment did not finish within ${Math.round(req.deadlineMs / 1000)}s (last status: ${lastStatus})`,
  };
}

// ─── Cloudflare ─────────────────────────────────────────────────

async function runCloudflare(req: DeployRequest, logs: LogCollector): Promise<Outcome> {
  const cf = req.cloudflare!;
  if (!config.cloudflareApiToken) return { status: 'failed', error: 'CLOUDFLARE_API_TOKEN is not configured on the runner' };
  const docker = await dockerAvailable();
  if (!docker.ok) return { status: 'failed', error: `Docker required for deploy execution: ${docker.detail}` };

  const release = await jobSlots.acquire();
  let job: JobContainer | null = null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (job) void killJob(job);
  }, req.deadlineMs);
  const push = (stream: 'stdout' | 'stderr', line: string) => logs.push(stream, line);
  const baseEnv = {
    CI: 'true',
    GITFLARE_REPO: cf.repoName,
    GITFLARE_BRANCH: cf.checkout.branch,
    GITFLARE_COMMIT_SHA: cf.checkout.commitSha,
  };

  try {
    job = await createJobContainer('deploy', req.deploymentId, push);
    const clone = await cloneInJob(job, cf.checkout, push);
    if (clone.code !== 0) return { status: 'failed', error: `checkout failed (exit ${clone.code})` };

    // Install WITHOUT deploy credentials.
    logs.note('Installing dependencies');
    const install = await execInJob(
      job,
      ['sh', '-c', 'if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; fi'],
      baseEnv,
      { onLine: push }
    );
    if (install.code !== 0) return { status: 'failed', error: timedOut ? 'Deploy timed out' : `dependency install failed (exit ${install.code})` };

    // Credentials exist only in this exec's environment. The config path is
    // validated and passed as a positional argument, never interpolated.
    logs.note('Running wrangler deploy');
    const argv = cf.wranglerConfig
      ? ['sh', '-c', 'exec npx --yes wrangler deploy --config "$1"', 'deploy', cf.wranglerConfig]
      : ['sh', '-c', 'exec npx --yes wrangler deploy', 'deploy'];
    const deploy = await execInJob(
      job,
      argv,
      {
        ...baseEnv,
        CLOUDFLARE_API_TOKEN: config.cloudflareApiToken,
        ...(config.cloudflareAccountId ? { CLOUDFLARE_ACCOUNT_ID: config.cloudflareAccountId } : {}),
      },
      { onLine: push }
    );
    if (timedOut) return { status: 'failed', error: `Deploy did not finish within ${Math.round(req.deadlineMs / 1000)}s` };
    if (deploy.code !== 0) return { status: 'failed', error: `wrangler deploy failed (exit ${deploy.code})` };
    return { status: 'success' };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    if (job) await removeJob(job).catch(err => console.error(`deploy ${req.deploymentId}: cleanup failed`, err));
    release();
  }
}

// ─── Google Cloud Run ───────────────────────────────────────────

const SERVICE_URL_MARKER = 'GITFLARE_SERVICE_URL=';

/**
 * Source deploy: gcloud uploads the workspace, Cloud Build builds it
 * (buildpacks or Dockerfile) and the resulting revision is rolled out. The
 * key file lives only for the duration of this exec and is removed on exit.
 */
const CLOUDRUN_SCRIPT = [
  'set -eu',
  'command -v gcloud >/dev/null 2>&1 || { echo "gcloud is not installed in the Cloud Run image (CLOUDRUN_IMAGE)" >&2; exit 127; }',
  'export CLOUDSDK_CONFIG="$(mktemp -d)"',
  'KEY_FILE="$CLOUDSDK_CONFIG/sa.json"',
  'trap \'rm -rf "$CLOUDSDK_CONFIG"\' EXIT',
  'printf \'%s\' "$GCP_SERVICE_ACCOUNT_KEY" > "$KEY_FILE"',
  'unset GCP_SERVICE_ACCOUNT_KEY',
  'gcloud auth activate-service-account --key-file="$KEY_FILE" --quiet',
  'gcloud run deploy "$1" --source . --project "$2" --region "$3" --quiet',
  'URL="$(gcloud run services describe "$1" --project "$2" --region "$3" --format=\'value(status.url)\' 2>/dev/null || true)"',
  `[ -n "$URL" ] && echo "${SERVICE_URL_MARKER}$URL"`,
  'exit 0',
].join('\n');

async function runCloudRun(req: DeployRequest, logs: LogCollector): Promise<Outcome> {
  const cr = req.cloudrun!;
  const serviceAccountKey = cr.serviceAccountKey || config.gcpServiceAccountKey;
  if (!serviceAccountKey) {
    return { status: 'failed', error: 'No GCP service-account key: set one on the deploy target or GCP_SERVICE_ACCOUNT_KEY on the runner' };
  }
  const docker = await dockerAvailable();
  if (!docker.ok) return { status: 'failed', error: `Docker required for deploy execution: ${docker.detail}` };

  const release = await jobSlots.acquire();
  let job: JobContainer | null = null;
  let timedOut = false;
  let serviceUrl: string | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    if (job) void killJob(job);
  }, req.deadlineMs);
  const push = (stream: 'stdout' | 'stderr', line: string) => {
    if (line.startsWith(SERVICE_URL_MARKER)) {
      serviceUrl = line.slice(SERVICE_URL_MARKER.length).trim();
      logs.note(`Service URL: ${serviceUrl}`);
      return;
    }
    logs.push(stream, line);
  };

  try {
    job = await createJobContainer('deploy', req.deploymentId, push, config.cloudRunImage);
    const clone = await cloneInJob(job, cr.checkout, push);
    if (clone.code !== 0) return { status: 'failed', error: `checkout failed (exit ${clone.code})` };

    // Credentials exist only in this exec's environment. Identifiers are
    // validated and passed as positional arguments, never interpolated.
    logs.note(`Deploying ${cr.service} to Cloud Run (${cr.projectId}/${cr.region}) from source`);
    const deploy = await execInJob(
      job,
      ['sh', '-c', CLOUDRUN_SCRIPT, 'cloudrun', cr.service, cr.projectId, cr.region],
      {
        CI: 'true',
        GITFLARE_REPO: cr.repoName,
        GITFLARE_BRANCH: cr.checkout.branch,
        GITFLARE_COMMIT_SHA: cr.checkout.commitSha,
        CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
        GCP_SERVICE_ACCOUNT_KEY: serviceAccountKey,
      },
      { onLine: push }
    );
    if (timedOut) return { status: 'failed', error: `Deploy did not finish within ${Math.round(req.deadlineMs / 1000)}s` };
    if (deploy.code !== 0) return { status: 'failed', error: `gcloud run deploy failed (exit ${deploy.code})` };
    return { status: 'success', serviceUrl };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    if (job) await removeJob(job).catch(err => console.error(`deploy ${req.deploymentId}: cleanup failed`, err));
    release();
  }
}

/** Secret strings to mask in Cloud Run logs: the key JSON and its private_key on its own. */
function cloudRunSecrets(key: string | null | undefined): string[] {
  if (!key) return [];
  const out = [key];
  try {
    const parsed = JSON.parse(key) as { private_key?: unknown };
    if (typeof parsed.private_key === 'string' && parsed.private_key) out.push(parsed.private_key);
  } catch {
    // not JSON — mask the raw value only
  }
  return out;
}

// ─── Entry ──────────────────────────────────────────────────────

const activeDeploys = new Set<string>();

/** True if this deployment is already executing (redelivered dispatch). */
export function isDeployKnown(deploymentId: string): boolean {
  return activeDeploys.has(deploymentId);
}

export async function executeDeploy(req: DeployRequest): Promise<void> {
  activeDeploys.add(req.deploymentId);
  try {
    await runDeploy(req);
  } finally {
    activeDeploys.delete(req.deploymentId);
  }
}

async function runDeploy(req: DeployRequest): Promise<void> {
  const started = Date.now();
  const secrets = [
    req.coolify?.apiKey,
    req.cloudflare?.checkout.token,
    req.cloudflare?.checkout.lfs?.token,
    req.cloudrun?.checkout.token,
    req.cloudrun?.checkout.lfs?.token,
    config.cloudflareApiToken,
    ...cloudRunSecrets(req.cloudrun?.serviceAccountKey),
    ...cloudRunSecrets(config.gcpServiceAccountKey),
  ].filter((s): s is string => !!s);
  const logs = new LogCollector(secrets);
  console.log(`Deploy ${req.deploymentId} (${req.type}) started`);

  let outcome: Outcome;
  try {
    outcome =
      req.type === 'coolify' ? await runCoolify(req, logs) : req.type === 'cloudrun' ? await runCloudRun(req, logs) : await runCloudflare(req, logs);
  } catch (err) {
    outcome = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }

  if (outcome.error) logs.note(outcome.error);
  console.log(`Deploy ${req.deploymentId} finished: ${outcome.status}${outcome.error ? ` (${outcome.error})` : ''}`);
  await sendCallback(
    req.callbackUrl,
    {
      deploymentId: req.deploymentId,
      status: outcome.status,
      durationMs: Date.now() - started,
      ...(outcome.coolifyDeploymentId ? { coolifyDeploymentId: outcome.coolifyDeploymentId } : {}),
      ...(outcome.serviceUrl ? { serviceUrl: outcome.serviceUrl } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      logs: logs.tail(200),
    },
    `deploy ${req.deploymentId}`
  );
}
