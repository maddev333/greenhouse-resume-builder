/**
 * Candidate suggestion — the heart of the "you're already going there" nudge.
 * Unions three candidate sources against a trip anchor and ranks them by `suggestionScore`:
 *   (a) event ATTENDEES — existing contacts on-site → travel ≈ 0, tagged `re-engage`/`on-site`
 *   (b) NEARBY contacts within radius of the anchor → tagged `re-engage`/`off-site`
 *   (c) event exhibitor PROSPECTS — new companies → tagged `initiate`/`on-site` (no staleness)
 * Fit is attached as a soft flag, never a filter (ARCHITECTURE §6).
 */
import type { Contact, EngagementEvent, Leader } from '@greenhouse-resume-builder/shared';
import { DEFAULT_WEIGHTS, PlannerWeights } from './weights';
import { loadConfig, demoToday, isStale, DemoConfig } from './clock';
import { haversineKm } from './distance';
import { suggestionScore } from './score';
import type { Anchor, Candidate, FitFlag } from './types';

const levelNum = (lvl?: string): number | undefined =>
  lvl && /^L[1-4]$/.test(lvl) ? Number(lvl.slice(1)) : undefined;

/** Soft "fit" flags for a leader×contact pairing — advisory badges, never filters. */
export function fitFlags(leader: Leader, contact: Contact, w: PlannerWeights = DEFAULT_WEIGHTS): FitFlag[] {
  const flags: FitFlag[] = [];
  if (leader.domain !== contact.domain) {
    flags.push({
      type: 'domain-mismatch',
      detail: `${leader.domain} leader → ${contact.domain} contact`,
    });
  }
  const ll = levelNum(leader.level);
  const cl = levelNum(contact.level);
  if (ll !== undefined && cl !== undefined && Math.abs(ll - cl) >= w.levelGapFlag) {
    flags.push({ type: 'level-gap', detail: `leader ${leader.level} vs contact ${contact.level}` });
  }
  return flags;
}

export interface SuggestInput {
  leader: Leader;
  anchor: Anchor;
  contacts: Contact[];
  /** The anchor event, when the anchor is one — supplies attendee + exhibitor rosters. */
  event?: EngagementEvent;
  /** "Nearby" radius for off-site candidates (default from weights). */
  radiusKm?: number;
  /** When true, drop candidates whose topics don't intersect the anchor topics (the "who to meet on X" path). */
  requireTopicMatch?: boolean;
  weights?: PlannerWeights;
  cfg?: DemoConfig;
}

/** Rank candidate stops for a leader around a trip anchor. Highest score first. */
export function suggest(input: SuggestInput): Candidate[] {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const cfg = input.cfg ?? loadConfig();
  const today = demoToday(cfg);
  const radiusKm = input.radiusKm ?? w.nearbyRadiusKm;
  const targetTopics = input.anchor.topicIds ?? input.event?.topicIds;

  const byId = new Map(input.contacts.map((c) => [c.id, c]));
  const attendeeIds = new Set(input.event?.attendingContactIds ?? []);
  const prospectIds = new Set(input.event?.exhibitorProspectIds ?? []);

  const topicHit = (c: Contact): boolean =>
    !targetTopics || targetTopics.length === 0 || (c.topicIds ?? []).some((t) => targetTopics.includes(t));

  const out = new Map<string, Candidate>(); // dedupe by contactId; on-site wins over off-site

  const add = (c: Contact, placement: 'on-site' | 'off-site', distanceKm: number): void => {
    if (input.requireTopicMatch && !topicHit(c)) return;
    if (out.has(c.id) && out.get(c.id)!.placement === 'on-site') return; // keep the on-site variant
    const { score, factors } = suggestionScore(c, targetTopics, today, w);
    out.set(c.id, {
      contactId: c.id,
      name: c.name,
      location: c.location,
      distanceKm,
      placement,
      kind: c.status === 'prospect' ? 'initiate' : 're-engage',
      status: c.status,
      isStale: isStale(c.lastInteractionDate, cfg),
      strategicValue: c.strategicValue,
      score,
      factors,
      fitFlags: fitFlags(input.leader, c, w),
    });
  };

  // (a) attendees — on-site, travel ≈ 0
  for (const id of attendeeIds) {
    const c = byId.get(id);
    if (c && c.status === 'active') add(c, 'on-site', 0);
  }
  // (c) exhibitor prospects — on-site, initiate
  for (const id of prospectIds) {
    const c = byId.get(id);
    if (c && c.status === 'prospect') add(c, 'on-site', 0);
  }
  // (b) nearby active contacts — off-site within radius (skip those already on-site)
  for (const c of input.contacts) {
    if (c.status !== 'active' || attendeeIds.has(c.id) || out.has(c.id)) continue;
    const distanceKm = haversineKm(input.anchor.location, c.location);
    if (distanceKm <= radiusKm) add(c, 'off-site', distanceKm);
  }

  return [...out.values()].sort((a, b) => b.score - a.score);
}
