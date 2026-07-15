/**
 * Topics-in-area — given a geographic area (centroid + radius) and the already-authorized contacts
 * (+ optional events), aggregate WHICH topics have a live footprint there and rank them by
 * opportunity. Pure + deterministic; the security trim runs upstream, so this only ever sees
 * records the caller may read.
 */
import type { Contact, EngagementEvent, GeoPoint, Topic } from '@greenhouse-resume-builder/shared';
import { haversineMi } from './distance';
import { isStale, loadConfig, DemoConfig } from './clock';

export interface TopicInArea {
  topicId: string;
  name: string;
  domain: string;
  smeAreas: string[];
  ownerOrg?: string;
  /** Whether a centrally-approved message exists (drives the "talking points ready" badge). */
  hasApprovedMessage: boolean;
  /** Active contacts in-area on this topic. */
  activeCount: number;
  /** Prospect (never-engaged) contacts in-area on this topic. */
  prospectCount: number;
  /** In-area active contacts on this topic that are stale (overdue for a touch). */
  staleCount: number;
  /** In-area events touching this topic. */
  eventCount: number;
  /** Σ strategicValue across in-area contacts on this topic. */
  strategicValueSum: number;
  /** Ranking heuristic — higher = more reason to go now. */
  opportunityScore: number;
  /** One-line "why this topic is hot here" (active/stale/prospect/event/message footprint). */
  reason: string;
}

/** Compose the human-readable "why it's hot" line for a topic's in-area footprint. */
function topicReason(a: Agg, hasApprovedMessage: boolean): string {
  const parts = [
    a.activeCount ? `${a.activeCount} active` : null,
    a.staleCount ? `${a.staleCount} stale (re-engage)` : null,
    a.prospectCount ? `${a.prospectCount} prospect` : null,
    a.eventCount ? `${a.eventCount} event${a.eventCount > 1 ? 's' : ''}` : null,
    a.strategicValueSum ? `Σ value ${a.strategicValueSum}` : null,
    hasApprovedMessage ? 'approved message ✓' : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'no live footprint';
}

export interface TopicsInAreaInput {
  centroid: GeoPoint;
  radiusMi: number;
  /** Security-trimmed contacts (only records the caller may read). */
  contacts: Contact[];
  /** Optional security-trimmed events — add prospect magnets + topic presence. */
  events?: EngagementEvent[];
  /** Topic catalog for names / domains / approved-message flag. */
  topics: Topic[];
  cfg?: DemoConfig;
}

interface Agg {
  activeCount: number;
  prospectCount: number;
  staleCount: number;
  eventCount: number;
  strategicValueSum: number;
}

const inRadius = (centroid: GeoPoint, p: GeoPoint, radiusMi: number): boolean =>
  haversineMi(centroid, p) <= radiusMi;

/** Aggregate + rank the topics with a live footprint inside the area. Highest opportunity first. */
export function topicsInArea(input: TopicsInAreaInput): TopicInArea[] {
  const cfg = input.cfg ?? loadConfig();
  const topicById = new Map(input.topics.map((t) => [t.id, t]));

  const agg = new Map<string, Agg>();
  const bump = (topicId: string, patch: Partial<Agg>): void => {
    const a =
      agg.get(topicId) ??
      { activeCount: 0, prospectCount: 0, staleCount: 0, eventCount: 0, strategicValueSum: 0 };
    agg.set(topicId, {
      activeCount: a.activeCount + (patch.activeCount ?? 0),
      prospectCount: a.prospectCount + (patch.prospectCount ?? 0),
      staleCount: a.staleCount + (patch.staleCount ?? 0),
      eventCount: a.eventCount + (patch.eventCount ?? 0),
      strategicValueSum: a.strategicValueSum + (patch.strategicValueSum ?? 0),
    });
  };

  for (const c of input.contacts) {
    if (!inRadius(input.centroid, c.location, input.radiusMi)) continue;
    const stale = c.status === 'active' && isStale(c.lastInteractionDate, cfg);
    for (const topicId of c.topicIds ?? []) {
      bump(topicId, {
        activeCount: c.status === 'active' ? 1 : 0,
        prospectCount: c.status === 'prospect' ? 1 : 0,
        staleCount: stale ? 1 : 0,
        strategicValueSum: c.strategicValue ?? 0,
      });
    }
  }

  for (const e of input.events ?? []) {
    if (!inRadius(input.centroid, e.location, input.radiusMi)) continue;
    for (const topicId of e.topicIds ?? []) bump(topicId, { eventCount: 1 });
  }

  const out: TopicInArea[] = [];
  for (const [topicId, a] of agg) {
    const t = topicById.get(topicId);
    // Opportunity: strategic weight + prospect upside + urgency from staleness + event leverage.
    const opportunityScore =
      a.strategicValueSum + a.prospectCount * 2 + a.staleCount * 3 + a.eventCount * 4;
    const hasApprovedMessage = !!(t && t.approvedMessageId);
    out.push({
      topicId,
      name: t?.name ?? topicId,
      domain: t?.domain ?? 'unknown',
      smeAreas: t?.smeAreas ?? [],
      ownerOrg: t?.ownerOrg,
      hasApprovedMessage,
      activeCount: a.activeCount,
      prospectCount: a.prospectCount,
      staleCount: a.staleCount,
      eventCount: a.eventCount,
      strategicValueSum: a.strategicValueSum,
      opportunityScore,
      reason: topicReason(a, hasApprovedMessage),
    });
  }
  return out.sort(
    (x, y) => y.opportunityScore - x.opportunityScore || x.topicId.localeCompare(y.topicId),
  );
}
