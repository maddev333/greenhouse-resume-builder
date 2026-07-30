/**
 * Tool surface for the Area Discovery capability.
 *
 * One tool, `search_businesses`: given a travel anchor (city/state or lat/lng), return the businesses
 * physically around it. This server holds NO engagement data and applies NO security trim — every
 * result is public POI data from Azure Maps. Deciding which of these are *new* (i.e. not already a
 * tracked relationship) is the orchestrator's job: it cross-references the names against
 * `search_contacts` on the engagements capability.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  clamp,
  discoverBusinesses,
  geocodePlace,
  isMapsConfigured,
  loadMapsConfig,
  MapsError,
  type Anchor,
  type Business,
} from "./maps.js";

const DEFAULT_RADIUS_MI = 10;
const DEFAULT_LIMIT = 15;

/**
 * Curated Azure Maps POI category ids, grouped to mirror the engagement audiences the planner already
 * reasons about. Without a focus, an un-keyed sweep returns restaurants and tourist attractions, which
 * is noise for engagement planning. Ids come from the Search POI Category Tree API.
 */
const FOCUS_CATEGORIES = {
  industry: [9352, 7378, 9383], // Company, Business Park, Industrial Building
  manufacturing: [9352011, 9156, 9352021], // Manufacturing Company, Manufacturing Facility, OEM
  technology: [9352005, 9352004, 9352015, 9352020], // Software, Computer & Data Services, Electronics, Telecom
  research: [9157], // Research Facility
  academia: [7377], // College/University
  government: [7367], // Government Office
  venues: [9377], // Exhibition & Convention Center
} as const;

type Focus = keyof typeof FOCUS_CATEGORIES;
const FOCUS_NAMES = Object.keys(FOCUS_CATEGORIES) as [Focus, ...Focus[]];

/** Azure Maps answers HTTP 400 when `categorySet` carries more than ten ids. */
const MAX_CATEGORY_IDS = 10;

/**
 * Resolve focus groups to category ids within the Azure Maps ceiling. Groups are taken in the order
 * the caller listed them and are dropped WHOLE rather than truncated mid-group, so a reported focus
 * always means "every category in this group was searched".
 */
function applyFocus(focus: Focus[] | undefined): {
  applied: Focus[];
  dropped: Focus[];
  categorySet: number[];
} {
  const applied: Focus[] = [];
  const dropped: Focus[] = [];
  const categorySet: number[] = [];
  for (const group of focus ?? []) {
    if (applied.includes(group) || dropped.includes(group)) continue;
    const next = FOCUS_CATEGORIES[group].filter(
      (id) => !categorySet.includes(id),
    );
    if (categorySet.length + next.length > MAX_CATEGORY_IDS) {
      dropped.push(group);
      continue;
    }
    categorySet.push(...next);
    applied.push(group);
  }
  return { applied, dropped, categorySet };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    structuredContent: { error: message },
  };
}

function isLatLng(lat: number | undefined, lng: number | undefined): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

function line(b: Business): string {
  const where = [b.city, b.state].filter(Boolean).join(", ");
  const dist = b.distanceMi === null ? "" : ` — ${b.distanceMi} mi`;
  const cat = b.category ? ` [${b.category}]` : "";
  return `  • ${b.name}${cat}${dist}${where ? ` — ${where}` : ""}`;
}

