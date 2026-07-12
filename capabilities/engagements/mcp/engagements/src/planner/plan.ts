/**
 * Area-first OPTIONED planning (Phase 3) — turn a resolved area + a date window into a single
 * `PlanOptions` envelope the agent renders as menus along each axis:
 *   - duration  → how long (stop-derived, not the event window): Core vs Extended tiers.
 *   - extension → "+N day unlocks THIS stop on THIS topic — here are the approved talking points."
 *
 * Everything here is PURE + deterministic and only ever sees already-authorized records (the
 * security trim runs upstream in the read model). It composes the existing engine primitives
 * (`suggest`, `planRoute`, `tripRoi`, the conflict detectors) rather than reinventing them, so the
 * "show-your-math" story stays consistent (ARCHITECTURE §6, MVP-PLAN §5.1).
 */
import type {
  Contact,
  DateRange,
  EngagementEvent,
  GeoPoint,
  Leader,
  Message,
  Sector,
  SuggestionPlacement,
  Topic,
} from '@greenhouse-resume-builder/shared';
import { DEFAULT_WEIGHTS, PlannerWeights } from './weights';
import { daysBetween, loadConfig, DemoConfig } from './clock';
import { haversineKm } from './distance';
import { suggest } from './suggest';
import { planRoute } from './route';
import { tripRoi } from './roi';
import { detectAvailabilityBudget, detectFit, detectOpportunityCost } from './conflicts';
import { topicsInArea, type TopicInArea } from './topics';
import { suggestLeaders, type LeaderOption, type LeaderWeights } from './leaders';
import type { ResolvedArea } from './area';
import type { Anchor, Candidate, Conflict, RouteResult, RoiResult, RouteStop } from './types';

/** A working day is eight hours of on-the-ground travel + meetings before it rolls to the next day. */
export const WORKDAY_MINUTES = 8 * 60;
/** Default per-off-site-meeting dwell (arrive, meet, depart), minutes. */
export const DEFAULT_DWELL_MINS = 120;
/** How many nearest in-area off-site stops the smallest ("core") trip keeps. */
export const CORE_OFFSITE_N = 1;
/** Upper bound of off-site stops the "extended" bundle considers. */
export const EXTENDED_OFFSITE_N = 4;

// ── Duration (stop-derived) ───────────────────────────────────────────────

/** The "show-your-math" breakdown behind an estimated trip length. */
export interface DurationEstimate {
  days: number; // bucketed whole days (>= 1)
  onSiteDays: number; // conference/on-site base
  offSiteStops: number;
  travelMins: number;
  dwellMins: number;
  workdayMins: number;
}

/**
 * Estimate a trip's length from its ROUTE, not the anchor event's calendar window (which was the
 * old, wrong `days = end − start + 1`). On-site/conference days form the base; off-site legs
 * (`route.totalTravelMins`) plus per-stop dwell are bucketed into whole added days.
 */
export function estimateDuration(
  route: RouteResult,
  onSiteDays: number,
  dwellPerStopMins: number = DEFAULT_DWELL_MINS,
  workdayMins: number = WORKDAY_MINUTES,
): DurationEstimate {
  const offSiteStops = route.order.filter((s) => s.kind === 'off-site').length;
  const travelMins = route.totalTravelMins;
  const dwellMins = offSiteStops * dwellPerStopMins;
  const extraDays = workdayMins > 0 ? Math.ceil((travelMins + dwellMins) / workdayMins) : 0;
  const base = Math.max(0, Math.round(onSiteDays));
  return { days: Math.max(1, base + extraDays), onSiteDays: base, offSiteStops, travelMins, dwellMins, workdayMins };
}

// ── Costing a stop set (route + duration + ROI + conflicts) ────────────────

interface CostedTrip {
  stops: Candidate[];
  route: RouteResult;
  duration: DurationEstimate;
  roi: RoiResult;
  conflicts: Conflict[];
}

function costTrip(
  stops: Candidate[],
  centroid: GeoPoint,
  leader: Leader,
  window: DateRange,
  onSiteDays: number,
  contactsById: Map<string, Contact>,
  w: PlannerWeights,
): CostedTrip {
  const routeStops: RouteStop[] = stops.map((c) => ({ id: c.contactId, location: c.location, kind: c.placement }));
  const route = planRoute(centroid, routeStops, w);
  const duration = estimateDuration(route, onSiteDays);
  const roi = tripRoi(stops.map((c) => c.score), route.legs, duration.days, leader.daysAwayBudget, w);
  const conflicts: Conflict[] = [
    ...stops.flatMap((c) => {
      const ct = contactsById.get(c.contactId);
      return ct ? detectFit(leader, ct, w) : [];
    }),
    ...detectAvailabilityBudget(leader, window, duration.days),
    ...detectOpportunityCost(roi, w),
  ];
  return { stops, route, duration, roi, conflicts };
}

