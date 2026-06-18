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
 * Resolve CORS headers for a browser request. The MCP UI Apps call these servers directly when
 * running standalone (cross-origin: Vite dev server -> Functions host), so the server must answer
 * the preflight. In IL5 the gateway/APIM owns CORS; this is a dev/edge convenience controlled by
 * `MCP_CORS_ALLOWED_ORIGINS`:
 *   - unset -> reflect localhost/127.0.0.1 origins only (local-dev default)
 *   - '*'   -> reflect any origin
 *   - csv   -> reflect an origin only when it is in the comma-separated allow-list
 * Returns {} (no CORS headers) for non-browser requests or disallowed origins.
 */
function corsHeaders(request: HttpRequest): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  const configured = (process.env.MCP_CORS_ALLOWED_ORIGINS || '').trim();
  let allowed: boolean;
  if (configured === '*') {
    allowed = true;
  } else if (configured) {
    allowed = configured.split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
  } else {
    allowed = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  }
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      request.headers.get('access-control-request-headers') || 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
  };
}

/** Merge extra headers (e.g. CORS) into a response without dropping any it already carries. */
function withHeaders(res: HttpResponseInit, headers: Record<string, string>): HttpResponseInit {
  if (Object.keys(headers).length === 0) return res;
  const existing = (res.headers ?? {}) as Record<string, string>;
  return { ...res, headers: { ...existing, ...headers } };
}

/**
 * Register an MCP capability server as a single {route} Azure Function. Handles POST (JSON-RPC)
 * plus an OPTIONS CORS preflight for browser-based MCP UI Apps. Call at import time (Functions v4).
 */
export function registerMcpServer(server: McpServerDef, opts: { functionName: string; route?: string }): void {
  const route = opts.route || `mcp/${server.name}`;
  app.http(opts.functionName, {
    route,
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
      const cors = corsHeaders(request);
      // CORS preflight: answer before auth/body handling (preflight requests carry no credentials).
      if (request.method === 'OPTIONS') return { status: 204, headers: cors };
      if (!verifyBearer(request)) return withHeaders(rpcError(null, -32001, 'Unauthorized'), cors);
      let body: JsonRpcRequest;
      try {
        body = (await request.json()) as JsonRpcRequest;
      } catch {
        return withHeaders(rpcError(null, -32700, 'Parse error'), cors);
      }
      const ctx: ToolCallContext = {
        tenantId: request.headers.get('x-tenant-id') || undefined,
        traceId: request.headers.get('x-trace-id') || undefined,
        invocation: context,
      };
      const res = await handleRpc(server, body, ctx);
      // Notifications -> 202 Accepted with no body.
      return withHeaders(res ?? { status: 202 }, cors);
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
