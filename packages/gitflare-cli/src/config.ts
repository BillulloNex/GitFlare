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

export function loadConfig(): Config | null {
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(data) as Config;
    }
  } catch (err) {
    // Ignore read errors
  }
  return null;
}

export function saveConfig(config: Config): void {
  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err: any) {
    console.error(chalk.red(`Failed to save config: ${err.message}`));
  }
}

export function getClient(): GitFlareClient {
  const envUrl = process.env.GITFLARE_URL;
  const envKey = process.env.GITFLARE_API_KEY;

  const config = loadConfig();

  const url = envUrl || config?.url;
  const apiKey = envKey || config?.apiKey;

  if (!url || !apiKey) {
    console.error(chalk.red('Error: GitFlare URL or API Key not found.'));
    console.error(chalk.yellow('Please set GITFLARE_URL and GITFLARE_API_KEY environment variables,'));
    console.error(chalk.yellow('or run `gitflare auth login` to configure them.'));
    process.exit(1);
  }

  return new GitFlareClient({ baseUrl: url, apiKey });
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
