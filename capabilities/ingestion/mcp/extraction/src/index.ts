/**
 * Extraction MCP server — Functions entry point (IL5-authorized compute).
 * Registers a single POST /api/mcp/extraction Streamable HTTP endpoint at import time.
 */
import { registerMcpServer } from '@greenhouse-resume-builder/mcp-core';
import { extractionTools } from './tools';

registerMcpServer(
  { name: 'extraction', version: '0.1.0', tools: extractionTools },
  { functionName: 'ExtractionMcp', route: 'mcp/extraction' },
);

export {};
