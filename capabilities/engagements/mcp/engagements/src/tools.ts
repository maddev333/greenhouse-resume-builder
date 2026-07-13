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
  planOptions,
  radiusPlan,
  DEFAULT_MEETINGS_PER_DAY,
  estimateDuration,
  haversineMi,
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
  type GeoPoint,
  type ResolvedArea,
  type RadiusPlanResult,
  type TopicInArea,
  type LeaderOption,
  type DurationOption,
  type ExtensionOption,
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

/** Add whole days to an ISO date (YYYY-MM-DD), UTC — used to synthesize a radius window from a day count. */
function isoAddDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

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
    distanceMi: round(c.distanceMi),
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
    distanceMi: round(o.distanceMi),
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

function conflictView(k: Conflict) {
  return { type: k.type, severity: k.severity, message: k.message, ...(k.recommendation ? { recommendation: k.recommendation } : {}) };
}

function durationOptionView(d: DurationOption) {
  return {
    tier: d.tier,
    days: d.days,
    duration: {
      onSiteDays: d.duration.onSiteDays,
      offSiteStops: d.duration.offSiteStops,
      travelMins: round(d.duration.travelMins),
      dwellMins: d.duration.dwellMins,
    },
    stops: d.stops.map((c) => ({ contactId: c.contactId, name: c.name, city: c.location.city, placement: c.placement, score: fixed(c.score) })),
    roiScore: fixed(d.roi.roiScore),
    overBudget: d.overBudget,
    conflicts: d.conflicts.map(conflictView),
  };
}

function extensionOptionView(e: ExtensionOption) {
  return {
    contactId: e.contactId,
    name: e.name,
    sector: e.sector,
    topicId: e.topicId,
    topicName: e.topicName,
    placement: e.placement,
    distanceMi: round(e.distanceMi),
    extraDays: e.extraDays,
    totalDays: e.totalDays,
    marginalRoi: fixed(e.marginalRoi),
    overBudget: e.overBudget,
    talkingPoints: e.talkingPoints,
    talkingPointsSource: e.talkingPointsSource,
    conflicts: e.conflicts.map(conflictView),
  };
}

