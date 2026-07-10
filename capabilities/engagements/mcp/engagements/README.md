# Engagements MCP capability server

The **capability tier** of the Strategic Engagements Travel Planner (ARCHITECTURE §5.3). It exposes the
deterministic planner engine (`api/src/planner`) and the security-trimmed retrieval shim
(`api/src/retrieval`) as MCP tools that the orchestrator/chat host calls. Local-first — runs with `tsx`,
no cloud. The `ui://trip-map` MCP App is added at **M3**; **M4** swaps the shim for real Azure AI Search.

## Tools

| Tool | Purpose |
| --- | --- |
| `search_contacts` | Security-trimmed contact recall (free-text + topic/status). Reports `$filter` + `redactedCount`. |
| `search_events` | Security-trimmed anchor discovery (the conferences a trip is built around). |
| `suggest_candidates` | **The nudge** — rank who a leader should meet at an anchor event (on-site + nearby stale re-engagements), authorized-only. Returns a ranked menu. |
| `build_itinerary` | Order accepted stops, compute trip-ROI, and surface advisory conflicts (fit / budget / opportunity-cost). |

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

## Interop note

`engine.ts` is the single bridge from this ESM capability into the CommonJS `api/src` engine
(default-import the module namespace, then destructure — immune to the `export *` / cjs-module-lexer
limitation on named imports). Everything else imports the engine only from `./engine.js`.
