/**
 * Discovery (search) MCP server — Functions entry point (IL5-authorized compute).
 * Registers a single POST /api/mcp/search Streamable HTTP endpoint at import time.
 */
import { registerMcpServer } from '@greenhouse-resume-builder/mcp-core';
import { searchTools } from './tools';

registerMcpServer(
  { name: 'search', version: '0.1.0', tools: searchTools },
  { functionName: 'SearchMcp', route: 'mcp/search' },
);

export {};
