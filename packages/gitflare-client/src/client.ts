import {
  type GitFlareConfig,
  type FetchLike,
  type Repo,
  type CreateRepoInput,
  type CreatedRepo,
  type ApiKey,
  type CreateKeyInput,
  type CreatedKey,
  type CIRun,
  type CIRunDetail,
  type CIStepLog,
  type CIStepLogTail,
  type TriggerCIInput,
  type TriggeredRun,
  type CancelledRun,
  type Tree,
  type BlobContent,
  type DeployTarget,
  type CreateDeployInput,
  type Mirror,
  type SetupMirrorInput,
  type MirrorSetupResult,
  type MirrorSyncResult,
  type Commit,
  type HealthResponse,
  type LfsSummary,
  type LfsObjectPage,
  type LfsToken,
  type DiaryEntry,
  type DiaryMedia,
  type DiaryPage,
  type CreateDiaryEntryInput,
  type TableList,
  type Table,
  type SaveTableInput,
  type SavedTable,
  type TableHistory,
  GitFlareError,
} from './types.js';

// ─── HTTP Transport ─────────────────────────────────────────────

class Http {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: GitFlareConfig) {
    this.base = config.baseUrl.replace(/\/$/, '');
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
  }

  get baseUrl(): string {
    return this.base;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    return { ...headers, ...this.config.headers, ...extra };
  }

  async raw(method: string, path: string, body?: unknown, authenticated = true): Promise<Response> {
    const extra: Record<string, string> = body !== undefined ? { 'Content-Type': 'application/json' } : {};
    const headers = authenticated ? this.headers(extra) : { Accept: 'application/json', ...extra };
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed: unknown = text || res.statusText;
      try { parsed = JSON.parse(text); } catch { /* keep text */ }
      throw new GitFlareError(res.status, res.statusText, parsed);
    }
    return res;
  }

  /** Send raw bytes (no JSON encoding) and return the `{ data }` envelope. */
  async bytes<T>(method: string, path: string, body: Uint8Array | Blob): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: this.headers({ 'Content-Type': 'application/octet-stream' }),
      body: body as BodyInit,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed: unknown = text || res.statusText;
      try { parsed = JSON.parse(text); } catch { /* keep text */ }
      throw new GitFlareError(res.status, res.statusText, parsed);
    }
    return ((await res.json()) as { data: T }).data;
  }

  /** JSON body as-is (endpoints that don't use an envelope). */
  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    return (await res.json()) as T;
  }

  /** Strip a single-key envelope such as `{ data: ... }`, `{ repos: [...] }`, `{ mirror: ... }`. */
  async unwrap<T>(key: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const payload = (await res.json()) as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object' || !(key in payload)) {
      throw new GitFlareError(res.status, `Unexpected response shape (missing "${key}")`, payload);
    }
    return payload[key] as T;
  }

  /** Shorthand for the `{ data: ... }` envelope used by most repo-scoped endpoints. */
  data<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.unwrap<T>('data', method, path, body);
  }
}

const seg = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

// ─── Sub-clients ────────────────────────────────────────────────

class ReposClient {
  constructor(private http: Http) {}

  /** `GET /api/repos` — repositories the caller can read. */
  list(limit = 50, offset = 0): Promise<Repo[]> {
    return this.http.unwrap('repos', 'GET', `/api/repos${query({ limit, offset })}`);
  }

  create(input: CreateRepoInput): Promise<CreatedRepo> {
    return this.http.json('POST', '/api/repos', input);
  }

  get(name: string): Promise<Repo> {
    return this.http.json('GET', `/api/repos/${seg(name)}`);
  }

  delete(name: string): Promise<{ success: boolean }> {
    return this.http.json('DELETE', `/api/repos/${seg(name)}`);
  }
}

class KeysClient {
  constructor(private http: Http) {}

  /** Admins see all keys; users see their own; a non-admin API key sees only itself. */
  list(): Promise<ApiKey[]> {
    return this.http.unwrap('keys', 'GET', '/api/keys');
  }

