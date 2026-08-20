#!/usr/bin/env node
/**
 * Dedicated MCP entry point, so MCP clients can be configured with a bare
 * command instead of a subcommand. Reads configuration from the environment.
 */
import { startMcpServer } from './mcp.mjs';

startMcpServer().catch((err) => {
  process.stderr.write(`agent-browser-mcp: ${err.message}\n`);
  process.exit(1);
});
