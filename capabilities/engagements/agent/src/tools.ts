/**
 * The tool surface the orchestrator composes, plus the MCP client that reaches the
 * engagements capability.
 *
 * The Python Agent Framework runtime owns model-facing tool definitions. `makeToolClient`
 * routes deterministic orchestration calls through that same Python service, so AGT policy
 * and audit apply to every agent-originated MCP invocation rather than only model calls.
 */
import { randomUUID } from "node:crypto";
import {
  callGovernedTool,
  discoverGovernedTools,
  type CapabilityBackend,
} from "./python-runtime.js";

export const AGENT_TOOL_NAMES = [
  "search_contacts",
  "search_events",
  "survey_area",
  "suggest_leaders",
  "nearby_leaders",
  "plan_options",
  "plan_radius",
  "suggest_candidates",
  "build_itinerary",
  "search_businesses",
] as const;

/** Grounded Q&A over the customer's document corpus — served instead of the planner surface. */
export const GROUNDING_TOOL_NAME = "search_grounding";

/**
 * Thrown when the capability serves ONLY `search_grounding`. A document corpus carries no
 * contact/event/leader records, so the deterministic router has nothing to compose — and quietly
 * continuing would let the model answer from the prompt catalog instead of the customer's index.
 */
export class GroundingOnlyCapabilityError extends Error {
  constructor(url: string) {
    super(
      `The engagements capability at ${url} is running RETRIEVAL_BACKEND=grounding: it registers ` +
        `only ${GROUNDING_TOOL_NAME}, so the deterministic planner has no contact, event, or leader ` +
        "tools to compose. Configure Azure OpenAI to answer grounded questions from that corpus, or " +
        "point the orchestrator at a capability running RETRIEVAL_BACKEND=memory or search.",
    );
    this.name = "GroundingOnlyCapabilityError";
  }
}

/** Area Discovery capability endpoint the governed runtime should route `search_businesses` to. */
export const DISCOVERY_URL = (): string =>
  process.env.DISCOVERY_MCP_URL || "http://localhost:3011/mcp";

export interface CapturedCall {
  name: string;
  args: unknown;
  /** Parsed `structuredContent` from the tool result (or `{}`). */
  result: any;
  /** Human-readable text content the capability rendered. */
  text: string;
}

export interface ToolClient {
  callTool: (name: string, args: any) => Promise<unknown>;
  captured: CapturedCall[];
  traceId: string;
  /** The surface the capability registered — always 'planner' here (see makeToolClient). */
  backend: CapabilityBackend;
  close: () => Promise<void>;
}

/** Open a governed Python tool gateway. */
export async function makeToolClient(url: string): Promise<ToolClient> {
  const discoveryMcpUrl = DISCOVERY_URL();
  const capability = await discoverGovernedTools({
    mcpUrl: url,
    discoveryMcpUrl,
  });
  if (capability.backend === "grounding") {
    throw new GroundingOnlyCapabilityError(url);
  }
  const captured: CapturedCall[] = [];
  const traceId = randomUUID();

  const callTool = async (name: string, args: any): Promise<unknown> => {
    const call = await callGovernedTool({
      mcpUrl: url,
      traceId,
      discoveryMcpUrl,
      name,
      args: args ?? {},
    });
    captured.push({
      name: call.name,
      args: call.args,
      result: call.result ?? {},
      text: call.text,
    });
    return call.modelResult;
  };

  return {
    callTool,
    captured,
    traceId,
    backend: capability.backend,
    close: async () => {},
  };
}
