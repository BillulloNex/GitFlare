/**
 * CI run execution: one throwaway Docker container per run.
 *
 *   volume + container → clone (inside the container) → steps via `docker exec`
 *   → final callback → container + volume removed
 *
 * A failed step, a step timeout, the run deadline and cancellation all end
 * the same way: the container is SIGKILLed and remaining steps are skipped.
 * Killing the container takes down every process the steps started.
 */
import { config } from './config.js';
import {
  cloneInJob,
  createJobContainer,
  execInJob,
  killJob,
  LogCollector,
  removeJob,
  type JobContainer,
} from './docker.js';
import type { CIRunRequest, CIStep, StepReport, StepStatus } from './protocol.js';
import { jobSlots, sendCallback, sendProgress } from './worker-client.js';

const TAIL_LINES = 50;

interface StepState {
  step: CIStep;
  status: StepStatus;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  logs: LogCollector;
}

interface ActiveRun {
  runId: string;
  job: JobContainer | null;
  cancelled: boolean;
  timedOut: boolean;
}

const activeRuns = new Map<string, ActiveRun>();

export function ciStats(): { active: number; queued: number } {
  return { active: jobSlots.running, queued: jobSlots.queued };
}

export function isRunKnown(runId: string): boolean {
  return activeRuns.has(runId);
}

/** Cancel a run: mark it and SIGKILL its container. Returns false if unknown. */
export async function cancelRun(runId: string): Promise<boolean> {
  const run = activeRuns.get(runId);
  if (!run) return false;
  if (!run.cancelled) {
    run.cancelled = true;
    console.log(`CI run ${runId}: cancel requested`);
    if (run.job) await killJob(run.job);
  }
  return true;
}

function report(s: StepState, tailOnly: boolean): StepReport {
  return {
    id: s.step.id,
    ordinal: s.step.ordinal,
    name: s.step.name,
    command: s.step.command,
    status: s.status,
    exit_code: s.exitCode,
    duration_ms: s.durationMs,
    started_at: s.startedAt,
    finished_at: s.finishedAt,
    logs: tailOnly ? s.logs.tail(TAIL_LINES) : s.logs.all(),
  };
}

function finishStep(s: StepState, status: StepStatus, exitCode: number | null): void {
  s.status = status;
  s.exitCode = exitCode;
  s.finishedAt = new Date().toISOString();
  s.durationMs = s.startedAt ? Date.now() - new Date(s.startedAt).getTime() : 0;
  s.logs.dirty = true;
}

/** Env for one step: allowlisted base (set on the container) + GITFLARE_* + the step's own env. */
function stepEnv(req: CIRunRequest, step: CIStep): Record<string, string> {
  return {
    CI: 'true',
    GITFLARE_RUN_ID: req.runId,
    GITFLARE_REPO: req.repoName,
    GITFLARE_BRANCH: req.checkout.branch,
    GITFLARE_COMMIT_SHA: req.checkout.commitSha,
    GITFLARE_JOB: step.jobName,
    GITFLARE_STEP: step.name,
    ...(step.env ?? {}),
  };
}

