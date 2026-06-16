/**
 * Quality/Citations MCP server — Functions entry point (IL5-authorized compute).
 * Registers a single POST /api/mcp/quality Streamable HTTP endpoint at import time.
 */
import { registerMcpServer } from '@greenhouse-resume-builder/mcp-core';
import { qualityTools } from './tools';

registerMcpServer(
  { name: 'quality', version: '0.1.0', tools: qualityTools },
  { functionName: 'QualityMcp', route: 'mcp/quality' },
);

export {};
