/**
 * Geographic distance + travel-time heuristics. Pure, deterministic, unit-tested.
 * The ETA heuristic is the honest stand-in for a real routing engine (ARCHITECTURE §6); swapping
 * in Azure Maps Route Matrix later is a one-file change behind the same `etaMinutes()` interface.
 */
import type { GeoPoint } from '@greenhouse-resume-builder/shared';
import { DEFAULT_WEIGHTS, PlannerWeights } from './weights';

const EARTH_RADIUS_MI = 3959;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two pre-geocoded points, in miles. */
export function haversineMi(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface Eta {
  mode: 'air' | 'ground';
  minutes: number;
  distanceMi: number;
}

/**
 * Travel-time estimate between two points.
 * - Ground (haversine ≤ threshold): `distanceMi / groundSpeed + groundBuffer`.
 * - Air (otherwise): `airFixed + distanceMi / airSpeed + airArrivalBuffer`.
 */
export function etaMinutes(a: GeoPoint, b: GeoPoint, w: PlannerWeights = DEFAULT_WEIGHTS): Eta {
  const mi = haversineMi(a, b);
  if (mi <= w.groundThresholdMi) {
    return {
      mode: 'ground',
      distanceMi: mi,
      minutes: Math.round((mi / w.groundSpeedMph) * 60 + w.groundBufferMins),
    };
  }
  return {
    mode: 'air',
    distanceMi: mi,
    minutes: Math.round(w.airFixedMins + (mi / w.airSpeedMph) * 60 + w.airArrivalBufferMins),
  };
}
