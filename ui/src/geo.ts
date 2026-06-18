/**
 * Geospatial helpers for the candidate profile page.
 *
 * Pulls location-bearing facts out of the candidate's extracted facts and projects them into
 * geocoded map pins by calling the Geospatial MCP server's `project_map_pins` tool. The MCP
 * server is the data provider, so the same call is available to any other agent.
 */

const GEOSPATIAL_MCP_URL =
  (import.meta as any).env?.VITE_GEOSPATIAL_MCP_URL || 'http://localhost:7076/api/mcp/geospatial';

/** Azure Maps subscription key injected at build time (see vite.config.ts). '' when not configured. */
export const MAPS_KEY = ((import.meta as any).env?.VITE_AZURE_MAPS_KEY as string) || '';

export type LocationCategory = 'current' | 'work' | 'education' | 'other';

export interface LocationRecord {
  /** Free-text location to geocode, e.g. "Seattle, WA". */
  location: string;
  category: LocationCategory;
  /** The fact key the location came from (for provenance). */
  factKey: string;
}

export interface MapPin {
  label?: string;
  query?: string;
  address?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  locationConfidence?: string | null;
}

export interface ProjectMapPinsResult {
  personId: string;
  pins: MapPin[];
  count: number;
  requested?: number;
  mapsConfigured: boolean;
}

type FactLike = { factKey?: string; factValue?: unknown; normalizedValue?: unknown };
type SectionsMap = Record<string, FactLike[] | undefined>;

function categoryFor(factKey: string): LocationCategory {
  if (factKey === 'profile.location') return 'current';
  if (factKey.startsWith('employment.')) return 'work';
  if (factKey.startsWith('education.')) return 'education';
  return 'other';
}

/** Coerce a fact value (string, or an object that may carry a location field) to a location string. */
function valueToLocation(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const candidate = v.location ?? v.city ?? v.value;
    if (typeof candidate === 'string') return candidate.trim();
  }
  return '';
}

/**
 * Extract de-duplicated location records from a facts-by-section map (the shape returned by
 * `GET /api/v1/insights/:personId/facts`). Any fact whose key ends in `.location` is treated as
 * a geocodable location.
 */
export function extractLocationRecords(sections: SectionsMap | undefined): LocationRecord[] {
  if (!sections) return [];
  const seen = new Set<string>();
  const records: LocationRecord[] = [];
  for (const facts of Object.values(sections)) {
    if (!Array.isArray(facts)) continue;
    for (const f of facts) {
      const factKey = String(f?.factKey ?? '');
      if (!/\.location$/.test(factKey)) continue;
      const location = valueToLocation(f?.factValue);
      if (!location) continue;
      const dedupeKey = location.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      records.push({ location, category: categoryFor(factKey), factKey });
    }
  }
  return records;
}

/**
 * Call the Geospatial MCP `project_map_pins` tool to geocode the given location records for a person.
 * Returns geocoded pins (lat/lng + coarse address). Throws on transport/tool error.
 */
export async function projectMapPins(
  personId: string,
  records: LocationRecord[],
  serverUrl: string = GEOSPATIAL_MCP_URL,
): Promise<ProjectMapPinsResult> {
  const locations = records.map((r) => ({ label: r.location, location: r.location }));
  const resp = await fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'project_map_pins', arguments: { personId, locations } },
    }),
  });
  if (!resp.ok) throw new Error(`Geospatial MCP HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message || 'project_map_pins failed');
  const structured = json.result?.structuredContent ?? json.result ?? {};
  return {
    personId: structured.personId ?? personId,
    pins: Array.isArray(structured.pins) ? structured.pins : [],
    count: structured.count ?? 0,
    requested: structured.requested,
    mapsConfigured: structured.mapsConfigured !== false,
  };
}

/** Map a geocoded pin back to the originating record's category (joined on the query string). */
export function categoryByQuery(records: LocationRecord[]): Map<string, LocationCategory> {
  const m = new Map<string, LocationCategory>();
  for (const r of records) m.set(r.location.toLowerCase(), r.category);
  return m;
}
