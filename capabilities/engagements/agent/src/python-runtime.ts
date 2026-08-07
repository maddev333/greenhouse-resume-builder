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

export interface PythonDocumentPlanMeeting {
  target: string;
  organization: string | null;
  purpose: string;
  location: string | null;
  time: string | null;
  sourceIds: string[];
}

export interface PythonDocumentPlanDay {
  day: number;
  date: string | null;
  location: string | null;
  meetings: PythonDocumentPlanMeeting[];
  notes: string[];
}

export interface PythonDocumentTripPlan {
  title: string;
  event: string | null;
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  summary: string;
  days: PythonDocumentPlanDay[];
  sourceIds: string[];
  gaps: string[];
}

export interface PythonAgentDecision {
  intent: "area" | "event" | "radius" | "lookup";
  stage: "clarify" | "options" | "plan" | "answer";
  clarify: "category" | "leader" | null;
  category: "congressional" | "academia" | "industry" | "army-internal" | null;
  leaderId: string | null;
  recommendedOptionIndex: number | null;
  answer: string;
  documentPlan?: PythonDocumentTripPlan | null;
}

interface RuntimeRequestContext {
  mcpUrl: string;
  traceId?: string;
  /** Area Discovery capability endpoint; the runtime falls back to its own DISCOVERY_MCP_URL. */
  discoveryMcpUrl?: string;
}

/**
 * Which surface the engagements capability actually registered:
 *   - 'planner'   the nine structured planning tools (RETRIEVAL_BACKEND=memory or search)
 *   - 'grounding' ONLY `search_grounding` over a document corpus (RETRIEVAL_BACKEND=grounding)
 * The planner surface may additionally carry `search_grounding` when a `search` index also declares
 * a `mapping.grounding` block.
 */
export type CapabilityBackend = "planner" | "grounding";

export interface DiscoveredCapability {
  tools: string[];
  backend: CapabilityBackend;
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
): Promise<DiscoveredCapability> {
  const response = await postJson<{
    tools: { name: string }[];
    backend?: string;
  }>("/tools/list", {
    ...context,
    traceId: context.traceId || randomUUID(),
  });
  const tools = response.tools.map((tool) => tool.name);
  return { tools, backend: resolveBackend(tools, response.backend) };
}

/** Trust the runtime's classification when it sends one; otherwise read it off the tool names. */
function resolveBackend(
  tools: string[],
  declared: string | undefined,
): CapabilityBackend {
  if (declared === "planner" || declared === "grounding") return declared;
  const names = new Set(tools);
  return names.has("search_grounding") && !names.has("search_contacts")
    ? "grounding"
    : "planner";
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
