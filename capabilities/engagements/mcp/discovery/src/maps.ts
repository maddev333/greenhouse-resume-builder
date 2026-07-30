/**
 * Azure Maps Search provider — the discovery backend.
 *
 * Two calls, both on the Search v1 surface:
 *   - `search/address/json`  geocode "Huntsville, AL" → lat/lng anchor
 *   - `search/poi/json`      keyword POI search around that anchor  (used when a query is given)
 *   - `search/nearby/json`   un-keyed "what's around here" sweep    (used when no query is given)
 *
 * Security notes:
 *   - The subscription key is sent as the `subscription-key` HEADER, never in the query string, so it
 *     cannot leak into proxy/access logs. It is never echoed into an error message or a tool result.
 *   - Every URL is built with `URL`/`searchParams`, so caller-supplied text is encoded and cannot
 *     inject extra path segments or parameters.
 *   - Only `AZURE_MAPS_ENDPOINT` (operator-controlled) selects the host — caller input never does.
 *   - Every request carries an abort timeout so a hung upstream cannot pin an MCP request open.
 */

const DEFAULT_ENDPOINT = "https://atlas.microsoft.com";
const API_VERSION = "1.0";
const METERS_PER_MILE = 1609.344;

/** Azure Maps caps the POI/nearby radius at 50 km and the result set at 100. */
const MAX_RADIUS_METERS = 50_000;
const MAX_LIMIT = 50;

export class MapsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MapsError";
  }
}

export interface MapsConfig {
  endpoint: string;
  key: string;
  timeoutMs: number;
}

/** True when the repo-root `.env` carries an Azure Maps key — lets the server boot without one. */
export function isMapsConfigured(): boolean {
  return Boolean(process.env.AZURE_MAPS_KEY?.trim());
}

export function loadMapsConfig(): MapsConfig {
  const key = process.env.AZURE_MAPS_KEY?.trim();
  if (!key) {
    throw new MapsError(
      "AZURE_MAPS_KEY is not set. Add it to the repo-root .env to enable area discovery.",
    );
  }
  const endpoint = (
    process.env.AZURE_MAPS_ENDPOINT?.trim() || DEFAULT_ENDPOINT
  ).replace(/\/+$/, "");
  const timeoutMs = clamp(
    Number(process.env.DISCOVERY_TIMEOUT_MS ?? 8000),
    1000,
    30_000,
  );
  return { endpoint, key, timeoutMs };
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function milesToMeters(mi: number): number {
  return clamp(Math.round(mi * METERS_PER_MILE), 100, MAX_RADIUS_METERS);
}

export function metersToMiles(m: number): number {
  return Number((m / METERS_PER_MILE).toFixed(2));
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Anchor extends GeoPoint {
  /** Human-readable provenance for the tool result ("Huntsville, AL" or "34.730, -86.586"). */
  label: string;
}

export interface Business {
  id: string;
  name: string;
  /** Primary Azure Maps POI category, e.g. "restaurant", "company", "electronics". */
  category: string | null;
  categories: string[];
  brand: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  lat: number;
  lng: number;
  distanceMi: number | null;
  phone: string | null;
  url: string | null;
}

// ── Azure Maps wire shapes (only the fields we read) ─────────────────────

interface MapsPosition {
  lat?: number;
  lon?: number;
}

interface MapsAddress {
  freeformAddress?: string;
  municipality?: string;
  countrySubdivision?: string;
  postalCode?: string;
}

interface MapsResult {
  id?: string;
  dist?: number;
  position?: MapsPosition;
  address?: MapsAddress;
  poi?: {
    name?: string;
    phone?: string;
    url?: string;
    brands?: { name?: string }[];
    categories?: string[];
  };
}

interface MapsResponse {
  results?: MapsResult[];
}

/**
 * Issue a Search request. `path` is a fixed literal chosen by this module (never caller input) and
 * `params` are appended through `searchParams`, so nothing the caller sends can alter the target.
 */
async function mapsGet(
  cfg: MapsConfig,
  path: string,
  params: Record<string, string>,
): Promise<MapsResponse> {
  const url = new URL(`${cfg.endpoint}/${path}`);
  url.searchParams.set("api-version", API_VERSION);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await globalThis.fetch(url, {
      headers: { "subscription-key": cfg.key, accept: "application/json" },
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError"
        ? "timed out"
        : "was unreachable";
    // Deliberately does not include the URL — it would carry the caller's query but also our endpoint.
    throw new MapsError(`Azure Maps ${reason} after ${cfg.timeoutMs}ms.`);
  }

  if (!res.ok) {
    // Upstream bodies can echo request context; surface only the status.
    throw new MapsError(`Azure Maps returned HTTP ${res.status}.`, res.status);
  }
  return (await res.json()) as MapsResponse;
}

/** Geocode a free-text place ("Huntsville, AL") to a single anchor point. */
export async function geocodePlace(
  cfg: MapsConfig,
  place: string,
  countryCode = "US",
): Promise<Anchor | null> {
  const data = await mapsGet(cfg, "search/address/json", {
    query: place,
    countrySet: countryCode,
    limit: "1",
  });
  const hit = data.results?.[0];
  const lat = hit?.position?.lat;
  const lng = hit?.position?.lon;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return { lat, lng, label: hit?.address?.freeformAddress ?? place };
}

export interface DiscoverOptions {
  query?: string;
  radiusMi: number;
  limit: number;
  countryCode: string;
  /** Azure Maps POI category ids to restrict the sweep to. Empty/undefined = every category. */
  categorySet?: number[];
}

/**
 * Businesses around an anchor. With a `query` this is a keyword POI search; without one it is an
 * un-keyed nearby sweep ("what is around here at all"), which is the "surface the unknown" case.
 */
export async function discoverBusinesses(
  cfg: MapsConfig,
  anchor: GeoPoint,
  opts: DiscoverOptions,
): Promise<Business[]> {
  const radius = milesToMeters(opts.radiusMi);
  const limit = String(clamp(Math.round(opts.limit), 1, MAX_LIMIT));
  const query = opts.query?.trim();

  const shared: Record<string, string> = {
    lat: String(anchor.lat),
    lon: String(anchor.lng),
    radius: String(radius),
    limit,
    countrySet: opts.countryCode,
  };
  if (opts.categorySet?.length) shared.categorySet = opts.categorySet.join(",");

  const data = query
    ? await mapsGet(cfg, "search/poi/json", { ...shared, query })
    : await mapsGet(cfg, "search/nearby/json", shared);

  return (data.results ?? [])
    .map(toBusiness)
    .filter((b): b is Business => b !== null)
    .sort((a, b) => (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity));
}

function toBusiness(r: MapsResult): Business | null {
  const lat = r.position?.lat;
  const lng = r.position?.lon;
  const name = r.poi?.name?.trim();
  // Address-only geocoder hits carry no `poi` block — they are not businesses.
  if (!name || typeof lat !== "number" || typeof lng !== "number") return null;

  const categories = r.poi?.categories?.filter(Boolean) ?? [];
  return {
    id: r.id ?? `${lat},${lng}`,
    name,
    category: categories[0] ?? null,
    categories,
    brand: r.poi?.brands?.find((b) => b.name)?.name ?? null,
    address: r.address?.freeformAddress ?? null,
    city: r.address?.municipality ?? null,
    state: r.address?.countrySubdivision ?? null,
    postalCode: r.address?.postalCode ?? null,
    lat,
    lng,
    distanceMi: typeof r.dist === "number" ? metersToMiles(r.dist) : null,
    phone: r.poi?.phone ?? null,
    url: r.poi?.url ?? null,
  };
}
