import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { saveConfig, getClient, getConfigOrEnv } from './config.js';
import { GitFlareClient, GitFlareError, type DeployTarget } from '@gitflare/client';

const program = new Command();

program
  .name('gitflare')
  .description('CLI for GitFlare - GitHub on Cloudflare')
  .version('1.0.0');

// --- Helper Functions ---
function handleError(err: unknown) {
  if (err instanceof GitFlareError) {
    console.error(chalk.red(`GitFlare API Error: ${err.message} (Status: ${err.status})`));
  } else {
    console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
  }
  process.exit(1);
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

function formatBranchFilter(target: DeployTarget): string {
  if (!target.branch_filter) return 'All';
  try {
    const patterns = JSON.parse(target.branch_filter);
    return Array.isArray(patterns) && patterns.length ? patterns.join(', ') : 'All';
  } catch {
    return target.branch_filter;
  }
}

/**
 * Write a throwaway GIT_ASKPASS helper that prints the key from the
 * GITFLARE_ASKPASS_TOKEN env var (the key itself is never written to disk).
 * The directory is created 0700 by mkdtemp.
 */
function createAskPass(): { script: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitflare-askpass-'));
  const isWindows = process.platform === 'win32';
  const script = path.join(dir, isWindows ? 'askpass.cmd' : 'askpass.sh');
  const content = isWindows
    ? '@echo off\r\necho %GITFLARE_ASKPASS_TOKEN%\r\n'
    : '#!/bin/sh\nprintf \'%s\\n\' "$GITFLARE_ASKPASS_TOKEN"\n';
  fs.writeFileSync(script, content, { mode: 0o700 });
  return { script, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// --- Auth Commands ---
const auth = program.command('auth').description('Manage authentication');

auth.command('login')
  .description('Login to a GitFlare instance')
  .action(async () => {
    try {
      const url = await prompt('GitFlare URL (e.g., https://git.example.com): ');
      if (!url) {
        console.error(chalk.red('URL is required'));
        return;
      }
      const apiKey = await prompt('API Key: ');
      if (!apiKey) {
        console.error(chalk.red('API Key is required'));
        return;
      }

      console.log(chalk.cyan('Verifying credentials...'));
      const client = new GitFlareClient({ baseUrl: url, apiKey });
      // /health is public — verify against a protected endpoint before saving.
      await client.verifyAuth();
      const health = await client.health().catch(() => null);

      saveConfig({ url, apiKey });
      console.log(chalk.green(`Successfully authenticated!${health ? ` GitFlare v${health.version}` : ''}`));
    } catch (err) {
      handleError(err);
    }
  });

auth.command('whoami')
  .description('Show current configuration')
  .action(async () => {
    try {
      const config = getConfigOrEnv();
      if (!config) {
        console.log(chalk.yellow('Not logged in. Run `gitflare auth login` or set environment variables.'));
        return;
      }
      console.log(chalk.cyan(`URL: ${config.url}`));
      const prefix = config.apiKey.substring(0, 8);
      console.log(chalk.cyan(`API Key: ${prefix}${'*'.repeat(24)}`));

      const client = getClient();
      await client.verifyAuth();
      // Best effort: show this key's permission level. Non-admin keys only see
      // themselves; admins see all keys, so match on the key prefix.
      const keys = await client.keys.list().catch(() => []);
      const self = keys.filter(k => k.key_prefix === prefix);
      if (self.length === 1) {
        const k = self[0];
        console.log(chalk.cyan(`Key name: ${k.name}`));
        console.log(chalk.cyan(`Permissions: ${k.permissions}${k.repo_id ? ` (scoped to repo ${k.repo_id})` : ''}`));
      }
      console.log(chalk.green('Credentials verified.'));
    } catch (err) {
      handleError(err);
    }
  });

// --- Repo Commands ---
const repo = program.command('repo').description('Manage repositories');

repo.command('list')
  .description('List repositories')
  .action(async () => {
    try {
      const client = getClient();
      const repos = await client.repos.list();
      if (repos.length === 0) {
        console.log(chalk.yellow('No repositories found.'));
        return;
      }
      console.table(repos.map(r => ({
        Name: r.name,
        Description: r.description || '-',
        Branch: r.default_branch,
        Private: r.is_private ? 'Yes' : 'No',
        Created: r.created_at,
      })));
    } catch (err) {
      handleError(err);
    }
  });

repo.command('create')
  .argument('<name>', 'Repository name')
  .description('Create a new repository')
  .option('-d, --description <desc>', 'Repository description')
  .option('-p, --private', 'Make repository private (default)')
  .option('--public', 'Make repository public')
  .action(async (name: string, options: { description?: string; private?: boolean; public?: boolean }) => {
    try {
      if (options.private && options.public) {
        console.error(chalk.red('Use either --private or --public, not both.'));
        process.exit(1);
      }
      const client = getClient();
      const result = await client.repos.create({
        name,
        description: options.description,
        is_private: !options.public,
      });
      console.log(chalk.green(`✓ ${options.public ? 'Public' : 'Private'} repository "${result.name}" created (ID: ${result.id})`));
      console.log(chalk.cyan(`  Git remote: ${client.gitRemoteUrl(name)}`));
    } catch (err) {
      handleError(err);
    }
  });

repo.command('info')
  .argument('<name>', 'Repository name')
  .description('Show repository details')
  .action(async (name: string) => {
    try {
      const client = getClient();
      const r = await client.repos.get(name);
      console.log(chalk.cyan(`Name:           ${r.name}`));
      console.log(chalk.cyan(`ID:             ${r.id}`));
      console.log(chalk.cyan(`Description:    ${r.description || 'N/A'}`));
      console.log(chalk.cyan(`Default Branch: ${r.default_branch}`));
      console.log(chalk.cyan(`Private:        ${r.is_private ? 'Yes' : 'No'}`));
      console.log(chalk.cyan(`Created:        ${r.created_at}`));
      if (r.remote) {
        console.log(chalk.cyan(`Remote:         ${r.remote}`));
      }
    } catch (err) {
      handleError(err);
    }
  });

repo.command('delete')
  .argument('<name>', 'Repository name')
  .description('Delete a repository')
  .action(async (name: string) => {
    try {
      const answer = await prompt(chalk.yellow(`Are you sure you want to delete "${name}"? (y/N): `));
      if (answer.toLowerCase() !== 'y') {
        console.log('Aborted.');
        return;
      }
      const client = getClient();
      await client.repos.delete(name);
      console.log(chalk.green(`✓ Repository "${name}" deleted.`));
    } catch (err) {
      handleError(err);
    }
  });

// --- Key Commands ---
const key = program.command('key').description('Manage API keys');

key.command('list')
  .description('List API keys')
  .action(async () => {
    try {
      const client = getClient();
      const keys = await client.keys.list();
      if (keys.length === 0) {
        console.log(chalk.yellow('No keys found.'));
        return;
      }
      console.table(keys.map(k => ({
        ID: k.id.substring(0, 8) + '...',
        Name: k.name,
        Prefix: k.key_prefix,
        Permissions: k.permissions,
        Repo: k.repo_id ? k.repo_id.substring(0, 8) + '...' : 'Global',
        Created: k.created_at,
      })));
    } catch (err) {
      handleError(err);
    }
  });

key.command('create')
  .argument('<name>', 'Key name')
  .description('Create a new API key')
  .option('--permissions <level>', 'Permission level (read, write, admin)', 'read')
  .option('--repo <repo-id>', 'Restrict to specific repository ID')
  .option('--expires-in-days <n>', 'Expiration in days')
  .action(async (name: string, options: { permissions: string; repo?: string; expiresInDays?: string }) => {
    try {
      const client = getClient();
      const result = await client.keys.create({
        name,
        permissions: options.permissions as 'read' | 'write' | 'admin',
        repo_id: options.repo,
        expires_in_days: options.expiresInDays ? parseInt(options.expiresInDays, 10) : undefined,
      });
      console.log(chalk.green(`✓ Key "${name}" created (${result.permissions})!`));
      console.log(chalk.yellow('\n⚠️  Save this key now — it will NOT be shown again:\n'));
      console.log(chalk.bgBlack.white(`  ${result.key}  `));
      console.log('');
    } catch (err) {
      handleError(err);
    }
  });

key.command('revoke')
  .argument('<id>', 'Key ID to revoke')
  .description('Revoke an API key')
  .action(async (id: string) => {
    try {
      const client = getClient();
      await client.keys.revoke(id);
      console.log(chalk.green(`✓ Key ${id} revoked.`));
    } catch (err) {
      handleError(err);
    }
  });

// --- CI Commands ---
const ci = program.command('ci').description('Manage CI runs');

ci.command('runs')
  .argument('<repo>', 'Repository name')
  .description('List CI runs for a repository')
  .action(async (repoName: string) => {
    try {
      const client = getClient();
      const runs = await client.ci.runs(repoName);
      if (runs.length === 0) {
        console.log(chalk.yellow('No CI runs found.'));
        return;
      }
      console.table(runs.map(r => ({
        ID: r.id.substring(0, 8) + '...',
        Status: r.status,
        Branch: r.branch,
        Commit: r.short_sha,
        Message: r.commit_message,
        Trigger: r.trigger,
        Created: r.created_at,
      })));
    } catch (err) {
      handleError(err);
    }
  });

ci.command('trigger')
  .argument('<repo>', 'Repository name')
  .description('Trigger a CI run')
  .option('-b, --branch <branch>', "Branch to trigger on (default: the repo's default branch)")
  .option('--commit <sha>', 'Commit SHA (default: branch tip)')
  .action(async (repoName: string, options: { branch?: string; commit?: string }) => {
    try {
      const client = getClient();
      const result = await client.ci.trigger(repoName, { branch: options.branch, commit_sha: options.commit });
      console.log(chalk.green(`✓ CI run triggered on ${result.branch} (ID: ${result.id})`));
    } catch (err) {
      handleError(err);
    }
  });

ci.command('status')
  .argument('<repo>', 'Repository name')
  .argument('<run-id>', 'CI run ID')
  .description('Show CI run status')
  .action(async (repoName: string, runId: string) => {
    try {
      const client = getClient();
      const run = await client.ci.status(repoName, runId);
      console.log(chalk.cyan(`Run ID:   ${run.id}`));
      console.log(chalk.cyan(`Status:   ${run.status}`));
      console.log(chalk.cyan(`Branch:   ${run.branch}`));
      console.log(chalk.cyan(`Commit:   ${run.short_sha} ${run.commit_message}`));
      console.log(chalk.cyan(`Duration: ${run.duration_text}`));
      for (const job of run.jobs) {
        console.log(chalk.cyan(`\nJob ${job.name} — ${job.status} (${job.duration})`));
        console.table(job.steps.map(s => ({
          Name: s.name,
          Status: s.status,
          Exit: s.exit_code ?? '-',
          Duration: s.duration,
        })));
      }
    } catch (err) {
      handleError(err);
    }
  });

ci.command('logs')
  .argument('<repo>', 'Repository name')
  .argument('<run-id>', 'CI run ID')
  .argument('[step-index]', 'Show the full log of this step (default: last lines of every step)')
  .description('Show CI logs')
  .action(async (repoName: string, runId: string, stepIndex?: string) => {
    try {
      const client = getClient();
      const printLine = (l: { stream: string; line: string }) =>
        console.log(l.stream === 'stderr' ? chalk.red(l.line) : l.line);

      if (stepIndex !== undefined) {
        const index = Number(stepIndex);
        if (!Number.isInteger(index) || index < 0) {
          console.error(chalk.red('step-index must be a non-negative integer'));
          process.exit(1);
        }
        const log = await client.ci.stepLog(repoName, runId, index);
        console.log(chalk.cyan(`── [${log.step_index}] ${log.job_name} / ${log.name} (${log.status}) ──`));
        log.logs.forEach(printLine);
        if (!log.complete) console.log(chalk.yellow('(full log not available yet — showing the stored tail)'));
        return;
      }

      const steps = await client.ci.logs(repoName, runId);
      if (steps.length === 0) {
        console.log(chalk.yellow('No steps recorded for this run yet.'));
        return;
      }
      for (const step of steps) {
        console.log(chalk.cyan(`── [${step.index}] ${step.job_name} / ${step.name} (${step.status}${step.exit_code != null ? `, exit ${step.exit_code}` : ''}) ──`));
        step.logs.forEach(printLine);
      }
      console.log(chalk.gray(`\nShowing the last lines of each step. Full log: gitflare ci logs ${repoName} ${runId} <step-index>`));
    } catch (err) {
      handleError(err);
    }
  });

// --- Files Commands ---
const files = program.command('files').description('Browse repository files');

files.command('tree')
  .argument('<repo>', 'Repository name')
  .argument('[ref]', "Git reference (default: the repo's default branch)")
  .argument('[path]', 'Path in the repo', '')
  .description('Browse file tree')
  .action(async (repoName: string, ref: string | undefined, dirPath: string) => {
    try {
      const client = getClient();
      const { entries } = await client.files.tree(repoName, ref, dirPath);
      if (entries.length === 0) {
        console.log(chalk.yellow('Directory is empty.'));
        return;
      }
      console.table(entries.map(e => ({
        Type: e.type === 'tree' ? '📁' : '📄',
        Name: e.name,
        Path: e.path,
        Size: e.size !== undefined ? e.size : '-',
      })));
    } catch (err) {
      handleError(err);
    }
  });

files.command('cat')
  .argument('<repo>', 'Repository name')
  .argument('<path>', 'File path')
  .description('Read file content')
  .option('--ref <ref>', "Git reference (default: the repo's default branch)")
  .action(async (repoName: string, filePath: string, options: { ref?: string }) => {
    try {
      const client = getClient();
      const blob = await client.files.blob(repoName, options.ref, filePath);
      console.log(blob.content);
    } catch (err) {
      handleError(err);
    }
  });

// --- Deploy Commands ---
const deploy = program.command('deploy').description('Manage deployments');

deploy.command('list')
  .argument('<repo>', 'Repository name')
  .description('List deploy targets')
  .action(async (repoName: string) => {
    try {
      const client = getClient();
      const targets = await client.deploys.list(repoName);
      if (targets.length === 0) {
        console.log(chalk.yellow('No deploy targets found.'));
        return;
      }
      console.table(targets.map(t => ({
        ID: t.id.substring(0, 8) + '...',
        Name: t.name,
        Type: t.type,
        Target: t.type === 'cloudrun' ? `${t.gcp_project_id}/${t.gcp_region}/${t.gcp_service}` : t.type === 'coolify' ? t.coolify_app_id ?? '' : t.wrangler_config ?? 'wrangler.jsonc',
        Branches: formatBranchFilter(t),
      })));
    } catch (err) {
      handleError(err);
    }
  });

deploy.command('add')
  .argument('<repo>', 'Repository name')
  .description('Add a deploy target')
  .requiredOption('--name <name>', 'Target name')
  .requiredOption('--type <type>', 'Deploy type (coolify, cloudflare or cloudrun)')
  .option('--app-id <id>', 'Coolify app ID')
  .option('--base-url <url>', 'Coolify base URL')
  .option('--api-key <key>', 'Coolify API key')
  .option('--wrangler-config <path>', 'Cloudflare: wrangler config path')
  .option('--gcp-project <id>', 'Cloud Run: GCP project id')
  .option('--gcp-region <region>', 'Cloud Run: region, e.g. us-central1')
  .option('--gcp-service <name>', 'Cloud Run: service name')
  .option('--gcp-key-file <path>', 'Cloud Run: service-account JSON key file (omit to use the runner key)')
  .option('--branch-filter <branches>', 'Comma-separated list of branches')
  .action(async (repoName: string, options: any) => {
    try {
      const client = getClient();
      const gcpKey = options.gcpKeyFile ? fs.readFileSync(options.gcpKeyFile, 'utf8') : undefined;
      const result = await client.deploys.create(repoName, {
        name: options.name,
        type: options.type,
        coolify_app_id: options.appId,
        coolify_base_url: options.baseUrl,
        coolify_api_key: options.apiKey,
        wrangler_config: options.wranglerConfig,
        gcp_project_id: options.gcpProject,
        gcp_region: options.gcpRegion,
        gcp_service: options.gcpService,
        gcp_service_account_key: gcpKey,
        branch_filter: options.branchFilter?.split(',').map((b: string) => b.trim()),
      });
      console.log(chalk.green(`✓ Deploy target added (ID: ${result.id})`));
    } catch (err) {
      handleError(err);
    }
  });

// --- Mirror Commands ---
const mirror = program.command('mirror').description('Manage GitHub mirrors');

mirror.command('setup')
  .argument('<repo>', 'Repository name')
  .description('Set up GitHub mirror')
  .requiredOption('--github-url <url>', 'GitHub repository URL')
  .option('--github-token <token>', 'GitHub token with push access (default: $GITHUB_TOKEN)')
  .option('--branch-filter <branches>', 'Comma-separated list of branches')
  .action(async (repoName: string, options: { githubUrl: string; githubToken?: string; branchFilter?: string }) => {
    try {
      const githubToken = options.githubToken || process.env.GITHUB_TOKEN;
      if (!githubToken) {
        console.error(chalk.red('A GitHub token is required: pass --github-token or set GITHUB_TOKEN.'));
        process.exit(1);
      }
      const client = getClient();
      const result = await client.mirrors.setup(repoName, {
        github_url: options.githubUrl,
        github_token: githubToken,
        branch_filter: options.branchFilter?.split(',').map((b: string) => b.trim()).filter(Boolean),
      });
      console.log(chalk.green(`✓ ${result.message} for "${repoName}" → ${result.github_repo} (ID: ${result.id})`));
    } catch (err) {
      handleError(err);
    }
  });

mirror.command('sync')
  .argument('<repo>', 'Repository name')
  .description('Trigger mirror sync')
  .action(async (repoName: string) => {
    try {
      const client = getClient();
      const result = await client.mirrors.sync(repoName);
      const refs = Object.entries(result.refs);
      console.log(chalk.green(`✓ Mirror sync ${result.queued ? 'queued' : 'started'} for "${repoName}" (${refs.length} ref${refs.length === 1 ? '' : 's'}).`));
      for (const [ref, sha] of refs) console.log(chalk.cyan(`  ${sha.substring(0, 7)}  ${ref}`));
    } catch (err) {
      handleError(err);
    }
  });

// --- Clone Command ---
program.command('clone')
  .argument('<repo>', 'Repository name')
  .argument('[directory]', 'Target directory')
  .description('Clone a repository using GitFlare credentials')
  .action(async (repoName: string, directory?: string) => {
    try {
      const config = getConfigOrEnv();
      if (!config) {
        console.error(chalk.red('Not logged in. Run `gitflare auth login` or set env vars.'));
        process.exit(1);
      }

      const client = getClient();
      // Username only in the URL (git.ts ignores it); the API key is supplied
      // via GIT_ASKPASS so it never appears in argv, the remote URL, or .git/config.
      const url = new URL(client.gitRemoteUrl(repoName));
      url.username = 'x-api-key';

      // `-c credential.helper=` clears configured helpers for this command so
      // the key isn't persisted to the keychain / credential store.
      const args = ['-c', 'credential.helper=', 'clone', url.toString()];
      if (directory) args.push(directory);

      console.log(chalk.cyan(`Cloning ${repoName}...`));

      const askPass = createAskPass();
      const child = spawn('git', args, {
        stdio: 'inherit',
        env: {
          ...process.env,
          GIT_ASKPASS: askPass.script,
          GITFLARE_ASKPASS_TOKEN: config.apiKey,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      child.on('error', (err) => {
        askPass.cleanup();
        handleError(err);
      });
      child.on('close', (code) => {
        askPass.cleanup();
        if (code === 0) {
          console.log(chalk.green(`✓ Successfully cloned ${repoName}`));
        } else {
          console.error(chalk.red(`Git clone failed with code ${code}`));
          process.exit(code || 1);
        }
      });
    } catch (err) {
      handleError(err);
    }
  });

// --- Health Command ---
program.command('health')
  .description('Check GitFlare instance health')
  .action(async () => {
    try {
      const client = getClient();
      const health = await client.health();
      console.log(chalk.green('✓ System is healthy!'));
      console.log(chalk.cyan(`  Service: ${health.service}`));
      console.log(chalk.cyan(`  Status:  ${health.status}`));
      console.log(chalk.cyan(`  Version: ${health.version}`));
    } catch (err) {
      handleError(err);
    }
  });

program.parse();
