/**
 * Server factory — assembles an `McpServer` with the engagement tools registered. Stateless:
 * `main.ts` creates a fresh server per HTTP request, matching the Streamable-HTTP stateless transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEngagementTools } from "./tools.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "Engagements Travel Planner",
    version: "0.1.0",
  });
  registerEngagementTools(server);
  return server;
}
