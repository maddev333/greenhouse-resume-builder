/**
 * Temporal Intelligence MCP server — Functions entry point (IL5-authorized compute).
 * Registers a single POST /api/mcp/temporal Streamable HTTP endpoint at import time.
 */
import { registerMcpServer } from '@greenhouse-resume-builder/mcp-core';
import { temporalTools } from './tools';

registerMcpServer(
  { name: 'temporal', version: '0.1.0', tools: temporalTools },
  { functionName: 'TemporalMcp', route: 'mcp/temporal' },
);

export {};
