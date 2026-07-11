/**
 * The five trip-feasibility conflict detectors (ARCHITECTURE §6, MVP-PLAN §4.1).
 * ALL are advisory — the planner flags and recommends; the human always decides. `fit` and
 * `opportunity-cost` are soft (flag-only); the rest are hard (infeasible unless overridden).
 * Each detector is pure and independently testable; the capability tool composes them per trip.
 */
import type { Contact, DateRange, Leader } from '@greenhouse-resume-builder/shared';
import { DEFAULT_WEIGHTS, PlannerWeights } from './weights';
import { etaMinutes } from './distance';
import { fitFlags } from './suggest';
import type { Conflict, RouteStop, RoiResult } from './types';

const ms = (iso: string): number => new Date(iso).getTime();
const overlaps = (aStart: string, aEnd: string, bStart: string, bEnd: string): boolean =>
  ms(aStart) < ms(bEnd) && ms(bStart) < ms(aEnd);

/** 1. Fit — wrong domain / big level gap. Always SOFT: shown, never blocked. */
export function detectFit(leader: Leader, contact: Contact, w: PlannerWeights = DEFAULT_WEIGHTS): Conflict[] {
  return fitFlags(leader, contact, w).map((f) => ({
    type: 'fit' as const,
    severity: 'soft' as const,
    message:
      f.type === 'domain-mismatch'
        ? `Fit: ${f.detail}`
        : `Fit: level gap (${f.detail})`,
    recommendation: 'Allowed — consider a better-matched leader; the human decides.',
  }));
}

export interface Booking {
  id: string;
  start: string; // ISO datetime
  end: string; // ISO datetime
}

/** 2. Double-book — any two of the leader's bookings (new stops + existing engagements) overlap. */
export function detectDoubleBook(bookings: Booking[]): Conflict[] {
  const out: Conflict[] = [];
  for (let i = 0; i < bookings.length; i++) {
    for (let j = i + 1; j < bookings.length; j++) {
      const a = bookings[i];
      const b = bookings[j];
      if (overlaps(a.start, a.end, b.start, b.end)) {
        out.push({
          type: 'double-book',
          severity: 'hard',
          stopId: b.id,
          message: `Double-book: "${a.id}" overlaps "${b.id}".`,
          recommendation: 'Shift one stop or reassign to another leader.',
        });
      }
    }
  }
  return out;
}

/**
 * 3. Travel-infeasible — for consecutive scheduled stops, `arrive(next) < depart(prev) + ETA`.
 * Stops without both timestamps are skipped (nothing to check yet).
 */
export function detectTravelInfeasible(
  orderedStops: RouteStop[],
  w: PlannerWeights = DEFAULT_WEIGHTS,
): Conflict[] {
  const out: Conflict[] = [];
  for (let i = 1; i < orderedStops.length; i++) {
    const prev = orderedStops[i - 1];
    const next = orderedStops[i];
    if (!prev.depart || !next.arrive) continue;
    const eta = etaMinutes(prev.location, next.location, w);
    const earliestArrival = ms(prev.depart) + eta.minutes * 60_000;
    if (ms(next.arrive) < earliestArrival) {
      out.push({
        type: 'travel-infeasible',
        severity: 'hard',
        stopId: next.id,
        message: `Travel-infeasible: can't reach "${next.id}" (~${eta.minutes} min ${eta.mode}) before its window.`,
        recommendation: 'Re-order stops, widen the gap, or re-anchor to a nearer window.',
      });
    }
  }
  return out;
}

/** 4. Availability / days-away budget — trip window outside the leader's availability, or over budget. */
export function detectAvailabilityBudget(leader: Leader, window: DateRange, tripDays: number): Conflict[] {
  const out: Conflict[] = [];
  const covered = (leader.availability ?? []).some(
    (a) => a.start <= window.start && window.end <= a.end,
  );
  if (!covered) {
    out.push({
      type: 'availability-budget',
      severity: 'hard',
      message: `Availability: ${window.start}…${window.end} is outside ${leader.name}'s availability.`,
      recommendation: 'Pick a slot inside an availability window.',
    });
  }
  if (tripDays > leader.daysAwayBudget) {
    out.push({
      type: 'availability-budget',
      severity: 'hard',
      message: `Budget: ${tripDays} travel-days exceeds ${leader.name}'s ${leader.daysAwayBudget}-day budget.`,
      recommendation: 'Trim stops or split into two trips.',
    });
  }
  return out;
}

/** 5. Opportunity-cost — trip-ROI below threshold. SOFT: a nudge to batch or fill conference slots. */
export function detectOpportunityCost(roi: RoiResult, w: PlannerWeights = DEFAULT_WEIGHTS): Conflict[] {
  if (roi.roiScore >= w.roiThreshold) return [];
  return [
    {
      type: 'opportunity-cost',
      severity: 'soft',
      message: `Opportunity-cost: trip-ROI ${roi.roiScore.toFixed(2)} is below ${w.roiThreshold}.`,
      recommendation: 'Batch nearby stale contacts or fill open conference slots before flying far.',
    },
  ];
}