// ── Candidate sourcing for an area (event auto-absorption) ─────────────────

const rangesOverlap = (aStart: string, aEnd: string, bStart: string, bEnd: string): boolean =>
  aStart <= bEnd && bStart <= aEnd;

export interface AreaCandidatesInput {
  leader: Leader;
  centroid: GeoPoint;
  /** In-area radius (km) — bounds the events that get auto-absorbed as on-site sub-anchors. */
  radiusKm: number;
  /** Wider reachable radius (km) for off-site sourcing, so farther "+1 day" stops surface. */
  reachRadiusKm?: number;
  window: DateRange;
  contacts: Contact[];
  events: EngagementEvent[];
  topicIds?: string[];
  requireTopicMatch?: boolean;
  weights?: PlannerWeights;
  cfg?: DemoConfig;
}

export interface AreaCandidates {
  candidates: Candidate[];
  absorbedEvents: EngagementEvent[];
  onSiteDays: number;
}

/**
 * Gather the trip's candidate stops around an area: off-site relationships within a (wider) reach
 * radius of the centroid, PLUS the on-site attendees/exhibitor-prospects of any authorized events
 * that fall inside the area + window (so "just an area" is as rich as "an event"). On-site wins over
 * off-site on dedupe. Highest score first.
 */
export function gatherAreaCandidates(input: AreaCandidatesInput): AreaCandidates {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const reach = Math.max(input.radiusKm, input.reachRadiusKm ?? input.radiusKm);
  const absorbed = input.events.filter(
    (e) =>
      haversineKm(input.centroid, e.location) <= input.radiusKm &&
      rangesOverlap(e.start, e.end, input.window.start, input.window.end),
  );

  const byId = new Map<string, Candidate>();
  const put = (c: Candidate): void => {
    const cur = byId.get(c.contactId);
    if (!cur) {
      byId.set(c.contactId, c);
      return;
    }
    if (cur.placement === 'on-site') return; // keep the on-site variant
    if (c.placement === 'on-site' || c.score > cur.score) byId.set(c.contactId, c);
  };

  // (1) off-site relationships within reach of the area centroid (event-less anchor).
  const areaAnchor: Anchor = { id: `area:${input.centroid.city}`, location: input.centroid, window: input.window, topicIds: input.topicIds };
  for (const c of suggest({ leader: input.leader, anchor: areaAnchor, contacts: input.contacts, radiusKm: reach, requireTopicMatch: input.requireTopicMatch, weights: w, cfg: input.cfg })) {
    put(c);
  }

  // (2) on-site attendees + exhibitor prospects from each absorbed in-area event.
  for (const ev of absorbed) {
    const anchor: Anchor = { id: ev.id, eventId: ev.id, location: ev.location, window: { start: ev.start, end: ev.end }, topicIds: ev.topicIds };
    for (const c of suggest({ leader: input.leader, anchor, contacts: input.contacts, event: ev, radiusKm: reach, requireTopicMatch: input.requireTopicMatch, weights: w, cfg: input.cfg })) {
      if (c.placement === 'on-site') put(c);
    }
  }

  const onSiteDays = absorbed.length ? Math.max(...absorbed.map((e) => daysBetween(e.start, e.end) + 1)) : 0;
  const candidates = [...byId.values()].sort((a, b) => b.score - a.score || a.contactId.localeCompare(b.contactId));
  return { candidates, absorbedEvents: absorbed, onSiteDays };
}

// ── Duration options (Core vs Extended tiers) ──────────────────────────────

export interface DurationOption {
  tier: 'core' | 'extended';
  days: number;
  duration: DurationEstimate;
  stops: Candidate[];
  roi: RoiResult;
  conflicts: Conflict[];
  overBudget: boolean;
}

export interface DurationOptionsInput {
  candidates: Candidate[];
  centroid: GeoPoint;
  leader: Leader;
  window: DateRange;
  onSiteDays: number;
  /** In-area radius (km) — bounds which off-site stops belong to the tight "core" trip. */
  coreRadiusKm: number;
  contactsById: Map<string, Contact>;
  weights?: PlannerWeights;
}

function toDurationOption(tier: DurationOption['tier'], c: CostedTrip): DurationOption {
  return { tier, days: c.duration.days, duration: c.duration, stops: c.stops, roi: c.roi, conflicts: c.conflicts, overBudget: c.roi.overBudget };
}

/**
 * Tiered, fully-costed whole-trip options:
 *   - Core     — on-site + the nearest in-area high-value off-site stop (smallest viable trip).
 *   - Extended — on-site + the top off-site stops (adds the +1/+2-day reach); only when it adds stops.
 */
