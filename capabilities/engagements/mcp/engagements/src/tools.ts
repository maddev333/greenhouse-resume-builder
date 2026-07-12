/**
 * Engagements MCP tools — the deterministic planner + security-trimmed retrieval, exposed to the
 * orchestrator/host as callable tools (ARCHITECTURE §5.3). Every tool:
 *   1. resolves the caller's verified claims (`getContext`),
 *   2. loads a FRESH index each call (so demo add/update/delete + "reindex" shows immediately),
 *   3. lets the security trim run server-side BEFORE any recall/scoring, and
 *   4. reports the exact `$filter` + `redactedCount` so the trim is observable on stage.
 *
 * UI is intentionally absent here — `build_itinerary` returns a structured route that the
 * `ui://trip-map` App will render at M3; the tool contract does not change.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  suggest,
  anchorFromEvent,
  resolveArea,
  topicsInArea,
  suggestLeaders,
  haversineKm,
  planRoute,
  tripRoi,
  detectFit,
  detectAvailabilityBudget,
  detectOpportunityCost,
  daysBetween,
  type Candidate,
  type Contact,
  type Leader,
  type EngagementEvent,
  type TopicInArea,
  type LeaderOption,
  type Conflict,
  type RouteResult,
  type RouteStop,
  type RoiResult,
  type Labeled,
} from './engine.js';
import { getReadModel, type ReadModel } from './readmodel.js';
import type { ResolvedContext } from './context.js';
import type { TripMapLeg, TripMapPayload, TripMapPoint } from './app-payload.js';

type ContextProvider = () => ResolvedContext;

/** The ui://trip-map App: URI the tool advertises + where `vite build` writes the single-file HTML. */
const TRIP_MAP_RESOURCE_URI = 'ui://trip-map/trip-map.html';
const APP_DIST = resolve(import.meta.dirname, '..', 'dist');

/** Instance type of the retrieval index (the value is default-imported via engine.ts, so name its type here). */
type Index = ReadModel;

// ── small helpers ─────────────────────────────────────────────────────────

const round = (n: number): number => Math.round(n);
const fixed = (n: number, d = 3): number => Number(n.toFixed(d));

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function isRejected(filter: string): boolean {
  return filter.startsWith('(rejected');
}

function findLeader(idx: Index, leaderId: string): Labeled<Leader> | undefined {
  return idx.leaders.find((l) => l.id === leaderId);
}

/** Resolve the anchor event through the SAME security-trimmed event search the caller would see. */
async function resolveEvent(
  idx: Index,
  ctx: ResolvedContext['ctx'],
  opts: { eventId?: string; eventQuery?: string },
): Promise<{ event?: Labeled<EngagementEvent>; filter: string; redactedCount: number }> {
  const res = await idx.searchEvents({ ctx, query: opts.eventQuery });
  const event = opts.eventId ? res.items.find((e) => e.id === opts.eventId) : res.items[0];
  return { event, filter: res.filter, redactedCount: res.redactedCount };
}

function candidateView(c: Candidate) {
  return {
    contactId: c.contactId,
    name: c.name,
    city: c.location.city,
    state: c.location.state,
    placement: c.placement,
    kind: c.kind,
    status: c.status,
    isStale: c.isStale,
    strategicValue: c.strategicValue,
    distanceKm: round(c.distanceKm),
    score: fixed(c.score),
    fitFlags: c.fitFlags.map((f) => f.type),
    factors: {
      staleness: fixed(c.factors.stalenessNorm, 2),
      value: fixed(c.factors.valueNorm, 2),
      topic: fixed(c.factors.topicRelevance, 2),
    },
  };
}

function topicInAreaView(t: TopicInArea) {
  return {
    topicId: t.topicId,
    name: t.name,
    domain: t.domain,
    smeAreas: t.smeAreas,
    ownerOrg: t.ownerOrg,
    hasApprovedMessage: t.hasApprovedMessage,
    activeCount: t.activeCount,
    prospectCount: t.prospectCount,
    staleCount: t.staleCount,
    eventCount: t.eventCount,
    strategicValueSum: t.strategicValueSum,
    opportunityScore: t.opportunityScore,
  };
}