export function registerDiscoveryTools(server: McpServer): void {
  server.registerTool(
    "search_businesses",
    {
      title: "Discover businesses around a travel area",
      description:
        "Return real businesses physically located around a travel anchor (a city/state, or a lat/lng " +
        "from an existing itinerary stop), sourced from the Azure Maps POI index. Use this to make a " +
        "traveler aware of organizations in the area they may not already track. Steer it with `focus` " +
        "(recommended — restricts to engageable organization types) and/or `query` (a name/brand/keyword). " +
        "With neither, the sweep returns whatever is nearby, including restaurants and shops. Results are " +
        "PUBLIC place data with no relationship history: cross-reference the returned names against " +
        "`search_contacts` to separate already-known organizations from genuinely new leads before " +
        "offering any as an itinerary addition.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            'Optional keyword / brand / name to match (e.g. "robotics"). Matches POI names, so it is narrow — prefer `focus` for broad discovery.',
          ),
        focus: z
          .array(z.enum(FOCUS_NAMES))
          .optional()
          .describe(
            "Restrict to engageable organization types. Combine freely: industry, manufacturing, technology, research, academia, government, venues. The upstream index accepts a limited number of categories, so list the most important groups FIRST — any that do not fit are reported back in `focusDropped`.",
          ),
        city: z
          .string()
          .optional()
          .describe(
            'Anchor city (e.g. "Huntsville"). Ignored when lat/lng are supplied.',
          ),
        state: z
          .string()
          .optional()
          .describe('State abbreviation disambiguating the city (e.g. "AL").'),
        lat: z
          .number()
          .optional()
          .describe(
            "Anchor latitude — pair with lng to anchor on an existing itinerary stop.",
          ),
        lng: z
          .number()
          .optional()
          .describe("Anchor longitude — pair with lat."),
        radiusMi: z
          .number()
          .optional()
          .describe(
            `Search radius in miles (default ${DEFAULT_RADIUS_MI}, max 31).`,
          ),
        limit: z
          .number()
          .optional()
          .describe(
            `Max businesses to return (default ${DEFAULT_LIMIT}, max 50).`,
          ),
        countryCode: z
          .string()
          .optional()
          .describe('ISO country code bounding the search (default "US").'),
      },
    },
    async ({
      query,
      focus,
      city,
      state,
      lat,
      lng,
      radiusMi,
      limit,
      countryCode,
    }): Promise<CallToolResult> => {
      if (!isMapsConfigured()) {
        return errorResult(
          "Area discovery is unavailable: AZURE_MAPS_KEY is not set in the repo-root .env.",
        );
      }

      const country = (countryCode ?? "US").trim().toUpperCase();
      const radius = clamp(radiusMi ?? DEFAULT_RADIUS_MI, 0.5, 31);
      const max = clamp(Math.round(limit ?? DEFAULT_LIMIT), 1, 50);

      try {
        const cfg = loadMapsConfig();

        let anchor: Anchor | null;
        if (isLatLng(lat, lng)) {
          anchor = {
            lat: lat as number,
            lng: lng as number,
            label: `${lat}, ${lng}`,
          };
        } else {
          const place = [city?.trim(), state?.trim()]
            .filter(Boolean)
            .join(", ");
          if (!place) {
            return errorResult(
              "Provide an anchor: either a city (with optional state) or a lat/lng pair.",
            );
          }
          anchor = await geocodePlace(cfg, place, country);
          if (!anchor)
            return errorResult(`Could not locate "${place}" in ${country}.`);
        }

        const {
          applied: appliedFocus,
          dropped: droppedFocus,
          categorySet,
        } = applyFocus(focus);

        const businesses = await discoverBusinesses(cfg, anchor, {
          query,
          radiusMi: radius,
          limit: max,
          countryCode: country,
          categorySet,
        });

        const structuredContent = {
          provider: "azure-maps",
          anchor: {
            lat: anchor.lat,
            lng: anchor.lng,
            label: anchor.label,
            radiusMi: radius,
          },
          query: query?.trim() || null,
          focus: appliedFocus,
          focusDropped: droppedFocus,
          count: businesses.length,
          businesses,
        };

        const scope = [
          query ? `matching "${query}"` : null,
          appliedFocus.length ? `in [${appliedFocus.join(", ")}]` : null,
        ]
          .filter(Boolean)
          .join(" ");
        const suffix = scope ? ` ${scope}` : "";
        const header = businesses.length
          ? `${businesses.length} business(es) within ${radius} mi of ${anchor.label}${suffix}:`
          : `No businesses found within ${radius} mi of ${anchor.label}${suffix}.`;

        return {
          content: [
            {
              type: "text",
              text: [header, ...businesses.map(line)].join("\n"),
            },
          ],
          structuredContent,
        };
      } catch (err) {
        if (err instanceof MapsError) return errorResult(err.message);
        throw err;
      }
    },
  );
}