  create(input: CreateKeyInput): Promise<CreatedKey> {
    return this.http.json('POST', '/api/keys', input);
  }

  revoke(id: string): Promise<{ success: boolean; revoked: string }> {
    return this.http.json('DELETE', `/api/keys/${seg(id)}`);
  }
}

class CIClient {
  constructor(private http: Http) {}

  runs(repo: string, opts: { limit?: number; offset?: number; status?: string } = {}): Promise<CIRun[]> {
    return this.http.data('GET', `/api/repos/${seg(repo)}/ci/runs${query(opts)}`);
  }

  /** Run detail with jobs → steps (each step carries a log tail). */
  status(repo: string, runId: string): Promise<CIRunDetail> {
    return this.http.data('GET', `/api/repos/${seg(repo)}/ci/runs/${seg(runId)}`);
  }

  /**
   * Quick view: the truncated log tail of every step in the run, flattened
   * across jobs. Each entry's `index` can be passed to `stepLog` for the full log.
   */
  async logs(repo: string, runId: string): Promise<CIStepLogTail[]> {
    const run = await this.status(repo, runId);
    const ordinals = new Map(run.raw_steps.map(s => [s.id, s.global_ordinal ?? s.step_index]));
    return run.jobs.flatMap(job =>
      job.steps.map(step => ({
        index: ordinals.get(step.id) ?? -1,
        job_name: job.name,
        name: step.name,
        status: step.status,
        exit_code: step.exit_code,
        logs: step.logs,
      })),
    );
  }

  /** Full log for one step (from R2; falls back to the tail with `complete: false`). */
  stepLog(repo: string, runId: string, stepIndex: number): Promise<CIStepLog> {
    return this.http.data('GET', `/api/repos/${seg(repo)}/ci/runs/${seg(runId)}/logs/${stepIndex}`);
  }

  trigger(repo: string, input: TriggerCIInput = {}): Promise<TriggeredRun> {
    return this.http.data('POST', `/api/repos/${seg(repo)}/ci/trigger`, input);
  }

  rerun(repo: string, runId: string): Promise<{ id: string; status: 'queued' }> {
    return this.http.data('POST', `/api/repos/${seg(repo)}/ci/runs/${seg(runId)}/rerun`, {});
  }

  cancel(repo: string, runId: string): Promise<CancelledRun> {
    return this.http.data('POST', `/api/repos/${seg(repo)}/ci/runs/${seg(runId)}/cancel`, {});
  }
}

class FilesClient {
  constructor(private http: Http) {}

  /** `ref` defaults to the repo's default branch on the server. */
  tree(repo: string, ref?: string, path = ''): Promise<Tree> {
    return this.http.data('GET', `/api/repos/${seg(repo)}/tree${query({ ref, path: path === '/' ? '' : path })}`);
  }

  /** `ref` defaults to the repo's default branch on the server. */
  blob(repo: string, ref: string | undefined, path: string): Promise<BlobContent> {
    return this.http.data('GET', `/api/repos/${seg(repo)}/blob${query({ ref, path })}`);
  }

  async raw(repo: string, ref: string | undefined, path: string): Promise<string> {
    const res = await this.http.raw('GET', `/api/repos/${seg(repo)}/raw${query({ ref, path })}`);
    return res.text();
  }
}

class CommitsClient {
  constructor(private http: Http) {}

  /** `branch` defaults to the repo's default branch; `limit` is clamped to 1-100 by the server. */
  list(repo: string, branch?: string, limit = 20): Promise<Commit[]> {
    return this.http.data('GET', `/api/repos/${seg(repo)}/commits${query({ branch, limit })}`);
  }
}

class DeployClient {
  constructor(private http: Http) {}

  list(repo: string): Promise<DeployTarget[]> {
    return this.http.data('GET', `/api/repos/${seg(repo)}/deploys`);
  }

  create(repo: string, input: CreateDeployInput): Promise<{ id: string }> {
    return this.http.data('POST', `/api/repos/${seg(repo)}/deploys`, input);
  }

