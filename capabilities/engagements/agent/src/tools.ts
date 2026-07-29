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
] as const;

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
  close: () => Promise<void>;
}

/** Open a governed Python tool gateway bound to one demo persona. */
export async function makeToolClient(url: string, persona: string): Promise<ToolClient> {
  await discoverGovernedTools({ mcpUrl: url, persona });
  const captured: CapturedCall[] = [];
  const traceId = randomUUID();

  const callTool = async (name: string, args: any): Promise<unknown> => {
    const call = await callGovernedTool({
      mcpUrl: url,
      persona,
      traceId,
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

  return { callTool, captured, traceId, close: async () => {} };
}
