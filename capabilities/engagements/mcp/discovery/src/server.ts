/**
 * Server factory — assembles an `McpServer` with the discovery tools registered. Stateless, and
 * (unlike the engagements capability) context-free: there is no security trim to drive, because the
 * only data this server returns is public Azure Maps POI data.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDiscoveryTools } from "./tools.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "Area Discovery",
    version: "0.1.0",
  });
  registerDiscoveryTools(server);
  return server;
}
