/**
 * Repository Data Store for GitFlare
 * Provides GitHub-style tree browsing, file contents, commit history, and diffs.
 */

export interface CommitAuthor {
  name: string;
  email: string;
  avatar?: string;
}

export interface CommitSummary {
  sha: string;
  short_sha: string;
  message: string;
  description?: string;
  author: CommitAuthor;
  date: string;
  time_ago: string;
  ci_status?: 'passed' | 'failed' | 'running' | 'queued' | null;
  ci_run_id?: string | null;
  stats: {
    additions: number;
    deletions: number;
    total: number;
    files_changed: number;
  };
}

export interface CommitFileDiff {
  filename: string;
  status: 'modified' | 'added' | 'deleted';
  additions: number;
  deletions: number;
  patch: string;
}

export interface CommitDetail extends CommitSummary {
  parent_sha: string | null;
  parent_short_sha: string | null;
  files: CommitFileDiff[];
}

export interface TreeEntry {
  name: string;
  type: 'tree' | 'blob';
  path: string;
  size?: number;
  message: string;
  updated_at: string;
}

export interface Breadcrumb {
  name: string;
  path: string;
}

export interface TreeResult {
  repo: string;
  ref: string;
  path: string;
  breadcrumbs: Breadcrumb[];
  latest_commit: {
    sha: string;
    short_sha: string;
    message: string;
    author: CommitAuthor;
    date: string;
    time_ago: string;
  };
  entries: TreeEntry[];
  readme?: {
    name: string;
    content: string;
  } | null;
}

export interface BlobResult {
  repo: string;
  ref: string;
  path: string;
  name: string;
  size: number;
  lines: number;
  content: string;
  is_binary: boolean;
  latest_commit: {
    sha: string;
    short_sha: string;
    message: string;
    author: CommitAuthor;
    date: string;
  };
}

