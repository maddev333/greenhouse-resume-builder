/**
 * Leader selection — given an area + the target topics there, rank WHICH senior leader should go,
 * scoring SME/domain fit, proximity, availability overlap with the window, travel-budget headroom,
 * and echelon fit vs the area's anchor contact. Advisory only: every leader is returned as a ranked
 * OPTION (never hard-filtered), because the human always decides (ARCHITECTURE §6). Pure engine.
 */
import type { Contact, DateRange, GeoPoint, Leader, Topic } from '@greenhouse-resume-builder/shared';
import { haversineKm } from './distance';
import { addDays, daysBetween } from './clock';

/** CONUS-scale normalizer: a home base at/above this distance contributes ~0 proximity. */
const MAX_PROXIMITY_KM = 4000;
/** Guard the day-by-day availability scan against a pathological window. */
const MAX_WINDOW_DAYS = 366;

export interface LeaderFactors {
  topicMatch: number; // 0..1 SME/domain fit with the target topics
  proximity: number; // 0..1 (closer home base = higher)
  availability: number; // 0..1 fraction of the window the leader is available
  budgetHeadroom: number; // 0..1 travel-days budget vs the window length
  levelFit: number; // 0..1 echelon closeness vs the area's anchor contact
}

export interface LeaderOption {
  leaderId: string;
  name: string;
  role: string;
  score: number; // 0..1 weighted blend of the factors
  distanceKm: number;
  availableInWindow: boolean;
  factors: LeaderFactors;
  /** Advisory badges, e.g. domain mismatch vs the target topics. */
  notes: string[];
}

export interface LeaderWeights {
  topicMatch: number;
  proximity: number;
  availability: number;
  budgetHeadroom: number;
  levelFit: number;
}

export const DEFAULT_LEADER_WEIGHTS: LeaderWeights = {
  topicMatch: 0.35,
  proximity: 0.25,
  availability: 0.2,
  budgetHeadroom: 0.1,
  levelFit: 0.1,
};

export interface SuggestLeadersInput {
  centroid: GeoPoint;
  window: DateRange;
  /** Target topics to staff for (usually the top topics-in-area). */
  topicIds: string[];
  leaders: Leader[];
  topics: Topic[];
  /** Optional in-area contacts — used for the echelon (level) fit factor. */
  contacts?: Contact[];
  weights?: LeaderWeights;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const levelNum = (lvl?: string): number | undefined =>
  lvl && /^L[1-4]$/.test(lvl) ? Number(lvl.slice(1)) : undefined;

/** Fraction of `window` covered by the union of the leader's availability ranges (day-granular). */
function availabilityOverlap(availability: DateRange[], window: DateRange): number {
  const windowDays = Math.min(MAX_WINDOW_DAYS, Math.max(1, daysBetween(window.start, window.end) + 1));
  let covered = 0;
  for (let i = 0; i < windowDays; i++) {
    const day = addDays(window.start, i);
    if (availability.some((r) => day >= r.start && day <= r.end)) covered++;
  }
  return clamp01(covered / windowDays);
}

/** Rank leaders as options for staffing an area over a window. Highest score first. */
export function suggestLeaders(input: SuggestLeadersInput): LeaderOption[] {
  const w = input.weights ?? DEFAULT_LEADER_WEIGHTS;
  const targetTopics = input.topics.filter((t) => input.topicIds.includes(t.id));

  const targetSme = new Set<string>();
  const domainCount: Record<string, number> = {};
  for (const t of targetTopics) {
    for (const s of t.smeAreas ?? []) targetSme.add(s);
    domainCount[t.domain] = (domainCount[t.domain] ?? 0) + 1;
  }
  const majorityDomain = Object.entries(domainCount).sort((a, b) => b[1] - a[1])[0]?.[0];
  const hasTargets = targetSme.size > 0 || !!majorityDomain;

  // Reference echelon = level of the highest-strategic-value in-area contact.
  let refLevel: number | undefined;
  let bestVal = -Infinity;
  for (const c of input.contacts ?? []) {
    const ln = levelNum(c.level);
    if (ln === undefined) continue;
    if ((c.strategicValue ?? 0) > bestVal) {
      bestVal = c.strategicValue ?? 0;
      refLevel = ln;
    }
  }

  const windowDays = Math.max(1, daysBetween(input.window.start, input.window.end) + 1);

  const options: LeaderOption[] = input.leaders.map((leader) => {
    const smeOverlap = targetSme.size
      ? (leader.smeAreas ?? []).filter((s) => targetSme.has(s)).length / targetSme.size
      : 0;
    const domainMatch = majorityDomain ? (leader.domain === majorityDomain ? 1 : 0) : 0.5;
    const topicMatch = hasTargets ? clamp01(0.6 * smeOverlap + 0.4 * domainMatch) : 0.5;

    const distanceKm = haversineKm(input.centroid, leader.homeBase);
    const proximity = clamp01(1 - distanceKm / MAX_PROXIMITY_KM);

    const availability = availabilityOverlap(leader.availability ?? [], input.window);
    const budgetHeadroom = clamp01((leader.daysAwayBudget ?? 0) / windowDays);

    let levelFit = 0.5;
    const ll = levelNum(leader.level);
    if (refLevel !== undefined && ll !== undefined) {
      levelFit = clamp01(1 - Math.abs(ll - refLevel) / 3);
    }

    const factors: LeaderFactors = { topicMatch, proximity, availability, budgetHeadroom, levelFit };
    const score = clamp01(
      w.topicMatch * topicMatch +
        w.proximity * proximity +
        w.availability * availability +
        w.budgetHeadroom * budgetHeadroom +
        w.levelFit * levelFit,
    );

    const notes: string[] = [];
    if (majorityDomain && leader.domain !== majorityDomain) {
      notes.push(`domain mismatch: ${leader.domain} leader vs ${majorityDomain} topics`);
    }
    if (availability === 0) notes.push('no availability in window');
    if ((leader.daysAwayBudget ?? 0) < windowDays) {
      notes.push(`travel budget ${leader.daysAwayBudget ?? 0}d < ${windowDays}d window`);
    }

    return {
      leaderId: leader.id,
      name: leader.name,
      role: leader.role,
      score,
      distanceKm,
      availableInWindow: availability > 0,
      factors,
      notes,
    };
  });

  return options.sort((a, b) => b.score - a.score || a.leaderId.localeCompare(b.leaderId));
}
