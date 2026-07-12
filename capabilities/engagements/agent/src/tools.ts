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
    name: 'plan_radius',
    description:
      'Fixed-duration, event-OPTIONAL planning for "a leader must visit a SPECIFIC company (or place) for N days" ' +
      'with NO anchor event. Anchor by company (anchorContactId or a company name), a raw lat/lng, or a city/region; ' +
      'set a radius + the trip length. Fills days × meetingsPerDay slots with the mandatory anchor (met on-site) + ' +
      'the best authorized contacts within the radius, and returns "+N day unlocks …" extension options. Then call ' +
      'build_itinerary with the SAME anchor to render the map.',
    parameters: {
      type: 'object',
      properties: {
        anchorContactId: { type: 'string', description: 'Must-meet company/contact id (e.g. "C3"); becomes stop #1, met on-site.' },
        company: { type: 'string', description: 'Company/contact name ("Meridian Robotics") resolved to the anchor when no id is given.' },
        lat: { type: 'number', description: 'Raw anchor latitude (with lng) for a coordinate anchor.' },
        lng: { type: 'number', description: 'Raw anchor longitude (with lat).' },
        city: { type: 'string', description: 'City centroid anchor.' },
        state: { type: 'string', description: 'State for the city anchor.' },
        region: { type: 'string', description: 'Free-text region/alias ("NCR").' },
        regionId: { type: 'string', description: 'Known region id (e.g. "R-NCR").' },
        radiusKm: { type: 'number', description: 'Search radius around the anchor (km).' },
        days: { type: 'number', description: 'FIXED trip length in days the leader is on the ground.' },
        meetingsPerDay: { type: 'number', description: 'Meetings/day capacity (default 2).' },
        window: {
          type: 'object',
          properties: { start: { type: 'string' }, end: { type: 'string' } },
          description: 'Planning window (ISO YYYY-MM-DD) for availability + budget checks.',
        },
        leaderId: { type: 'string', description: 'Force a leader; defaults to the top-ranked option for the area.' },
        topicIds: { type: 'array', items: { type: 'string' }, description: 'Target topics; defaults to the area topics.' },
        requireTopicMatch: { type: 'boolean', description: 'Drop stops off the target topics (default false).' },
      },
      required: ['days'],
    },
  },
  {
    name: 'build_itinerary',
    description:
      'Given a leader and EITHER an anchor event (acceptedContactIds from suggest_candidates) OR a fixed-radius anchor ' +
      '(a company/coordinate/city + a day count, from plan_radius), order the stops, compute trip-ROI, and surface ' +
      'advisory conflicts. Renders on the ui://trip-map app. For a radius trip, pass the SAME anchor you gave plan_radius ' +
      "(anchorContactId/company/lat+lng/city) and the days; omit acceptedContactIds to accept the auto-filled plan. " +
      "Only accepts ids from the caller's authorized set.",
    parameters: {
      type: 'object',
      properties: {
        leaderId: { type: 'string', description: 'Leader whose time is being allocated (e.g. "L1").' },
        eventId: { type: 'string', description: 'Event mode: anchor event id (e.g. "E-AUSA").' },
        eventQuery: { type: 'string', description: 'Event mode: free-text anchor ("AUSA") resolved to one authorized event.' },
        anchorContactId: { type: 'string', description: 'Radius mode: must-meet company/contact id (stop #1, on-site).' },
        company: { type: 'string', description: 'Radius mode: company/contact name for the anchor.' },
        lat: { type: 'number', description: 'Radius mode: anchor latitude (with lng).' },
        lng: { type: 'number', description: 'Radius mode: anchor longitude (with lat).' },
        city: { type: 'string', description: 'Radius mode: city centroid anchor.' },
        state: { type: 'string', description: 'Radius mode: state for the city anchor.' },
        region: { type: 'string', description: 'Radius mode: free-text region/alias.' },
        regionId: { type: 'string', description: 'Radius mode: known region id.' },
        radiusKm: { type: 'number', description: 'Radius mode: search radius (km).' },
        days: { type: 'number', description: 'Radius mode: FIXED trip length in days.' },
        meetingsPerDay: { type: 'number', description: 'Radius mode: meetings/day capacity.' },
        window: {
          type: 'object',
          properties: { start: { type: 'string' }, end: { type: 'string' } },
          description: 'Radius mode planning window (ISO).',
        },
        acceptedContactIds: { type: 'array', items: { type: 'string' }, description: 'Chosen stop ids (event mode: from suggest_candidates; radius mode: optional — omit to accept the auto-fill).' },
        topicIds: { type: 'array', items: { type: 'string' }, description: 'Same topic focus used for the plan step.' },
        requireTopicMatch: { type: 'boolean', description: 'Event mode default true; radius mode default false.' },
      },
      required: ['leaderId'],
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
