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
    description: 'Project location-bearing records for a person into normalized map pins.',
    inputSchema: {
      type: 'object',
      properties: { personId: { type: 'string' } },
      required: ['personId'],
    },
    handler: () => toolResult('Map-pin projection stub.', { pins: [] }),
  }),
];