function leaderOptionView(o: LeaderOption) {
  return {
    leaderId: o.leaderId,
    name: o.name,
    role: o.role,
    score: fixed(o.score),
    distanceKm: round(o.distanceKm),
    availableInWindow: o.availableInWindow,
    factors: {
      topicMatch: fixed(o.factors.topicMatch, 2),
      proximity: fixed(o.factors.proximity, 2),
      availability: fixed(o.factors.availability, 2),
      budgetHeadroom: fixed(o.factors.budgetHeadroom, 2),
      levelFit: fixed(o.factors.levelFit, 2),
    },
    notes: o.notes,
  };
}

function routeView(route: RouteResult) {
  return {
    order: route.order.map((s) => ({ id: s.id, city: s.location.city, kind: s.kind })),
    legs: route.legs.map((l) => ({
      from: l.fromStopId,
      to: l.toStopId,
      mode: l.mode,
      distanceKm: round(l.distanceKm),
      estTravelMins: round(l.estTravelMins),
    })),
    totalKm: round(route.totalKm),
    totalTravelMins: round(route.totalTravelMins),
  };
}

/**
 * Project the engine's route + accepted candidates into the browser-safe `ui://trip-map` payload
 * (lat/lng for every pin + travel legs). This is the ONLY place the engine → App wire mapping lives;
 * `app-payload.ts` stays import-free so Vite can bundle it into the browser App.
 */
function buildTripMapPayload(
  leader: Labeled<Leader>,
  event: Labeled<EngagementEvent>,
  accepted: Candidate[],
  route: RouteResult,
  roi: RoiResult,
  caller: string,
): TripMapPayload {
  const byContactId = new Map(accepted.map((c) => [c.contactId, c]));
  const origin: TripMapPoint = {
    id: `event:${event.id}`,
    label: event.name,
    lat: event.location.lat,
    lng: event.location.lng,
    kind: 'origin',
    detail: `${event.location.city}${event.location.state ? `, ${event.location.state}` : ''} · ${event.start}→${event.end}`,
  };
  const stops: TripMapPoint[] = route.order.map((s) => {
    const c = byContactId.get(s.id);
    // On-site contacts are met AT the anchor venue (they carry no travel leg), so co-locate their pin
    // with the origin rather than their home city — otherwise a home-based coordinate scatters the map.
    const atVenue = s.kind === 'on-site';
    return {
      id: s.id,
      label: c?.name ?? s.id,
      lat: atVenue ? event.location.lat : s.location.lat,
      lng: atVenue ? event.location.lng : s.location.lng,
      kind: s.kind, // SuggestionPlacement: 'on-site' | 'off-site'
      detail: c
        ? `${c.placement} · ${c.kind}${c.isStale ? ' · STALE' : ''} · val ${c.strategicValue} · score ${fixed(c.score)}`
        : `${s.location.city}${s.location.state ? `, ${s.location.state}` : ''}`,
    };
  });
  const byPointId = new Map<string, TripMapPoint>([[origin.id, origin], ...stops.map((p) => [p.id, p] as const)]);
  const legs: TripMapLeg[] = route.legs.map((l) => {
    const from = byPointId.get(l.fromStopId) ?? origin; // fromStopId === ORIGIN_ID → the anchor venue
    const to = byPointId.get(l.toStopId) ?? origin;
    return { fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng, mode: l.mode, distanceKm: round(l.distanceKm) };
  });
  return {
    title: `${leader.name} @ ${event.name}`,
    origin,
    stops,
    legs,
    roiScore: fixed(roi.roiScore),
    overBudget: roi.overBudget,
    totalKm: round(route.totalKm),
    caller,
  };
}

/** Run the shared "resolve leader → resolve anchor → trim contacts → suggest" pipeline once. */
async function runSuggest(
  idx: Index,
  ctx: ResolvedContext['ctx'],
  args: { leaderId: string; eventId?: string; eventQuery?: string; topicIds?: string[]; requireTopicMatch?: boolean },
): Promise<
  | { ok: false; rejected: boolean; error: string }
  | {
      ok: true;
      leader: Labeled<Leader>;
      event: Labeled<EngagementEvent>;
      candidates: Candidate[];
      contactsById: Map<string, Labeled<Contact>>;
      filter: string;
      redactedCount: number;
    }
