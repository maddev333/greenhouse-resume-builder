# Geospatial capability (IL5)

Projects location-bearing records into Azure Maps pins. Bundles one MCP server, the
agent-framework runtime, and the Map Pins UI App.

| Part | Path | Role |
|------|------|------|
| MCP server | `mcp/geospatial` | `normalize_location`, `geocode`, `project_map_pins` (live Azure Maps geocoding) |
| Agent | `agent` | self-hosted Azure OpenAI normalize/geocode loop |
| UI App | `ui` | Map Pins — renders an interactive Azure Maps map (hybrid web + MCP App) |

## Run locally

```bash
npm run build -w @greenhouse-resume-builder/cap-geospatial-mcp-geospatial
cd capabilities/geospatial/mcp/geospatial && func start --port 7076

npm run build -w @greenhouse-resume-builder/cap-geospatial-agent
node capabilities/geospatial/agent/dist/agent.js person-123

npm run dev -w @greenhouse-resume-builder/cap-geospatial-ui   # http://localhost:5185
```

`project_map_pins` accepts `{ personId, locations? }` (each location a string or `{ label?, location }`),
geocodes them via Azure Maps, and returns pins with `latitude`/`longitude`. The Map Pins UI plots those
pins as markers with popups and fits the map to their bounds.

### Consumed by the main app (candidate profile, page 2)

The main UI's candidate profile page renders a **Map** tab whenever a candidate has location-bearing
facts. It extracts those locations from the person's facts (`profile.location`, `employment.location`,
`education.location` — served by `GET /api/v1/insights/:personId/facts`), calls this server's
`project_map_pins` to geocode them, and draws the Azure Maps map with category-coloured markers
(current / work / education). The MCP server is the geocoding data provider, so any agent can make the
same call. The standalone Map Pins UI (below) remains a zero-dependency demo where you type locations directly.

### Azure Maps key wiring (local dev)

Both sides reuse the repo-root `.env` `AZURE_MAPS_KEY` automatically — no extra setup:

- **Server:** `mcp/geospatial` loads the nearest `.env`/`.env.local` (walking up from `dist`) before
  registering, so the func process picks up `AZURE_MAPS_KEY` (or `AZURE_MAPS_CLIENT_ID` managed identity).
- **Browser:** both the standalone Map Pins UI (`capabilities/geospatial/ui/`) and the main app UI
  (`ui/`) inject `import.meta.env.VITE_AZURE_MAPS_KEY` via `vite.config.ts`, sourced from that app's
  `.env` (`VITE_AZURE_MAPS_KEY`) or, if unset, the root `.env` `AZURE_MAPS_KEY`. Without a key the UI
  still lists pins but shows a placeholder instead of the map. See each app's `.env.example`.

The UIs call the server cross-origin; the shared MCP server reflects localhost origins by default
(override with `MCP_CORS_ALLOWED_ORIGINS`).

## IL5 notes

- Do not geocode sensitive personal/home locations; prefer coarse city/region precision.
- Map pins are projections over source records, not independent facts.
- Azure Maps is IL5-authorized; managed identity by default; deploy `mcp/geospatial`
  behind API Management (not Container Apps).
- The browser map key is for local dev only — it is baked into the client bundle. In production,
  serve the map with Azure Maps AAD (anonymous) auth instead of a subscription key.
