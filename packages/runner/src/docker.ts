/**
 * Docker helpers. Everything goes through the `docker` CLI against the mounted
 * socket, with argv arrays (never a shell on the runner side).
 *
 * Secrets: values for `-e NAME` flags are placed in the docker CLI's own
 * environment, not on its argv, so they never show up in `ps`.
 *
 * Paths: the runner itself runs in a container, so bind-mounting a runner path
 * would resolve on the HOST. Job workspaces are therefore named volumes, and
 * the repo is cloned inside the job container.
 */
import { spawn } from 'node:child_process';
import { config } from './config.js';
import type { LogLine } from './protocol.js';

export const WORKSPACE = '/workspace';
const JOB_HOME = '/tmp/home';
const LABEL_JOB = 'gitflare.job';
const LABEL_RUNNER = 'gitflare.runner';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Extra environment for the docker CLI process (values for `-e NAME` flags). */
  env?: Record<string, string>;
  timeoutMs?: number;
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
}

/** Minimal environment for the docker CLI itself — never the runner's secrets. */
function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG || '/tmp/.docker',
  };
  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
  return { ...env, ...extra };
}

/** Run `docker <args>`. Never rejects; spawn failures resolve with code 127. */
export function docker(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    const partial = { stdout: '', stderr: '' };
    let settled = false;
    const child = spawn('docker', args, { env: cliEnv(opts.env), stdio: ['ignore', 'pipe', 'pipe'] });

    const onData = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString();
      if (stream === 'stdout') stdout = (stdout + text).slice(-64 * 1024);
      else stderr = (stderr + text).slice(-64 * 1024);
      if (!opts.onLine) return;
      const lines = (partial[stream] + text).split('\n');
      partial[stream] = lines.pop() ?? '';
      for (const line of lines) opts.onLine(stream, line.replace(/\r$/, ''));
    };
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));

    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (opts.onLine) {
        for (const stream of ['stdout', 'stderr'] as const) {
          if (partial[stream]) opts.onLine(stream, partial[stream]);
        }
      }
      resolve({ code, stdout, stderr });
    };
    child.on('error', err => {
      stderr += `\n${err.message}`;
      finish(127);
    });
    child.on('close', code => finish(code ?? 128));
  });
}

let dockerCheck: { ok: boolean; at: number; detail: string } | null = null;

/** Is the Docker daemon reachable? Cached for 30s. */
export async function dockerAvailable(): Promise<{ ok: boolean; detail: string }> {
  if (dockerCheck && Date.now() - dockerCheck.at < 30_000) return dockerCheck;
  const res = await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000 });
  dockerCheck = {
    ok: res.code === 0 && !!res.stdout.trim(),
    at: Date.now(),
    detail: res.code === 0 ? `docker ${res.stdout.trim()}` : res.stderr.trim().split('\n').pop() || 'docker unavailable',
  };
  return dockerCheck;
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
}

export interface JobContainer {
  name: string;
  volume: string;
}

/**
 * Create a throwaway job container: named volume at /workspace (chowned to
 * the job user), long-lived idle process, non-root, no capabilities,
 * resource-limited. Steps are `docker exec`ed into it.
 */
export async function createJobContainer(kind: 'ci' | 'deploy', id: string, onLine: ExecOptions['onLine']): Promise<JobContainer> {
  const base = `gitflare-${kind}-${safeName(id)}`;
  const job: JobContainer = { name: base, volume: base };
  const labels = ['--label', `${LABEL_JOB}=${id}`, '--label', `${LABEL_RUNNER}=${config.runnerId}`];

  const vol = await docker(['volume', 'create', ...labels, job.volume]);
  if (vol.code !== 0) throw new Error(`docker volume create failed: ${vol.stderr.trim()}`);

  // Pull explicitly so pull progress shows up in the logs.
  const pull = await docker(['pull', '--quiet', config.ciImage], { timeoutMs: 15 * 60_000, onLine });
  if (pull.code !== 0) {
    // A locally built image may not be pullable; carry on if it exists.
    const inspect = await docker(['image', 'inspect', config.ciImage]);
    if (inspect.code !== 0) throw new Error(`Could not pull image ${config.ciImage}: ${pull.stderr.trim()}`);
  }

  // Fresh named volumes are root-owned; hand /workspace to the job user.
  const chown = await docker([
    'run', '--rm', ...labels,
    '--user', '0:0', '--network', 'none',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
    '--security-opt', 'no-new-privileges',
    '-v', `${job.volume}:${WORKSPACE}`,
    '--entrypoint', 'chown',
    config.ciImage, config.jobUser, WORKSPACE,
  ], { timeoutMs: 120_000 });
  if (chown.code !== 0) throw new Error(`Could not prepare workspace volume: ${chown.stderr.trim()}`);

  const run = await docker([
    'run', '-d', '--init', '--name', job.name, ...labels,
    '--user', config.jobUser,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(config.jobPidsLimit),
    '--memory', config.jobMemory,
    '--cpus', config.jobCpus,
    '--network', config.jobNetwork,
    '-v', `${job.volume}:${WORKSPACE}`,
    // No `-w WORKSPACE` here: on Docker 29 (containerd snapshotter) a run-time
    // workdir that is also a volume mount resets the volume root to root:root,
    // undoing the chown above. Steps get the workdir from `docker exec -w`.
    // Allowlisted base env only; PATH etc. come from the image.
    '-e', `HOME=${JOB_HOME}`, '-e', 'TMPDIR=/tmp', '-e', 'LANG=C.UTF-8', '-e', 'CI=true',
    '--entrypoint', 'sh',
    config.ciImage,
    '-c', `mkdir -p "$HOME" && exec tail -f /dev/null`,
  ], { timeoutMs: 120_000 });
  if (run.code !== 0) throw new Error(`docker run failed: ${run.stderr.trim()}`);

  return job;
}

