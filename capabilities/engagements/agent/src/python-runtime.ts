import { randomUUID } from "node:crypto";

export interface RuntimeCapturedCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  text: string;
  modelResult: unknown;
}

export interface PythonAgentResult {
  output: string | null;
  decision: PythonAgentDecision;
  iterations: number;
  toolCalls: { name: string; args: Record<string, unknown> }[];
  captured: RuntimeCapturedCall[];
}

export interface PythonAgentDecision {
  intent: "area" | "event" | "radius" | "lookup";
  stage: "clarify" | "options" | "plan" | "answer";
  clarify: "category" | "leader" | null;
  category: "congressional" | "academia" | "industry" | "army-internal" | null;
  leaderId: string | null;
  recommendedOptionIndex: number | null;
  answer: string;
}

interface RuntimeRequestContext {
  mcpUrl: string;
  traceId?: string;
  /** Area Discovery capability endpoint; the runtime falls back to its own DISCOVERY_MCP_URL. */
  discoveryMcpUrl?: string;
}

export class PythonRuntimeRequestError extends Error {
  constructor(
    readonly status: number,
    path: string,
    detail: string,
  ) {
    super(`Python agent runtime ${path} failed: ${detail}`);
    this.name = "PythonRuntimeRequestError";
  }
}

export function isGovernanceDenial(
  error: unknown,
): error is PythonRuntimeRequestError {
  return error instanceof PythonRuntimeRequestError && error.status === 403;
}

const runtimeUrl = (): string =>
  (process.env.ENGAGEMENTS_PYTHON_AGENT_URL || "http://127.0.0.1:3030").replace(
    /\/+$/,
    "",
  );

const timeoutMs = (): number => {
  const configured = Number(process.env.ENGAGEMENTS_PYTHON_AGENT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
};

export function isModelConfigured(): boolean {
  return Boolean(
    process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_DEPLOYMENT,
  );
}

export async function discoverGovernedTools(
  context: RuntimeRequestContext,
): Promise<string[]> {
  const response = await postJson<{ tools: { name: string }[] }>(
    "/tools/list",
    {
      ...context,
      traceId: context.traceId || randomUUID(),
    },
  );
  return response.tools.map((tool) => tool.name);
}

export async function callGovernedTool(
  context: RuntimeRequestContext & {
    name: string;
    args: Record<string, unknown>;
  },
): Promise<RuntimeCapturedCall> {
  return postJson<RuntimeCapturedCall>("/tools/call", {
    ...context,
    traceId: context.traceId || randomUUID(),
  });
}

export async function runPythonAgent(input: {
  system: string;
  user: string;
  mcpUrl: string;
  maxIterations?: number;
  traceId?: string;
  discoveryMcpUrl?: string;
}): Promise<PythonAgentResult> {
  return postJson<PythonAgentResult>("/run", {
    ...input,
    maxIterations: input.maxIterations ?? 8,
    traceId: input.traceId || randomUUID(),
  });
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const endpoint = `${runtimeUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        detail?: unknown;
      } | null;
      const detail =
        typeof payload?.detail === "string"
          ? payload.detail
          : `HTTP ${response.status}`;
      throw new PythonRuntimeRequestError(response.status, path, detail);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Python agent runtime ${path} timed out at ${endpoint}.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
