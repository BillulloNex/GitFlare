import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const server = createServer();

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('GitFlare MCP server running on stdio');
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
