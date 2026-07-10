# Engagements MCP capability server

The **capability tier** of the Strategic Engagements Travel Planner (ARCHITECTURE §5.3). It exposes the
deterministic planner engine (`api/src/planner`) and the security-trimmed retrieval shim
(`api/src/retrieval`) as MCP tools that the orchestrator/chat host calls. Local-first — runs with `tsx`,
no cloud. `build_itinerary` renders on the **`ui://trip-map`** Azure Maps MCP App (M3, the one UI in
scope); **M4** swaps the shim for real Azure AI Search.

## Tools

| Tool | Purpose |
| --- | --- |
| `search_contacts` | Security-trimmed contact recall (free-text + topic/status). Reports `$filter` + `redactedCount`. |
| `search_events` | Security-trimmed anchor discovery (the conferences a trip is built around). |
| `suggest_candidates` | **The nudge** — rank who a leader should meet at an anchor event (on-site + nearby stale re-engagements), authorized-only. Returns a ranked menu. |
| `build_itinerary` | Order accepted stops, compute trip-ROI, and surface advisory conflicts (fit / budget / opportunity-cost). **App tool** — its result carries a `tripMap` payload rendered on `ui://trip-map`. |

## Caller identity (security trim)

Claims arrive as request headers (the prod Keycloak token maps to the same shape). Fastest demo switch:

```
x-demo-persona: EA_BASIC | EA_G8 | ADMIN | CROSS_TENANT | NO_TENANT
```

or the granular form: `x-tenant-id`, `x-user-id`, `x-user-groups`, `x-user-roles`, `x-user-scopes`.
Default caller is `EA_BASIC` (enterprise baseline), so the trim is visible out-of-the-box: the canonical
AUSA/UAS menu returns `{P2, C3}` with the G8-restricted **C4** redacted until you elevate to `EA_G8`.

## Run

```bash
# from the repo root
npm run serve  --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements   # HTTP  → http://localhost:3010/mcp
npm run serve:stdio --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements  # stdio
npm test       --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements   # end-to-end MCP client tests
```

`PORT` / `ENGAGEMENTS_MCP_PORT` override the port; `ENGAGEMENTS_DEMO_PERSONA` sets the stdio/default persona.

## Trip Map App (`ui://trip-map`)

`build_itinerary` is an MCP **App tool**: its result carries a `tripMap` payload (anchor venue + ordered
stops with lat/lng + travel legs) that the host renders on an Azure Maps map — the one UI in scope
(ARCHITECTURE §9). On-site contacts plot at the venue (≈0 travel); off-site detours radiate out with
dashed legs; a ROI / over-budget summary sits on top. The wire shape is `src/app-payload.ts` (import-free
so Vite can bundle it into the browser App); the engine → payload mapping lives in `tools.ts`.

Build the single-file App before serving (the server reads `dist/trip-map.html`; `dist/` is gitignored):

```bash
npm run build:app --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements   # → dist/trip-map.html
npm run watch:app --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements   # rebuild on change
```

- **Azure Maps key** — baked at build from the repo-root `AZURE_MAPS_KEY` (local dev only; prod should use
  Azure Maps AAD anonymous auth). With no key, or if the host blocks tiles, the App degrades to a schematic
  list — always legible.
- **CSP** — the resource declares `*.atlas.microsoft.com` in `connectDomains` / `resourceDomains` so the
  sandboxed iframe can load map tiles.
- **Standalone preview** — open the built `dist/trip-map.html?demo` in a browser to see a sample AUSA
  itinerary without a host.

Try it in a real host with the ext-apps `basic-host`:

```bash
npm run build:app --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements
npm run serve     --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements   # http://localhost:3010/mcp
# then, in a clone of modelcontextprotocol/ext-apps:
#   SERVERS='["http://localhost:3010/mcp"]' npm run start   → http://localhost:8080
```

## Interop note

`engine.ts` is the single bridge from this ESM capability into the CommonJS `api/src` engine
(default-import the module namespace, then destructure — immune to the `export *` / cjs-module-lexer
limitation on named imports). Everything else imports the engine only from `./engine.js`.
