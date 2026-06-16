/**
 * Geospatial MCP server — Functions entry point (IL5-authorized compute).
 * Registers a single POST /api/mcp/geospatial Streamable HTTP endpoint at import time.
 */
import { registerMcpServer } from '@greenhouse-resume-builder/mcp-core';
import { geospatialTools } from './tools';

registerMcpServer(
  { name: 'geospatial', version: '0.1.0', tools: geospatialTools },
  { functionName: 'GeospatialMcp', route: 'mcp/geospatial' },
);

export {};
