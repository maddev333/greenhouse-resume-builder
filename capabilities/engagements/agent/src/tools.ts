/**
 * The tool surface the orchestrator composes, plus the MCP client that reaches the
 * engagements capability.
 *
 * `AGENT_TOOLS` are the function specs handed to the Azure OpenAI loop — they mirror the
 * capability's `inputSchema`s (tools.ts) so the model calls them with valid arguments.
 *
 * `makeToolClient` binds ONE demo persona to an MCP client: every request carries
 * `x-demo-persona`, so the capability enforces the SAME server-side security trim the real
 * Keycloak claims would (records the caller may not see never leave the index). Tool results
 * are captured for assembly (menu / itinerary / trip-map) and the heavy `tripMap` payload is
 * stripped from what flows back to the model to save tokens.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentTool } from '@greenhouse-resume-builder/mcp-core';

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'search_contacts',
    description:
      'Return engagement contacts the caller is authorized to see (server-side security trim runs first). ' +
      'Use to explore who exists on a topic/status before planning.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text over name / org / SME area.' },
        topicIds: { type: 'array', items: { type: 'string' }, description: 'Restrict to these topic ids (e.g. ["T3"]).' },
        status: { type: 'string', enum: ['active', 'prospect'], description: 'active = existing relationship; prospect = never engaged.' },
      },
    },
  },
  {
    name: 'search_events',
    description: 'Find the conferences/functions the caller is authorized to see — the trip "anchors" the planner batches contacts around.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text over event name / city / state ("AUSA").' },
        topicIds: { type: 'array', items: { type: 'string' }, description: 'Restrict to events covering any of these topic ids.' },
      },
    },
  },
  {
    name: 'suggest_candidates',
    description:
      'The core nudge: given a leader and an anchor event they are already attending, rank WHO they should meet — ' +
      'on-site attendees/prospects and nearby stale relationships — filtered to the caller\'s authorized contacts and an optional topic focus. ' +
      'Returns a ranked menu; feed the chosen ids to build_itinerary.',
    parameters: {
      type: 'object',
      properties: {
        leaderId: { type: 'string', description: 'Leader whose time is being allocated (e.g. "L1").' },
        eventId: { type: 'string', description: 'Anchor event id (e.g. "E-AUSA"). Takes precedence over eventQuery.' },
        eventQuery: { type: 'string', description: 'Free-text anchor ("AUSA") resolved to one authorized event.' },
        topicIds: { type: 'array', items: { type: 'string' }, description: 'Topic focus ("UAS/drone" -> ["T3"]).' },
        requireTopicMatch: { type: 'boolean', description: 'When true (default), drop candidates whose topics do not intersect the ask.' },
      },
      required: ['leaderId'],
    },
  },
  {
    name: 'build_itinerary',
    description:
      'Given a leader, an anchor event, and the contact ids accepted from suggest_candidates, order the stops, compute trip-ROI, ' +
      'and surface advisory conflicts. Renders on the ui://trip-map app. Only accepts ids from the caller\'s authorized candidate set.',
    parameters: {
      type: 'object',
      properties: {
        leaderId: { type: 'string', description: 'Leader whose time is being allocated (e.g. "L1").' },
        eventId: { type: 'string', description: 'Anchor event id (e.g. "E-AUSA").' },
        eventQuery: { type: 'string', description: 'Free-text anchor ("AUSA") resolved to one authorized event.' },
        acceptedContactIds: { type: 'array', items: { type: 'string' }, description: 'Contact ids picked from the suggest_candidates menu.' },
        topicIds: { type: 'array', items: { type: 'string' }, description: 'Same topic focus used for suggest_candidates.' },
        requireTopicMatch: { type: 'boolean', description: 'Match suggest_candidates (default true).' },
      },
      required: ['leaderId', 'acceptedContactIds'],
    },
  },
];

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
  close: () => Promise<void>;
}

function textOf(res: any): string {
  const parts = Array.isArray(res?.content) ? res.content : [];
  return parts
    .filter((p: any) => p?.type === 'text')
    .map((p: any) => p.text)
    .join('\n');
}

/** Open an MCP client bound to one demo persona (drives the server-side trim). */
export async function makeToolClient(url: string, persona: string): Promise<ToolClient> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { 'x-demo-persona': persona } },
  });
  const client = new Client({ name: 'engagements-orchestrator', version: '0.1.0' });
  await client.connect(transport);

  const captured: CapturedCall[] = [];

  const callTool = async (name: string, args: any): Promise<unknown> => {
    const res: any = await client.callTool({ name, arguments: args ?? {} });
    const structured = res?.structuredContent ?? null;
    const text = textOf(res);
    captured.push({ name, args, result: structured ?? {}, text });

    // What the MODEL sees: never inline the heavy map payload.
    if (!structured) return text || {};
    if (name === 'build_itinerary' && 'tripMap' in structured) {
      const { tripMap, ...rest } = structured;
      return rest;
    }
    return structured;
  };

  return { callTool, captured, close: () => client.close() };
}