export async function executeCIRun(req: CIRunRequest): Promise<void> {
  const run: ActiveRun = { runId: req.runId, job: null, cancelled: false, timedOut: false };
  activeRuns.set(req.runId, run);

  const steps: StepState[] = req.steps.map(step => ({
    step,
    status: 'pending',
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    logs: new LogCollector([req.checkout.token, req.checkout.lfs?.token ?? '']),
  }));
  // Setup (pull, clone) output is shown on the first step.
  const setupLog = steps[0].logs;

  const release = await jobSlots.acquire();
  const startedAt = Date.now();
  const budgetMs = Math.min(req.maxDurationMs, config.maxRunMs);
  let failed = false;
  let errorMessage: string | undefined;

  // ── Incremental progress + cancellation heartbeat ──
  let flushing = false;
  const flush = async () => {
    if (flushing) return;
    const dirty = steps.filter(s => s.logs.dirty);
    if (dirty.length === 0) return;
    flushing = true;
    dirty.forEach(s => (s.logs.dirty = false));
    const res = await sendProgress(req.logsUrl, { runId: req.runId, steps: dirty.map(s => report(s, true)) });
    flushing = false;
    if (res?.cancelled === true) await cancelRun(req.runId);
  };
  const heartbeat = setInterval(() => void flush(), config.logFlushIntervalMs);
  const deadline = setTimeout(() => {
    run.timedOut = true;
    console.error(`CI run ${req.runId} exceeded ${budgetMs}ms`);
    if (run.job) void killJob(run.job);
  }, budgetMs);

  console.log(`CI run ${req.runId} started: ${steps.length} step(s) for ${req.repoName}@${req.checkout.branch} (${req.checkout.commitSha.slice(0, 7)})`);

  try {
    if (run.cancelled) throw new Error('cancelled before start');

    setupLog.note(`Preparing job container (${config.ciImage})`);
    run.job = await createJobContainer('ci', req.runId, (stream, line) => setupLog.push(stream, line));
    if (run.cancelled || run.timedOut) throw new Error(run.cancelled ? 'cancelled' : 'timed out');

    setupLog.note(`Cloning ${req.repoName}@${req.checkout.branch}`);
    const clone = await cloneInJob(run.job, req.checkout, (stream, line) => setupLog.push(stream, line));
    if (clone.code !== 0) throw new Error(`checkout failed (exit ${clone.code})`);

    for (const s of steps) {
      if (failed || run.cancelled || run.timedOut) break;

      s.status = 'running';
      s.startedAt = new Date().toISOString();
      s.logs.dirty = true;
      void flush();

      const timeoutMs = (s.step.timeout ?? config.defaultStepTimeoutS) * 1000;
      let stepTimedOut = false;
      const stepTimer = setTimeout(() => {
        stepTimedOut = true;
        if (run.job) void killJob(run.job);
      }, timeoutMs);

      console.log(`CI run ${req.runId}: step ${s.step.ordinal} "${s.step.name}"`);
      const result = await execInJob(run.job, ['sh', '-c', s.step.command], stepEnv(req, s.step), {
        onLine: (stream, line) => s.logs.push(stream, line),
      });
      clearTimeout(stepTimer);

      if (run.cancelled) {
        s.logs.note('Run cancelled');
        finishStep(s, 'cancelled', result.code);
      } else if (stepTimedOut) {
        s.logs.note(`Step timed out after ${Math.round(timeoutMs / 1000)}s`);
        finishStep(s, 'failed', 124);
        failed = true;
      } else if (run.timedOut) {
        s.logs.note(`Run exceeded its time budget (${Math.round(budgetMs / 1000)}s)`);
        finishStep(s, 'failed', 124);
        failed = true;
      } else if (result.code === 0) {
        finishStep(s, 'passed', 0);
      } else {
        finishStep(s, 'failed', result.code);
        failed = true;
      }
      console.log(`CI run ${req.runId}: step ${s.step.ordinal} ${s.status} (exit ${s.exitCode}, ${s.durationMs}ms)`);
    }
  } catch (err) {
    if (!run.cancelled) {
      failed = true;
      errorMessage = err instanceof Error ? err.message : String(err);
      setupLog.note(run.timedOut ? 'Run exceeded its time budget' : `Job setup failed: ${errorMessage}`);
      console.error(`CI run ${req.runId} errored: ${errorMessage}`);
      if (steps[0].status === 'pending') {
        steps[0].startedAt = new Date().toISOString();
        finishStep(steps[0], 'failed', null);
      }
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
    if (run.job) await removeJob(run.job).catch(err => console.error(`CI run ${req.runId}: cleanup failed`, err));
    release();
    activeRuns.delete(req.runId);
  }

  if (run.timedOut && !run.cancelled) failed = true;
  for (const s of steps) {
    if (s.status === 'pending') finishStep(s, 'skipped', null);
    else if (s.status === 'running') finishStep(s, run.cancelled ? 'cancelled' : 'failed', null);
  }

  const status = run.cancelled ? 'cancelled' : failed ? 'failed' : 'passed';
  console.log(`CI run ${req.runId} finished: ${status}`);
  await sendCallback(
    req.callbackUrl,
    {
      runId: req.runId,
      status,
      durationMs: Date.now() - startedAt,
      ...(errorMessage ? { error: errorMessage } : {}),
      steps: steps.map(s => report(s, false)),
    },
    `CI run ${req.runId}`
  );
}
