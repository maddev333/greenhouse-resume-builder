import { defineTool, toolResult, type McpTool, type ToolResult } from '@greenhouse-resume-builder/mcp-core';
import { geocodeLocation, isMapsConfigured } from './maps';

/**
 * Geospatial MCP server tools.
 *
 * `normalize_location` and `geocode` call Azure Maps (LocationEnrichmentAgent backing).
 * Avoid geocoding sensitive personal/home locations; prefer coarse precision for sensitive
 * data, and treat map pins as projections over source records, not independent facts.
 */
function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export const geospatialTools: McpTool[] = [
  defineTool({
    name: 'normalize_location',
    description: 'Normalize a raw location string into structured fields (city, region, country).',
    inputSchema: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location'],
    },
    handler: async (args: any) => {
      const location = String(args?.location ?? '');
      if (!isMapsConfigured()) {
        return toolResult(`Azure Maps not configured; cannot normalize "${location}".`, {
          address: null,
          city: null,
          region: null,
          country: null,
          locationPrecision: 'unknown',
        });
      }
      try {
        const r = await geocodeLocation(location);
        if (!r) {
          return toolResult(`No match for "${location}".`, {
            address: null,
            city: null,
            region: null,
            country: null,
            locationPrecision: 'none',
          });
        }
        // Coarse precision: return administrative fields, not raw coordinates.
        return toolResult(`Normalized "${location}".`, {
          address: r.formattedAddress,
          city: r.city,
          region: r.region,
          country: r.country,
          countryCode: r.countryCode,
          locationPrecision: 'coarse',
        });
      } catch (err: any) {
        return errorResult(`normalize_location failed: ${err?.message || err}`);
      }
    },
  }),
  defineTool({
    name: 'geocode',
    description: 'Geocode an approved public/professional location to coordinates (skip sensitive addresses).',
    inputSchema: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location'],
    },
    handler: async (args: any) => {
      const location = String(args?.location ?? '');
      if (!isMapsConfigured()) {
        return toolResult('Azure Maps not configured (set AZURE_MAPS_KEY).', {
          latitude: null,
          longitude: null,
          locationConfidence: 0,
        });
      }
      try {
        const r = await geocodeLocation(location);
        if (!r) {
          return toolResult(`No geocode match for "${location}".`, {
            latitude: null,
            longitude: null,
            locationConfidence: 0,
          });
        }
        return toolResult(`Geocoded "${location}" -> ${r.latitude}, ${r.longitude}.`, {
          latitude: r.latitude,
          longitude: r.longitude,
          formattedAddress: r.formattedAddress,
          locationConfidence: r.locationConfidence,
        });
      } catch (err: any) {
        return errorResult(`geocode failed: ${err?.message || err}`);
      }
    },
  }),
  defineTool({
    name: 'project_map_pins',
    description:
      "Project a person's location-bearing records into normalized map pins by geocoding each " +
      'supplied location (coarse city/region precision). Pins are projections over source records, not facts.',
    inputSchema: {
      type: 'object',
      properties: {
        personId: { type: 'string' },
        locations: {
          type: 'array',
          description: 'Location records to plot. Each item is a string, or an object { label?, location }.',
          items: {},
        },
      },
      required: ['personId'],
    },
    handler: async (args: any) => {
      const personId = String(args?.personId ?? '');
      const rawList: any[] = Array.isArray(args?.locations) ? args.locations : [];
      // Normalize each record to { label, query }; drop blanks and cap to keep the call bounded.
      const records = rawList
        .map((item) => {
          if (typeof item === 'string') return { label: item.trim(), query: item.trim() };
          const query = String(item?.location ?? item?.query ?? '').trim();
          return { label: String(item?.label ?? query).trim(), query };
        })
        .filter((r) => r.query.length > 0)
        .slice(0, 25);

      if (!isMapsConfigured()) {
        return toolResult(
          `Azure Maps not configured (set AZURE_MAPS_KEY); cannot project ${records.length} location(s).`,
          { personId, pins: [], count: 0, mapsConfigured: false },
        );
      }
      if (records.length === 0) {
        return toolResult(`No locations supplied for ${personId || '(unknown person)'}.`, {
          personId,
          pins: [],
          count: 0,
          mapsConfigured: true,
        });
      }

      const settled = await Promise.allSettled(records.map((r) => geocodeLocation(r.query)));
      const pins = settled
        .map((res, i) => {
          if (res.status !== 'fulfilled' || !res.value) return null;
          const g = res.value;
          return {
            label: records[i].label || g.formattedAddress || g.city || records[i].query,
            query: records[i].query,
            address: g.formattedAddress,
            city: g.city,
            region: g.region,
            country: g.country,
            latitude: g.latitude,
            longitude: g.longitude,
            locationConfidence: g.locationConfidence,
          };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);

      return toolResult(
        `Projected ${pins.length}/${records.length} pin(s) for ${personId || '(unknown person)'}.`,
        { personId, pins, count: pins.length, requested: records.length, mapsConfigured: true },
      );
    },
  }),
];