export function durationOptions(input: DurationOptionsInput): DurationOption[] {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const onSite = input.candidates.filter((c) => c.placement === 'on-site');
  const offSite = input.candidates.filter((c) => c.placement === 'off-site'); // already score-sorted
  const coreOff = offSite.filter((c) => c.distanceKm <= input.coreRadiusKm).slice(0, CORE_OFFSITE_N);
  const coreStops = [...onSite, ...coreOff];
  const extendedStops = [...onSite, ...offSite.slice(0, EXTENDED_OFFSITE_N)];

  const options: DurationOption[] = [
    toDurationOption('core', costTrip(coreStops, input.centroid, input.leader, input.window, input.onSiteDays, input.contactsById, w)),
  ];
  if (extendedStops.length > coreStops.length) {
    options.push(toDurationOption('extended', costTrip(extendedStops, input.centroid, input.leader, input.window, input.onSiteDays, input.contactsById, w)));
  }
  return options;
}

// ── Extension options ("+N day unlocks …") ────────────────────────────────

export interface ExtensionOption {
  contactId: string;
  name: string;
  sector?: Sector;
  topicId?: string;
  topicName?: string;
  placement: SuggestionPlacement;
  distanceKm: number;
  /** Days this stop adds on top of the base plan. */
  extraDays: number;
  totalDays: number;
  /** ROI(base + this stop) − ROI(base): added value net of added cost. */
  marginalRoi: number;
  overBudget: boolean;
  /** Approved talking points for the topic, or a graceful "coordinate with the owner" fallback. */
  talkingPoints: string[];
  talkingPointsSource: 'approved-message' | 'coordinate';
  conflicts: Conflict[];
}

function pickTopic(contact: Contact | undefined, targetTopicIds: string[] | undefined, topicById: Map<string, Topic>): Topic | undefined {
  const ids = contact?.topicIds ?? [];
  const target = new Set(targetTopicIds ?? []);
  const hit = ids.find((id) => target.has(id)) ?? ids[0];
  return hit ? topicById.get(hit) : undefined;
}

/** Approved talking points for a topic (`Topic.approvedMessageId` → `Message.intendedPoints`), or a fallback. */
export function talkingPointsFor(
  topic: Topic | undefined,
  messages: Message[],
): { points: string[]; source: 'approved-message' | 'coordinate' } {
  if (topic?.approvedMessageId) {
    const m = messages.find((x) => x.id === topic.approvedMessageId && x.status === 'approved');
    if (m && m.intendedPoints.length) return { points: m.intendedPoints, source: 'approved-message' };
  }
  const owner = topic?.ownerOrg ?? 'the topic owner';
  return { points: [`No approved message yet — coordinate talking points with ${owner} before engaging.`], source: 'coordinate' };
}

export interface ExtensionOptionsInput {
  /** The base (usually "core") stop set the extensions are measured against. */
  base: Candidate[];
  /** The extra off-site candidates to offer, each priced individually as a marginal add. */
  offered: Candidate[];
  centroid: GeoPoint;
  leader: Leader;
  window: DateRange;
  onSiteDays: number;
  contactsById: Map<string, Contact>;
  topics: Topic[];
  messages: Message[];
  topicIds?: string[];
  weights?: PlannerWeights;
}

/**
 * Marginal analysis: for each offered stop, cost `base + stop`, and report the ADDED days, the
 * marginal ROI, and the approved talking points for the stop's in-scope topic. This is exactly the
 * "extend 1 day → meet this industry/academic/political entity on this topic; here's the message"
 * surface. Ranked by marginal ROI, then by fewest extra days.
 */
export function extensionOptions(input: ExtensionOptionsInput): ExtensionOption[] {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const topicById = new Map(input.topics.map((t) => [t.id, t]));
  const baseCost = costTrip(input.base, input.centroid, input.leader, input.window, input.onSiteDays, input.contactsById, w);

  const out: ExtensionOption[] = input.offered.map((c) => {
    const cost = costTrip([...input.base, c], input.centroid, input.leader, input.window, input.onSiteDays, input.contactsById, w);
    const ct = input.contactsById.get(c.contactId);
    const topic = pickTopic(ct, input.topicIds, topicById);
    const tp = talkingPointsFor(topic, input.messages);
    return {
      contactId: c.contactId,
      name: c.name,
      sector: ct?.sector,
      topicId: topic?.id,
      topicName: topic?.name,
      placement: c.placement,
      distanceKm: c.distanceKm,
      extraDays: Math.max(0, cost.duration.days - baseCost.duration.days),
      totalDays: cost.duration.days,
      marginalRoi: cost.roi.roiScore - baseCost.roi.roiScore,
      overBudget: cost.roi.overBudget,
      talkingPoints: tp.points,
      talkingPointsSource: tp.source,
      conflicts: cost.conflicts,
    };
  });

  return out.sort(
    (a, b) => b.marginalRoi - a.marginalRoi || a.extraDays - b.extraDays || a.contactId.localeCompare(b.contactId),
  );
}

