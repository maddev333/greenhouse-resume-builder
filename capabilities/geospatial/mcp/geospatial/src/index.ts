/**
 * Geospatial MCP server — Functions entry point (IL5-authorized compute).
 * Registers a single POST /api/mcp/geospatial Streamable HTTP endpoint at import time.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { registerMcpServer } from '@greenhouse-resume-builder/mcp-core';
import { geospatialTools } from './tools';

// Local-dev convenience: hydrate process.env from the nearest .env up the tree (the repo root),
// so AZURE_MAPS_KEY set there reaches this standalone Functions app for geocoding. A no-op in
// deployment, where app settings / managed identity supply configuration.
(function loadNearestEnv() {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const envPath = resolve(dir, '.env');
    if (existsSync(envPath)) {
      loadDotenv({ path: envPath });
      loadDotenv({ path: resolve(dir, '.env.local') });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
})();

registerMcpServer(
  { name: 'geospatial', version: '0.1.0', tools: geospatialTools },
  { functionName: 'GeospatialMcp', route: 'mcp/geospatial' },
);

export {};
