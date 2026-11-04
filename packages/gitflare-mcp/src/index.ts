import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GitFlareClient } from '@gitflare/client';
import { createServer } from './server.js';

const GITFLARE_URL = process.env.GITFLARE_URL;
const GITFLARE_API_KEY = process.env.GITFLARE_API_KEY;

async function main() {
  if (!GITFLARE_URL) {
    throw new Error('GITFLARE_URL environment variable is required (e.g. https://git.example.com)');
  }
  if (!GITFLARE_API_KEY) {
    throw new Error('GITFLARE_API_KEY environment variable is required');
  }
  const server = createServer(new GitFlareClient({ baseUrl: GITFLARE_URL, apiKey: GITFLARE_API_KEY }));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('GitFlare MCP server running on stdio');
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