> {
  const leader = findLeader(idx, args.leaderId);
  if (!leader) return { ok: false, rejected: false, error: `Unknown leader '${args.leaderId}'.` };

  const { event, filter: eventFilter } = await resolveEvent(idx, ctx, { eventId: args.eventId, eventQuery: args.eventQuery });
  if (!event) {
    if (isRejected(eventFilter)) {
      return { ok: false, rejected: true, error: 'Access rejected fail-closed — no verified tenant claim.' };
    }
    const which = args.eventId ?? args.eventQuery ?? '(none given)';
    return { ok: false, rejected: false, error: `No authorized anchor event matched '${which}'.` };
  }

  const contacts = await idx.searchContacts({ ctx, topicIds: args.topicIds });
  const anchor = { ...anchorFromEvent(event), ...(args.topicIds?.length ? { topicIds: args.topicIds } : {}) };
  const candidates = suggest({
    leader,
    anchor,
    contacts: contacts.items,
    event,
    requireTopicMatch: args.requireTopicMatch ?? true,
  });

  const contactsById = new Map(contacts.items.map((c) => [c.id, c]));
  return { ok: true, leader, event, candidates, contactsById, filter: contacts.filter, redactedCount: contacts.redactedCount };
}

// ── registration ────────────────────────────────────────────────────────

