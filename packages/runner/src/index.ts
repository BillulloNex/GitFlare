import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.PORT || 7654;
const RUNNER_SECRET = process.env.RUNNER_SECRET;
const COOLIFY_BASE_URL = process.env.COOLIFY_BASE_URL || 'https://cloud.comfyspace.tech';
const COOLIFY_API_KEY = process.env.COOLIFY_API_KEY;

// CI execution limits
const DEFAULT_STEP_TIMEOUT_S = 300;
const CI_RUN_TIMEOUT_MS = Number(process.env.CI_RUN_TIMEOUT_MS) || 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024; // keep the last 1 MiB of stdout/stderr per step
const KILL_GRACE_MS = 5000;
const CALLBACK_ATTEMPTS = 3;
// Runner credentials must not leak into user-supplied CI commands
const SECRET_ENV_KEYS = ['RUNNER_SECRET', 'COOLIFY_API_KEY'];

interface CIStep {
  name: string;
  command: string;
  env?: Record<string, string>;
  timeout?: number; // seconds
}

interface CIRunPayload {
  runId: string;
  repoName?: string;
  branch?: string;
  commitSha?: string;
  steps: CIStep[];
  callbackUrl: string;
}

interface CIStepResult {
  name: string;
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

function validateCIPayload(payload: any): string | null {
  if (!payload || typeof payload !== 'object') return 'Body must be a JSON object';
  if (typeof payload.runId !== 'string' || !payload.runId) return 'runId is required';
  if (typeof payload.callbackUrl !== 'string' || !payload.callbackUrl) return 'callbackUrl is required';
  if (!Array.isArray(payload.steps) || payload.steps.length === 0) return 'steps must be a non-empty array';
  for (const [i, step] of payload.steps.entries()) {
    if (!step || typeof step.name !== 'string' || typeof step.command !== 'string' || !step.command) {
      return `steps[${i}] must have string name and command`;
    }
    if (step.timeout !== undefined && (typeof step.timeout !== 'number' || step.timeout <= 0)) {
      return `steps[${i}].timeout must be a positive number of seconds`;
    }
    if (step.env !== undefined && (typeof step.env !== 'object' || step.env === null || Array.isArray(step.env))) {
      return `steps[${i}].env must be an object`;
    }
  }
  return null;
}

/** Append to a buffer, keeping only the trailing MAX_OUTPUT_BYTES. */
function appendCapped(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_OUTPUT_BYTES ? next.slice(next.length - MAX_OUTPUT_BYTES) : next;
}

function runStep(step: CIStep, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Omit<CIStepResult, 'name' | 'command'>> {
  return new Promise(resolve => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    // detached → child gets its own process group, so a timeout kills the whole tree
    const child = spawn(step.command, { shell: true, cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // process group already gone
      }
    };

    const finish = (exitCode: number, extraStderr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (extraStderr) stderr = appendCapped(stderr, extraStderr);
      resolve({
        status: exitCode === 0 && !timedOut ? 'passed' : 'failed',
        exit_code: exitCode,
        stdout,
        stderr,
        duration_ms: Date.now() - start,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout = appendCapped(stdout, chunk.toString()); });
    child.stderr.on('data', chunk => { stderr = appendCapped(stderr, chunk.toString()); });

    child.on('error', err => finish(127, `\n[runner] Failed to start step: ${err.message}\n`));
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(124, `\n[runner] Step timed out after ${Math.round(timeoutMs / 1000)}s\n`);
      } else if (code === null) {
        finish(128, `\n[runner] Step terminated by signal ${signal}\n`);
      } else {
        finish(code);
      }
    });
  });
}

async function sendCICallback(callbackUrl: string, body: unknown) {
  for (let attempt = 1; attempt <= CALLBACK_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RUNNER_SECRET}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
      });
      console.log(`CI callback response: ${r.status}`);
      if (r.ok || (r.status >= 400 && r.status < 500)) return; // don't retry client errors
    } catch (err) {
      console.error(`CI callback attempt ${attempt}/${CALLBACK_ATTEMPTS} failed`, err);
    }
    if (attempt < CALLBACK_ATTEMPTS) await new Promise(r => setTimeout(r, 2000 * attempt));
  }
  console.error(`CI callback to ${callbackUrl} gave up after ${CALLBACK_ATTEMPTS} attempts`);
}