function routeView(route: RouteResult) {
  return {
    order: route.order.map((s) => ({ id: s.id, city: s.location.city, kind: s.kind })),
    legs: route.legs.map((l) => ({
      from: l.fromStopId,
      to: l.toStopId,
      mode: l.mode,
      distanceMi: round(l.distanceMi),
      estTravelMins: round(l.estTravelMins),
    })),
    totalMi: round(route.totalMi),
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
  return buildTripMapFromOrigin(
    `${leader.name} @ ${event.name}`,
    {
      id: `event:${event.id}`,
      label: event.name,
      location: event.location,
      detail: `${event.location.city}${event.location.state ? `, ${event.location.state}` : ''} · ${event.start}→${event.end}`,
    },
    accepted,
    route,
    roi,
    caller,
  );
}

/** A generic trip origin — an event venue, a company HQ, or a raw coordinate the leader anchors on. */
interface MapOrigin {
  id: string;
  label: string;
  location: GeoPoint;
  detail: string;
}

/**
 * The event-agnostic core of the trip-map projection: place the origin pin, co-locate on-site stops
 * with it (they carry no travel leg), and wire the route legs. `buildTripMapPayload` (event trips) and
 * the radius/company-anchored trips both funnel through here, so the App wire format never diverges.
 */
function buildTripMapFromOrigin(
  title: string,
  origin: MapOrigin,
  accepted: Candidate[],
  route: RouteResult,
  roi: RoiResult,
  caller: string,
): TripMapPayload {
  const byContactId = new Map(accepted.map((c) => [c.contactId, c]));
  const originPoint: TripMapPoint = {
    id: origin.id,
    label: origin.label,
    lat: origin.location.lat,
    lng: origin.location.lng,
    kind: 'origin',
    detail: origin.detail,
  };
  const stops: TripMapPoint[] = route.order.map((s) => {
    const c = byContactId.get(s.id);
    // On-site contacts are met AT the anchor (they carry no travel leg), so co-locate their pin with
    // the origin rather than their home city — otherwise a home-based coordinate scatters the map.
    const atVenue = s.kind === 'on-site';
    return {
      id: s.id,
      label: c?.name ?? s.id,
      lat: atVenue ? origin.location.lat : s.location.lat,
      lng: atVenue ? origin.location.lng : s.location.lng,
      kind: s.kind, // SuggestionPlacement: 'on-site' | 'off-site'
      detail: c
        ? `${c.placement} · ${c.kind}${c.isStale ? ' · STALE' : ''} · val ${c.strategicValue} · score ${fixed(c.score)}`
        : `${s.location.city}${s.location.state ? `, ${s.location.state}` : ''}`,
    };
  });
  const byPointId = new Map<string, TripMapPoint>([[originPoint.id, originPoint], ...stops.map((p) => [p.id, p] as const)]);
  const legs: TripMapLeg[] = route.legs.map((l) => {
    const from = byPointId.get(l.fromStopId) ?? originPoint; // fromStopId === ORIGIN_ID → the anchor
    const to = byPointId.get(l.toStopId) ?? originPoint;
    return { fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng, mode: l.mode, distanceMi: round(l.distanceMi) };
  });
  return {
    title,
    origin: originPoint,
    stops,
    legs,
    roiScore: fixed(roi.roiScore),
    overBudget: roi.overBudget,
    totalMi: round(route.totalMi),
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

/**
 * Resolve a fixed-radius trip anchor from tool args → a centroid area (+ the must-meet contact when
 * one is named). Precedence: explicit contact id → company/contact NAME (matched against the already
 * authorized set, mirroring `search_contacts`) → raw coordinate → city/region centroid. Shared by
 * `plan_radius` and the event-less `build_itinerary` branch so both anchor identically.
 */
function resolveRadiusAnchor(
  contacts: Labeled<Contact>[],
  events: Labeled<EngagementEvent>[],
  regions: ReadModel['regions'],
  args: {
    anchorContactId?: string;
    company?: string;
    lat?: number;
    lng?: number;
    city?: string;
    state?: string;
    region?: string;
    regionId?: string;
    radiusMi?: number;
  },
): { area: ResolvedArea; anchorContact?: Labeled<Contact> } | { error: string } {
  // (a) explicit contact id — the strongest anchor signal.
  let anchorContact: Labeled<Contact> | undefined;
  if (args.anchorContactId) {
    anchorContact = contacts.find((c) => c.id === args.anchorContactId);
    if (!anchorContact) return { error: `Anchor contact '${args.anchorContactId}' is not in your authorized set.` };
  } else if (args.company && args.company.trim()) {
    // (b) resolve a company/contact by name/org against the trimmed set (substring, like search_contacts);
    //     prefer an org/company entity so "meet Meridian Robotics" anchors on the HQ, not an employee.
    const q = args.company.trim().toLowerCase();
    const hits = contacts.filter((c) => c.name.toLowerCase().includes(q) || (c.org?.toLowerCase().includes(q) ?? false));
    anchorContact = hits.find((c) => c.type === 'company' || c.type === 'org') ?? hits[0];
    if (!anchorContact) return { error: `No authorized company/contact matched '${args.company}'.` };
  }

  if (anchorContact) {
    const area = resolveArea(
      {
        lat: anchorContact.location.lat,
        lng: anchorContact.location.lng,
        city: anchorContact.location.city,
        state: anchorContact.location.state,
        label: anchorContact.org ?? anchorContact.name,
        radiusMi: args.radiusMi,
      },
      regions,
      [],
    );
    return area ? { area, anchorContact } : { error: 'Could not resolve an area around the anchor contact.' };
  }

  // (c) no named company → a raw coordinate or a city/region centroid.
  const knownPoints = [...contacts.map((c) => c.location), ...events.map((e) => e.location)];
  const area = resolveArea(
    { lat: args.lat, lng: args.lng, city: args.city, state: args.state, region: args.region, regionId: args.regionId, radiusMi: args.radiusMi },
    regions,
    knownPoints,
  );
  if (!area) {
    return { error: 'Provide an anchor: a company (anchorContactId or company name), a lat/lng coordinate, or a known city/region.' };
  }
  return { area };
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
        radiusMi: z.number().optional().describe('Override the search radius in mi (defaults to the region default or 100).'),
      },
    },
    async ({ regionId, region, city, state, radiusMi }): Promise<CallToolResult> => {
      const { ctx, label } = getContext();
      const rm = getReadModel();
      const contacts = await rm.searchContacts({ ctx });
      if (isRejected(contacts.filter)) {
        const structuredContent = { caller: label, rejected: true, today: rm.today, area: null, topics: [], redactedCount: 0, filter: contacts.filter };
        return { content: [{ type: 'text', text: 'Access rejected — no verified tenant claim.' }], structuredContent };
      }
      const events = await rm.searchEvents({ ctx });
      const knownPoints = [...contacts.items.map((c) => c.location), ...events.items.map((e) => e.location)];
      const area = resolveArea({ regionId, region, city, state, radiusMi }, rm.regions, knownPoints);
      if (!area) {
        const known = rm.regions.map((r) => `${r.id} (${r.name})`).join(', ');
        return errorResult(`Could not resolve an area from the given input. Try a known region: ${known}; or a city/state present in your contacts.`);
      }
      const topics = topicsInArea({
        centroid: area.centroid,
        radiusMi: area.radiusMi,
        contacts: contacts.items,
        events: events.items,
        topics: rm.topics,
      });
      const structuredContent = {
        caller: label,
        rejected: false,
        today: rm.today,
        area: { id: area.id, name: area.name, city: area.centroid.city, state: area.centroid.state, radiusMi: area.radiusMi, resolvedVia: area.resolvedVia },
        topicCount: topics.length,
        topics: topics.map(topicInAreaView),
        contactsInScope: contacts.items.length,
        redactedCount: contacts.redactedCount,
        filter: contacts.filter,
      };
      const header = `${area.name} (${area.radiusMi} mi): ${topics.length} topic(s) with a live footprint; ${contacts.redactedCount} contact(s) redacted by trim.`;
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
        radiusMi: z.number().optional().describe('Override the search radius in mi.'),
        window: z
          .object({ start: z.string(), end: z.string() })
          .describe('Planning window (ISO YYYY-MM-DD) the leader must be available in.'),
        topicIds: z.array(z.string()).optional().describe("Target topics to staff for; defaults to the area's in-scope topics."),
      },
    },
    async ({ regionId, region, city, state, radiusMi, window, topicIds }): Promise<CallToolResult> => {
      const { ctx, label } = getContext();
      const rm = getReadModel();
      const contacts = await rm.searchContacts({ ctx });
      if (isRejected(contacts.filter)) {
        const structuredContent = { caller: label, rejected: true, today: rm.today, area: null, leaders: [], redactedCount: 0, filter: contacts.filter };
        return { content: [{ type: 'text', text: 'Access rejected — no verified tenant claim.' }], structuredContent };
      }
      const events = await rm.searchEvents({ ctx });
      const knownPoints = [...contacts.items.map((c) => c.location), ...events.items.map((e) => e.location)];
      const area = resolveArea({ regionId, region, city, state, radiusMi }, rm.regions, knownPoints);
      if (!area) {
        const known = rm.regions.map((r) => `${r.id} (${r.name})`).join(', ');
        return errorResult(`Could not resolve an area from the given input. Try a known region: ${known}; or a city/state present in your contacts.`);
      }
      const inArea = contacts.items.filter((c) => haversineMi(area.centroid, c.location) <= area.radiusMi);
      const survey = topicsInArea({ centroid: area.centroid, radiusMi: area.radiusMi, contacts: contacts.items, events: events.items, topics: rm.topics });
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
        area: { id: area.id, name: area.name, city: area.centroid.city, state: area.centroid.state, radiusMi: area.radiusMi, resolvedVia: area.resolvedVia },
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
          `  ${i + 1}. ${o.leaderId} ${o.name} — score ${fixed(o.score)}, ${round(o.distanceMi)}mi, ${o.availableInWindow ? 'available' : 'UNAVAILABLE'}` +
          `${o.notes.length ? `, notes: ${o.notes.join('; ')}` : ''}`,
      );
      return { content: [{ type: 'text', text: [header, ...lines, `filter: ${contacts.filter}`].join('\n') }], structuredContent };
    },
  );

  // 5) plan_options — area-first CAPSTONE: survey → leader → duration → extensions, in one call
  server.registerTool(
    'plan_options',
    {
      title: 'Plan options for an area (survey → leader → duration → extensions)',
      description:
        'Area-first, OPTIONED planning in one call: anchor on a place + a date window and get (1) the ' +
        'topic survey, (2) ranked leader options (top pick chosen by default, alternatives kept), (3) ' +
        'tiered duration options (core vs extended, fully costed), and (4) extension options — each ' +
        "extra day's newly unlocked stop with its sector, topic, marginal ROI, and the APPROVED talking " +
        'points (or a coordinate-with-owner fallback). Advisory only; every list is ranked and the human ' +
        "decides. Runs over the caller's authorized records (same server-side trim + $filter reporting).",
      inputSchema: {
        regionId: z.string().optional().describe('Known region id (e.g. "R-NCR"). Highest precedence.'),
        region: z.string().optional().describe('Region name or alias (e.g. "NCR", "Bay Area") — case-insensitive.'),
        city: z.string().optional().describe('City to anchor on when no region matches.'),
        state: z.string().optional().describe('State to disambiguate the city.'),
        radiusMi: z.number().optional().describe('Override the in-area radius (mi).'),
        window: z
          .object({ start: z.string(), end: z.string() })
          .describe('Planning window (ISO YYYY-MM-DD) for availability + duration.'),
        leaderId: z.string().optional().describe('Force a specific leader; defaults to the top-ranked option.'),
        topicIds: z.array(z.string()).optional().describe("Target topics; defaults to the area's in-scope topics."),
        requireTopicMatch: z.boolean().optional().describe('Drop candidate stops off the target topics (default false — a broad menu).'),
      },
    },
    async ({ regionId, region, city, state, radiusMi, window, leaderId, topicIds, requireTopicMatch }): Promise<CallToolResult> => {
      const { ctx, label } = getContext();
      const rm = getReadModel();
      const contacts = await rm.searchContacts({ ctx });
      if (isRejected(contacts.filter)) {
        const structuredContent = { caller: label, rejected: true, today: rm.today, area: null, areaSurvey: [], leaderOptions: [], durationOptions: [], extensionOptions: [], redactedCount: 0, filter: contacts.filter };
        return { content: [{ type: 'text', text: 'Access rejected — no verified tenant claim.' }], structuredContent };
      }
      const events = await rm.searchEvents({ ctx });
      const knownPoints = [...contacts.items.map((c) => c.location), ...events.items.map((e) => e.location)];
      const area = resolveArea({ regionId, region, city, state, radiusMi }, rm.regions, knownPoints);
      if (!area) {
        const known = rm.regions.map((r) => `${r.id} (${r.name})`).join(', ');
        return errorResult(`Could not resolve an area from the given input. Try a known region: ${known}; or a city/state present in your contacts.`);
      }
      const plan = planOptions({
        area,
        window,
        contacts: contacts.items,
        events: events.items,
        leaders: rm.leaders,
        topics: rm.topics,
        messages: rm.messages,
        topicIds,
        leaderId,
        requireTopicMatch,
      });
      const structuredContent = {
        caller: label,
        rejected: false,
        today: rm.today,
        area: { id: area.id, name: area.name, city: area.centroid.city, state: area.centroid.state, radiusMi: area.radiusMi, resolvedVia: area.resolvedVia },
        window,
        topicIds: plan.topicIds,
        areaSurvey: plan.areaSurvey.map(topicInAreaView),
        chosenLeaderId: plan.chosenLeaderId,
        leaderOptions: plan.leaderOptions.map(leaderOptionView),
        onSiteDays: plan.onSiteDays,
        absorbedEventIds: plan.absorbedEventIds,
        durationOptions: plan.durationOptions.map(durationOptionView),
        extensionOptions: plan.extensionOptions.map(extensionOptionView),
        redactedCount: contacts.redactedCount,
        filter: contacts.filter,
      };
      const chosen = plan.leaderOptions.find((o) => o.leaderId === plan.chosenLeaderId);
      const header =
        `${area.name} (${area.radiusMi} mi) over ${window.start}→${window.end}: ${plan.areaSurvey.length} topic(s); ` +
        `recommend ${chosen ? `${chosen.leaderId} ${chosen.name}` : '(no leader)'}; ` +
        `${plan.durationOptions.length} duration option(s); ${plan.extensionOptions.length} extension(s).`;
      const durLines = plan.durationOptions.map(
        (d) => `  • ${d.tier}: ${d.days} day(s), ${d.stops.length} stop(s), ROI ${fixed(d.roi.roiScore)}${d.overBudget ? ' (OVER BUDGET)' : ''}`,
      );
      const extLines = plan.extensionOptions.slice(0, 5).map((e) => {
        const pts = e.talkingPoints.slice(0, 3).map((p) => `“${p}”`).join('; ');
        return `  • +${e.extraDays}d → ${e.contactId} ${e.name}${e.sector ? ` (${e.sector})` : ''} on ${e.topicId ?? '—'}, mROI ${fixed(e.marginalRoi)} · ${e.talkingPointsSource}: ${pts}`;
      });
      return {
        content: [{ type: 'text', text: [header, 'duration:', ...durLines, 'extensions:', ...extLines, `filter: ${contacts.filter}`].join('\n') }],
        structuredContent,
      };
    },
  );

  // 5b) plan_radius — company/coords-first FIXED-DURATION planning (event-OPTIONAL): "go meet <company>
  //     (or be within X mi of <place>) for N days" → fill the trip with the best authorized contacts.
  server.registerTool(
    'plan_radius',
    {
      title: 'Plan a fixed-duration trip around a company or location',
      description:
        'Radius-first planning for when a leader must visit a SPECIFIC company (or place) for a FIXED ' +
        'number of days, with NO anchor event. Anchor by company (anchorContactId or a company name), a ' +
        'raw lat/lng, or a city/region; set a radius and the trip length. Fills days × meetingsPerDay slots ' +
        'with the mandatory anchor (met on-site) + the highest-value authorized contacts within the radius, ' +
        'and returns the leftover as "+N day unlocks …" extension options. Feed the accepted stops to ' +
        'build_itinerary (with the same anchor) to render the map. Fail-closed: no verified tenant ⇒ rejected.',
      inputSchema: {
        anchorContactId: z.string().optional().describe('Must-meet company/contact id (e.g. "C3"); becomes stop #1, met on-site.'),
        company: z.string().optional().describe('Free-text company/contact name ("Meridian Robotics") resolved to the anchor when no id is given.'),
        lat: z.number().optional().describe('Raw anchor latitude (with lng) when the leader is going to a coordinate, not a named company.'),
        lng: z.number().optional().describe('Raw anchor longitude (with lat).'),
        city: z.string().optional().describe('City centroid anchor (alternative to a company/coordinate).'),
        state: z.string().optional().describe('State for the city anchor.'),
        region: z.string().optional().describe('Free-text region/alias ("NCR", "DC metro").'),
        regionId: z.string().optional().describe('Known region id (e.g. "R-NCR").'),
        radiusMi: z.number().positive().optional().describe('Search radius around the anchor (mi). Defaults to the region/area default.'),
        days: z.number().int().positive().describe('FIXED trip length in days the leader is on the ground.'),
        meetingsPerDay: z.number().int().positive().optional().describe(`Meetings/day capacity (default ${DEFAULT_MEETINGS_PER_DAY}).`),
        window: z.object({ start: z.string(), end: z.string() }).describe('Planning window (ISO YYYY-MM-DD) for availability + budget checks.'),
        leaderId: z.string().optional().describe('Force a specific leader; defaults to the top-ranked option for the area.'),
        topicIds: z.array(z.string()).optional().describe("Target topics; defaults to the area's in-scope topics."),
        requireTopicMatch: z.boolean().optional().describe('Drop stops off the target topics (default false — a broad menu).'),
      },
    },
    async ({
      anchorContactId,
      company,
      lat,
      lng,
      city,
      state,
      region,
      regionId,
      radiusMi,
      days,
      meetingsPerDay,
      window,
      leaderId,
      topicIds,
      requireTopicMatch,
    }): Promise<CallToolResult> => {
      const { ctx, label } = getContext();
      const rm = getReadModel();
      const contacts = await rm.searchContacts({ ctx });
      if (isRejected(contacts.filter)) {
        const structuredContent = { caller: label, rejected: true, today: rm.today, anchor: null, area: null, areaSurvey: [], leaderOptions: [], stops: [], extensionOptions: [], redactedCount: 0, filter: contacts.filter };
        return { content: [{ type: 'text', text: 'Access rejected — no verified tenant claim.' }], structuredContent };
      }
      const events = await rm.searchEvents({ ctx });
      const resolved = resolveRadiusAnchor(contacts.items, events.items, rm.regions, { anchorContactId, company, lat, lng, city, state, region, regionId, radiusMi });
      if ('error' in resolved) return errorResult(resolved.error);
      const { area, anchorContact } = resolved;

      const areaSurvey = topicsInArea({ centroid: area.centroid, radiusMi: area.radiusMi, contacts: contacts.items, events: events.items, topics: rm.topics });
      const effectiveTopicIds = topicIds?.length ? topicIds : areaSurvey.map((t) => t.topicId);
      const inArea = contacts.items.filter((c) => haversineMi(area.centroid, c.location) <= area.radiusMi);
      const leaderOptions = suggestLeaders({ centroid: area.centroid, window, topicIds: effectiveTopicIds, leaders: rm.leaders, topics: rm.topics, contacts: inArea });
      const chosen = leaderId
        ? rm.leaders.find((l) => l.id === leaderId)
        : leaderOptions[0]
          ? rm.leaders.find((l) => l.id === leaderOptions[0].leaderId)
          : undefined;

      const areaView = { id: area.id, name: area.name, city: area.centroid.city, state: area.centroid.state, lat: area.centroid.lat, lng: area.centroid.lng, radiusMi: area.radiusMi, resolvedVia: area.resolvedVia };
      if (!chosen) {
        const structuredContent = {
          caller: label,
          rejected: false,
          today: rm.today,
          anchor: anchorContact ? { contactId: anchorContact.id, name: anchorContact.name } : null,
          area: areaView,
          window,
          days,
          meetingsPerDay: meetingsPerDay ?? DEFAULT_MEETINGS_PER_DAY,
          topicIds: effectiveTopicIds,
          areaSurvey: areaSurvey.map(topicInAreaView),
          chosenLeaderId: null,
          leaderOptions: leaderOptions.map(leaderOptionView),
          stops: [],
          extensionOptions: [],
          redactedCount: contacts.redactedCount,
          filter: contacts.filter,
        };
        return { content: [{ type: 'text', text: `No eligible leader for ${area.name}.` }], structuredContent };
      }

      const plan = radiusPlan({
        leader: chosen,
        area,
        window,
        days,
        meetingsPerDay,
        anchorContactId: anchorContact?.id,
        contacts: contacts.items,
        events: events.items,
        topics: rm.topics,
        messages: rm.messages,
        topicIds: effectiveTopicIds,
        requireTopicMatch,
      });

      const structuredContent = {
        caller: label,
        rejected: false,
        today: rm.today,
        anchor: plan.anchor,
        area: areaView,
        window,
        days: plan.days,
        meetingsPerDay: plan.meetingsPerDay,
        capacity: plan.capacity,
        topicIds: plan.topicIds,
        areaSurvey: areaSurvey.map(topicInAreaView),
        chosenLeaderId: chosen.id,
        leaderOptions: leaderOptions.map(leaderOptionView),
        stops: plan.stops.map(candidateView),
        route: routeView(plan.route),
        duration: { days: plan.duration.days, onSiteDays: plan.duration.onSiteDays, offSiteStops: plan.duration.offSiteStops, travelMins: round(plan.duration.travelMins), dwellMins: plan.duration.dwellMins },
        roi: plan.roi,
        conflicts: plan.conflicts.map(conflictView),
        overflowCount: plan.overflowCount,
        extensionOptions: plan.extensionOptions.map(extensionOptionView),
        redactedCount: contacts.redactedCount,
        filter: contacts.filter,
      };

      const header =
        `${chosen.name} → ${area.name} (${area.radiusMi} mi), ${plan.days} day(s) @ ${plan.meetingsPerDay}/day = ${plan.capacity} slot(s): ` +
        `${plan.stops.length} stop(s)${plan.anchor ? ` (anchor ${plan.anchor.contactId} ${plan.anchor.name})` : ''}, ` +
        `ROI ${fixed(plan.roi.roiScore)}${plan.roi.overBudget ? ' (OVER BUDGET)' : ''}; ${plan.extensionOptions.length} extension(s).`;
      const stopLines = plan.stops.map(
        (s, i) => `  ${i + 1}. ${s.contactId} ${s.name} — ${s.placement}, ${s.location.city}, val ${s.strategicValue}, score ${fixed(s.score)}`,
      );
      const extLines = plan.extensionOptions.slice(0, 5).map((e) => {
        const pts = e.talkingPoints.slice(0, 2).map((p) => `“${p}”`).join('; ');
        return `  • +${e.extraDays}d → ${e.contactId} ${e.name}${e.sector ? ` (${e.sector})` : ''} on ${e.topicId ?? '—'}, mROI ${fixed(e.marginalRoi)} · ${e.talkingPointsSource}: ${pts}`;
      });
      return {
        content: [{ type: 'text', text: [header, 'stops:', ...stopLines, 'extensions:', ...extLines, `filter: ${contacts.filter}`].join('\n') }],
        structuredContent,
      };
    },
  );

  // 6) suggest_candidates — the "you're already going there" nudge
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

  // 7) build_itinerary — route + ROI + conflicts for the accepted picks, rendered on ui://trip-map (M3).
  //    Two modes: EVENT-anchored (acceptedContactIds from suggest_candidates) or RADIUS-anchored /
  //    event-less (a company/coordinate/city + a fixed day count, from plan_radius).
  registerAppTool(
    server,
    'build_itinerary',
    {
      title: 'Build a trip itinerary',
      description:
        'Given a leader and EITHER an anchor event OR a fixed-radius anchor (a company / coordinate / city ' +
        '+ a day count), order the stops (on-site first, then nearest-neighbor off-site), compute trip-ROI ' +
        '(value minus airfare / per-diem / time penalty), and surface advisory conflicts (fit, availability-' +
        'budget, opportunity-cost). Event mode takes acceptedContactIds from suggest_candidates; radius mode ' +
        '(no event) takes the company/coords + days from plan_radius — omit acceptedContactIds to accept the ' +
        "auto-filled plan. Renders ui://trip-map. Only accepts ids from the caller's authorized set.",
      inputSchema: {
        leaderId: z.string().describe('Leader whose time is being allocated (e.g. "L1").'),
        eventId: z.string().optional().describe('Event mode: anchor event id (e.g. "E-AUSA").'),
        eventQuery: z.string().optional().describe('Event mode: free-text anchor ("AUSA") resolved to one authorized event.'),
        anchorContactId: z.string().optional().describe('Radius mode: must-meet company/contact id, met on-site as stop #1.'),
        company: z.string().optional().describe('Radius mode: company/contact name resolved to the anchor when no id is given.'),
        lat: z.number().optional().describe('Radius mode: raw anchor latitude (with lng).'),
        lng: z.number().optional().describe('Radius mode: raw anchor longitude (with lat).'),
        city: z.string().optional().describe('Radius mode: city centroid anchor.'),
        state: z.string().optional().describe('Radius mode: state for the city anchor.'),
        region: z.string().optional().describe('Radius mode: free-text region/alias ("NCR").'),
        regionId: z.string().optional().describe('Radius mode: known region id (e.g. "R-NCR").'),
        radiusMi: z.number().positive().optional().describe('Radius mode: search radius around the anchor (mi).'),
        days: z.number().int().positive().optional().describe('Radius mode: FIXED trip length in days (required when there is no event).'),
        meetingsPerDay: z.number().int().positive().optional().describe('Radius mode: meetings/day capacity.'),
        window: z.object({ start: z.string(), end: z.string() }).optional().describe('Radius mode planning window (ISO); defaults to today → today+days-1.'),
        acceptedContactIds: z
          .array(z.string())
          .optional()
          .describe('Chosen stop ids. Event mode: from suggest_candidates (required). Radius mode: from plan_radius (omit to accept the auto-filled plan).'),
        topicIds: z.array(z.string()).optional().describe('Topic focus (keeps the candidate set consistent with the plan step).'),
        requireTopicMatch: z.boolean().optional().describe('Event mode default true; radius mode default false.'),
      },
      _meta: { ui: { resourceUri: TRIP_MAP_RESOURCE_URI } },
    },
    async ({
      leaderId,
      eventId,
      eventQuery,
      anchorContactId,
      company,
      lat,
      lng,
      city,
      state,
      region,
      regionId,
      radiusMi,
      days,
      meetingsPerDay,
      window,
      acceptedContactIds,
      topicIds,
      requireTopicMatch,
    }): Promise<CallToolResult> => {
      const { ctx, label } = getContext();
      const rm = getReadModel();
      const eventMode = !!(eventId || eventQuery);

      if (eventMode) {
        // ── EVENT-anchored build ──────────────────────────────────────────
        const r = await runSuggest(rm, ctx, { leaderId, eventId, eventQuery, topicIds, requireTopicMatch });
        if (!r.ok) return errorResult(r.error);

        const ids = acceptedContactIds ?? [];
        const accepted = r.candidates.filter((c) => ids.includes(c.contactId));
        const notMatched = ids.filter((id) => !accepted.some((c) => c.contactId === id));
        if (accepted.length === 0) {
          return errorResult(
            `None of [${ids.join(', ')}] are in ${r.leader.name}'s authorized candidate set for ${r.event.name}.`,
          );
        }

        const stops: RouteStop[] = accepted.map((c) => ({ id: c.contactId, location: c.location, kind: c.placement }));
        const route = planRoute(r.event.location, stops);
        // Stop-derived duration: on-site/conference days + off-site travel + per-stop dwell, bucketed to
        // whole days (replaces the old, wrong days = event-window span, which ignored the off-site legs).
        const onSiteDays = daysBetween(r.event.start, r.event.end) + 1;
        const duration = estimateDuration(route, onSiteDays);
        const days2 = duration.days;
        const roi = tripRoi(accepted.map((c) => c.score), route.legs, days2, r.leader.daysAwayBudget);

        const conflicts: Conflict[] = [
          ...accepted.flatMap((c) => {
            const contact = r.contactsById.get(c.contactId);
            return contact ? detectFit(r.leader, contact) : [];
          }),
          ...detectAvailabilityBudget(r.leader, { start: r.event.start, end: r.event.end }, days2),
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
          duration: { days: days2, onSiteDays: duration.onSiteDays, offSiteStops: duration.offSiteStops, travelMins: round(duration.travelMins), dwellMins: duration.dwellMins },
          roi,
          conflicts,
          tripMap,
          filter: r.filter,
          redactedCount: r.redactedCount,
        };
        const header =
          `Itinerary for ${r.leader.name} @ ${r.event.name}: ${accepted.length} stop(s), ` +
          `${days2} day(s), ROI ${fixed(roi.roiScore)}${roi.overBudget ? ' (OVER BUDGET)' : ''}.`;
        const orderLine = `  route: ${route.order.map((s) => s.location.city).join(' → ')}`;
        const conflictLines = conflicts.length
          ? conflicts.map((c) => `  ⚠ ${c.severity}/${c.type}: ${c.message}`)
          : ['  no conflicts flagged'];
        const notMatchedLine = notMatched.length ? [`  (ignored, not authorized/suggested: ${notMatched.join(', ')})`] : [];
        return {
          content: [{ type: 'text', text: [header, orderLine, ...conflictLines, ...notMatchedLine].join('\n') }],
          structuredContent,
        };
      }

      // ── RADIUS-anchored build (event-less) ────────────────────────────────
      const leader = findLeader(rm, leaderId);
      if (!leader) return errorResult(`Unknown leader '${leaderId}'.`);
      if (!days) return errorResult("Radius build needs a day count ('days') — the leader's fixed trip length.");
      const contacts = await rm.searchContacts({ ctx });
      if (isRejected(contacts.filter)) return errorResult('Access rejected — no verified tenant claim.');
      const events = await rm.searchEvents({ ctx });
      const resolved = resolveRadiusAnchor(contacts.items, events.items, rm.regions, { anchorContactId, company, lat, lng, city, state, region, regionId, radiusMi });
      if ('error' in resolved) return errorResult(resolved.error);
      const { area, anchorContact } = resolved;
      const win = window ?? { start: rm.today, end: isoAddDays(rm.today, Math.max(0, days - 1)) };

      const plan = radiusPlan({
        leader,
        area,
        window: win,
        days,
        meetingsPerDay,
        anchorContactId: anchorContact?.id,
        acceptedContactIds,
        contacts: contacts.items,
        events: events.items,
        topics: rm.topics,
        messages: rm.messages,
        topicIds,
        requireTopicMatch,
      });
      if (plan.stops.length === 0) return errorResult(`No authorized stops within ${area.radiusMi} mi of ${area.name}.`);

      const chosenIds = new Set(plan.stops.map((s) => s.contactId));
      const notMatched = (acceptedContactIds ?? []).filter((id) => !chosenIds.has(id));
      const origin: MapOrigin = anchorContact
        ? {
            id: `contact:${anchorContact.id}`,
            label: anchorContact.org ?? anchorContact.name,
            location: anchorContact.location,
            detail: `${anchorContact.location.city}${anchorContact.location.state ? `, ${anchorContact.location.state}` : ''} · anchor`,
          }
        : {
            id: `area:${area.id}`,
            label: area.name,
            location: area.centroid,
            detail: `${area.centroid.city}${area.centroid.state ? `, ${area.centroid.state}` : ''} · ${area.radiusMi} mi`,
          };
      const tripMap = buildTripMapFromOrigin(`${leader.name} @ ${origin.label}`, origin, plan.stops, plan.route, plan.roi, label);
      const structuredContent = {
        caller: label,
        today: rm.today,
        leader: { id: leader.id, name: leader.name, role: leader.role, daysAwayBudget: leader.daysAwayBudget },
        anchor: plan.anchor,
        area: { id: area.id, name: area.name, city: area.centroid.city, state: area.centroid.state, lat: area.centroid.lat, lng: area.centroid.lng, radiusMi: area.radiusMi, resolvedVia: area.resolvedVia },
        window: win,
        days: plan.days,
        meetingsPerDay: plan.meetingsPerDay,
        capacity: plan.capacity,
        accepted: plan.stops.map(candidateView),
        notMatched,
        route: routeView(plan.route),
        duration: { days: plan.duration.days, onSiteDays: plan.duration.onSiteDays, offSiteStops: plan.duration.offSiteStops, travelMins: round(plan.duration.travelMins), dwellMins: plan.duration.dwellMins },
        roi: plan.roi,
        conflicts: plan.conflicts.map(conflictView),
        overflowCount: plan.overflowCount,
        extensionOptions: plan.extensionOptions.map(extensionOptionView),
        tripMap,
        filter: contacts.filter,
        redactedCount: contacts.redactedCount,
      };
      const header =
        `Itinerary for ${leader.name} @ ${origin.label} (${area.radiusMi} mi): ${plan.stops.length} stop(s), ` +
        `${plan.days} day(s), ROI ${fixed(plan.roi.roiScore)}${plan.roi.overBudget ? ' (OVER BUDGET)' : ''}.`;
      const orderLine = `  route: ${plan.route.order.map((s) => s.location.city).join(' → ')}`;
      const conflictLines = plan.conflicts.length
        ? plan.conflicts.map((c) => `  ⚠ ${c.severity}/${c.type}: ${c.message}`)
        : ['  no conflicts flagged'];
      const notMatchedLine = notMatched.length ? [`  (ignored, not authorized/in-radius: ${notMatched.join(', ')})`] : [];
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
