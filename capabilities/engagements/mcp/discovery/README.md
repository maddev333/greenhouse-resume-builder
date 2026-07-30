# Area Discovery MCP capability

Surfaces **businesses physically around a travel anchor** so a traveler can be made aware of
organizations in the area they don't already track. Standalone by design: it holds no engagement data
and applies no security trim, because everything it returns is public Azure Maps POI data.

The **"new/unknown" judgement is not made here.** This server answers _"what is there?"_; the
orchestrator cross-references the returned names against `search_contacts` on the engagements
capability to decide which are already-known relationships and which are genuinely new leads worth
offering as an itinerary addition.

## Run

```bash
npm run serve       --workspace @greenhouse-resume-builder/cap-engagements-mcp-discovery   # HTTP  → http://localhost:3011/mcp
npm run serve:stdio --workspace @greenhouse-resume-builder/cap-engagements-mcp-discovery   # stdio
npm test            --workspace @greenhouse-resume-builder/cap-engagements-mcp-discovery   # fetch is stubbed; no network, no key needed
```

Requires `AZURE_MAPS_KEY` in the repo-root `.env` — the same key the trip-map App uses. Without it the
server still boots and `search_businesses` returns a clear tool error.

## `search_businesses`

| Input                                 | Notes                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `city` + `state` **or** `lat` + `lng` | The anchor. A city is geocoded first; lat/lng skips that hop.                                                          |
| `focus`                               | Curated organization types: `industry`, `manufacturing`, `technology`, `research`, `academia`, `government`, `venues`. |
| `query`                               | Keyword matched against **POI names** (e.g. `"aerospace"`), so it is narrow.                                           |
| `radiusMi`                            | Default 10, clamped to 31 (Azure Maps caps the radius at 50 km).                                                       |
| `limit`                               | Default 15, max 50.                                                                                                    |
| `countryCode`                         | Default `US`.                                                                                                          |

Returns `{ provider, anchor, query, focus, count, businesses[] }`, each business carrying
`name / category / brand / address / city / state / lat / lng / distanceMi / phone / url`. The
`lat`/`lng` feed straight into the existing `ui://trip-map` App.

**Picking the right knobs.** `focus` alone is distance-ranked, so in a dense downtown a wide radius
still returns the nearest block (law offices, coffee shops classified as "company"). Combining
`focus` with a `query` is what produces a targeted list:

```
query="aerospace", focus=[industry, technology, research], radiusMi=25
  → FMS Aerospace (1.64 mi) · Onyx Aerospace (1.67 mi) · PPG Aerospace (4.5 mi)
    UTC Aerospace Systems (4.62 mi) · Cummings Aerospace (5.77 mi) · Griffon Aerospace (9.35 mi)
```

## Backend

Azure Maps **Search v1**: `search/address/json` to geocode, then `search/poi/json` (with `query`) or
`search/nearby/json` (without). `focus` groups map to verified POI category ids from the Search POI
Category Tree API.

Handling of the subscription key:

- sent as a `subscription-key` **header**, never a query parameter, so it cannot land in proxy logs
- never echoed into a tool result — upstream failures surface only the HTTP status, not the body
- URLs are built with `URL`/`searchParams`, so caller text cannot inject path segments or parameters
- every request carries an `AbortSignal.timeout` (`DISCOVERY_TIMEOUT_MS`, default 8 s)

Azure Maps returns at most 100 POIs per area regardless of paging — this is a _discovery_ surface, not
an exhaustive business registry.
