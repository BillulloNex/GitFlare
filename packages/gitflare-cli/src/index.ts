import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
import { loadConfig, saveConfig, getClient, getConfigOrEnv } from './config.js';
import { GitFlareError } from '@gitflare/client';

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

// --- Auth Commands ---
const auth = program.command('auth').description('Manage authentication');

auth.command('login')
  .description('Login to a GitFlare instance')
  .action(async () => {
    try {
      const url = await prompt('GitFlare URL (e.g., https://git.beenex.company): ');
      if (!url) {
        console.error(chalk.red('URL is required'));
        return;
      }
      const apiKey = await prompt('API Key: ');
      if (!apiKey) {
        console.error(chalk.red('API Key is required'));
        return;
      }

      saveConfig({ url, apiKey });
      console.log(chalk.cyan('Config saved, verifying connection...'));

      const client = getClient();
      const health = await client.health();
      console.log(chalk.green(`Successfully authenticated! GitFlare v${health.version}`));
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
      const health = await client.health();
      console.log(chalk.green(`Connection verified: GitFlare v${health.version}`));
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
      const { repos } = await client.repos.list();
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
  .option('-p, --private', 'Make repository private', false)
  .action(async (name: string, options: { description?: string; private: boolean }) => {
    try {
      const client = getClient();
      const result = await client.repos.create({
        name,
        description: options.description,
        is_private: options.private,
      });
      console.log(chalk.green(`✓ Repository "${result.name}" created (ID: ${result.id})`));
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
      const { keys } = await client.keys.list();
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
      console.log(chalk.green(`✓ Key "${result.name}" created!`));
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
      const { runs } = await client.ci.runs(repoName);
      if (runs.length === 0) {
        console.log(chalk.yellow('No CI runs found.'));
        return;
      }
      console.table(runs.map(r => ({
        ID: r.id.substring(0, 8) + '...',
        Status: r.status,
        Branch: r.branch,
        Commit: r.commit_sha.substring(0, 7),
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
  .option('-b, --branch <branch>', 'Branch to trigger on', 'main')
  .action(async (repoName: string, options: { branch: string }) => {
    try {
      const client = getClient();
      const result = await client.ci.trigger(repoName, { branch: options.branch });
      console.log(chalk.green(`✓ CI run triggered (ID: ${result.run_id})`));
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
      const { run, jobs } = await client.ci.status(repoName, runId);
      console.log(chalk.cyan(`Run ID:  ${run.id}`));
      console.log(chalk.cyan(`Status:  ${run.status}`));
      console.log(chalk.cyan(`Branch:  ${run.branch}`));
      console.log(chalk.cyan(`Commit:  ${run.commit_sha}`));
      if (jobs.length > 0) {
        console.log(chalk.cyan('\nJobs:'));
        console.table(jobs.map(j => ({
          ID: j.id.substring(0, 8) + '...',
          Name: j.name,
          Status: j.status,
          Exit: j.exit_code ?? '-',
        })));
      }
    } catch (err) {
      handleError(err);
    }
  });

ci.command('logs')
  .argument('<repo>', 'Repository name')
  .argument('<run-id>', 'CI run ID')
  .argument('<job-id>', 'Job ID')
  .description('Show CI job logs')
  .action(async (repoName: string, runId: string, jobId: string) => {
    try {
      const client = getClient();
      const { logs } = await client.ci.logs(repoName, runId, jobId);
      for (const log of logs) {
        console.log(chalk.cyan(`── ${log.step_name} (exit: ${log.exit_code}, ${log.duration_ms}ms) ──`));
        console.log(log.output);
      }
    } catch (err) {
      handleError(err);
    }
  });

// --- Files Commands ---
const files = program.command('files').description('Browse repository files');

files.command('tree')
  .argument('<repo>', 'Repository name')
  .argument('[ref]', 'Git reference', 'main')
  .argument('[path]', 'Path in the repo', '/')
  .description('Browse file tree')
  .action(async (repoName: string, ref: string, path: string) => {
    try {
      const client = getClient();
      const { entries } = await client.files.tree(repoName, ref, path);
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
  .option('--ref <ref>', 'Git reference', 'main')
  .action(async (repoName: string, path: string, options: { ref: string }) => {
    try {
      const client = getClient();
      const blob = await client.files.blob(repoName, options.ref, path);
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
      const { targets } = await client.deploys.list(repoName);
      if (targets.length === 0) {
        console.log(chalk.yellow('No deploy targets found.'));
        return;
      }
      console.table(targets.map(t => ({
        ID: t.id.substring(0, 8) + '...',
        Name: t.name,
        Type: t.type,
        Branches: t.branch_filter?.join(', ') || 'All',
      })));
    } catch (err) {
      handleError(err);
    }
  });

deploy.command('add')
  .argument('<repo>', 'Repository name')
  .description('Add a deploy target')
  .requiredOption('--name <name>', 'Target name')
  .requiredOption('--type <type>', 'Deploy type (coolify or cloudflare)')
  .option('--app-id <id>', 'Coolify app ID')
  .option('--base-url <url>', 'Coolify base URL')
  .option('--branch-filter <branches>', 'Comma-separated list of branches')
  .action(async (repoName: string, options: any) => {
    try {
      const client = getClient();
      const result = await client.deploys.create(repoName, {
        name: options.name,
        type: options.type,
        coolify_app_id: options.appId,
        coolify_base_url: options.baseUrl,
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
  .option('--branch-filter <branches>', 'Comma-separated list of branches')
  .action(async (repoName: string, options: any) => {
    try {
      const client = getClient();
      const result = await client.mirrors.setup(repoName, {
        github_url: options.githubUrl,
        branch_filter: options.branchFilter?.split(',').map((b: string) => b.trim()),
      });
      console.log(chalk.green(`✓ Mirror for "${repoName}" set up (ID: ${result.id})`));
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
      await client.mirrors.sync(repoName);
      console.log(chalk.green(`✓ Mirror sync triggered for "${repoName}".`));
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
      const cloneUrl = client.gitRemoteUrl(repoName);
      // Embed credentials in URL for git clone
      const url = new URL(cloneUrl);
      url.username = 'x-api-key';
      url.password = config.apiKey;

      const args = ['clone', url.toString()];
      if (directory) args.push(directory);

      console.log(chalk.cyan(`Cloning ${repoName}...`));

      const child = spawn('git', args, { stdio: 'inherit' });
      child.on('close', (code) => {
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