async function executeCIRun(payload: CIRunPayload) {
  const { runId, repoName, branch, commitSha, steps, callbackUrl } = payload;
  const deadline = Date.now() + CI_RUN_TIMEOUT_MS;
  const results: CIStepResult[] = [];
  let failed = false;
  let workDir: string | undefined;

  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SECRET_ENV_KEYS) delete baseEnv[key];
  Object.assign(baseEnv, {
    CI: 'true',
    GITFLARE_RUN_ID: runId,
    GITFLARE_REPO: repoName ?? '',
    GITFLARE_BRANCH: branch ?? '',
    GITFLARE_COMMIT_SHA: commitSha ?? '',
  });

  console.log(`CI run ${runId} started: ${steps.length} step(s) for ${repoName ?? '?'}@${branch ?? '?'} (${commitSha ?? '?'})`);

  try {
    workDir = await mkdtemp(join(tmpdir(), `gitflare-ci-${runId.replace(/[^a-zA-Z0-9_-]/g, '')}-`));

    for (const step of steps) {
      const remainingMs = deadline - Date.now();
      if (failed || remainingMs <= 0) {
        if (!failed) console.error(`CI run ${runId} exceeded max run time (${CI_RUN_TIMEOUT_MS}ms)`);
        failed = true;
        results.push({ name: step.name, command: step.command, status: 'skipped', exit_code: -1, stdout: '', stderr: '', duration_ms: 0 });
        continue;
      }

      const stepTimeoutMs = (step.timeout ?? DEFAULT_STEP_TIMEOUT_S) * 1000;
      const env = { ...baseEnv, ...(step.env ?? {}) };
      console.log(`CI run ${runId}: running step "${step.name}"`);
      const result = await runStep(step, workDir, env, Math.min(stepTimeoutMs, remainingMs));
      console.log(`CI run ${runId}: step "${step.name}" ${result.status} (exit ${result.exit_code}, ${result.duration_ms}ms)`);
      results.push({ name: step.name, command: step.command, ...result });
      if (result.status === 'failed') failed = true;
    }
  } catch (err) {
    console.error(`CI run ${runId} errored`, err);
    failed = true;
    // Account for any steps that never ran
    for (const step of steps.slice(results.length)) {
      results.push({ name: step.name, command: step.command, status: 'skipped', exit_code: -1, stdout: '', stderr: '', duration_ms: 0 });
    }
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(err => console.error(`Failed to clean ${workDir}`, err));
  }

  const status = failed ? 'failed' : 'passed';
  console.log(`CI run ${runId} finished with status ${status}. Calling callback: ${callbackUrl}`);
  await sendCICallback(callbackUrl, { runId, status, steps: results });
}

async function pollDeployment(deploymentUuid: string, runId: string, callbackUrl: string, startTime: number) {
  const checkInterval = 2500;
  
  const poll = async () => {
    try {
      const response = await fetch(`${COOLIFY_BASE_URL}/api/v1/deployments/${deploymentUuid}`, {
        headers: { 'Authorization': `Bearer ${COOLIFY_API_KEY}` }
      });
      
      if (!response.ok) {
        throw new Error(`Coolify API error: ${response.status}`);
      }
      
      const data = await response.json();
      const status = data.status;
      
      if (status !== 'in_progress') {
        const finalStatus = status === 'finished' ? 'success' : 'failed';
        const durationMs = Date.now() - startTime;
        
        console.log(`Deployment ${deploymentUuid} finished with status ${status} (${finalStatus}). Calling callback: ${callbackUrl}`);
        await fetch(callbackUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${RUNNER_SECRET}`
          },
          body: JSON.stringify({ runId, status: finalStatus, deploymentUuid, durationMs })
        }).then(r => console.log(`Callback response: ${r.status}`)).catch(err => console.error("Callback failed", err));
        
        return;
      }
      setTimeout(poll, checkInterval);
    } catch (error) {
      console.error("Polling error", error);
      setTimeout(poll, checkInterval);
    }
  };
  
  setTimeout(poll, checkInterval);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }
  
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const authHeader = req.headers.authorization;
        if (!authHeader || authHeader !== `Bearer ${RUNNER_SECRET}`) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        if (url.pathname === '/webhook/deploy') {
          const payload = JSON.parse(body);
          const { runId, coolifyAppId, callbackUrl } = payload;
          
          if (!runId || !coolifyAppId || !callbackUrl) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing fields' }));
            return;
          }

          const coolifyRes = await fetch(`${COOLIFY_BASE_URL}/api/v1/deploy?uuid=${coolifyAppId}&force=false`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${COOLIFY_API_KEY}`,
              'Content-Type': 'application/json'
            }
          });

          if (!coolifyRes.ok) {
            const errBody = await coolifyRes.text();
            console.error(`Coolify deploy failed: ${coolifyRes.status} ${coolifyRes.statusText}`, errBody);
            console.error(`URL: ${COOLIFY_BASE_URL}/api/v1/applications/${coolifyAppId}/deploy`);
            res.writeHead(502);
            res.end(JSON.stringify({ error: 'Failed Coolify deployment', status: coolifyRes.status, detail: errBody }));
            return;
          }

          const coolifyData = await coolifyRes.json() as any;
          const deploymentUuid = coolifyData.deployments?.[0]?.deployment_uuid || coolifyData.deployment_uuid || coolifyData.uuid;
          
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'accepted', deploymentUuid }));
          
          pollDeployment(deploymentUuid, runId, callbackUrl, Date.now());
        } else if (url.pathname === '/webhook/ci') {
          let payload: any;
          try {
            payload = JSON.parse(body);
          } catch {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
          }

          const validationError = validateCIPayload(payload);
          if (validationError) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: validationError }));
            return;
          }

          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'accepted', runId: payload.runId }));

          executeCIRun(payload as CIRunPayload).catch(err => console.error(`CI run ${payload.runId} crashed`, err));
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    });
    return;
  }
  
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Runner listening on port ${PORT}`);
  console.log(`COOLIFY_BASE_URL: ${COOLIFY_BASE_URL}`);
  console.log(`COOLIFY_API_KEY: ${COOLIFY_API_KEY ? '***set***' : 'MISSING'}`);
  console.log(`RUNNER_SECRET: ${RUNNER_SECRET ? '***set***' : 'MISSING'}`);
  console.log(`CI_RUN_TIMEOUT_MS: ${CI_RUN_TIMEOUT_MS}`);
});
