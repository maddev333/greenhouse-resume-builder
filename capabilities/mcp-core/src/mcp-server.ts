/**
 * Minimal MCP server over Streamable HTTP, hosted on Azure Functions (IL5-authorized compute).
 *
 * This is a dependency-light skeleton implementing the core JSON-RPC methods an MCP
 * client needs (initialize, tools/list, tools/call, ping). Swap in the official
 * @modelcontextprotocol/sdk transport when you need the full protocol surface; the
 * tool definitions (McpTool[]) carry over unchanged.
 *
 * Security: registered at authLevel 'anonymous' because in IL5 the server sits behind
 * API Management + Entra ID OAuth on a Private Link/VNet boundary. `verifyBearer`
 * provides an optional in-process check for local testing (MCP_REQUIRE_BEARER=true).
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { McpServerDef, McpTool, ToolCallContext, ToolResult } from './types';

const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

function ok(id: any, result: unknown): HttpResponseInit {
  return { status: 200, jsonBody: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: any, code: number, message: string): HttpResponseInit {
  return { status: 200, jsonBody: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolDescriptor(t: McpTool) {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema };
}

async function handleRpc(
  server: McpServerDef,
  body: JsonRpcRequest,
  ctx: ToolCallContext,
): Promise<HttpResponseInit | null> {
  const { id, method, params } = body;
  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: server.version },
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: server.tools.map(toolDescriptor) });
    case 'tools/call': {
      const name = params?.name;
      const tool = server.tools.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await tool.handler(params?.arguments ?? {}, ctx);
        return ok(id, result);
      } catch (err: any) {
        const result: ToolResult = {
          content: [{ type: 'text', text: `Tool ${name} failed: ${err?.message || err}` }],
          isError: true,
        };
        return ok(id, result);
      }
    }
    default:
      // Notifications (method starting with notifications/) and id-less calls need no response.
      if (method?.startsWith('notifications/') || id === undefined || id === null) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Optional, very small bearer presence check for local testing (APIM/Entra enforce in IL5). */
function verifyBearer(request: HttpRequest): boolean {
  if ((process.env.MCP_REQUIRE_BEARER || 'false').toLowerCase() !== 'true') return true;
  const auth = request.headers.get('authorization') || '';
  return /^Bearer\s+.+/i.test(auth);
}

/**
 * Register an MCP capability server as a single POST {route} Azure Function.
 * Call at import time (Functions v4 model).
 */
export function registerMcpServer(server: McpServerDef, opts: { functionName: string; route?: string }): void {
  const route = opts.route || `mcp/${server.name}`;
  app.http(opts.functionName, {
    route,
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
      if (!verifyBearer(request)) return rpcError(null, -32001, 'Unauthorized');
      let body: JsonRpcRequest;
      try {
        body = (await request.json()) as JsonRpcRequest;
      } catch {
        return rpcError(null, -32700, 'Parse error');
      }
      const ctx: ToolCallContext = {
        tenantId: request.headers.get('x-tenant-id') || undefined,
        traceId: request.headers.get('x-trace-id') || undefined,
        invocation: context,
      };
      const res = await handleRpc(server, body, ctx);
      // Notifications -> 202 Accepted with no body.
      return res ?? { status: 202 };
    },
  });
}

/** Convenience for building a typed tool with a JSON-schema input. */
export function defineTool<TArgs = Record<string, unknown>>(tool: McpTool<TArgs>): McpTool<TArgs> {
  return tool;
}

/** Build a text tool result, optionally attaching the strict-JSON structured payload. */
export function toolResult(text: string, structuredContent?: unknown): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent };
}