// ── The unified PlanOptions envelope ───────────────────────────────────────

export interface PlanOptionsInput {
  area: ResolvedArea;
  window: DateRange;
  /** Security-trimmed contacts (only records the caller may read). */
  contacts: Contact[];
  /** Security-trimmed events. */
  events: EngagementEvent[];
  /** The caller's leader roster. */
  leaders: Leader[];
  topics: Topic[];
  messages: Message[];
  /** Explicit topic focus; defaults to the topics present in the area survey. */
  topicIds?: string[];
  /** Explicit leader; defaults to the top-ranked `suggestLeaders` option. */
  leaderId?: string;
  requireTopicMatch?: boolean;
  reachRadiusKm?: number;
  weights?: PlannerWeights;
  leaderWeights?: LeaderWeights;
  cfg?: DemoConfig;
}

export interface PlanOptionsResult {
  area: ResolvedArea;
  window: DateRange;
  topicIds: string[];
  areaSurvey: TopicInArea[];
  leaderOptions: LeaderOption[];
  chosenLeaderId: string | null;
  onSiteDays: number;
  absorbedEventIds: string[];
  durationOptions: DurationOption[];
  extensionOptions: ExtensionOption[];
}

/**
 * Build the full optioned plan for an area + window: what's here (survey), who should go (leaders),
 * how long (duration tiers), and what each extra day unlocks (extensions w/ talking points). The
 * top-ranked leader is chosen by default and the alternatives stay on the menu (advisor, not
 * optimizer). Pure — the tool supplies already-trimmed data and renders the envelope.
 */
export function planOptions(input: PlanOptionsInput): PlanOptionsResult {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const { centroid, radiusKm } = input.area;
  const inArea = input.contacts.filter((c) => haversineKm(centroid, c.location) <= radiusKm);

  const areaSurvey = topicsInArea({ centroid, radiusKm, contacts: input.contacts, events: input.events, topics: input.topics, cfg: input.cfg });
  const topicIds = input.topicIds?.length ? input.topicIds : areaSurvey.map((t) => t.topicId);

  const leaderOptions = suggestLeaders({ centroid, window: input.window, topicIds, leaders: input.leaders, topics: input.topics, contacts: inArea, weights: input.leaderWeights });
  const chosen = input.leaderId
    ? input.leaders.find((l) => l.id === input.leaderId)
    : leaderOptions[0]
      ? input.leaders.find((l) => l.id === leaderOptions[0].leaderId)
      : undefined;

  if (!chosen) {
    return { area: input.area, window: input.window, topicIds, areaSurvey, leaderOptions, chosenLeaderId: null, onSiteDays: 0, absorbedEventIds: [], durationOptions: [], extensionOptions: [] };
  }

  const reachRadiusKm = Math.max(radiusKm, input.reachRadiusKm ?? Math.max(radiusKm, w.nearbyRadiusKm));
  const gathered = gatherAreaCandidates({
    leader: chosen,
    centroid,
    radiusKm,
    reachRadiusKm,
    window: input.window,
    contacts: input.contacts,
    events: input.events,
    topicIds,
    requireTopicMatch: input.requireTopicMatch,
    weights: w,
    cfg: input.cfg,
  });
  const contactsById = new Map(input.contacts.map((c) => [c.id, c]));

  const dOptions = durationOptions({ candidates: gathered.candidates, centroid, leader: chosen, window: input.window, onSiteDays: gathered.onSiteDays, coreRadiusKm: radiusKm, contactsById, weights: w });

  const coreStops = dOptions[0]?.stops ?? [];
  const coreIds = new Set(coreStops.map((c) => c.contactId));
  const offered = gathered.candidates.filter((c) => c.placement === 'off-site' && !coreIds.has(c.contactId));
  const eOptions = extensionOptions({ base: coreStops, offered, centroid, leader: chosen, window: input.window, onSiteDays: gathered.onSiteDays, contactsById, topics: input.topics, messages: input.messages, topicIds, weights: w });

  return {
    area: input.area,
    window: input.window,
    topicIds,
    areaSurvey,
    leaderOptions,
    chosenLeaderId: chosen.id,
    onSiteDays: gathered.onSiteDays,
    absorbedEventIds: gathered.absorbedEvents.map((e) => e.id),
    durationOptions: dOptions,
    extensionOptions: eOptions,
  };
}
