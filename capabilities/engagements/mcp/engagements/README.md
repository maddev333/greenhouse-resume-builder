# Engagements MCP capability server

The **capability tier** of the Strategic Engagements Travel Planner (ARCHITECTURE §5.3). It exposes the
deterministic planner engine (`src/planner`) and the retrieval layer (`src/retrieval`) as MCP tools
that the orchestrator/chat host calls. Local-first — runs with `tsx`, no cloud. `build_itinerary`
renders on the **`ui://trip-map`** Azure Maps MCP App (M3, the one UI in scope); a real Azure AI Search
backend is selectable with `RETRIEVAL_BACKEND` (see below).

> **No access control.** This server applies **no** security trim, tenant isolation or ACL/sensitivity
> filtering — those were removed. Every caller sees the **entire corpus** the configured backend
> holds. Access control, if you need it, has to live in front of this server.

## Tools

Nine planner tools are registered for `RETRIEVAL_BACKEND=memory` and `search`. `search_grounding` is
registered **in addition** whenever an index declaration carries a `mapping.grounding` block, and is
the **only** tool registered when `RETRIEVAL_BACKEND=grounding`.

| Tool                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_grounding`   | **Grounded RAG** — ranked passages from a document/chunk index (hybrid BM25 + vector, semantic reranking where configured), returned with citation metadata (`id`, `title`, `url`, `parentId`). Inputs: `query`, `top` (default 8), optional OData `filter`. Registration is conditional — see above.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `search_contacts`    | Contact recall (free-text over name / org / SME area / city / state, plus `topicIds` and `status`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `search_events`      | Anchor discovery (the conferences a trip is built around).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `survey_area`        | **Area-first** — anchor on a place + date window and see which topics have a live footprint there (contacts/events + approved-message badge), ranked by opportunity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `suggest_leaders`    | Given an area + topics, rank **which senior leader should go** (topic fit, availability in the window, seniority). Always a ranked menu — advisory, not an auto-pick.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `nearby_leaders`     | **Deconfliction / awareness** — anchor on an event or an area + window and see which **other senior leaders** will be at, or close to, the same place: sharing the anchor event (`same-event`), owning a contact on the itinerary (`same-contact`), or home-based within reach and available (`nearby-geo`). Pass `leaderId` to frame "who else" and `stopContactIds` to light up shared-contact overlaps. Advisory only.                                                                                                                                                                                                                                                                                                                                         |
| `suggest_candidates` | **The nudge** — rank who a leader should meet at an anchor event (on-site + nearby stale re-engagements). Returns a ranked menu.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `plan_options`       | **The capstone** — anchor on an area + window and get one optioned plan: topic survey, ranked leader options, tiered **duration options** (core vs. extended, fully costed), and **extension options** ("+N days unlocks meeting THIS entity on THIS topic — here are the approved talking points").                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `plan_radius`        | **Fixed-radius planner** — the "a leader must visit a specific company (or coordinate/city) for a fixed N days, **no anchor event**" entry. Anchors by company name / contact id / raw `lat`+`lng` / city, fills `days × meetingsPerDay` slots with the anchor (met on-site) + the highest-value contacts inside the radius, and offers the overflow as fixed-days **extension options** ("+1 day unlocks one more meeting…"). Purely geographic — it does **not** absorb nearby events' rosters.                                                                                                                                                                                                                                                                 |
| `build_itinerary`    | Order accepted stops, compute trip-ROI, and surface advisory conflicts (fit / budget / opportunity-cost) **plus `nearbyLeaders` awareness** (other senior leaders at/near the same event/contact/geo). **Two modes:** event-anchored (`eventId`/`eventQuery`) or **event-less radius** (`company`/`anchorContactId`/`lat`+`lng`/`city` + `days`). In event mode, optional **`additionalContactIds`** appends a **regional swing** — far-afield on-topic stops beyond the event's nearby pool — which is how the leader-first `/ask` builds longer options while keeping the on-site attendees; ids that match no known contact come back in `notMatched` and are never routed. **App tool** — its result carries a `tripMap` payload rendered on `ui://trip-map`. |

## Run

```bash
# from the repo root
npm run serve  --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements   # HTTP  → http://localhost:3010/mcp
npm run serve:stdio --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements  # stdio
npm test       --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements   # end-to-end MCP client tests
```

`PORT` / `ENGAGEMENTS_MCP_PORT` override the port.

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

## Retrieval backend (`memory` | `search` | `grounding`)

The planner tools read through one async seam (`src/readmodel.ts`), selected by `RETRIEVAL_BACKEND`:

