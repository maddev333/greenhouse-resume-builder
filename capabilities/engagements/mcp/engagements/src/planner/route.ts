/**
 * Greedy route ordering (nearest-neighbor) + leg construction.
 * On-site stops sit at the anchor venue, so they carry no travel legs and are visited first (during
 * the conference); off-site stops are swept in nearest-neighbor order out of the anchor. This is a
 * transparent advisor, not an optimizer (ARCHITECTURE §6) — a 2-opt pass can slot in later.
 */
import type { GeoPoint } from '@greenhouse-resume-builder/shared';
import { DEFAULT_WEIGHTS, PlannerWeights } from './weights';
import { etaMinutes } from './distance';
import type { RouteStop, RouteLeg, RouteResult } from './types';

/** The synthetic "from" id of the first leg out of the trip anchor. */
export const ORIGIN_ID = '__origin__';

/**
 * Order `stops` and build legs starting from `origin` (the anchor venue).
 * @param origin the anchor location (trip start)
 * @param stops candidate stops; `kind: 'on-site'` are treated as at-venue (no legs)
 */
export function planRoute(
  origin: GeoPoint,
  stops: RouteStop[],
  w: PlannerWeights = DEFAULT_WEIGHTS,
): RouteResult {
  const onsite = stops.filter((s) => s.kind === 'on-site');
  const remaining = stops.filter((s) => s.kind === 'off-site');

  const ordered: RouteStop[] = [];
  const legs: RouteLeg[] = [];
  let cur = origin;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestMi = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const mi = etaMinutes(cur, remaining[i].location, w).distanceMi;
      if (mi < bestMi) {
        bestMi = mi;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    const eta = etaMinutes(cur, next.location, w);
    legs.push({
      fromStopId: ordered.length > 0 ? ordered[ordered.length - 1].id : ORIGIN_ID,
      toStopId: next.id,
      mode: eta.mode,
      distanceMi: eta.distanceMi,
      estTravelMins: eta.minutes,
    });
    ordered.push(next);
    cur = next.location;
  }

  const order = [...onsite, ...ordered]; // on-site first (at the conference), then the off-site sweep
  const totalMi = legs.reduce((s, l) => s + l.distanceMi, 0);
  const totalTravelMins = legs.reduce((s, l) => s + l.estTravelMins, 0);
  return { order, legs, totalMi, totalTravelMins };
}
