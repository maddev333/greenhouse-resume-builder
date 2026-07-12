/**
 * Area-first anchoring — resolve a free-form area request (region id, region name/alias, or a
 * city/state) to a concrete `{ centroid, radiusKm }` and turn it into a planner {@link Anchor}
 * WITHOUT any live geocode. Region centroids are pre-resolved in the seed gazetteer; a bare
 * city/state falls back to a matching point among already-authorized records (contacts/events), so
 * the demo path stays fully offline (ARCHITECTURE §1). Pure + deterministic.
 */
import type { DateRange, GeoPoint, Region } from '@greenhouse-resume-builder/shared';
import type { Anchor } from './types';

/** Default search radius when neither the request nor a matched region specifies one. */
export const DEFAULT_AREA_RADIUS_KM = 150;

/** A free-form area request — supply a regionId, a region name/alias, a city (+state), or raw coords. */
export interface AreaInput {
  regionId?: string;
  /** A region name or alias, e.g. "NCR" or "Bay Area" (case-insensitive). */
  region?: string;
  city?: string;
  state?: string;
  /** Raw anchor latitude — pairs with `lng` for a point-anchored (event-less) trip. */
  lat?: number;
  /** Raw anchor longitude — pairs with `lat`. */
  lng?: number;
  /** Human label for a raw-coordinate anchor (e.g. a company HQ name); falls back to "lat, lng". */
  label?: string;
  /** Override the resolved radius (km). */
  radiusKm?: number;
}

/** A concrete, resolved area ready to anchor on. */
export interface ResolvedArea {
  id: string;
  name: string;
  centroid: GeoPoint;
  radiusKm: number;
  /** How the area was resolved (for transparent "show-your-math" output). */
  resolvedVia: 'regionId' | 'regionName' | 'city' | 'coords';
}

const norm = (s: string): string => s.trim().toLowerCase();

function matchRegion(
  input: AreaInput,
  regions: Region[],
): { region: Region; via: 'regionId' | 'regionName' } | undefined {
  if (input.regionId) {
    const r = regions.find((x) => x.id === input.regionId);
    if (r) return { region: r, via: 'regionId' };
  }
  const needle = input.region ? norm(input.region) : undefined;
  if (needle) {
    const r = regions.find(
      (x) => norm(x.name) === needle || (x.aliases ?? []).some((a) => norm(a) === needle),
    );
    if (r) return { region: r, via: 'regionName' };
  }
  return undefined;
}

/**
 * Resolve an {@link AreaInput} to a {@link ResolvedArea}. Precedence: regionId → region name/alias →
 * city (matched first against region centroids, then against `knownPoints`). Returns `undefined`
 * when nothing matches (the tool then asks the caller to pick a known region).
 */
export function resolveArea(
  input: AreaInput,
  regions: Region[],
  knownPoints: GeoPoint[] = [],
): ResolvedArea | undefined {
  // Highest precedence: an explicit lat/lng anchor (a company HQ, an address the EA geocoded, etc.).
  // This is the event-less "go meet a specific place" entry point — no gazetteer lookup needed.
  if (typeof input.lat === 'number' && typeof input.lng === 'number') {
    const label = input.label?.trim() || `${input.lat.toFixed(4)}, ${input.lng.toFixed(4)}`;
    return {
      id: `coords:${input.lat.toFixed(4)},${input.lng.toFixed(4)}`,
      name: label,
      centroid: { city: input.city ?? label, state: input.state, lat: input.lat, lng: input.lng },
      radiusKm: input.radiusKm ?? DEFAULT_AREA_RADIUS_KM,
      resolvedVia: 'coords',
    };
  }

  const matched = matchRegion(input, regions);
  if (matched) {
    return {
      id: matched.region.id,
      name: matched.region.name,
      centroid: matched.region.centroid,
      radiusKm: input.radiusKm ?? matched.region.defaultRadiusKm,
      resolvedVia: matched.via,
    };
  }

  const city = input.city ? norm(input.city) : input.region ? norm(input.region) : undefined;
  if (city) {
    // A region whose centroid city matches.
    const byRegionCity = regions.find((x) => norm(x.centroid.city) === city);
    if (byRegionCity) {
      return {
        id: byRegionCity.id,
        name: byRegionCity.name,
        centroid: byRegionCity.centroid,
        radiusKm: input.radiusKm ?? byRegionCity.defaultRadiusKm,
        resolvedVia: 'city',
      };
    }
    // Fall back to an authorized record located in that city (offline geocode).
    const pt = knownPoints.find(
      (p) => norm(p.city) === city && (!input.state || norm(p.state ?? '') === norm(input.state)),
    );
    if (pt) {
      const label = pt.state ? `${pt.city}, ${pt.state}` : pt.city;
      return {
        id: `city:${label}`,
        name: label,
        centroid: pt,
        radiusKm: input.radiusKm ?? DEFAULT_AREA_RADIUS_KM,
        resolvedVia: 'city',
      };
    }
  }
  return undefined;
}

/** Build a trip anchor from a resolved area + a date window (no event → nearby off-site sourcing). */
export function anchorFromArea(area: ResolvedArea, window: DateRange, topicIds?: string[]): Anchor {
  return { id: area.id, location: area.centroid, window, topicIds };
}
