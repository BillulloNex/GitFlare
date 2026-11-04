/**
 * GitFlare runner.
 *
 *   GET  /health             liveness + protocol version + Docker status
 *   POST /webhook/ci         run CI steps in a throwaway Docker container   (202)
 *   POST /webhook/ci/cancel  kill a run's container                          (200 / 404)
 *   POST /webhook/deploy     Coolify or Cloudflare deploy                    (202)
 *   POST /webhook/merge      merge-queue rebase / fast-forward (git argv)    (202)
 *
 * All POSTs need `Authorization: Bearer <RUNNER_SECRET>` (503 if the secret
 * is unset — fail closed) and `X-GitFlare-Runner-Protocol: <PROTOCOL_VERSION>`
 * (426 otherwise). CI and Cloudflare deploys need a reachable Docker daemon
 * (503 "Docker required for CI execution" otherwise — there is no fallback to
 * running commands on the runner itself).
 */
import * as http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { cancelRun, ciStats, executeCIRun, isRunKnown } from './ci.js';
import { executeDeploy, isDeployKnown } from './deploy.js';
import { dockerAvailable, sweepOrphans } from './docker.js';
import { executeMerge, isMergeKnown, mergeCapacityAvailable } from './merge.js';
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  validateCIRequest,
  validateDeployRequest,
  validateMergeRequest,
  type CIRunRequest,
  type DeployRequest,
  type MergeRequest,
} from './protocol.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Constant-time Bearer check; both sides hashed so length differences don't leak or throw. */
function isAuthorized(authHeader: string | undefined, secret: string): boolean {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const provided = createHash('sha256').update(authHeader.slice(7)).digest();
  const expected = createHash('sha256').update(secret).digest();
  return timingSafeEqual(provided, expected);
}

function send(res: http.ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handlePost(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Fail closed: without a configured secret, no webhook is accepted.
  if (!config.runnerSecret) return send(res, 503, { error: 'Not configured' });
  if (!isAuthorized(req.headers.authorization, config.runnerSecret)) return send(res, 401, { error: 'Unauthorized' });

  // Lockstep protocol check (B1.7).
  const version = req.headers[PROTOCOL_HEADER];
  if (version !== String(PROTOCOL_VERSION)) {
    return send(res, 426, { error: 'Runner protocol mismatch', expected: PROTOCOL_VERSION, got: version ?? null });
  }

  let payload: any;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return send(res, 400, { error: err instanceof Error && err.message === 'Body too large' ? 'Body too large' : 'Invalid JSON' });
  }

  switch (url.pathname) {
    case '/webhook/ci': {
      const error = validateCIRequest(payload, config.allowedCallbackOrigins);
      if (error) return send(res, 400, { error });
      const docker = await dockerAvailable();
      if (!docker.ok) return send(res, 503, { error: 'Docker required for CI execution', detail: docker.detail });
      const request = payload as CIRunRequest;
      // Idempotent: a redelivered dispatch for a run we already have is accepted, not re-run.
      if (isRunKnown(request.runId)) return send(res, 202, { status: 'accepted', runId: request.runId, duplicate: true });
      send(res, 202, { status: 'accepted', runId: request.runId });
      executeCIRun(request).catch(err => console.error(`CI run ${request.runId} crashed`, err));
      return;
    }

    case '/webhook/ci/cancel': {
      if (typeof payload?.runId !== 'string') return send(res, 400, { error: 'runId is required' });
      const found = await cancelRun(payload.runId);
      return send(res, found ? 200 : 404, { cancelled: found, runId: payload.runId });
    }

    case '/webhook/deploy': {
      const error = validateDeployRequest(payload, config.allowedCallbackOrigins);
      if (error) return send(res, 400, { error });
      const request = payload as DeployRequest;
      if (request.type === 'cloudflare') {
        const docker = await dockerAvailable();
        if (!docker.ok) return send(res, 503, { error: 'Docker required for deploy execution', detail: docker.detail });
      }
      if (isDeployKnown(request.deploymentId)) {
        return send(res, 202, { status: 'accepted', deploymentId: request.deploymentId, duplicate: true });
      }
      send(res, 202, { status: 'accepted', deploymentId: request.deploymentId });
      executeDeploy(request).catch(err => console.error(`Deploy ${request.deploymentId} crashed`, err));
      return;
    }

    case '/webhook/merge': {
      const error = validateMergeRequest(payload, config.allowedCallbackOrigins);
      if (error) return send(res, 400, { error });
      const request = payload as MergeRequest;
      // Idempotent: a redelivered dispatch for an attempt we already run is accepted, not re-run.
      if (isMergeKnown(request)) return send(res, 202, { status: 'accepted', attemptId: request.attemptId, duplicate: true });
      // 503 is transient for the Worker: the merge queue retries with backoff.
      if (!mergeCapacityAvailable()) return send(res, 503, { error: 'Merge capacity exhausted, retry later' });
      send(res, 202, { status: 'accepted', attemptId: request.attemptId });
      executeMerge(request).catch(err => console.error(`Merge ${request.ticketId} crashed`, err));
      return;
    }

    default:
      return send(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://runner.local');

  if (req.method === 'GET' && url.pathname === '/health') {
    void dockerAvailable().then(docker =>
      send(res, 200, {
        status: 'ok',
        uptime: process.uptime(),
        protocolVersion: PROTOCOL_VERSION,
        docker: docker.ok,
        dockerDetail: docker.detail,
        jobs: ciStats(),
      })
    );
    return;
  }

  if (req.method === 'POST') {
    handlePost(url, req, res).catch(err => {
      console.error('Request failed', err);
      if (!res.headersSent) send(res, 500, { error: 'Internal Server Error' });
    });
    return;
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(config.port, async () => {
  console.log(`Runner listening on port ${config.port} (protocol v${PROTOCOL_VERSION}, id ${config.runnerId})`);
  console.log(`RUNNER_SECRET: ${config.runnerSecret ? 'set' : 'MISSING — all webhooks will return 503'}`);
  console.log(`CI image: ${config.ciImage}, max concurrent jobs: ${config.maxConcurrentJobs}`);
  console.log(`Callback origins: ${config.allowedCallbackOrigins.join(', ') || '(any — set ALLOWED_CALLBACK_ORIGINS)'}`);
  console.log(`CLOUDFLARE_API_TOKEN: ${config.cloudflareApiToken ? 'set' : 'not set (Cloudflare deploys disabled)'}`);
  const docker = await dockerAvailable();
  if (docker.ok) {
    console.log(`Docker: ${docker.detail}`);
    await sweepOrphans().catch(err => console.error('Orphan sweep failed', err));
  } else {
    console.error(`Docker: UNAVAILABLE (${docker.detail}) — CI jobs will be rejected until it is reachable`);
  }
});

// Let in-flight requests finish on redeploy; jobs left behind are swept on next start.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
