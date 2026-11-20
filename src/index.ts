#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHostGovernorServer } from './adapters/mcp-server.js';

async function run() {
  const server = createHostGovernorServer();
  const transport = new StdioServerTransport();

  // Strict stdio hygiene: reserve stdout exclusively for JSON-RPC frames
  await server.connect(transport);
  console.error('[host-governor] MCP Server v2.0 running over stdio transport.');
}

run().catch((err) => {
  console.error('[host-governor] Fatal server initialization error:', err);
  process.exit(1);
});