/**
 * `docker exec` a command in the job container as the job user.
 * `env` keys are passed as `-e NAME` with values via the CLI's environment.
 */
export function execInJob(job: JobContainer, argv: string[], env: Record<string, string>, opts: Omit<ExecOptions, 'env'> = {}): Promise<ExecResult> {
  const envFlags = Object.keys(env).flatMap(k => ['-e', k]);
  return docker(['exec', '-u', config.jobUser, '-w', WORKSPACE, ...envFlags, job.name, ...argv], { ...opts, env });
}

/** SIGKILL every process in the job container (cancellation / timeout). */
export async function killJob(job: JobContainer): Promise<void> {
  await docker(['kill', job.name], { timeoutMs: 30_000 });
}

export async function removeJob(job: JobContainer): Promise<void> {
  await docker(['rm', '-f', '-v', job.name], { timeoutMs: 60_000 });
  await docker(['volume', 'rm', '-f', job.volume], { timeoutMs: 60_000 });
}

/**
 * Clone the commit into /workspace from inside the job container.
 * The token travels as GIT_CONFIG_* env on this one exec only — never in
 * .git/config, argv, or any step's environment.
 */
export async function cloneInJob(
  job: JobContainer,
  checkout: { url: string; token: string; branch: string; commitSha: string },
  onLine: ExecOptions['onLine']
): Promise<ExecResult> {
  const script = [
    'set -eu',
    'command -v git >/dev/null 2>&1 || { echo "git is not installed in the CI image" >&2; exit 127; }',
    'git init -q .',
    'git remote add origin "$1"',
    'if ! git fetch -q --depth=1 origin "$2" 2>/dev/null; then',
    '  git fetch -q --depth=50 origin "+refs/heads/$3:refs/remotes/origin/$3"',
    '  git cat-file -e "$2^{commit}" 2>/dev/null || git fetch -q --unshallow origin "+refs/heads/$3:refs/remotes/origin/$3"',
    'fi',
    'git -c advice.detachedHead=false checkout -q "$2"',
    'echo "Checked out $(git rev-parse --short HEAD) ($3)"',
  ].join('\n');
  return execInJob(
    job,
    ['sh', '-c', script, 'clone', checkout.url, checkout.commitSha, checkout.branch],
    {
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${checkout.token}`,
    },
    { onLine, timeoutMs: 10 * 60_000 }
  );
}

/** Remove containers/volumes left behind by a previous process of THIS runner (crash, restart). */
export async function sweepOrphans(): Promise<void> {
  const filter = ['--filter', `label=${LABEL_RUNNER}=${config.runnerId}`];
  const ps = await docker(['ps', '-aq', ...filter]);
  const ids = ps.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  if (ids.length) await docker(['rm', '-f', '-v', ...ids]);
  const vols = await docker(['volume', 'ls', '-q', ...filter]);
  const names = vols.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  if (names.length) await docker(['volume', 'rm', '-f', ...names]);
  if (ids.length || names.length) console.log(`Swept ${ids.length} orphan container(s), ${names.length} volume(s)`);
}

// ─── Log collection ─────────────────────────────────────────────

/** Bounded, secret-masking line collector. */
export class LogCollector {
  readonly lines: LogLine[] = [];
  private chars = 0;
  private dropped = 0;
  dirty = false;

  constructor(private readonly secrets: string[] = []) {}

  push(stream: 'stdout' | 'stderr', raw: string): void {
    let line = raw.length > 8192 ? `${raw.slice(0, 8192)}…[truncated]` : raw;
    for (const s of this.secrets) if (s && s.length >= 6) line = line.split(s).join('***');
    this.lines.push({ timestamp: new Date().toISOString(), stream, line });
    this.chars += line.length;
    while (this.chars > config.maxStepLogChars && this.lines.length > 1) {
      this.chars -= this.lines.shift()!.line.length;
      this.dropped++;
    }
    this.dirty = true;
  }

  note(line: string): void {
    this.push('stderr', `[runner] ${line}`);
  }

  /** All lines, with a marker if older output was dropped. */
  all(): LogLine[] {
    if (!this.dropped) return this.lines;
    return [{ timestamp: this.lines[0]?.timestamp ?? '', stream: 'stderr', line: `[runner] ${this.dropped} earlier line(s) truncated` }, ...this.lines];
  }

  tail(n: number): LogLine[] {
    return this.lines.slice(-n);
  }
}
