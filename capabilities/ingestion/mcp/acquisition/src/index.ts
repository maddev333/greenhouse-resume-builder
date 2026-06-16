/**
 * Acquisition MCP server — Functions entry point (IL5-authorized compute).
 * Registers a single POST /api/mcp/acquisition Streamable HTTP endpoint at import time.
 */
import { registerMcpServer } from '@greenhouse-resume-builder/mcp-core';
import { acquisitionTools } from './tools';

registerMcpServer(
  { name: 'acquisition', version: '0.1.0', tools: acquisitionTools },
  { functionName: 'AcquisitionMcp', route: 'mcp/acquisition' },
);

export {};
