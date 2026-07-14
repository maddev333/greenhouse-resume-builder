/**
 * Area intelligence — the "what's going on here, and why should I care?" briefing that sits on top
 * of the raw area survey. Given a geographic area (centroid + radius) and the already-authorized
 * contacts/events, it names the concrete signals an EA acts on:
 *
 *   - staleContactsInArea → the ACTIVE relationships in the area overdue for a touch (who, how far
 *     past their cadence, and how strategically valuable) — the "re-engage while you're there" list.
 *   - eventsInArea        → the in-area events with a freshness verdict: a lapsed event whose
 *     after-action follow-up is overdue, an event happening in-window, or an upcoming on-site magnet.
 *
 * Pure + deterministic (the security trim runs upstream, so this only ever sees records the caller
 * may read). It complements {@link topicsInArea}, which answers WHICH topics are hot; this answers
 * WHICH specific people/events are the reason, with a one-line "why" for each.
 */
import type { Contact, EngagementEvent, GeoPoint, Sector } from '@greenhouse-resume-builder/shared';
import { haversineMi } from './distance';
import { isStale, loadConfig, demoToday, shiftDateByMonths, daysBetween, DemoConfig } from './clock';

const inRadius = (centroid: GeoPoint, p: GeoPoint, radiusMi: number): boolean =>
  haversineMi(centroid, p) <= radiusMi;

const monthsAgo = (days: number): number => Math.max(1, Math.round(days / 30));

// ── Stale relationships in the area ────────────────────────────────────────

/** An active in-area relationship overdue for a touch, with the "why it's stale" spelled out. */
export interface StaleContact {
  contactId: string;
  name: string;
  org?: string;
  sector?: Sector;
  city?: string;
  state?: string;
  topicIds: string[];
  strategicValue: number;
  distanceMi: number;
  /** (Shifted) last-interaction date. */
  lastInteractionDate: string;
  /** Whole days since that last touch (relative to the demo clock). */
  daysSinceContact: number;
  /** Rounded months since the last touch (for the human-readable reason). */
  monthsSinceContact: number;
  /** Days past the cadence cutoff (`daysSinceContact − staleCutoffDays`, floored at 0). */
  overdueDays: number;
  /** One-line "why re-engage now". */
  reason: string;
}

export interface StaleContactsInput {
  centroid: GeoPoint;
  radiusMi: number;
  /** Security-trimmed contacts (only records the caller may read). */
  contacts: Contact[];
  cfg?: DemoConfig;
}

/**
 * The active relationships inside the area that are overdue for a touch (see {@link isStale}).
 * Prospects (no history) are never "stale" — they surface as a separate freshness signal in the
 * area survey's prospect count. Sorted most-overdue first, then by strategic value.
 */
export function staleContactsInArea(input: StaleContactsInput): StaleContact[] {
  const cfg = input.cfg ?? loadConfig();
  const today = demoToday(cfg);
  const cutoff = cfg.staleCutoffDays ?? 180;

  const out: StaleContact[] = [];
  for (const c of input.contacts) {
    if (c.status !== 'active' || !c.lastInteractionDate) continue;
    if (!inRadius(input.centroid, c.location, input.radiusMi)) continue;
    if (!isStale(c.lastInteractionDate, cfg)) continue;

    const last = shiftDateByMonths(c.lastInteractionDate, cfg.shiftMonths || 0);
    const daysSinceContact = daysBetween(last, today);
    const overdueDays = Math.max(0, daysSinceContact - cutoff);
    const months = monthsAgo(daysSinceContact);
    const strategicValue = c.strategicValue ?? 0;
    out.push({
      contactId: c.id,
      name: c.name,
      org: c.org,
      sector: c.sector,
      city: c.location.city,
      state: c.location.state,
      topicIds: c.topicIds ?? [],
      strategicValue,
      distanceMi: Math.round(haversineMi(input.centroid, c.location)),
      lastInteractionDate: last,
      daysSinceContact,
      monthsSinceContact: months,
      overdueDays,
      reason:
        `last touched ${last} (~${months} mo ago) — ${overdueDays}d past the ${cutoff}-day cadence` +
        `; strategic value ${strategicValue}/5`,
    });
  }
  return out.sort(
    (a, b) =>
      b.daysSinceContact - a.daysSinceContact ||
      b.strategicValue - a.strategicValue ||
      a.contactId.localeCompare(b.contactId),
  );
}

// ── Event freshness in the area ────────────────────────────────────────────

export type AreaEventStatus = 'lapsed' | 'in-window' | 'upcoming';

/** An in-area event with a freshness verdict + the "why it matters" reason. */
export interface AreaEvent {
  eventId: string;
  name: string;
  city?: string;
  state?: string;
  /** (Shifted) start/end. */
  start: string;
  end: string;
  topicIds: string[];
  attendees?: number;
  status: AreaEventStatus;
  /** Days until it starts (`upcoming`), or since it ended (`lapsed`); 0 for `in-window`. */
  daysUntil?: number;
  daysSince?: number;
  /** One-line "why it matters" (follow-up overdue / happening now / on-site magnet). */
  reason: string;
}

export interface EventsInAreaInput {
  centroid: GeoPoint;
  radiusMi: number;
  /** Security-trimmed events (only records the caller may read). */
  events: EngagementEvent[];
  cfg?: DemoConfig;
}

const STATUS_RANK: Record<AreaEventStatus, number> = { 'in-window': 0, upcoming: 1, lapsed: 2 };

/**
 * The in-area events, each classified relative to the demo clock: a `lapsed` event whose
 * after-action follow-up is overdue, one happening `in-window`, or an `upcoming` on-site magnet.
 * Sorted by urgency (happening now → soonest upcoming → most-recently lapsed).
 */
export function eventsInArea(input: EventsInAreaInput): AreaEvent[] {
  const cfg = input.cfg ?? loadConfig();
  const today = demoToday(cfg);

  const out: AreaEvent[] = [];
  for (const e of input.events) {
    if (!inRadius(input.centroid, e.location, input.radiusMi)) continue;
    const start = shiftDateByMonths(e.start, cfg.shiftMonths || 0);
    const end = shiftDateByMonths(e.end, cfg.shiftMonths || 0);
    const attendees = e.scale?.attendees;

    let status: AreaEventStatus;
    let daysUntil: number | undefined;
    let daysSince: number | undefined;
    let reason: string;
    if (end < today) {
      status = 'lapsed';
      daysSince = daysBetween(end, today);
      reason = `ended ${end} (${daysSince}d ago) — after-action / follow-up overdue`;
    } else if (start <= today) {
      status = 'in-window';
      reason = `happening now (through ${end})` + (attendees ? ` · ~${attendees} attendees` : '');
    } else {
      status = 'upcoming';
      daysUntil = daysBetween(today, start);
      reason = `in ${daysUntil}d (${start}) — on-site magnet` + (attendees ? ` · ~${attendees} attendees` : '');
    }

    out.push({
      eventId: e.id,
      name: e.name,
      city: e.location.city,
      state: e.location.state,
      start,
      end,
      topicIds: e.topicIds ?? [],
      attendees,
      status,
      daysUntil,
      daysSince,
      reason,
    });
  }
  return out.sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      (a.daysUntil ?? a.daysSince ?? 0) - (b.daysUntil ?? b.daysSince ?? 0) ||
      a.eventId.localeCompare(b.eventId),
  );
}
