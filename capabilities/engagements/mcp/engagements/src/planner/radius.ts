/**
 * Radius planning (event-OPTIONAL, fixed-duration) — the "a leader has to go meet a specific
 * company (or place) and is there for N days" entry point. Unlike the area-first `planOptions`
 * (which derives trip length from the route and offers Core/Extended tiers), here the EA fixes the
 * DURATION up front and we FILL it: capacity = `days × meetingsPerDay`, seeded with the mandatory
 * anchor company (met on-site at its HQ) and then the highest-value authorized contacts within the
 * radius. Whatever doesn't fit becomes a "+N day unlocks …" extension option (same surface as the
 * area flow), so the EA still always sees options.
 *
 * Pure + deterministic; only ever sees already-authorized records (the security trim runs upstream
 * in the read model). Composes the existing engine primitives rather than reinventing them.
 */
import type {
  Contact,
  DateRange,
  EngagementEvent,
  Leader,
  Message,
  Topic,
} from '@greenhouse-resume-builder/shared';
import { DEFAULT_WEIGHTS, PlannerWeights } from './weights';
import { demoToday, isStale, loadConfig, DemoConfig } from './clock';
import { suggestionScore } from './score';
import { fitFlags } from './suggest';
import { planRoute } from './route';
import { tripRoi } from './roi';
import { detectAvailabilityBudget, detectFit, detectOpportunityCost } from './conflicts';
import {
  estimateDuration,
  extensionOptions,
  gatherAreaCandidates,
  type DurationEstimate,
  type ExtensionOption,
} from './plan';
import type { ResolvedArea } from './area';
import type { Candidate, Conflict, RoiResult, RouteResult, RouteStop } from './types';

/** Default meetings a leader can realistically take per on-the-ground day (dwell + local travel). */
export const DEFAULT_MEETINGS_PER_DAY = 2;

export interface RadiusPlanInput {
  leader: Leader;
  /** Resolved anchor: a company HQ, a raw coordinate, or a city/region centroid, + its radius. */
  area: ResolvedArea;
  window: DateRange;
  /** Fixed trip length in whole days the leader is on the ground (>= 1). */
  days: number;
  /** Meetings/day capacity (default {@link DEFAULT_MEETINGS_PER_DAY}). */
  meetingsPerDay?: number;
  /** The must-meet company/contact — pinned as the first (on-site) stop when authorized. */
  anchorContactId?: string;
  /**
   * When set, the trip commits to exactly these stops (plus the anchor) instead of auto-filling the
   * fixed days — the build step passes the EA's chosen ids so route/ROI are costed on the real trip.
   * Everything else within the radius still surfaces as extension options.
   */
  acceptedContactIds?: string[];
  /** Security-trimmed contacts (only records the caller may read). */
  contacts: Contact[];
  /** Security-trimmed events — nearby in-window ones still absorb as on-site context. */
  events: EngagementEvent[];
  topics: Topic[];
  messages: Message[];
  topicIds?: string[];
  requireTopicMatch?: boolean;
  reachRadiusKm?: number;
  weights?: PlannerWeights;
  cfg?: DemoConfig;
}

export interface RadiusPlanResult {
  area: ResolvedArea;
  window: DateRange;
  days: number;
  meetingsPerDay: number;
  /** days × meetingsPerDay — the max stops (including the anchor) the trip holds. */
  capacity: number;
  topicIds: string[];
  /** The mandatory-first company/contact, when one was given and authorized. */
  anchor: { contactId: string; name: string } | null;
  /** Chosen stops (anchor first, then top-scored fill), capped at `capacity`. */
  stops: Candidate[];
  /** How many authorized off-site contacts within radius did NOT fit the fixed days. */
  overflowCount: number;
  duration: DurationEstimate;
  route: RouteResult;
  roi: RoiResult;
  conflicts: Conflict[];
  /** The overflow, priced as marginal "+N day unlocks X on topic Y (talking points)" add-ons. */
  extensionOptions: ExtensionOption[];
}

/** Build a Candidate for the anchor company itself — met on-site at its HQ (distance 0). */
function anchorCandidate(
  leader: Leader,
  c: Contact,
  topicIds: string[],
  cfg: DemoConfig,
  w: PlannerWeights,
): Candidate {
  const targetTopics = topicIds.length ? topicIds : undefined;
  const { score, factors } = suggestionScore(c, targetTopics, demoToday(cfg), w);
  return {
    contactId: c.id,
    name: c.name,
    location: c.location,
    distanceKm: 0,
    placement: 'on-site',
    kind: c.status === 'prospect' ? 'initiate' : 're-engage',
    status: c.status,
    isStale: isStale(c.lastInteractionDate, cfg),
    strategicValue: c.strategicValue,
    score,
    factors,
    fitFlags: fitFlags(leader, c, w),
  };
}

/**
 * Plan a fixed-duration trip around an anchor: fill `days × meetingsPerDay` slots with the anchor
 * company (if any) plus the highest-value authorized contacts within the radius; everything that
 * doesn't fit becomes an extension option. ROI is costed against the FIXED `days` (the leader is on
 * the ground that long regardless of the route), while the route/dwell breakdown stays transparent.
 */