| Value              | Backend                                                                                                 | Notes                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory` (default) | In-memory `EngagementIndex` over the staged seed.                                                       | Zero cloud. Loaded fresh per call, so a live add/update/delete shows immediately.                                                                                            |
| `search`           | **Azure AI Search index of STRUCTURED records** (contacts, events, leaders, topics, messages, regions). | The full deterministic planner. Needs `mapping.entityType` + `mapping.payload` in the index declaration.                                                                     |
| `grounding`        | **Azure AI Search index of DOCUMENTS/CHUNKS** — an ordinary RAG index.                                  | Registers **only** `search_grounding`. The deterministic planner is unavailable, because a text corpus carries no contacts, geo or leader roster. Needs `mapping.grounding`. |

**Seed isolation.** Neither cloud mode falls back to the seed. Asking for `search` or `grounding`
without `AZURE_SEARCH_SERVICE` set is a **hard error**, not a silent downgrade — a quiet fallback
would serve demo data while looking healthy. In `search` mode contacts, events, leaders, topics,
messages **and** regions all come from the index, and `today` is the real current date rather than
the seed's month-shifted demo clock; a record kind the index does not carry reads back **empty**
rather than being substituted from the seed. `grounding` mode does not open the seed at all.

`search_grounding` over-fetches, then collapses passages **by parent document** (best-scoring chunk
wins) before taking the top N, so one long PDF cannot occupy every result slot.

### Cloud config (repo-root `.env`)

```
AZURE_SEARCH_SERVICE=https://<service>.search.windows.net
AZURE_SEARCH_API_KEY=<admin-or-query-key>       # omit to use DefaultAzureCredential (az login / managed identity)
# AZURE_SEARCH_ENDPOINT_SUFFIX=search.windows.net   # sovereign clouds
```

### Index schema registry

Each index is described by its own JSON config file declaring `id`, `indexName`, `fields[]`
(`name`, `type`, `key`/`filterable`/`searchable`/`sortable`/`facetable`/`retrievable`) and a
`mapping` from logical role → physical field name. Adding an index means dropping in a file — no
code change. The declarations are also the query guard: a `filterable` mismatch fails with a readable
message naming the field and the file, instead of an opaque Azure HTTP 400.

| Var                         | Takes                                                                                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENGAGEMENTS_INDEX_SCHEMAS` | Comma/semicolon-separated **file and/or directory** paths. A directory contributes every `*.json` in it, sorted by filename, **skipping `*.example.json`**. Wins over the singular form.                                                                                  |
| `ENGAGEMENTS_INDEX_SCHEMA`  | One file (the original single-index knob).                                                                                                                                                                                                                                |
| _(neither set)_             | The checked-in default for the backend: [`config/rag-index.json`](./config/rag-index.json) when `RETRIEVAL_BACKEND=grounding`, else [`index-schema.json`](./index-schema.json). Taken from the process working directory when a deployed copy is there, else from source. |

**Grounding needs no path configuration.** `RETRIEVAL_BACKEND=grounding` serves exactly one index —
the customer RAG corpus — so its default is `config/rag-index.json`, the single file to edit.
`engagements-mcp.zip` packages that same file at `config/rag-index.json` beside the running process,
so the identical declaration loads locally and on App Service. (Defaulting grounding to the
structured `index-schema.json`, which carries no `mapping.grounding` block, would fail every
grounded query.)

Roles resolve **by content, not by order**:

- the declaration carrying `mapping.grounding` is the corpus `search_grounding` answers from;
- `mapping.entityType` values decide which declaration serves each record kind — so contacts and
  events may live in **different** indexes, one index may hold everything, or one index per kind.

Validation rejects duplicate `id`s, more than one `mapping.grounding` block, the same record kind
claimed by two declarations, an `indexName` left as an unedited `<placeholder>`, and an empty
registry — each error naming the offending files.

Examples to copy: [`index-schema.json`](./index-schema.json) (the demo index),
[`index-schema.structured.example.json`](./index-schema.structured.example.json) (a customer index of
structured records with unknown field names), and
[`index-schema.grounding.example.json`](./index-schema.grounding.example.json) (the annotated
reference for a plain document/chunk RAG index — for an actual grounding deployment edit
[`config/rag-index.json`](./config/rag-index.json) instead, since that is the one loaded by default).

Two caveats worth knowing:

- **`ENGAGEMENTS_SEARCH_INDEX` throws** when the registry holds more than one declaration — applying
  one name to several declarations would silently collapse distinct indexes onto one. Set
  `indexName` in each config file instead.
- **Prefer absolute paths.** A relative `ENGAGEMENTS_INDEX_SCHEMA(S)` resolves against the process
  working directory, which differs between `npm run -w <workspace>` and a deployed Web App.

### Provision + reindex

```bash
npm run provision:search --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements -- validate   # OFFLINE — check + print every declaration
npm run provision:search --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements               # reindex (ensure + sync)
npm run provision:search --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements -- ensure      # create/update indexes only
npm run provision:search --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements -- sync        # upsert seed docs only
npm run provision:search --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements -- delete contact C4   # delete one record (demo)
```

> **Never run `ensure` / `sync` / `reindex` against a customer index.** `ensure` reshapes the index
> from the declaration and `sync` pushes demo seed records into it. `validate` makes **no** Azure
> calls and is the only safe command against an index you did not create — run it first, and check
> that the printed `index`, `kinds` and `grounding` lines match what you expect.

The checked-in `index-schema.json` describes the demo `engagements` index: one index carrying every
record kind behind a `kind` discriminator, with `topicIds[]` / `status` / `city` / `state` filterable
and the full record in a retrievable `json` payload field. `provision:search` is the local stand-in
for the ETL/indexer that would normally land per-source blobs.

Serve against it with `RETRIEVAL_BACKEND=search npm run serve …`. Add/update/delete a record then
`reindex` to watch a source change flow through live (indexing is eventually consistent — allow a
second or two).

## Interop note

The deterministic **planner** (`src/planner`) and **retrieval** (`src/retrieval`) engines
live inside this ESM package. `engine.ts` is the single bridge that adapts them into the MCP tool layer:
it imports each as a namespace (`import * as planner from './planner/index.js'`), then re-exports the
pieces the tools use. Everything else imports the engine only from `./engine.js`.