  remove(repo: string, targetId: string): Promise<{ success: boolean }> {
    return this.http.json('DELETE', `/api/repos/${seg(repo)}/deploys/${seg(targetId)}`);
  }
}

class MirrorsClient {
  constructor(private http: Http) {}

  /** null when no mirror is configured. */
  get(repo: string): Promise<Mirror | null> {
    return this.http.unwrap('mirror', 'GET', `/api/repos/${seg(repo)}/mirror`);
  }

  setup(repo: string, input: SetupMirrorInput): Promise<MirrorSetupResult> {
    return this.http.json('POST', `/api/repos/${seg(repo)}/mirror`, input);
  }

  sync(repo: string): Promise<MirrorSyncResult> {
    return this.http.json('POST', `/api/repos/${seg(repo)}/mirror/sync`, {});
  }

  disable(repo: string): Promise<{ success: boolean; message: string }> {
    return this.http.json('DELETE', `/api/repos/${seg(repo)}/mirror`);
  }
}

class LfsClient {
  constructor(private http: Http) {}

  /** Policy, usage and tracked patterns. Call before committing anything large. */
  status(repo: string): Promise<LfsSummary> {
    return this.http.data('GET', `/api/repos/${seg(repo)}/lfs`);
  }

  async list(repo: string, opts: { limit?: number; offset?: number } = {}): Promise<LfsObjectPage> {
    const res = await this.http.raw('GET', `/api/repos/${seg(repo)}/lfs/objects${query({ limit: opts.limit, offset: opts.offset })}`);
    return (await res.json()) as LfsObjectPage;
  }

  /** Mint a short-lived LFS bearer token (write scope needs write access on the repo). */
  token(repo: string, opts: { scope?: 'read' | 'write'; ttl_seconds?: number } = {}): Promise<LfsToken> {
    return this.http.data('POST', `/api/repos/${seg(repo)}/lfs/token`, opts);
  }

  /** Authenticated download of one object's bytes. */
  download(repo: string, oid: string, filename?: string): Promise<Response> {
    return this.http.raw('GET', `/api/repos/${seg(repo)}/lfs/objects/${encodeURIComponent(oid)}${query({ filename })}`);
  }
}

/** Data tables: CSV files under `tables/`, one commit per save. */
class TablesClient {
  constructor(private http: Http) {}

  list(repo: string, opts: { ref?: string } = {}): Promise<TableList> {
    return this.http.data('GET', `/api/repos/${seg(repo)}/tables${query({ ref: opts.ref })}`);
  }

  /** `ref` may be a branch, tag or commit id (to read an old version). */
  get(repo: string, name: string, opts: { ref?: string } = {}): Promise<Table> {
    return this.http.data('GET', `/api/repos/${seg(repo)}/tables/${seg(name)}${query({ ref: opts.ref })}`);
  }

  history(repo: string, name: string, opts: { ref?: string } = {}): Promise<TableHistory> {
    return this.http.data('GET', `/api/repos/${seg(repo)}/tables/${seg(name)}/history${query({ ref: opts.ref })}`);
  }

  /** Create, replace or rename a table in one commit. */
  save(repo: string, name: string, input: SaveTableInput): Promise<SavedTable> {
    return this.http.data('PUT', `/api/repos/${seg(repo)}/tables/${seg(name)}`, input);
  }

  delete(repo: string, name: string, opts: { branch?: string; base_blob?: string; message?: string } = {}): Promise<{ name: string; branch: string; commit: string; deleted: boolean }> {
    return this.http.data('DELETE', `/api/repos/${seg(repo)}/tables/${seg(name)}${query(opts)}`);
  }
}

class DiaryClient {
  constructor(private http: Http) {}

  /** Entries newest first (or `order: 'asc'`), paged by `cursor`. */
  async list(repo: string, opts: { order?: 'asc' | 'desc'; limit?: number; cursor?: string } = {}): Promise<DiaryPage> {
    const res = await this.http.raw('GET', `/api/repos/${seg(repo)}/diary${query({ order: opts.order, limit: opts.limit, cursor: opts.cursor })}`);
    return (await res.json()) as DiaryPage;
  }

