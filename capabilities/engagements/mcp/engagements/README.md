# Engagements MCP capability server

The **capability tier** of the Strategic Engagements Travel Planner (ARCHITECTURE §5.3). It exposes the
deterministic planner engine (`src/planner`) and the security-trimmed retrieval shim
(`src/retrieval`) as MCP tools that the orchestrator/chat host calls. Local-first — runs with `tsx`,
no cloud. `build_itinerary` renders on the **`ui://trip-map`** Azure Maps MCP App (M3, the one UI in
scope); **M4** adds a real Azure AI Search backend, selectable with `RETRIEVAL_BACKEND` (see below).

## Tools

| Tool | Purpose |
| --- | --- |
| `search_contacts` | Security-trimmed contact recall (free-text + topic/status). Reports `$filter` + `redactedCount`. |
| `search_events` | Security-trimmed anchor discovery (the conferences a trip is built around). |
| `survey_area` | **Area-first** — anchor on a place + date window and see which topics have a live footprint there (contacts/events + approved-message badge), ranked by opportunity. |
| `suggest_leaders` | Given an area + topics, rank **which senior leader should go** (topic fit, availability in the window, seniority). Always a ranked menu — advisory, not an auto-pick. |
| `nearby_leaders` | **Deconfliction / awareness** — anchor on an event or an area + window and see which **other senior leaders** will be at, or close to, the same place: sharing the anchor event (`same-event`), owning a contact on the itinerary (`same-contact`), or home-based within reach and available (`nearby-geo`). Pass `leaderId` to frame "who else" and `stopContactIds` to light up shared-contact overlaps. Advisory only. |
| `suggest_candidates` | **The nudge** — rank who a leader should meet at an anchor event (on-site + nearby stale re-engagements), authorized-only. Returns a ranked menu. |
| `plan_options` | **The capstone** — anchor on an area + window and get one optioned plan: topic survey, ranked leader options, tiered **duration options** (core vs. extended, fully costed), and **extension options** ("+N days unlocks meeting THIS entity on THIS topic — here are the approved talking points"). |
| `plan_radius` | **Fixed-radius planner** — the "a leader must visit a specific company (or coordinate/city) for a fixed N days, **no anchor event**" entry. Anchors by company name / contact id / raw `lat`+`lng` / city, fills `days × meetingsPerDay` slots with the anchor (met on-site) + the highest-value **authorized contacts inside the radius**, and offers the overflow as fixed-days **extension options** ("+1 day unlocks one more meeting…"). Purely geographic — it does **not** absorb nearby events' rosters. |
| `build_itinerary` | Order accepted stops, compute trip-ROI, and surface advisory conflicts (fit / budget / opportunity-cost) **plus `nearbyLeaders` awareness** (other senior leaders at/near the same event/contact/geo). **Two modes:** event-anchored (`eventId`/`eventQuery`) or **event-less radius** (`company`/`anchorContactId`/`lat`+`lng`/`city` + `days`). In event mode, optional **`additionalContactIds`** appends an authorized **regional swing** — far-afield on-topic stops beyond the event's nearby pool (re-authorized through the same trim, so it can't smuggle a redacted contact) — which is how the leader-first `/ask` builds longer options while keeping the on-site attendees. **App tool** — its result carries a `tripMap` payload rendered on `ui://trip-map`. |

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

`npm run serve` rebuilds the single-file App automatically (a `preserve` hook runs `build:app`), so the
served `dist/trip-map.html` always reflects the current repo-root `AZURE_MAPS_KEY`. Build it manually only
for the standalone `?demo` preview or to watch for changes (`dist/` is gitignored):

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

## Retrieval backend (`memory` | `search`)

The tools read through one async seam (`src/readmodel.ts`), selected by `RETRIEVAL_BACKEND`:

| Value | Backend | Notes |
| --- | --- | --- |
| `memory` (default) | In-memory `EngagementIndex` over the staged seed. | Zero cloud; the trim runs as a predicate. Loaded fresh per call. |
| `search` | **Real Azure AI Search** — the same tenant + ACL + sensitivity trim is enforced **server-side** as an OData `$filter`. | Falls back to `memory` if no service is configured. |

Both honor the identical `TrimmedResult` contract, so the demo beats (`redactedCount`, the AUSA/UAS
menu, the "watch C4 disappear" for `EA_BASIC`) are byte-for-byte the same on either backend.

### Cloud config (repo-root `.env`)

```
AZURE_SEARCH_SERVICE=https://<service>.search.windows.net
AZURE_SEARCH_API_KEY=<admin-or-query-key>       # omit to use DefaultAzureCredential (az login / managed identity)
# ENGAGEMENTS_SEARCH_INDEX=engagements          # optional override (default: engagements)
```

### Provision + reindex

One `engagements` index carries both sources via a `kind` (`contact` | `event`) discriminator, with the
governance envelope (`tenantId`, `aclGroups[]`, `sensitivity`, `topicIds[]`) as filterable fields and the
full record in a retrievable `json` field. The CLI is the local stand-in for the ETL/indexer:

```bash
npm run provision:search --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements               # reindex (ensure + upsert seed)
npm run provision:search --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements -- ensure      # create/update index only
npm run provision:search --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements -- sync        # upsert docs only
npm run provision:search --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements -- delete contact C4   # delete one record (demo)
```

Serve against it with `RETRIEVAL_BACKEND=search npm run serve …`. Add/update/delete a record then
`reindex` to watch a source change flow through the trim live (indexing is eventually consistent — allow
a second or two).

## Interop note

The deterministic **planner** (`src/planner`) and **retrieval / security** (`src/retrieval`) engines
live inside this ESM package. `engine.ts` is the single bridge that adapts them into the MCP tool layer:
it imports each as a namespace (`import * as planner from './planner/index.js'`), then re-exports the
pieces the tools use. Everything else imports the engine only from `./engine.js`.
