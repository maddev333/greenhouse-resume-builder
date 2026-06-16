# Geospatial capability (IL5)

Projects location-bearing records into Azure Maps pins. Bundles one MCP server, the
agent-framework runtime, and the Map Pins UI App.

| Part | Path | Role |
|------|------|------|
| MCP server | `mcp/geospatial` | `normalize_location`, `geocode`, `project_map_pins` |
| Agent | `agent` | self-hosted Azure OpenAI normalize/geocode loop |
| UI App | `ui` | Map Pins (hybrid web + MCP App) |

## Run locally

```bash
npm run build -w @greenhouse-resume-builder/cap-geospatial-mcp-geospatial
cd capabilities/geospatial/mcp/geospatial && func start --port 7076

npm run build -w @greenhouse-resume-builder/cap-geospatial-agent
node capabilities/geospatial/agent/dist/agent.js person-123

npm run dev -w @greenhouse-resume-builder/cap-geospatial-ui
```

## IL5 notes

- Do not geocode sensitive personal/home locations; prefer coarse city/region precision.
- Map pins are projections over source records, not independent facts.
- Azure Maps is IL5-authorized; managed identity by default; deploy `mcp/geospatial`
  behind API Management (not Container Apps).
