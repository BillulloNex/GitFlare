import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GitFlareClient } from '@gitflare/client';
import chalk from 'chalk';

export interface Config {
  url: string;
  apiKey: string;
}

const configDir = path.join(os.homedir(), '.config', 'gitflare');
const configPath = path.join(configDir, 'config.json');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * The config file holds an API key: keep the directory owner-only (0700) and
 * the file owner read/write (0600). Also tightens files written by older
 * versions, which used the default umask (typically 0755 / 0644).
 */
function tightenPermissions(): void {
  if (process.platform === 'win32') return; // POSIX modes don't apply
  try {
    if (fs.existsSync(configDir) && (fs.statSync(configDir).mode & 0o777) !== DIR_MODE) {
      fs.chmodSync(configDir, DIR_MODE);
    }
    if (fs.existsSync(configPath) && (fs.statSync(configPath).mode & 0o777) !== FILE_MODE) {
      fs.chmodSync(configPath, FILE_MODE);
    }
  } catch (err: any) {
    console.error(chalk.yellow(`Warning: could not restrict permissions on ${configDir}: ${err.message}`));
  }
}

export function loadConfig(): Config | null {
  try {
    if (fs.existsSync(configPath)) {
      tightenPermissions();
      const data = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(data) as Config;
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(configDir, { recursive: true, mode: DIR_MODE });
  // `mode` only applies when the file is created; tightenPermissions() covers existing files.
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: FILE_MODE });
  tightenPermissions();
}

export function getConfigOrEnv(): Config | null {
  const envUrl = process.env.GITFLARE_URL;
  const envKey = process.env.GITFLARE_API_KEY;
  const config = loadConfig();

  const url = envUrl || config?.url;
  const apiKey = envKey || config?.apiKey;

  if (url && apiKey) {
    return { url, apiKey };
  }
  return null;
}

export function getClient(): GitFlareClient {
  const config = getConfigOrEnv();
  if (!config) {
    console.error(chalk.red('Error: GitFlare URL or API Key not found.'));
    console.error(chalk.yellow('Please set GITFLARE_URL and GITFLARE_API_KEY environment variables,'));
    console.error(chalk.yellow('or run `gitflare auth login` to configure them.'));
    process.exit(1);
  }

  return new GitFlareClient({ baseUrl: config.url, apiKey: config.apiKey });
}
