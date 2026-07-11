/**
 * Entry point. Two transports:
 *   - Streamable HTTP (default): stateless, one server per request, caller claims read from request
 *     headers (x-demo-persona / x-tenant-id / x-user-*). This is what the chat host + basic-host use.
 *   - stdio (`--stdio`): single server, caller claims from env/default persona.
 *
 * Run locally: `npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements`
 */

import './load-env.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import { createServer } from './server.js';
import { resolveSecurityContext, type HeaderBag } from './context.js';

const PORT = parseInt(process.env.ENGAGEMENTS_MCP_PORT ?? process.env.PORT ?? '3010', 10);

async function startHttp(): Promise<void> {
  const app = createMcpExpressApp({ host: '0.0.0.0' });
  // The chat UI / MCP Apps host loads from a different origin — allow the demo headers through.
  app.use(
    cors({
      exposedHeaders: ['mcp-session-id'],
      allowedHeaders: ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'x-demo-persona', 'x-tenant-id', 'x-user-id', 'x-user-groups', 'x-user-roles', 'x-user-scopes'],
    }),
  );

  app.all('/mcp', async (req, res) => {
    // Fresh server + caller context per request (stateless). Claims come from THIS request's headers.
    const server = createServer(() => resolveSecurityContext(req.headers as HeaderBag));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP error:', error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  const httpServer = app.listen(PORT, () => {
    console.log(`Engagements MCP server listening on http://localhost:${PORT}/mcp`);
    console.log(`  default caller: set header 'x-demo-persona: EA_G8' (or EA_BASIC/ADMIN/CROSS_TENANT/NO_TENANT) to switch the security trim.`);
  });

  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function startStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

async function main(): Promise<void> {
  if (process.argv.includes('--stdio')) {
    await startStdio();
  } else {
    await startHttp();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
