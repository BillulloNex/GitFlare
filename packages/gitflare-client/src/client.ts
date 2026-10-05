import {
  type GitFlareConfig,
  type Repo,
  type CreateRepoInput,
  type ApiKey,
  type CreateKeyInput,
  type CreatedKey,
  type CIRun,
  type CIJob,
  type CIJobLog,
  type TriggerCIInput,
  type TreeEntry,
  type BlobContent,
  type DeployTarget,
  type CreateDeployInput,
  type Mirror,
  type SetupMirrorInput,
  type Commit,
  type HealthResponse,
  GitFlareError,
} from './types.js';

// ─── HTTP Helper ────────────────────────────────────────────────

async function request<T>(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const resBody = await res.json().catch(() => res.statusText);
    throw new GitFlareError(res.status, res.statusText, resBody);
  }

  return (await res.json()) as T;
}

// ─── Sub-clients ────────────────────────────────────────────────

class ReposClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  async list(limit = 50, offset = 0) {
    return request<{ repos: Repo[]; limit: number; offset: number }>(
      this.baseUrl, this.apiKey, 'GET',
      `/api/repos?limit=${limit}&offset=${offset}`,
    );
  }

  async create(input: CreateRepoInput) {
    return request<{ id: string; name: string }>(
      this.baseUrl, this.apiKey, 'POST', '/api/repos', input,
    );
  }

  async get(name: string) {
    return request<Repo>(
      this.baseUrl, this.apiKey, 'GET', `/api/repos/${encodeURIComponent(name)}`,
    );
  }

  async delete(name: string) {
    return request<{ success: boolean }>(
      this.baseUrl, this.apiKey, 'DELETE', `/api/repos/${encodeURIComponent(name)}`,
    );
  }
}

class KeysClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  async list() {
    return request<{ keys: ApiKey[] }>(
      this.baseUrl, this.apiKey, 'GET', '/api/keys',
    );
  }

  async create(input: CreateKeyInput) {
    return request<CreatedKey>(
      this.baseUrl, this.apiKey, 'POST', '/api/keys', input,
    );
  }

  async revoke(id: string) {
    return request<{ success: boolean; revoked: string }>(
      this.baseUrl, this.apiKey, 'DELETE', `/api/keys/${encodeURIComponent(id)}`,
    );
  }

  /** Bootstrap the first admin key using the ADMIN_API_KEY secret */
  async bootstrap(adminApiKey: string, name = 'admin-bootstrap') {
    return request<CreatedKey>(
      this.baseUrl, adminApiKey, 'POST', '/api/bootstrap', { name },
    );
  }
}

class CIClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  async runs(repo: string) {
    return request<{ runs: CIRun[] }>(
      this.baseUrl, this.apiKey, 'GET',
      `/api/repos/${encodeURIComponent(repo)}/ci/runs`,
    );
  }

  async status(repo: string, runId: string) {
    return request<{ run: CIRun; jobs: CIJob[] }>(
      this.baseUrl, this.apiKey, 'GET',
      `/api/repos/${encodeURIComponent(repo)}/ci/runs/${encodeURIComponent(runId)}`,
    );
  }

  async logs(repo: string, runId: string, jobId: string) {
    return request<{ logs: CIJobLog[] }>(
      this.baseUrl, this.apiKey, 'GET',
      `/api/repos/${encodeURIComponent(repo)}/ci/runs/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobId)}/logs`,
    );
  }

  async trigger(repo: string, input?: TriggerCIInput) {
    return request<{ run_id: string; status: string }>(
      this.baseUrl, this.apiKey, 'POST',
      `/api/repos/${encodeURIComponent(repo)}/ci/trigger`,
      input ?? {},
    );
  }

  async cancel(repo: string, runId: string) {
    return request<{ success: boolean }>(
      this.baseUrl, this.apiKey, 'POST',
      `/api/repos/${encodeURIComponent(repo)}/ci/runs/${encodeURIComponent(runId)}/cancel`,
    );
  }
}

class FilesClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  async tree(repo: string, ref: string, path = '/') {
    const params = new URLSearchParams({ ref, path });
    return request<{ entries: TreeEntry[] }>(
      this.baseUrl, this.apiKey, 'GET',
      `/api/repos/${encodeURIComponent(repo)}/tree?${params}`,
    );
  }

  async blob(repo: string, ref: string, path: string) {
    const params = new URLSearchParams({ ref, path });
    return request<BlobContent>(
      this.baseUrl, this.apiKey, 'GET',
      `/api/repos/${encodeURIComponent(repo)}/blob?${params}`,
    );
  }

  async raw(repo: string, ref: string, path: string): Promise<string> {
    const params = new URLSearchParams({ ref, path });
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/repos/${encodeURIComponent(repo)}/raw?${params}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      throw new GitFlareError(res.status, res.statusText, await res.text());
    }
    return res.text();
  }
}

class CommitsClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  async list(repo: string, ref = 'main', limit = 20) {
    const params = new URLSearchParams({ ref, limit: String(limit) });
    return request<{ commits: Commit[] }>(
      this.baseUrl, this.apiKey, 'GET',
      `/api/repos/${encodeURIComponent(repo)}/commits?${params}`,
    );
  }
}

class DeployClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  async list(repo: string) {
    return request<{ targets: DeployTarget[] }>(
      this.baseUrl, this.apiKey, 'GET',
      `/api/repos/${encodeURIComponent(repo)}/deploys`,
    );
  }

  async create(repo: string, input: CreateDeployInput) {
    return request<{ id: string }>(
      this.baseUrl, this.apiKey, 'POST',
      `/api/repos/${encodeURIComponent(repo)}/deploys`,
      input,
    );
  }

  async remove(repo: string, targetId: string) {
    return request<{ success: boolean }>(
      this.baseUrl, this.apiKey, 'DELETE',
      `/api/repos/${encodeURIComponent(repo)}/deploys/${encodeURIComponent(targetId)}`,
    );
  }
}

class MirrorsClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  async get(repo: string) {
    return request<{ mirror: Mirror }>(
      this.baseUrl, this.apiKey, 'GET',
      `/api/repos/${encodeURIComponent(repo)}/mirror`,
    );
  }

  async setup(repo: string, input: SetupMirrorInput) {
    return request<{ id: string }>(
      this.baseUrl, this.apiKey, 'POST',
      `/api/repos/${encodeURIComponent(repo)}/mirror`,
      input,
    );
  }

  async sync(repo: string) {
    return request<{ status: string }>(
      this.baseUrl, this.apiKey, 'POST',
      `/api/repos/${encodeURIComponent(repo)}/mirror/sync`,
    );
  }

  async disable(repo: string) {
    return request<{ success: boolean }>(
      this.baseUrl, this.apiKey, 'DELETE',
      `/api/repos/${encodeURIComponent(repo)}/mirror`,
    );
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

  constructor(private config: GitFlareConfig) {
    const { baseUrl, apiKey } = config;
    this.repos = new ReposClient(baseUrl, apiKey);
    this.keys = new KeysClient(baseUrl, apiKey);
    this.ci = new CIClient(baseUrl, apiKey);
    this.files = new FilesClient(baseUrl, apiKey);
    this.commits = new CommitsClient(baseUrl, apiKey);
    this.deploys = new DeployClient(baseUrl, apiKey);
    this.mirrors = new MirrorsClient(baseUrl, apiKey);
  }

  /** Check GitFlare instance health */
  async health() {
    // Health endpoint is public, no auth needed
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/health`;
    const res = await fetch(url);
    return (await res.json()) as HealthResponse;
  }

  /** Get the Git remote URL for a repo */
  gitRemoteUrl(repoName: string): string {
    return `${this.config.baseUrl.replace(/\/$/, '')}/git/${repoName}`;
  }

  /** Get the base URL */
  get baseUrl(): string {
    return this.config.baseUrl;
  }
}