export function radiusPlan(input: RadiusPlanInput): RadiusPlanResult {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const cfg = input.cfg ?? loadConfig();
  const perDay = Math.max(1, Math.round(input.meetingsPerDay ?? DEFAULT_MEETINGS_PER_DAY));
  const days = Math.max(1, Math.round(input.days));
  const capacity = Math.max(1, days * perDay);
  const { centroid, radiusKm } = input.area;
  // The EA's radius bounds the whole trip — do NOT widen to the engine's default "nearby" reach the
  // area-first flow uses (that would pull in stops beyond the radius the user explicitly asked for).
  const reachRadiusKm = Math.max(radiusKm, input.reachRadiusKm ?? radiusKm);
  const contactsById = new Map(input.contacts.map((c) => [c.id, c]));
  const topicIds = input.topicIds ?? [];

  // 1) Source candidates by GEOGRAPHY around the centroid — the highest-value authorized contacts
  //    physically within the radius. This is a pure-radius fill: unlike the area/event flow, we do
  //    NOT absorb nearby events' rosters, because the leader is anchored on the company/coordinate,
  //    not attending a conference. Absorbing an in-area event would pull in its far-HQ exhibitor
  //    prospects (met "on-site" at distance 0) and pollute a trip the EA explicitly bounded by km.
  const gathered = gatherAreaCandidates({
    leader: input.leader,
    centroid,
    radiusKm,
    reachRadiusKm,
    window: input.window,
    contacts: input.contacts,
    events: [],
    topicIds: topicIds.length ? topicIds : undefined,
    requireTopicMatch: input.requireTopicMatch,
    weights: w,
    cfg,
  });

  // 2) Pin the must-meet company to the front as an on-site stop (met AT its HQ, distance 0).
  let ordered = [...gathered.candidates];
  let anchor: { contactId: string; name: string } | null = null;
  const anchorContact = input.anchorContactId ? contactsById.get(input.anchorContactId) : undefined;
  if (anchorContact) {
    anchor = { contactId: anchorContact.id, name: anchorContact.name };
    ordered = ordered.filter((c) => c.contactId !== anchorContact.id);
    ordered.unshift(anchorCandidate(input.leader, anchorContact, topicIds, cfg, w));
  }

  // 3) Fill the fixed days: anchor (if any) + top-scored others, capped at capacity. When the EA has
  //    committed a stop set (build step), honour exactly those (plus the anchor) instead of auto-fill.
  let stops: Candidate[];
  if (input.acceptedContactIds) {
    const accept = new Set(input.acceptedContactIds);
    if (anchor) accept.add(anchor.contactId);
    stops = ordered.filter((c) => accept.has(c.contactId));
  } else {
    stops = ordered.slice(0, capacity);
  }
  const chosenIds = new Set(stops.map((c) => c.contactId));
  const overflow = ordered.filter((c) => !chosenIds.has(c.contactId) && c.placement === 'off-site');

  // 4) Cost the chosen trip against the FIXED days (route/dwell breakdown stays "show-your-math").
  const routeStops: RouteStop[] = stops.map((c) => ({ id: c.contactId, location: c.location, kind: c.placement }));
  const route = planRoute(centroid, routeStops, w);
  const estimate = estimateDuration(route, 0);
  const duration: DurationEstimate = { ...estimate, days, onSiteDays: 0 };
  const roi = tripRoi(stops.map((c) => c.score), route.legs, days, input.leader.daysAwayBudget, w);
  const conflicts: Conflict[] = [
    ...stops.flatMap((c) => {
      const ct = contactsById.get(c.contactId);
      return ct ? detectFit(input.leader, ct, w) : [];
    }),
    ...detectAvailabilityBudget(input.leader, input.window, days),
    ...detectOpportunityCost(roi, w),
  ];

  // 5) The overflow becomes "extend the trip" options, each with its topic's talking points. We reuse
  //    the area-flow's marginal analysis for ROI/topic/talking-points/conflicts, but OVERRIDE the day
  //    math: this is a FIXED-days, capacity model, so a route-based "extra days" (≈0 for tightly
  //    clustered stops) is meaningless. Each extra on-the-ground day unlocks `perDay` more meetings,
  //    so the i-th highest-value overflow stop needs ⌊i / perDay⌋ + 1 extra day(s) to fit.
  const ext = extensionOptions({
    base: stops,
    offered: overflow,
    centroid,
    leader: input.leader,
    window: input.window,
    onSiteDays: 0,
    contactsById,
    topics: input.topics,
    messages: input.messages,
    topicIds,
    weights: w,
  }).map((e, i) => {
    const extraDays = Math.floor(i / perDay) + 1;
    return { ...e, extraDays, totalDays: days + extraDays };
  });

  return {
    area: input.area,
    window: input.window,
    days,
    meetingsPerDay: perDay,
    capacity,
    topicIds,
    anchor,
    stops,
    overflowCount: overflow.length,
    duration,
    route,
    roi,
    conflicts,
    extensionOptions: ext,
  };
}