export function registerEngagementTools(server: McpServer, getContext: ContextProvider): void {
  // 1) search_contacts — trimmed contact recall
  server.registerTool(
    'search_contacts',
    {
      title: 'Search contacts (security-trimmed)',
      description:
        'Return engagement contacts the caller is authorized to see. The claims-based security trim ' +
        '(tenant isolation + group ACL + sensitivity) runs server-side FIRST, so unauthorized records ' +
        'never leave the index. Reports the exact OData $filter and how many in-scope rows were redacted.',
      inputSchema: {
        query: z.string().optional().describe('Free-text over name / org / SME area.'),
        topicIds: z.array(z.string()).optional().describe('Restrict to contacts tagged with any of these topic ids (e.g. ["T3"]).'),
        status: z.enum(['active', 'prospect']).optional().describe('active = existing relationship; prospect = never engaged.'),
      },
    },
    async ({ query, topicIds, status }): Promise<CallToolResult> => {
      const { ctx, label } = getContext();
      const rm = getReadModel();
      const res = await rm.searchContacts({ ctx, query, topicIds, status });
      const contacts = res.items.map((c) => ({
        id: c.id,
        name: c.name,
        org: c.org,
        city: c.location.city,
        state: c.location.state,
        topicIds: c.topicIds,
        strategicValue: c.strategicValue,
        status: c.status,
        lastInteractionDate: c.lastInteractionDate,
      }));
      const structuredContent = {
        caller: label,
        rejected: isRejected(res.filter),
        count: contacts.length,
        redactedCount: res.redactedCount,
        filter: res.filter,
        contacts,
      };
      const header = isRejected(res.filter)
        ? `Access rejected — ${res.filter}`
        : `${contacts.length} contact(s) visible to ${label}; ${res.redactedCount} redacted by trim.`;
      const lines = contacts.map((c) => `  • ${c.id} ${c.name}${c.org ? ` (${c.org})` : ''} — ${c.city}, val ${c.strategicValue}, ${c.status}`);
      return { content: [{ type: 'text', text: [header, ...lines, `filter: ${res.filter}`].join('\n') }], structuredContent };
    },
  );

  // 2) search_events — trimmed anchor discovery
  server.registerTool(
    'search_events',
    {
      title: 'Search anchor events (security-trimmed)',
      description:
        'Find the conferences/conventions/functions the caller is authorized to see — the trip "anchors" ' +
        'the planner batches contacts around. Same server-side trim + $filter reporting as search_contacts.',
      inputSchema: {
        query: z.string().optional().describe('Free-text over event name / city / state ("AUSA").'),
        topicIds: z.array(z.string()).optional().describe('Restrict to events covering any of these topic ids.'),
      },
    },
    async ({ query, topicIds }): Promise<CallToolResult> => {
      const { ctx, label } = getContext();
      const rm = getReadModel();
      const res = await rm.searchEvents({ ctx, query, topicIds });
      const events = res.items.map((e) => ({
        id: e.id,
        name: e.name,
        city: e.location.city,
        state: e.location.state,
        start: e.start,
        end: e.end,
        topicIds: e.topicIds,
        attendees: e.attendingContactIds.length,
        prospects: e.exhibitorProspectIds.length,
      }));
      const structuredContent = {
        caller: label,
        rejected: isRejected(res.filter),
        count: events.length,
        redactedCount: res.redactedCount,
        filter: res.filter,
        events,
      };
      const header = isRejected(res.filter)
        ? `Access rejected — ${res.filter}`
        : `${events.length} event(s) visible to ${label}.`;
      const lines = events.map((e) => `  • ${e.id} ${e.name} — ${e.city} ${e.start}→${e.end}, topics [${e.topicIds.join(',')}]`);
      return { content: [{ type: 'text', text: [header, ...lines].join('\n') }], structuredContent };
    },
  );

  // 3) survey_area — area-first: which topics have a live footprint in a place?
  server.registerTool(
    'survey_area',
    {
      title: 'Survey a geographic area',
      description:
        'Area-first planning: anchor on a place (a known region like "NCR"/"Bay Area", or a city/state) ' +
        'and see WHICH topics have a live footprint there — active relationships, stale ones worth ' +
        're-engaging, never-engaged prospects, and any on-site events — ranked by opportunity. Runs over ' +
        "the caller's authorized contacts/events only (same server-side trim + $filter reporting). " +
        'Use this before suggest_leaders to decide where to go and why.',
      inputSchema: {
        regionId: z.string().optional().describe('Known region id (e.g. "R-NCR"). Highest precedence.'),
        region: z.string().optional().describe('Region name or alias (e.g. "NCR", "Bay Area") — case-insensitive.'),
        city: z.string().optional().describe('City to anchor on when no region matches (e.g. "Huntsville").'),
        state: z.string().optional().describe('State to disambiguate the city (e.g. "AL").'),
        radiusKm: z.number().optional().describe('Override the search radius in km (defaults to the region default or 150).'),
      },
    },
    async ({ regionId, region, city, state, radiusKm }): Promise<CallToolResult> => {
      const { ctx, label } = getContext();
      const rm = getReadModel();
      const contacts = await rm.searchContacts({ ctx });
      if (isRejected(contacts.filter)) {
        const structuredContent = { caller: label, rejected: true, today: rm.today, area: null, topics: [], redactedCount: 0, filter: contacts.filter };
        return { content: [{ type: 'text', text: 'Access rejected — no verified tenant claim.' }], structuredContent };
      }
      const events = await rm.searchEvents({ ctx });
      const knownPoints = [...contacts.items.map((c) => c.location), ...events.items.map((e) => e.location)];
      const area = resolveArea({ regionId, region, city, state, radiusKm }, rm.regions, knownPoints);
      if (!area) {
        const known = rm.regions.map((r) => `${r.id} (${r.name})`).join(', ');
        return errorResult(`Could not resolve an area from the given input. Try a known region: ${known}; or a city/state present in your contacts.`);
      }
      const topics = topicsInArea({
        centroid: area.centroid,
        radiusKm: area.radiusKm,
        contacts: contacts.items,
        events: events.items,
        topics: rm.topics,
      });
      const structuredContent = {
        caller: label,
        rejected: false,
        today: rm.today,
        area: { id: area.id, name: area.name, city: area.centroid.city, state: area.centroid.state, radiusKm: area.radiusKm, resolvedVia: area.resolvedVia },
        topicCount: topics.length,
        topics: topics.map(topicInAreaView),
        contactsInScope: contacts.items.length,
        redactedCount: contacts.redactedCount,
        filter: contacts.filter,
      };
      const header = `${area.name} (${area.radiusKm} km): ${topics.length} topic(s) with a live footprint; ${contacts.redactedCount} contact(s) redacted by trim.`;
      const lines = topics.map(
        (t) =>
          `  • ${t.topicId} ${t.name} — ${t.activeCount} active/${t.staleCount} stale/${t.prospectCount} prospect, ${t.eventCount} event(s), msg ${t.hasApprovedMessage ? '✓' : '—'}, opp ${t.opportunityScore}`,
      );
      return { content: [{ type: 'text', text: [header, ...lines, `filter: ${contacts.filter}`].join('\n') }], structuredContent };
    },
  );

  // 4) suggest_leaders — area-first: who should go, and how well they fit
  server.registerTool(
    'suggest_leaders',
    {
      title: 'Suggest which leader should go',
      description:
        'Area-first planning: given a place + a date window (and optionally the target topics), rank WHICH ' +
        'senior leader should go — scoring SME/domain fit, proximity to the area, availability overlap with ' +
        "the window, travel-budget headroom, and echelon fit vs the area's anchor relationships. Always " +
        'returns a ranked menu of OPTIONS (a poor fit is flagged, never dropped); the human decides. ' +
        "When topicIds are omitted, the area's in-scope topics are used.",
      inputSchema: {
        regionId: z.string().optional().describe('Known region id (e.g. "R-NCR").'),
        region: z.string().optional().describe('Region name or alias (e.g. "NCR", "Bay Area").'),
        city: z.string().optional().describe('City to anchor on when no region matches.'),
        state: z.string().optional().describe('State to disambiguate the city.'),
        radiusKm: z.number().optional().describe('Override the search radius in km.'),
        window: z
          .object({ start: z.string(), end: z.string() })
          .describe('Planning window (ISO YYYY-MM-DD) the leader must be available in.'),
        topicIds: z.array(z.string()).optional().describe("Target topics to staff for; defaults to the area's in-scope topics."),
      },
    },
    async ({ regionId, region, city, state, radiusKm, window, topicIds }): Promise<CallToolResult> => {
      const { ctx, label } = getContext();
      const rm = getReadModel();
      const contacts = await rm.searchContacts({ ctx });
      if (isRejected(contacts.filter)) {
        const structuredContent = { caller: label, rejected: true, today: rm.today, area: null, leaders: [], redactedCount: 0, filter: contacts.filter };
        return { content: [{ type: 'text', text: 'Access rejected — no verified tenant claim.' }], structuredContent };
      }
      const events = await rm.searchEvents({ ctx });
      const knownPoints = [...contacts.items.map((c) => c.location), ...events.items.map((e) => e.location)];
      const area = resolveArea({ regionId, region, city, state, radiusKm }, rm.regions, knownPoints);
      if (!area) {
        const known = rm.regions.map((r) => `${r.id} (${r.name})`).join(', ');
        return errorResult(`Could not resolve an area from the given input. Try a known region: ${known}; or a city/state present in your contacts.`);
      }
      const inArea = contacts.items.filter((c) => haversineKm(area.centroid, c.location) <= area.radiusKm);
      const survey = topicsInArea({ centroid: area.centroid, radiusKm: area.radiusKm, contacts: contacts.items, events: events.items, topics: rm.topics });
      const resolvedTopicIds = topicIds?.length ? topicIds : survey.map((t) => t.topicId);
      const leaders = suggestLeaders({
        centroid: area.centroid,
        window,
        topicIds: resolvedTopicIds,
        leaders: rm.leaders,
        topics: rm.topics,
        contacts: inArea,
      });
      const structuredContent = {
        caller: label,
        rejected: false,
        today: rm.today,
        area: { id: area.id, name: area.name, city: area.centroid.city, state: area.centroid.state, radiusKm: area.radiusKm, resolvedVia: area.resolvedVia },
        window,
        topicIds: resolvedTopicIds,
        leaderCount: leaders.length,
        leaders: leaders.map(leaderOptionView),
        redactedCount: contacts.redactedCount,
        filter: contacts.filter,
      };
      const header = `Who should staff ${area.name} on [${resolvedTopicIds.join(', ') || 'any topic'}] over ${window.start}→${window.end}? ${leaders.length} option(s).`;
      const lines = leaders.map(
        (o, i) =>
          `  ${i + 1}. ${o.leaderId} ${o.name} — score ${fixed(o.score)}, ${round(o.distanceKm)}km, ${o.availableInWindow ? 'available' : 'UNAVAILABLE'}` +
          `${o.notes.length ? `, notes: ${o.notes.join('; ')}` : ''}`,
      );
      return { content: [{ type: 'text', text: [header, ...lines, `filter: ${contacts.filter}`].join('\n') }], structuredContent };
    },
  );

  // 5) suggest_candidates — the "you're already going there" nudge
  server.registerTool(
    'suggest_candidates',
    {
      title: 'Suggest who to meet on a trip',
      description:
        'The core nudge: given a leader and an anchor event they are already attending, rank WHO they ' +
        'should meet — on-site attendees/prospects (≈0 travel) and nearby stale relationships worth ' +
        're-engaging — filtered to the caller\'s authorized contacts and (optionally) a topic focus. ' +
        'Returns a ranked menu of options; feed the chosen ids to build_itinerary.',
      inputSchema: {
        leaderId: z.string().describe('Leader whose time is being allocated (e.g. "L1").'),
        eventId: z.string().optional().describe('Anchor event id (e.g. "E-AUSA"). Takes precedence over eventQuery.'),
        eventQuery: z.string().optional().describe('Free-text anchor ("AUSA") resolved to one authorized event.'),
        topicIds: z.array(z.string()).optional().describe('Topic focus for the ask ("UAS/drone" → ["T3"]); overrides the event topics for matching/scoring.'),
        requireTopicMatch: z.boolean().optional().describe('When true (default), drop candidates whose topics do not intersect the ask.'),
      },
    },
    async ({ leaderId, eventId, eventQuery, topicIds, requireTopicMatch }): Promise<CallToolResult> => {
      const { ctx, label } = getContext();
      const rm = getReadModel();
      const r = await runSuggest(rm, ctx, { leaderId, eventId, eventQuery, topicIds, requireTopicMatch });
      if (!r.ok) {
        if (r.rejected) {
          const structuredContent = { caller: label, rejected: true, today: rm.today, candidates: [], redactedCount: 0, filter: '(rejected)', reason: r.error };
          return { content: [{ type: 'text', text: `Access rejected — ${r.error}` }], structuredContent };
        }
        return errorResult(r.error);
      }

      const candidates = r.candidates.map(candidateView);
      const structuredContent = {
        caller: label,
        rejected: isRejected(r.filter),
        today: rm.today,
        leader: { id: r.leader.id, name: r.leader.name, role: r.leader.role },
        event: { id: r.event.id, name: r.event.name, city: r.event.location.city, start: r.event.start, end: r.event.end },
        requireTopicMatch: requireTopicMatch ?? true,
        topicFocus: topicIds ?? r.event.topicIds,
        redactedCount: r.redactedCount,
        filter: r.filter,
        candidates,
      };
      const header = `${r.leader.name} @ ${r.event.name} (${r.event.location.city}) — ${candidates.length} option(s); ${r.redactedCount} contact(s) redacted by trim.`;
      const lines = candidates.map(
        (c, i) =>
          `  ${i + 1}. ${c.contactId} ${c.name} — ${c.placement}/${c.kind}, ${c.city}, val ${c.strategicValue}` +
          `${c.isStale ? ', STALE' : ''}, score ${c.score}${c.fitFlags.length ? `, flags [${c.fitFlags.join(',')}]` : ''}`,
      );
      return { content: [{ type: 'text', text: [header, ...lines, `filter: ${r.filter}`].join('\n') }], structuredContent };
    },
  );

  // 6) build_itinerary — route + ROI + conflicts for the accepted picks, rendered on ui://trip-map (M3)
  registerAppTool(
    server,
    'build_itinerary',
    {
      title: 'Build a trip itinerary',
      description:
        'Given a leader, an anchor event, and the contact ids accepted from suggest_candidates, order the ' +
        'stops (on-site first, then nearest-neighbor off-site), compute trip-ROI (value minus airfare / ' +
        'per-diem / time penalty), and surface advisory conflicts (fit, availability-budget, opportunity-cost). ' +
        'Only accepts ids from the caller\'s authorized candidate set.',
      inputSchema: {
        leaderId: z.string().describe('Leader whose time is being allocated (e.g. "L1").'),
        eventId: z.string().optional().describe('Anchor event id (e.g. "E-AUSA").'),
        eventQuery: z.string().optional().describe('Free-text anchor ("AUSA") resolved to one authorized event.'),
        acceptedContactIds: z.array(z.string()).min(1).describe('Contact ids picked from the suggest_candidates menu.'),
        topicIds: z.array(z.string()).optional().describe('Same topic focus used for suggest_candidates (keeps the candidate set consistent).'),
        requireTopicMatch: z.boolean().optional().describe('Match suggest_candidates (default true).'),
      },
      _meta: { ui: { resourceUri: TRIP_MAP_RESOURCE_URI } },
    },
    async ({ leaderId, eventId, eventQuery, acceptedContactIds, topicIds, requireTopicMatch }): Promise<CallToolResult> => {
      const { ctx, label } = getContext();
      const rm = getReadModel();
      const r = await runSuggest(rm, ctx, { leaderId, eventId, eventQuery, topicIds, requireTopicMatch });
      if (!r.ok) return errorResult(r.error);

      const accepted = r.candidates.filter((c) => acceptedContactIds.includes(c.contactId));
      const notMatched = acceptedContactIds.filter((id) => !accepted.some((c) => c.contactId === id));
      if (accepted.length === 0) {
        return errorResult(
          `None of [${acceptedContactIds.join(', ')}] are in ${r.leader.name}'s authorized candidate set for ${r.event.name}.`,
        );
      }

      const stops: RouteStop[] = accepted.map((c) => ({ id: c.contactId, location: c.location, kind: c.placement }));
      const route = planRoute(r.event.location, stops);
      const days = daysBetween(r.event.start, r.event.end) + 1;
      const roi = tripRoi(accepted.map((c) => c.score), route.legs, days, r.leader.daysAwayBudget);

      const conflicts: Conflict[] = [
        ...accepted.flatMap((c) => {
          const contact = r.contactsById.get(c.contactId);
          return contact ? detectFit(r.leader, contact) : [];
        }),
        ...detectAvailabilityBudget(r.leader, { start: r.event.start, end: r.event.end }, days),
        ...detectOpportunityCost(roi),
      ];

      const tripMap = buildTripMapPayload(r.leader, r.event, accepted, route, roi, label);
      const structuredContent = {
        caller: label,
        today: rm.today,
        leader: { id: r.leader.id, name: r.leader.name, role: r.leader.role, daysAwayBudget: r.leader.daysAwayBudget },
        event: { id: r.event.id, name: r.event.name, city: r.event.location.city, start: r.event.start, end: r.event.end },
        accepted: accepted.map(candidateView),
        notMatched,
        route: routeView(route),
        roi,
        conflicts,
        tripMap,
        filter: r.filter,
        redactedCount: r.redactedCount,
      };
      const header =
        `Itinerary for ${r.leader.name} @ ${r.event.name}: ${accepted.length} stop(s), ` +
        `${days} day(s), ROI ${fixed(roi.roiScore)}${roi.overBudget ? ' (OVER BUDGET)' : ''}.`;
      const orderLine = `  route: ${route.order.map((s) => s.location.city).join(' → ')}`;
      const conflictLines = conflicts.length
        ? conflicts.map((c) => `  ⚠ ${c.severity}/${c.type}: ${c.message}`)
        : ['  no conflicts flagged'];
      const notMatchedLine = notMatched.length ? [`  (ignored, not authorized/suggested: ${notMatched.join(', ')})`] : [];
      return {
        content: [{ type: 'text', text: [header, orderLine, ...conflictLines, ...notMatchedLine].join('\n') }],
        structuredContent,
      };
    },
  );

  // ui://trip-map App resource — the single-file HTML the host renders when build_itinerary returns.
  registerAppResource(
    server,
    'Trip Map',
    TRIP_MAP_RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      let html: string;
      try {
        html = await readFile(resolve(APP_DIST, 'trip-map.html'), 'utf-8');
      } catch {
        html =
          '<!DOCTYPE html><html><body style="font:14px system-ui;padding:24px">' +
          '<h3>Trip Map not built</h3><p>Run <code>npm run build:app</code> in the engagements capability to generate <code>dist/trip-map.html</code>.</p>' +
          '</body></html>';
      }
      return {
        contents: [
          {
            uri: TRIP_MAP_RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                // Azure Maps fetches tiles/styles/sprites from *.atlas.microsoft.com — the sandboxed
                // iframe has no same-origin server, so every origin must be declared here.
                csp: {
                  connectDomains: ['https://*.atlas.microsoft.com', 'https://atlas.microsoft.com'],
                  resourceDomains: ['https://*.atlas.microsoft.com', 'https://atlas.microsoft.com'],
                },
              },
            },
          },
        ],
      };
    },
  );
}
