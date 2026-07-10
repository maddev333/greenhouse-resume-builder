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
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  EngagementIndex,
  suggest,
  anchorFromEvent,
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
  type Conflict,
  type RouteResult,
  type RouteStop,
  type Labeled,
} from './engine.js';
import type { ResolvedContext } from './context.js';

type ContextProvider = () => ResolvedContext;

/** Instance type of the retrieval index (the value is default-imported via engine.ts, so name its type here). */
type Index = InstanceType<typeof EngagementIndex>;

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
  return idx.labeled.leaders.find((l) => l.id === leaderId);
}

/** Resolve the anchor event through the SAME security-trimmed event search the caller would see. */
function resolveEvent(
  idx: Index,
  ctx: ResolvedContext['ctx'],
  opts: { eventId?: string; eventQuery?: string },
): { event?: Labeled<EngagementEvent>; filter: string; redactedCount: number } {
  const res = idx.searchEvents({ ctx, query: opts.eventQuery });
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

/** Run the shared "resolve leader → resolve anchor → trim contacts → suggest" pipeline once. */
function runSuggest(
  idx: Index,
  ctx: ResolvedContext['ctx'],
  args: { leaderId: string; eventId?: string; eventQuery?: string; topicIds?: string[]; requireTopicMatch?: boolean },
):
  | { ok: false; rejected: boolean; error: string }
  | {
      ok: true;
      leader: Labeled<Leader>;
      event: Labeled<EngagementEvent>;
      candidates: Candidate[];
      contactsById: Map<string, Labeled<Contact>>;
      filter: string;
      redactedCount: number;
    } {
  const leader = findLeader(idx, args.leaderId);
  if (!leader) return { ok: false, rejected: false, error: `Unknown leader '${args.leaderId}'.` };

  const { event, filter: eventFilter } = resolveEvent(idx, ctx, { eventId: args.eventId, eventQuery: args.eventQuery });
  if (!event) {
    if (isRejected(eventFilter)) {
      return { ok: false, rejected: true, error: 'Access rejected fail-closed — no verified tenant claim.' };
    }
    const which = args.eventId ?? args.eventQuery ?? '(none given)';
    return { ok: false, rejected: false, error: `No authorized anchor event matched '${which}'.` };
  }

  const contacts = idx.searchContacts({ ctx, topicIds: args.topicIds });
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
      const idx = EngagementIndex.load();
      const res = idx.searchContacts({ ctx, query, topicIds, status });
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
      const idx = EngagementIndex.load();
      const res = idx.searchEvents({ ctx, query, topicIds });
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

  // 3) suggest_candidates — the "you're already going there" nudge
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
      const idx = EngagementIndex.load();
      const r = runSuggest(idx, ctx, { leaderId, eventId, eventQuery, topicIds, requireTopicMatch });
      if (!r.ok) {
        if (r.rejected) {
          const structuredContent = { caller: label, rejected: true, today: idx.today, candidates: [], redactedCount: 0, filter: '(rejected)', reason: r.error };
          return { content: [{ type: 'text', text: `Access rejected — ${r.error}` }], structuredContent };
        }
        return errorResult(r.error);
      }

      const candidates = r.candidates.map(candidateView);
      const structuredContent = {
        caller: label,
        rejected: isRejected(r.filter),
        today: idx.today,
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

  // 4) build_itinerary — route + ROI + conflicts for the accepted picks
  server.registerTool(
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
    },
    async ({ leaderId, eventId, eventQuery, acceptedContactIds, topicIds, requireTopicMatch }): Promise<CallToolResult> => {
      const { ctx, label } = getContext();
      const idx = EngagementIndex.load();
      const r = runSuggest(idx, ctx, { leaderId, eventId, eventQuery, topicIds, requireTopicMatch });
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

      const structuredContent = {
        caller: label,
        today: idx.today,
        leader: { id: r.leader.id, name: r.leader.name, role: r.leader.role, daysAwayBudget: r.leader.daysAwayBudget },
        event: { id: r.event.id, name: r.event.name, city: r.event.location.city, start: r.event.start, end: r.event.end },
        accepted: accepted.map(candidateView),
        notMatched,
        route: routeView(route),
        roi,
        conflicts,
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
}
