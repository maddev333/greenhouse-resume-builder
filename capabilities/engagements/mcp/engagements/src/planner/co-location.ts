/**
 * Co-location awareness — given a planned trip (a leader, an anchor location + window, the stops
 * being met, and optionally the anchor event), surface OTHER senior leaders who will plausibly be at
 * — or close to — the same place: sharing the anchor EVENT, holding the relationship with a CONTACT
 * on the itinerary, or simply based within reach and available (GEO). This deconflicts calendars and
 * enables joint calls / warm hand-offs. Advisory only — it flags awareness, never blocks a plan
 * (ARCHITECTURE §6). Pure + deterministic; the tool supplies already-authorized records.
 */
import type { Contact, DateRange, EngagementEvent, GeoPoint, Leader } from '@greenhouse-resume-builder/shared';
import { DEFAULT_WEIGHTS, PlannerWeights } from './weights';
import { haversineMi } from './distance';

/** Why another leader is flagged as near / co-located, in descending relevance. */
export type NearbyReasonType = 'same-event' | 'same-contact' | 'nearby-geo';

/** Lower = more relevant (a shared event beats mere geographic proximity). */
const REASON_PRIORITY: Record<NearbyReasonType, number> = {
  'same-event': 0,
  'same-contact': 1,
  'nearby-geo': 2,
};

export interface NearbyReason {
  type: NearbyReasonType;
  /** Human-readable "show-your-math" explanation of the tie. */
  detail: string;
  /** Contact ids that link the two leaders (same-event / same-contact). */
  contactIds?: string[];
  /** Home-base distance from the anchor (mi) — set for nearby-geo; 0 for a shared event/contact. */
  distanceMi?: number;
}

export interface NearbyLeader {
  leaderId: string;
  name: string;
  role: string;
  level?: string;
  homeBaseCity: string;
  /** Awareness proximity (mi): 0 when co-located via a shared event/contact, else the home-base distance. */
  distanceMi: number;
  /** Straight-line distance from the anchor to the leader's home base (mi) — always populated. */
  homeBaseDistanceMi: number;
  /** Whether the leader has any availability overlapping the planning window. */
  availableInWindow: boolean;
  /** Highest-priority reason present, for quick badging. */
  primaryReason: NearbyReasonType;
  /** Every awareness reason, most-relevant first. */
  reasons: NearbyReason[];
}

export interface NearbyLeadersInput {
  /** The leader being planned for — always excluded from the results (pass '' to exclude none). */
  planningLeaderId: string;
  /** The trip anchor (event venue or area centroid). */
  location: GeoPoint;
  /** The planning window — availability overlap is computed against it. */
  window: DateRange;
  /** The full leader roster. */
  leaders: Leader[];
  /** Authorized contacts — powers same-contact (owners of the stops) + same-event (owners of the roster). */
  contacts: Contact[];
  /** Contact ids being met on this trip (the accepted stops) — drives the same-contact signal. */
  stopContactIds?: string[];
  /** The anchor event, when the trip is event-anchored — drives the same-event signal. */
  event?: EngagementEvent;
  /** Home-base proximity threshold (mi) for the nearby-geo signal (defaults to weights.nearbyRadiusMi). */
  nearbyRadiusMi?: number;
  weights?: PlannerWeights;
}

/** True when any of the leader's availability ranges overlaps the window (inclusive). */
function availableInWindow(availability: DateRange[] | undefined, window: DateRange): boolean {
  return (availability ?? []).some((r) => r.start <= window.end && window.start <= r.end);
}

/** Group contact ids by each of their relationship-owner leader ids. */
function ownersOf(contactIds: string[], contactById: Map<string, Contact>): Map<string, string[]> {
  const byOwner = new Map<string, string[]>();
  for (const cid of contactIds) {
    const c = contactById.get(cid);
    for (const owner of c?.relationshipOwnerLeaderIds ?? []) {
      const arr = byOwner.get(owner) ?? [];
      arr.push(cid);
      byOwner.set(owner, arr);
    }
  }
  return byOwner;
}

/**
 * Detect the OTHER senior leaders who are — or will plausibly be — at/near the trip anchor, tagging
 * each with WHY (same event, same contact, or geographically near). Returns one entry per leader
 * (reasons merged), ranked by the strongest reason, then proximity, then id. Deterministic.
 */
export function nearbyLeaders(input: NearbyLeadersInput): NearbyLeader[] {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const radiusMi = input.nearbyRadiusMi ?? w.nearbyRadiusMi;
  const contactById = new Map(input.contacts.map((c) => [c.id, c]));

  const byLeader = new Map<string, NearbyReason[]>();
  const push = (leaderId: string, reason: NearbyReason): void => {
    if (!leaderId || leaderId === input.planningLeaderId) return;
    const list = byLeader.get(leaderId) ?? [];
    list.push(reason);
    byLeader.set(leaderId, list);
  };

  // (1) same-event — a leader who holds a relationship with a contact on the event's roster
  //     (existing attendees + exhibitor prospects): they have standing business AT this event.
  if (input.event) {
    const roster = [...input.event.attendingContactIds, ...input.event.exhibitorProspectIds];
    for (const [owner, cids] of ownersOf(roster, contactById)) {
      push(owner, {
        type: 'same-event',
        detail: `holds ${cids.length} relationship(s) at ${input.event.name} (${cids.join(', ')})`,
        contactIds: cids,
        distanceMi: 0,
      });
    }
  }

  // (2) same-contact — a leader who owns a contact that is a STOP on this itinerary: coordinate the
  //     message / consider a joint call so the contact hears one consistent voice.
  for (const [owner, cids] of ownersOf(input.stopContactIds ?? [], contactById)) {
    push(owner, {
      type: 'same-contact',
      detail: `owns the relationship with ${cids.length} stop(s) on this trip (${cids.join(', ')})`,
      contactIds: cids,
      distanceMi: 0,
    });
  }

  // (3) nearby-geo — a leader based within reach of the anchor and available in the window.
  for (const leader of input.leaders) {
    if (leader.id === input.planningLeaderId) continue;
    const dist = haversineMi(input.location, leader.homeBase);
    if (dist <= radiusMi && availableInWindow(leader.availability, input.window)) {
      push(leader.id, {
        type: 'nearby-geo',
        detail: `home base ${leader.homeBase.city} is ${Math.round(dist)} mi from the anchor`,
        distanceMi: dist,
      });
    }
  }

  const leaderById = new Map(input.leaders.map((l) => [l.id, l]));
  const out: NearbyLeader[] = [];
  for (const [leaderId, reasons] of byLeader) {
    const leader = leaderById.get(leaderId);
    if (!leader) continue;
    reasons.sort((a, b) => REASON_PRIORITY[a.type] - REASON_PRIORITY[b.type]);
    const homeBaseDistanceMi = haversineMi(input.location, leader.homeBase);
    const distanceMi = Math.min(...reasons.map((r) => r.distanceMi ?? homeBaseDistanceMi));
    out.push({
      leaderId,
      name: leader.name,
      role: leader.role,
      level: leader.level,
      homeBaseCity: leader.homeBase.city,
      distanceMi,
      homeBaseDistanceMi,
      availableInWindow: availableInWindow(leader.availability, input.window),
      primaryReason: reasons[0].type,
      reasons,
    });
  }

  return out.sort(
    (a, b) =>
      REASON_PRIORITY[a.primaryReason] - REASON_PRIORITY[b.primaryReason] ||
      a.distanceMi - b.distanceMi ||
      a.leaderId.localeCompare(b.leaderId),
  );
}
