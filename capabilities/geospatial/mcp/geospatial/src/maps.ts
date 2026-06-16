/**
 * Azure Maps geocoding client.
 *
 * Auth follows the repo's credential-precedence rule (IL5):
 *   - AZURE_MAPS_KEY set            -> subscription-key auth (simplest for local dev)
 *   - else AZURE_MAPS_CLIENT_ID set -> Microsoft Entra bearer token (managed identity),
 *                                      using the Maps account's client id header
 *   - else                          -> not configured
 *
 * Endpoint/scope are cloud-configurable (Commercial vs Azure Government) via env so a
 * single build targets either cloud. Uses the GA Geocoding API (api-version 2023-06-01).
 */
import { getEntraToken } from '@greenhouse-resume-builder/mcp-core';

export interface GeocodeResult {
  query: string;
  latitude: number;
  longitude: number;
  formattedAddress: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  /** Azure Maps match confidence (e.g. "High" | "Medium" | "Low"). */
  locationConfidence: string | null;
}

function mapsEndpoint(): string {
  // Commercial: https://atlas.microsoft.com  |  Azure Gov: set AZURE_MAPS_ENDPOINT accordingly.
  return (process.env.AZURE_MAPS_ENDPOINT || 'https://atlas.microsoft.com').replace(/\/+$/, '');
}

/** True when either a Maps key or a Maps client id (managed identity) is configured. */
export function isMapsConfigured(): boolean {
  return !!(process.env.AZURE_MAPS_KEY || process.env.AZURE_MAPS_CLIENT_ID);
}

/** Apply auth to the request: subscription key on the URL, or Entra bearer + client-id header. */
async function applyMapsAuth(url: URL): Promise<Record<string, string>> {
  const key = process.env.AZURE_MAPS_KEY;
  if (key) {
    url.searchParams.set('subscription-key', key);
    return {};
  }
  const clientId = process.env.AZURE_MAPS_CLIENT_ID;
  if (clientId) {
    const scope = process.env.AZURE_MAPS_TOKEN_SCOPE || 'https://atlas.microsoft.com/.default';
    return { Authorization: `Bearer ${await getEntraToken(scope)}`, 'x-ms-client-id': clientId };
  }
  throw new Error('Azure Maps is not configured: set AZURE_MAPS_KEY (local) or AZURE_MAPS_CLIENT_ID (managed identity).');
}

/**
 * Geocode a free-text location to coordinates + a coarse address. Returns null when there
 * is no match. Throws when Maps is unconfigured or the service returns an error.
 */
export async function geocodeLocation(
  query: string,
  opts: { top?: number; timeoutMs?: number } = {},
): Promise<GeocodeResult | null> {
  if (!query || !query.trim()) return null;

  const url = new URL(`${mapsEndpoint()}/geocode`);
  url.searchParams.set('api-version', '2023-06-01');
  url.searchParams.set('top', String(opts.top ?? 1));
  url.searchParams.set('query', query);
  const headers = await applyMapsAuth(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10000);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Azure Maps geocode HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = (await resp.json()) as {
      features?: Array<{
        geometry?: { coordinates?: [number, number] };
        properties?: {
          confidence?: string;
          address?: {
            formattedAddress?: string;
            locality?: string;
            adminDistricts?: Array<{ shortName?: string; name?: string }>;
            countryRegion?: { name?: string; ISO?: string };
          };
        };
      }>;
    };
    const feature = data.features?.[0];
    if (!feature || !feature.geometry?.coordinates) return null;

    const [lon, lat] = feature.geometry.coordinates;
    const addr = feature.properties?.address ?? {};
    const admin = addr.adminDistricts?.[0];
    return {
      query,
      latitude: lat,
      longitude: lon,
      formattedAddress: addr.formattedAddress ?? null,
      city: addr.locality ?? null,
      region: admin?.shortName ?? admin?.name ?? null,
      country: addr.countryRegion?.name ?? null,
      countryCode: addr.countryRegion?.ISO ?? null,
      locationConfidence: feature.properties?.confidence ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}
