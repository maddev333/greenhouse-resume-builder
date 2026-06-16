/**
 * Graph/Relationships MCP server — Functions entry point (IL5-authorized compute).
 * Registers a single POST /api/mcp/relationships Streamable HTTP endpoint at import time.
 */
import { registerMcpServer } from '@greenhouse-resume-builder/mcp-core';
import { relationshipsTools } from './tools';

registerMcpServer(
  { name: 'relationships', version: '0.1.0', tools: relationshipsTools },
  { functionName: 'RelationshipsMcp', route: 'mcp/relationships' },
);

export {};