// ─── Starship Commits Data ──────────────────────────────────────
const STARSHIP_COMMITS: CommitDetail[] = [
  {
    sha: '817001a1f4c1e4bc37907895580f2d1cb7e6ca9b',
    short_sha: '817001a',
    message: 'v0.81.7: live deployment speed test (bump version to 0.81.7)',
    description: 'Direct push to GitFlare edge custom domain git.beenex.company to verify commit-to-live latency.',
    author: {
      name: 'Thomas Nguyen',
      email: 'tungvunguyennguyen@gmail.com',
      avatar: 'TN'
    },
    date: '2026-10-02T23:55:00-04:00',
    time_ago: 'just now',
    ci_status: 'passed',
    ci_run_id: 'c9a4d9ce-faf4-4bdb-83ba-ff0837223d3b',
    parent_sha: '240fb22df4c1e4bc37907895580f2d1cb7e6ca9b',
    parent_short_sha: '240fb22',
    stats: {
      files_changed: 2,
      additions: 2,
      deletions: 2,
      total: 4
    },
    files: [
      {
        filename: 'VERSION',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: `@@ -1,1 +1,1 @@\n-0.81.6\n+0.81.7`
      },
      {
        filename: 'OpenHands/src/constants/grokbot-version.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: `@@ -1,1 +1,1 @@\n-export const GROKBOT_VERSION = "0.81.9" as const;\n+export const GROKBOT_VERSION = "0.81.7" as const;`
      }
    ]
  },
  {
    sha: '240fb22df4c1e4bc37907895580f2d1cb7e6ca9b',
    short_sha: '240fb22',
    message: 'v0.81.9: automated end-to-end GitFlare deployment',
    description: 'Trigger automated CI build and verify Coolify deployment webhook on bare metal.',
    author: {
      name: 'Thomas Nguyen',
      email: 'tungvunguyennguyen@gmail.com',
      avatar: 'TN'
    },
    date: '2026-10-02T23:07:34-04:00',
    time_ago: '3 hours ago',
    ci_status: 'passed',
    ci_run_id: 'c9a4d9ce-faf4-4bdb-83ba-ff0837223d3b',
    parent_sha: '1615d39665ae0dbe95fd2084feed1b84ad148b6b',
    parent_short_sha: '1615d39',
    stats: {
      files_changed: 1,
      additions: 1,
      deletions: 1,
      total: 2
    },
    files: [
      {
        filename: 'OpenHands/src/constants/grokbot-version.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: `@@ -1,1 +1,1 @@
-export const GROKBOT_VERSION = "0.81.8" as const;
+export const GROKBOT_VERSION = "0.81.9" as const;`
      }
    ]
  },
  {
    sha: '1615d39665ae0dbe95fd2084feed1b84ad148b6b',
    short_sha: '1615d39',
    message: 'v0.81.8: test automated GitFlare CI/CD pipeline',
    description: 'Bump grokbot version and test container re-build triggers.',
    author: {
      name: 'Thomas Nguyen',
      email: 'tungvunguyennguyen@gmail.com',
      avatar: 'TN'
    },
    date: '2026-10-02T23:05:26-04:00',
    time_ago: '3 hours ago',
    ci_status: 'failed',
    ci_run_id: 'df34f526-f3eb-4dba-a4db-a72b20ddffde',
    parent_sha: '6397201cc4fa27b1c86cecca31247b5eab6c06af',
    parent_short_sha: '6397201',
    stats: {
      files_changed: 1,
      additions: 1,
      deletions: 1,
      total: 2
    },
    files: [
      {
        filename: 'OpenHands/src/constants/grokbot-version.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: `@@ -1,1 +1,1 @@
-export const GROKBOT_VERSION = "0.81.7" as const;
+export const GROKBOT_VERSION = "0.81.8" as const;`
      }
    ]
  },
  {
    sha: '6397201cc4fa27b1c86cecca31247b5eab6c06af',
    short_sha: '6397201',
    message: 'v0.81.7: bump version + add handsome to hello text',
    description: 'Updated i18n translation key HOME$LETS_START_BUILDING with friendly greeting.',
    author: {
      name: 'Thomas Nguyen',
      email: 'tungvunguyennguyen@gmail.com',
      avatar: 'TN'
    },
    date: '2026-10-02T22:40:56-04:00',
    time_ago: '4 hours ago',
    ci_status: 'failed',
    ci_run_id: '6044270b-4699-4a67-9eba-779222afc945',
    parent_sha: 'acc7fe2aa50de657c4589f6f88da94c68a8ae7be',
    parent_short_sha: 'acc7fe2',
    stats: {
      files_changed: 2,
      additions: 2,
      deletions: 2,
      total: 4
    },
    files: [
      {
        filename: 'OpenHands/src/constants/grokbot-version.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: `@@ -1,1 +1,1 @@
-export const GROKBOT_VERSION = "0.81.6" as const;
+export const GROKBOT_VERSION = "0.81.7" as const;`
      },
      {
        filename: 'OpenHands/src/i18n/translation.json',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: `@@ -1887,7 +1887,7 @@
     "ca": "JSON no vàlid"
   },
   "HOME$LETS_START_BUILDING": {
-    "en": "Let's Start Building!",
+    "en": "Let's Start Building, handsome!",
     "ja": "開発を始めましょう！",
     "zh-CN": "让我们开始开发！",
     "zh-TW": "讓我們開始開發！",`
      }
    ]
  },
  {
    sha: 'acc7fe2aa50de657c4589f6f88da94c68a8ae7be',
    short_sha: 'acc7fe2',
    message: 'chore: bump version to 1.13.0',
    description: 'Update root package.json and version metadata.',
    author: {
      name: 'Thomas Nguyen',
      email: 'tungvunguyennguyen@gmail.com',
      avatar: 'TN'
    },
    date: '2026-10-02T21:57:25-04:00',
    time_ago: '5 hours ago',
    ci_status: 'failed',
    ci_run_id: '96ef3dcd-5032-4e34-9c05-257df10c19ab',
    parent_sha: 'f6e9debbc5a2603f504bee26cdac9d9c1711b2b9',
    parent_short_sha: 'f6e9deb',
    stats: {
      files_changed: 2,
      additions: 2,
      deletions: 2,
      total: 4
    },
    files: [
      {
        filename: 'VERSION',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: `@@ -1,1 +1,1 @@
-0.81.5
+0.81.6`
      },
      {
        filename: 'package.json',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: `@@ -1,5 +1,5 @@
 {
   "name": "starship",
-  "version": "1.12.9",
+  "version": "1.13.0",
   "private": true`
      }
    ]
  },
  {
    sha: 'f6e9debbc5a2603f504bee26cdac9d9c1711b2b9',
    short_sha: 'f6e9deb',
    message: 'Add GitFlare integration: push-to-gitflare skill + CI config',
    description: 'Configure Cloudflare Workers edge git remote and Coolify webhook pipeline.',
    author: {
      name: 'Thomas Nguyen',
      email: 'tungvunguyennguyen@gmail.com',
      avatar: 'TN'
    },
    date: '2026-10-02T21:44:49-04:00',
    time_ago: '5 hours ago',
    ci_status: 'passed',
    ci_run_id: null,
    parent_sha: '07250462026508b22c1b347b1dce2334f68d6eb1',
    parent_short_sha: '0725046',
    stats: {
      files_changed: 2,
      additions: 231,
      deletions: 0,
      total: 231
    },
    files: [
      {
        filename: '.gitflare/ci.yml',
        status: 'added',
        additions: 63,
        deletions: 0,
        patch: `@@ -0,0 +1,63 @@
+# GitFlare CI Configuration for Starship
+name: Starship CI/CD
+
+on:
+  push:
+    branches: [main]
+  pull_request:
+    branches: [main]
+  manual: true
+
+jobs:
+  lint:
+    name: Lint & Typecheck
+    sandbox: standard-1
+    steps:
+      - name: Install Python dependencies
+        run: pip install ruff mypy
+      - name: Lint Python
+        run: ruff check OpenHands/
+  test:
+    name: Run Tests
+    sandbox: standard-2
+    needs: [lint]
+    steps:
+      - name: Run Python tests
+        run: python -m pytest OpenHands/tests/ -x
+  deploy:
+    name: Deploy to Coolify
+    sandbox: basic
+    needs: [test]
+    deploy:
+      target: coolify
+      branch_filter: [main]
+    steps:
+      - name: Trigger Coolify deployment
+        run: echo "Deployment triggered via GitFlare -> Coolify webhook"`
      },
      {
        filename: '.agents/skills/push-to-gitflare/SKILL.md',
        status: 'added',
        additions: 168,
        deletions: 0,
        patch: `@@ -0,0 +1,168 @@
+---
+name: push-to-gitflare
+description: Autonomous agent skill for pushing code to GitFlare and deploying
+---
+# Push to GitFlare
+Deploy directly to edge GitFlare Git Smart HTTP endpoint.`
      }
    ]
  },
  {
    sha: '07250462026508b22c1b347b1dce2334f68d6eb1',
    short_sha: '0725046',
    message: 'fix: revert default Codex model to gpt-5.6-sol',
    description: 'Stabilize reasoning default parameters on fallback routes.',
    author: {
      name: 'Thomas Nguyen',
      email: 'tungvunguyennguyen@gmail.com',
      avatar: 'TN'
    },
    date: '2026-09-23T22:38:59-04:00',
    time_ago: '9 days ago',
    ci_status: 'passed',
    ci_run_id: null,
    parent_sha: '81d7956e2cbc29c43263749d6a74c23ee6c289aa',
    parent_short_sha: '81d7956',
    stats: {
      files_changed: 1,
      additions: 4,
      deletions: 4,
      total: 8
    },
    files: [
      {
        filename: 'OpenHands/openhands/core/config/models.py',
        status: 'modified',
        additions: 4,
        deletions: 4,
        patch: `@@ -42,4 +42,4 @@
-DEFAULT_MODEL = "gpt-6-astra"
+DEFAULT_MODEL = "gpt-5.6-sol"`
      }
    ]
  },
  {
    sha: '81d7956e2cbc29c43263749d6a74c23ee6c289aa',
    short_sha: '81d7956',
    message: 'fix(deploy): fix BSD mktemp template and container expansion in fast deploy (v0.81.5)',
    description: 'Ensure cross-platform compatibility on macOS development hosts and Linux servers.',
    author: {
      name: 'Thomas Nguyen',
      email: 'tungvunguyennguyen@gmail.com',
      avatar: 'TN'
    },
    date: '2026-09-23T18:33:35-04:00',
    time_ago: '9 days ago',
    ci_status: 'passed',
    ci_run_id: null,
    parent_sha: '5b6d96589857a41d2225b4735be6b3af5e31a550',
    parent_short_sha: '5b6d965',
    stats: {
      files_changed: 1,
      additions: 12,
      deletions: 8,
      total: 20
    },
    files: [
      {
        filename: 'scripts/deploy-fast.sh',
        status: 'modified',
        additions: 12,
        deletions: 8,
        patch: `@@ -18,8 +18,12 @@
-TMPDIR=$(mktemp -d /tmp/starship-deploy.XXXXXX)
+TMPDIR=$(mktemp -d -t starship-deploy)
+CONTAINER_ID=$(docker ps -q -f name=grokbot)`
      }
    ]
  }
];

// ─── Starship File Contents ──────────────────────────────────────
const STARSHIP_FILES: Record<string, string> = {
  'AGENTS.md': `# Starship Autonomous Agent Platform

Autonomous coding agent platform (OpenHands fork) self-hosted on bare metal with Cloudflare edge management.

## Capabilities
- Multi-agent orchestration with workspace isolation
- Sandboxed bash and python execution
- Direct integration with GitFlare CI/CD
- Coolify webhook deployment pipeline

## Running Agents
\`\`\`bash
# Start agent server
./scripts/deploy-fast.sh
\`\`\`

## Architecture
- **Control Plane:** Cloudflare Workers (GitFlare)
- **Execution Engine:** OpenHands Agent Runtime (Python 3.12 + Node 22)
- **Deploy Host:** Bare metal Mac Mini & Lenovo Y530 via Coolify
- **Storage:** Cloudflare Artifacts (Git), D1 (Metadata), R2 (Logs)
`,

  'GOAL.md': `# Goal

What is the goal here then?

There are 2 inspirations for what we are doing:

1. **Autonomous Development:** Building sessions should happen independently even when computer is sleeping.
2. **Grokbot Form Factor:** Communicate with an agent that has a sandbox VM that does its own thing.

## Target
Build our own Grokbot on bare metal with Coolify and Cloudflare Workers.
`,

  'COOLIFY_DETAILS.md': `# Coolify Project & Deployment Details — Grokbot

This document contains all fetched configuration details from Coolify for the **Grokbot** project and its deployment environment.

---

## 1. Application Overview

- **Application Name**: \`grokbot\`
- **Application UUID**: \`b13aardv73k5fyl01a80ggzc\`
- **Description**: Self-hosted OpenHands AI coding agent
- **Public URL (FQDN)**: [http://grok.beenex.org](http://grok.beenex.org)
- **Current Status**: \`running\`
- **Deploy Host**: Bare metal Coolify cluster
`,

  'VERSION': `0.81.7
`,

  'package.json': `{
  "name": "starship",
  "version": "1.13.0",
  "private": true,
  "scripts": {
    "deploy:fast": "./scripts/deploy-fast.sh",
    "deploy:rollback": "./scripts/deploy-fast.sh --rollback",
    "test": "vitest run"
  }
}
`,

  'Dockerfile': `FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \\
    DEBIAN_FRONTEND=noninteractive \\
    NODE_VERSION=22

RUN apt-get update && apt-get install -y --no-install-recommends \\
    curl git build-essential ca-certificates \\
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \\
    && apt-get install -y nodejs \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY .gitflare/ci.yml ./.gitflare/
COPY VERSION ./

EXPOSE 3000
CMD ["npm", "start"]
`,

  'docker-compose.datadog.yml': `version: '3.8'

services:
  datadog-agent:
    image: datadog/agent:7
    environment:
      - DD_API_KEY=\${DD_API_KEY}
      - DD_SITE=datadoghq.com
      - DD_LOGS_ENABLED=true
      - DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL=true
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /proc/:/host/proc/:ro
      - /sys/fs/cgroup/:/host/sys/fs/cgroup:ro
`,

  'wrangler.toml': `name = "starship"
main = "src/index.ts"
compatibility_date = "2026-09-01"
`,

  'wrapper-entrypoint.sh': `#!/usr/bin/env bash
set -euo pipefail

echo "==> Initializing Starship environment..."
echo "==> Node version: $(node -v)"
echo "==> Python version: $(python3 --version 2>&1 || true)"

exec "$@"
`,

  '.gitflare/ci.yml': `# GitFlare CI Configuration for Starship
# This file tells GitFlare how to test and deploy Starship

name: Starship CI/CD

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  manual: true

env:
  PYTHON_VERSION: "3.12"
  NODE_VERSION: "22"

jobs:
  lint:
    name: Lint & Typecheck
    sandbox: standard-1
    steps:
      - name: Install Python dependencies
        run: pip install ruff mypy
      - name: Lint Python
        run: ruff check OpenHands/
      - name: Check Node dependencies
        run: npm install
      - name: Typecheck frontend
        run: npx tsc --noEmit || true

  test:
    name: Run Tests
    sandbox: standard-2
    needs: [lint]
    steps:
      - name: Install dependencies
        run: |
          pip install -r OpenHands/requirements.txt 2>/dev/null || true
          npm install
      - name: Run Python tests
        run: python -m pytest OpenHands/tests/ -x --timeout=120 2>/dev/null || echo "No pytest tests found"
      - name: Run frontend tests
        run: npm test 2>/dev/null || echo "No npm tests configured"

  build:
    name: Build Docker Image
    sandbox: standard-3
    needs: [test]
    steps:
      - name: Build Docker image
        run: docker build -t starship:latest .
        timeout: 600

  deploy:
    name: Deploy to Coolify
    sandbox: basic
    needs: [build]
    deploy:
      target: coolify
      branch_filter: [main]
    steps:
      - name: Trigger Coolify deployment
        run: echo "Deployment triggered via GitFlare → Coolify webhook"
`,

  'scripts/bump-version.mjs': `import fs from 'node:fs';

const version = fs.readFileSync('VERSION', 'utf8').trim();
console.log(\`Current version: \${version}\`);
`,

  'scripts/deploy-fast.sh': `#!/usr/bin/env bash
set -euo pipefail

echo "==> Deploying Starship to Coolify..."
curl -s -X POST "https://cloud.comfyspace.tech/api/v1/deploy?uuid=b13aardv73k5fyl01a80ggzc" \\
  -H "Authorization: Bearer \${COOLIFY_API_KEY}"
echo "==> Deploy triggered successfully."
`,

  'scripts/smoke-test.sh': `#!/usr/bin/env bash
set -euo pipefail

curl -f http://grok.beenex.org/health || exit 1
echo "Smoke test passed!"
`,

  'OpenHands/src/constants/grokbot-version.ts': `export const GROKBOT_VERSION = "0.81.7" as const;
`,

  'OpenHands/package.json': `{
  "name": "openhands-frontend",
  "version": "0.81.7",
  "private": true
}
`,

  'tasks/prd-cursor-acp-live-activity.md': `# PRD: Cursor ACP Live Activity Stream

Enable real-time WebSocket streaming of agent activity directly into the GitFlare dashboard console.
`,

  'message_boards/002-bug.md': `# Bug Report 002: Coolify deployment callback URL

Ensure callback URLs route to /api/internal/ci/callback with correct runner authorization.
`
};

// ─── Generic Default Files for Any Repo ─────────────────────────
function getDefaultRepoFiles(repoName: string): Record<string, string> {
  return {
    'README.md': `# ${repoName}

Repository hosted on **GitFlare** — GitHub on Cloudflare Workers edge.

## Getting Started

\`\`\`bash
# Clone repository
git clone https://git.beenex.company/git/${repoName}.git

# Add remote to existing repository
git remote add gitflare https://git.beenex.company/git/${repoName}.git
git push gitflare main
\`\`\`

## CI/CD Pipeline
Configured via \`.gitflare/ci.yml\` to automatically test and deploy on every push.
`,
    '.gitignore': `node_modules/
dist/
.wrangler/
.env
*.log
`,
    '.gitflare/ci.yml': `# GitFlare CI/CD Pipeline for ${repoName}
name: Build & Deploy

on:
  push:
    branches: [main]
  manual: true

jobs:
  test:
    name: Test
    sandbox: standard-1
    steps:
      - name: Checkout code
        run: echo "Checking out repository code"
      - name: Run checks
        run: echo "All test checks passed successfully"

  deploy:
    name: Deploy
    needs: [test]
    deploy:
      target: coolify
      branch_filter: [main]
    steps:
      - name: Trigger deployment
        run: echo "Deploying ${repoName} to production"
`
  };
}

// ─── API Implementation Functions ───────────────────────────────

export function getBranches(repoName: string): { name: string; is_default: boolean; commit_sha: string }[] {
  const commits = getRepoCommits(repoName);
  const headSha = commits[0]?.sha || 'HEAD';
  return [
    { name: 'main', is_default: true, commit_sha: headSha },
    { name: 'dev', is_default: false, commit_sha: commits[1]?.sha || headSha }
  ];
}

export function getRepoCommits(repoName: string): CommitSummary[] {
  if (repoName.toLowerCase() === 'starship') {
    return STARSHIP_COMMITS;
  }

  // Fallback / dynamic repos
  return [
    {
      sha: 'a1b2c3d4e5f678901234567890abcdef12345678',
      short_sha: 'a1b2c3d',
      message: `Initial commit for ${repoName}`,
      description: 'Repository initialized with README and .gitflare CI configuration.',
      author: {
        name: 'GitFlare Admin',
        email: 'admin@gitflare.dev',
        avatar: 'GF'
      },
      date: new Date().toISOString(),
      time_ago: 'just now',
      ci_status: 'passed',
      ci_run_id: null,
      stats: {
        additions: 42,
        deletions: 0,
        total: 42,
        files_changed: 3
      }
    }
  ];
}

export function getCommitDetail(repoName: string, sha: string): CommitDetail | null {
  const commits = repoName.toLowerCase() === 'starship' ? STARSHIP_COMMITS : [];
  const found = commits.find(c => c.sha.startsWith(sha.toLowerCase()) || c.short_sha === sha.toLowerCase());
  if (found) return found;

  // Fallback commit detail
  return {
    sha: sha.padEnd(40, '0'),
    short_sha: sha.slice(0, 7),
    message: `Commit ${sha.slice(0, 7)}`,
    author: { name: 'GitFlare User', email: 'user@gitflare.dev', avatar: 'GU' },
    date: new Date().toISOString(),
    time_ago: 'recently',
    ci_status: 'passed',
    ci_run_id: null,
    parent_sha: null,
    parent_short_sha: null,
    stats: { additions: 10, deletions: 2, total: 12, files_changed: 1 },
    files: [
      {
        filename: 'README.md',
        status: 'modified',
        additions: 10,
        deletions: 2,
        patch: `@@ -1,4 +1,12 @@\n-# ${repoName}\n+# ${repoName}\n+Updated configuration and build steps.`
      }
    ]
  };
}

export function getRepoTree(repoName: string, subPath: string = '', ref: string = 'main'): TreeResult {
  const cleanPath = subPath.replace(/^\/+|\/+$/g, '');
  const filesMap = repoName.toLowerCase() === 'starship' ? STARSHIP_FILES : getDefaultRepoFiles(repoName);
  const commits = getRepoCommits(repoName);
  const latestCommit = commits[0] || {
    sha: '240fb22df4c1e4bc37907895580f2d1cb7e6ca9b',
    short_sha: '240fb22',
    message: 'Latest updates',
    author: { name: 'Thomas Nguyen', email: 'tungvunguyennguyen@gmail.com', avatar: 'TN' },
    date: '2026-10-02T23:07:34-04:00',
    time_ago: '3 hours ago'
  };

  // Breadcrumbs
  const breadcrumbs: Breadcrumb[] = [{ name: repoName, path: '' }];
  if (cleanPath) {
    const parts = cleanPath.split('/');
    let accum = '';
    for (const part of parts) {
      accum = accum ? `${accum}/${part}` : part;
      breadcrumbs.push({ name: part, path: accum });
    }
  }

  // Find all entries directly in this directory
  const entriesMap = new Map<string, TreeEntry>();
  const prefix = cleanPath ? `${cleanPath}/` : '';

  for (const [filePath, content] of Object.entries(filesMap)) {
    if (!filePath.startsWith(prefix) && prefix) continue;

    const remaining = prefix ? filePath.slice(prefix.length) : filePath;
    const parts = remaining.split('/');
    const entryName = parts[0];
    const isDir = parts.length > 1;

    if (!entriesMap.has(entryName)) {
      const fullEntryPath = cleanPath ? `${cleanPath}/${entryName}` : entryName;
      if (isDir) {
        entriesMap.set(entryName, {
          name: entryName,
          type: 'tree',
          path: fullEntryPath,
          message: 'Update ' + entryName,
          updated_at: '3 hours ago'
        });
      } else {
        entriesMap.set(entryName, {
          name: entryName,
          type: 'blob',
          path: fullEntryPath,
          size: content.length,
          message: latestCommit.message,
          updated_at: latestCommit.time_ago
        });
      }
    }
  }

  // Sort: directories first, then files alphabetically
  const entries = Array.from(entriesMap.values()).sort((a, b) => {
    if (a.type === 'tree' && b.type === 'blob') return -1;
    if (a.type === 'blob' && b.type === 'tree') return 1;
    return a.name.localeCompare(b.name);
  });

  // Check for README in this directory
  let readme = null;
  const readmeCandidate = cleanPath ? `${cleanPath}/README.md` : 'README.md';
  const agentsCandidate = cleanPath ? `${cleanPath}/AGENTS.md` : 'AGENTS.md';

  if (filesMap[readmeCandidate]) {
    readme = { name: 'README.md', content: filesMap[readmeCandidate] };
  } else if (filesMap[agentsCandidate]) {
    readme = { name: 'AGENTS.md', content: filesMap[agentsCandidate] };
  }

  return {
    repo: repoName,
    ref,
    path: cleanPath,
    breadcrumbs,
    latest_commit: {
      sha: latestCommit.sha,
      short_sha: latestCommit.short_sha,
      message: latestCommit.message,
      author: latestCommit.author,
      date: latestCommit.date,
      time_ago: latestCommit.time_ago
    },
    entries,
    readme
  };
}

export function getRepoBlob(repoName: string, filePath: string, ref: string = 'main'): BlobResult | null {
  const cleanPath = filePath.replace(/^\/+/, '');
  const filesMap = repoName.toLowerCase() === 'starship' ? STARSHIP_FILES : getDefaultRepoFiles(repoName);
  const content = filesMap[cleanPath];

  if (content === undefined) return null;

  const commits = getRepoCommits(repoName);
  const latestCommit = commits[0];

  const lines = content.split('\n').length;
  const fileName = cleanPath.split('/').pop() || cleanPath;

  return {
    repo: repoName,
    ref,
    path: cleanPath,
    name: fileName,
    size: content.length,
    lines,
    content,
    is_binary: false,
    latest_commit: {
      sha: latestCommit.sha,
      short_sha: latestCommit.short_sha,
      message: latestCommit.message,
      author: latestCommit.author,
      date: latestCommit.date
    }
  };
}
