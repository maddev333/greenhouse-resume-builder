/**
 * Self-hosted Azure OpenAI tool-calling loop — the "agent-framework" runtime each
 * capability ships. This is the IL5-compliant agent pattern (mvp_architecture.md 7.3):
 * app code owns the loop and Azure OpenAI provides reasoning + tool calling. The managed
 * Foundry Agent Service (IL2-only) is never used.
 *
 * The loop is transport-agnostic: you provide a `callTool(name, args)` function. Use
 * `mcpToolCaller(serverUrl)` to call a capability's MCP server over Streamable HTTP.
 */
import { getAoaiAuthHeaders, getEntraToken, getOboToken, isModelConfigured, isOboConfigured } from './identity';

export interface AgentTool {
  name: string;
  description: string;
  /** JSON schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface AgentLoopOptions {
  system: string;
  user: string;
  tools: AgentTool[];
  callTool: (name: string, args: any) => Promise<unknown>;
  maxIterations?: number;
  logger?: { info?: (...a: any[]) => void; warn?: (...a: any[]) => void };
  /**
   * Signed-in user's access token. When provided and OBO is configured, the Azure OpenAI
   * call runs On-Behalf-Of that user (no shared secret) instead of the app's own identity.
   */
  userAssertionToken?: string;
}

export interface AgentLoopResult {
  /** Final assistant text, or null when the model is unavailable (caller should use a deterministic fallback). */
  output: string | null;
  iterations: number;
  toolCalls: { name: string; args: unknown }[];
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
}

function aoaiUrl(): string {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT!.replace(/\/+$/, '');
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT!;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
  return `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${apiVersion}`;
}

/**
 * Run the tool-calling loop. Returns the final assistant message text (or null when the
 * model is not configured, so callers can fall back to deterministic behavior).
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const toolCalls: { name: string; args: unknown }[] = [];
  if (!isModelConfigured()) {
    opts.logger?.warn?.('[agent-loop] Azure OpenAI not configured; returning null (use heuristic fallback).');
    return { output: null, iterations: 0, toolCalls };
  }

  const maxIterations = opts.maxIterations ?? 6;
  const timeoutMs = Number(process.env.AZURE_OPENAI_TIMEOUT_MS || 30000);
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];
  const toolSpec = opts.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  for (let i = 1; i <= maxIterations; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let data: any;
    try {
      const resp = await fetch(aoaiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await getAoaiAuthHeaders(opts.userAssertionToken)) },
        body: JSON.stringify({
          messages,
          tools: toolSpec.length ? toolSpec : undefined,
          tool_choice: toolSpec.length ? 'auto' : undefined,
          temperature: 0,
          // GPT-4o and GPT-5-class deployments require max_completion_tokens; max_tokens is rejected.
          max_completion_tokens: 1800,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        opts.logger?.warn?.(`[agent-loop] HTTP ${resp.status}: ${text.slice(0, 300)}`);
        return { output: null, iterations: i, toolCalls };
      }
      data = await resp.json();
    } catch (err: any) {
      opts.logger?.warn?.(`[agent-loop] request failed: ${err?.message || err}`);
      return { output: null, iterations: i, toolCalls };
    } finally {
      clearTimeout(timer);
    }

    const msg = data?.choices?.[0]?.message;
    if (!msg) return { output: null, iterations: i, toolCalls };

    const calls = msg.tool_calls as any[] | undefined;
    if (calls && calls.length) {
      // Record the assistant turn that requested tools, then execute each tool.
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
      for (const call of calls) {
        let args: any = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          /* keep {} */
        }
        toolCalls.push({ name: call.function?.name, args });
        let toolOutput: unknown;
        try {
          toolOutput = await opts.callTool(call.function?.name, args);
        } catch (err: any) {
          toolOutput = { error: err?.message || String(err) };
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput),
        });
      }
      continue; // loop again so the model can use the tool results
    }

    // No tool calls -> final answer.
    return { output: msg.content ?? null, iterations: i, toolCalls };
  }

  opts.logger?.warn?.(`[agent-loop] hit maxIterations=${maxIterations} without a final answer`);
  return { output: null, iterations: maxIterations, toolCalls };
}

/**
 * Build a `callTool` that dispatches to a remote MCP capability server over Streamable
 * HTTP (JSON-RPC tools/call). Auth uses OBO when a user assertion is supplied and
 * configured, otherwise a managed-identity bearer token when MCP_TOKEN_SCOPE is set
 * (IL5); without a scope the call is unauthenticated for local dev.
 */
export interface McpToolCallerOptions {
  /** Signed-in user's access token for OBO-capable MCP service calls. */
  userAssertionToken?: string;
  tenantId?: string;
  traceId?: string;
}

export function mcpToolCaller(serverUrl: string, options: McpToolCallerOptions = {}): (name: string, args: any) => Promise<unknown> {
  let nextId = 1;
  return async (name: string, args: any): Promise<unknown> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const scope = process.env.MCP_TOKEN_SCOPE;
    if (options.tenantId) headers['x-tenant-id'] = options.tenantId;
    if (options.traceId) headers['x-trace-id'] = options.traceId;
    if (scope) {
      headers.Authorization = options.userAssertionToken && isOboConfigured()
        ? `Bearer ${await getOboToken(options.userAssertionToken, scope)}`
        : `Bearer ${await getEntraToken(scope)}`;
    }
    const resp = await fetch(serverUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    if (!resp.ok) throw new Error(`MCP call ${name} failed: HTTP ${resp.status}`);
    const json: any = await resp.json();
    if (json.error) throw new Error(`MCP call ${name} error: ${json.error.message}`);
    return json.result?.structuredContent ?? json.result;
  };
}
