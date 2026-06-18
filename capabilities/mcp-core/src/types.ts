/**
 * Shared types for the IL5 capability-module framework.
 */
import type { InvocationContext } from '@azure/functions';

/** A JSON-Schema object describing a tool's input (kept identical to the strict-JSON agent contracts). */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [k: string]: unknown;
}

/** Per-call context propagated through MCP tool handlers (tenantId/provenance for IL5 doc-level security). */
export interface ToolCallContext {
  tenantId?: string;
  /** Verified caller subject (Entra `oid`/`sub`), when the gateway propagates it. */
  userId?: string;
  /** Verified Entra app roles (`roles` claim) — RBAC / attribute-level authorization. */
  roles?: string[];
  /** Verified Entra security-group object IDs (`groups` claim) — need-to-know filtering. */
  groups?: string[];
  /** Verified Entra delegated scopes (`scp` claim) — gate operations / sensitive attributes. */
  scopes?: string[];
  traceId?: string;
  /** The raw Azure Functions invocation context (logging, etc.). */
  invocation?: InvocationContext;
}

/** MCP tool content block (text only in the skeleton). */
export interface ToolContent {
  type: 'text';
  text: string;
}

/** Result of a tool call. `structuredContent` mirrors the strict-JSON contract for programmatic callers. */
export interface ToolResult {
  content: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** A single MCP tool definition. */
export interface McpTool<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: TArgs, ctx: ToolCallContext) => Promise<ToolResult> | ToolResult;
}

/** An MCP server definition: a named, versioned set of tools. */
export interface McpServerDef {
  name: string;
  version: string;
  tools: McpTool[];
}
