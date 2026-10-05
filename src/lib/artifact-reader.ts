import type { ArtifactCommit, ArtifactRepo, Env } from '../env.ts';
import type { BlobResult, CommitDetail, CommitSummary, TreeResult } from './repo-store.ts';

const isoDate = (seconds: number) => new Date(seconds * 1000).toISOString();

function timeAgo(seconds: number): string {
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (elapsed < 60) return 'just now';
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)} minutes ago`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)} hours ago`;
  return `${Math.floor(elapsed / 86400)} days ago`;
}

function summary(commit: ArtifactCommit): CommitSummary {
  const [message, ...description] = commit.message.trimEnd().split('\n');
  return {
    sha: commit.hash,
    short_sha: commit.hash.slice(0, 7),
    message,
    description: description.join('\n').trim() || undefined,
    author: commit.author,
    date: isoDate(commit.committedAt),
    time_ago: timeAgo(commit.committedAt),
    ci_status: null,
    ci_run_id: null,
    stats: { additions: 0, deletions: 0, total: 0, files_changed: 0 },
  };
}

async function artifactRepo(env: Env, name: string): Promise<ArtifactRepo | null> {
  try {
    return await env.REPOS.get(name);
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return null;
    throw error;
  }
}

export async function getArtifactCommits(env: Env, name: string, ref = 'main', limit = 20): Promise<CommitSummary[]> {
  const repo = await artifactRepo(env, name);
  if (!repo) return [];
  return (await repo.log({ ref, limit: Math.min(Math.max(limit, 1), 100) })).map(summary);
}

export async function getArtifactCommitDetail(env: Env, name: string, sha: string): Promise<CommitDetail | null> {
  const repo = await artifactRepo(env, name);
  if (!repo) return null;
  let fullSha = sha;
  if (sha.length < 40) {
    const match = (await repo.log({ limit: 1000 })).find(commit => commit.hash.startsWith(sha));
    if (!match) return null;
    fullSha = match.hash;
  }
  const commit = await repo.readCommit(fullSha);
  if (!commit) return null;
  return {
    ...summary(commit),
    parent_sha: commit.parents[0] ?? null,
    parent_short_sha: commit.parents[0]?.slice(0, 7) ?? null,
    files: [],
  };
}

export async function getArtifactBranches(env: Env, name: string, defaultBranch: string): Promise<{ name: string; is_default: boolean; commit_sha: string }[]> {
  const commits = await getArtifactCommits(env, name, defaultBranch, 1);
  return commits.length ? [{ name: defaultBranch, is_default: true, commit_sha: commits[0].sha }] : [];
}

export async function getArtifactTree(env: Env, name: string, subPath = '', ref = 'main'): Promise<TreeResult | null> {
  const repo = await artifactRepo(env, name);
  if (!repo) return null;
  const cleanPath = subPath.replace(/^\/+|\/+$/g, '');
  const segments = cleanPath ? cleanPath.split('/') : [];
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;

  const breadcrumbs = [{ name, path: '' }];
  let breadcrumbPath = '';
  for (const segment of segments) {
    breadcrumbPath = breadcrumbPath ? `${breadcrumbPath}/${segment}` : segment;
    breadcrumbs.push({ name: segment, path: breadcrumbPath });
  }

  const [commit] = await repo.log({ ref, limit: 1 });
  if (!commit) {
    if (cleanPath) return null;
    return { repo: name, ref, path: '', breadcrumbs, latest_commit: null, entries: [], readme: null };
  }

  let treeHash = commit.treeHash;
  for (const segment of segments) {
    const parentEntries = await repo.readTree(treeHash);
    const child = parentEntries?.find(entry => entry.name === segment && entry.type === 'tree');
    if (!child) return null;
    treeHash = child.hash;
  }
  const children = await repo.readTree(treeHash);
  if (!children) return null;
  const latest = summary(commit);
  const entries = children.map(entry => ({
    name: entry.name,
    type: entry.type === 'tree' ? 'tree' as const : 'blob' as const,
    path: cleanPath ? `${cleanPath}/${entry.name}` : entry.name,
    message: latest.message,
    updated_at: latest.time_ago,
  })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : 1));

  const readmeEntry = children.find(entry => entry.name === 'README.md' || entry.name === 'AGENTS.md');
  const readmePath = readmeEntry && (cleanPath ? `${cleanPath}/${readmeEntry.name}` : readmeEntry.name);
  const readmeFile = readmePath ? await repo.readFile({ ref, path: readmePath }) : null;

  return {
    repo: name,
    ref,
    path: cleanPath,
    breadcrumbs,
    latest_commit: {
      sha: latest.sha,
      short_sha: latest.short_sha,
      message: latest.message,
      author: latest.author,
      date: latest.date,
      time_ago: latest.time_ago,
    },
    entries,
    readme: readmeFile && readmeEntry ? { name: readmeEntry.name, content: await readmeFile.text() } : null,
  };
}

export async function getArtifactBlob(env: Env, name: string, filePath: string, ref = 'main'): Promise<BlobResult | null> {
  const cleanPath = filePath.replace(/^\/+/, '');
  if (!cleanPath || cleanPath.split('/').some(segment => !segment || segment === '.' || segment === '..')) return null;
  const repo = await artifactRepo(env, name);
  if (!repo) return null;
  const file = await repo.readFile({ ref, path: cleanPath });
  if (!file) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let content = '';
  let isBinary = bytes.includes(0);
  if (!isBinary) {
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
    catch { isBinary = true; }
  }
  const [commit] = await repo.log({ ref, limit: 1 });
  const latest = commit ? summary(commit) : null;
  return {
    repo: name,
    ref,
    path: cleanPath,
    name: cleanPath.split('/').at(-1)!,
    size: bytes.length,
    lines: isBinary ? 0 : content.split('\n').length,
    content,
    is_binary: isBinary,
    latest_commit: {
      sha: latest?.sha ?? '',
      short_sha: latest?.short_sha ?? '',
      message: latest?.message ?? '',
      author: latest?.author ?? { name: '', email: '' },
      date: latest?.date ?? '',
    },
  };
}

export async function getArtifactRawFile(env: Env, name: string, filePath: string, ref = 'main'): Promise<Blob | null> {
  const cleanPath = filePath.replace(/^\/+/, '');
  if (!cleanPath || cleanPath.split('/').some(segment => !segment || segment === '.' || segment === '..')) return null;
  const repo = await artifactRepo(env, name);
  return repo ? repo.readFile({ ref, path: cleanPath }) : null;
}
