/** Runner → Worker HTTP calls (always authenticated, always versioned). */
import { config } from './config.js';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from './protocol.js';

const CALLBACK_ATTEMPTS = 5;

async function post(url: string, body: unknown, timeoutMs: number): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.runnerSecret}`,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Deliver a final result. Retries network errors and 5xx with backoff; gives
 * up on 4xx (the Worker rejected it — retrying won't help). If every attempt
 * fails, the Worker's cron eventually marks the run/deployment failed.
 */
export async function sendCallback(url: string, body: unknown, label: string): Promise<unknown> {
  for (let attempt = 1; attempt <= CALLBACK_ATTEMPTS; attempt++) {
    try {
      const res = await post(url, body, 60_000);
      if (res.ok) return res.json().catch(() => null);
      const text = await res.text().catch(() => '');
      console.error(`${label}: callback HTTP ${res.status} ${text.slice(0, 300)}`);
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return null;
    } catch (err) {
      console.error(`${label}: callback attempt ${attempt}/${CALLBACK_ATTEMPTS} failed`, err);
    }
    if (attempt < CALLBACK_ATTEMPTS) await new Promise(r => setTimeout(r, 2000 * 2 ** (attempt - 1)));
  }
  console.error(`${label}: callback to ${url} gave up after ${CALLBACK_ATTEMPTS} attempts`);
  return null;
}

/** Best-effort progress post (single attempt). Returns the parsed response or null. */
export async function sendProgress(url: string, body: unknown): Promise<any> {
  try {
    const res = await post(url, body, 15_000);
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

// ─── Concurrency ────────────────────────────────────────────────

/** FIFO semaphore for job containers (CI runs + Cloudflare deploys). */
class Slots {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}

  get running(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
    } else {
      // The releasing holder hands its slot straight to us (active unchanged).
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
}

export const jobSlots = new Slots(config.maxConcurrentJobs);
