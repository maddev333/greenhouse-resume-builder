/**
 * Server factory — assembles an `McpServer` with the engagement tools registered against a
 * per-request context provider. Stateless: `main.ts` creates a fresh server (and fresh caller
 * context) per HTTP request, matching the Streamable-HTTP stateless transport.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEngagementTools } from './tools.js';
import { resolveSecurityContext, type ResolvedContext } from './context.js';

/**
 * @param getContext resolves the caller's verified claims for THIS request/session. Defaults to the
 *   env/default persona (used by the stdio transport and tests, which carry no HTTP headers).
 */
export function createServer(getContext: () => ResolvedContext = () => resolveSecurityContext()): McpServer {
  const server = new McpServer({
    name: 'Engagements Travel Planner',
    version: '0.1.0',
  });
  registerEngagementTools(server, getContext);
  return server;
}