  get(repo: string, id: string): Promise<DiaryEntry> {
    return this.http.data('GET', `/api/repos/${seg(repo)}/diary/${seg(id)}`);
  }

  create(repo: string, input: CreateDiaryEntryInput): Promise<DiaryEntry> {
    return this.http.data('POST', `/api/repos/${seg(repo)}/diary`, input);
  }

  /** `media_ids`, when given, is the full new list (reorders, adds, and removes). */
  update(repo: string, id: string, input: CreateDiaryEntryInput): Promise<DiaryEntry> {
    return this.http.data('PATCH', `/api/repos/${seg(repo)}/diary/${seg(id)}`, input);
  }

  delete(repo: string, id: string): Promise<{ id: string; deleted: boolean }> {
    return this.http.data('DELETE', `/api/repos/${seg(repo)}/diary/${seg(id)}`);
  }

  /**
   * Upload a photo or video (jpg, png, gif, webp, avif, heic, mp4, mov, webm; up
   * to 2 GB) and return it ready to attach via `create({ media_ids })`.
   * Unattached uploads are deleted after a day.
   */
  async upload(repo: string, filename: string, bytes: Uint8Array | Blob): Promise<DiaryMedia> {
    const size = bytes instanceof Blob ? bytes.size : bytes.byteLength;
    const base = `/api/repos/${seg(repo)}/diary/media`;
    const started = await this.http.data<{ id: string; part_size: number; part_count: number }>('POST', base, { filename, size });
    const parts: { part_number: number; etag: string }[] = [];
    for (let n = 1; n <= started.part_count; n++) {
      const start = (n - 1) * started.part_size;
      const end = Math.min(n * started.part_size, size);
      const chunk = bytes instanceof Blob ? bytes.slice(start, end) : bytes.subarray(start, end);
      const part = await this.http.bytes<{ part_number: number; etag: string }>('PUT', `${base}/${seg(started.id)}/parts/${n}`, chunk);
      parts.push(part);
    }
    return this.http.data('POST', `${base}/${seg(started.id)}/complete`, { parts });
  }
}

// ─── Main Client ────────────────────────────────────────────────

export class GitFlareClient {
  public readonly repos: ReposClient;
  public readonly keys: KeysClient;
  public readonly ci: CIClient;
  public readonly files: FilesClient;
  public readonly commits: CommitsClient;
  public readonly deploys: DeployClient;
  public readonly mirrors: MirrorsClient;
  public readonly lfs: LfsClient;
  public readonly diary: DiaryClient;
  public readonly tables: TablesClient;
  private readonly http: Http;

  constructor(config: GitFlareConfig) {
    this.http = new Http(config);
    this.repos = new ReposClient(this.http);
    this.keys = new KeysClient(this.http);
    this.ci = new CIClient(this.http);
    this.files = new FilesClient(this.http);
    this.commits = new CommitsClient(this.http);
    this.deploys = new DeployClient(this.http);
    this.mirrors = new MirrorsClient(this.http);
    this.lfs = new LfsClient(this.http);
    this.diary = new DiaryClient(this.http);
    this.tables = new TablesClient(this.http);
  }

  /** Public health check — does NOT verify credentials (see `verifyAuth`). */
  async health(): Promise<HealthResponse> {
    const res = await this.http.raw('GET', '/health', undefined, false);
    return (await res.json()) as HealthResponse;
  }

  /**
   * Verify the configured credentials against a protected endpoint.
   * Throws `GitFlareError` (401/403) if they are rejected.
   */
  async verifyAuth(): Promise<void> {
    await this.repos.list(1, 0);
  }

  /** Git remote URL for a repo (no credentials embedded). */
  gitRemoteUrl(repoName: string): string {
    return `${this.http.baseUrl}/git/${seg(repoName)}`;
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }
}
