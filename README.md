# Strategic Engagements Travel Planner — MVP Demo

A CRM-style planning assistant for U.S. Army senior-leader engagements, delivered as a
**chat UI that hosts MCP UI Apps**. You ask a natural-language question; an orchestrator
agent calls a domain capability (living behind MCP tools), applies a persona-based security
trim, and answers with a menu of who-to-meet cards plus an interactive **Azure Maps** trip
itinerary rendered as a sandboxed MCP App.

> The "money moment": _"you're already going there"_ — the planner batches stale or
> high-value contacts into a trip a leader is already taking.

## What the demo shows

Open the chat host, keep the persona on **EA · G8**, and ask:

> _I'm planning a trip to AUSA — who should I meet on the UAS/drone topic?_

You get an assistant summary, a menu of candidate contacts, and a live trip map. Switch the
persona and re-ask to watch the **server-side security trim** change what's returned:

| Persona        | Result                                             |
| -------------- | -------------------------------------------------- |
| `EA_G8`        | 3 cards (1 redacted)                               |
| `EA_BASIC`     | 2 cards (2 redacted)                               |
| `NO_TENANT`    | rejected (fail-closed)                             |
| `CROSS_TENANT` | empty (tenant isolation)                           |

## Repository layout

```
capabilities/
  engagements/            ← the demo (the only capability wired up)
    mcp/engagements/      MCP capability server: seed data, retrieval, security trim,
                          suggest_candidates / build_itinerary tools, and the ui://trip-map App
    agent/                M5 orchestrator ("the chat brain") — POST /ask over the MCP tools
    ui/                   M6 chat UI + real MCP-Apps host (the interface you run)
  mcp-core/               shared MCP-server helper, agent loop, identity + governance gate
shared/                   canonical Strategic Engagements domain schema (framework-free types)
engagement-intelligence/  design docs (ARCHITECTURE, DEMO-DATASET, MVP-PLAN) + seed dataset
governance/               optional Agent-Governance-Toolkit policy for mcp-core
```

## Quickstart

Prerequisites: **Node 20+** and npm. This is an npm-workspaces monorepo — run `npm install`
once at the repo root.

```powershell
# from the repo root, one time:
npm install
az login          # optional — enables the Azure OpenAI path; a deterministic fallback runs without it
```

Then start the whole demo (builds the chat host and launches all three servers) with one command:

```powershell
npm run demo --workspace @greenhouse-resume-builder/cap-engagements-ui
```

Open **http://localhost:8080**. Press `Ctrl+C` to stop.

Full run details, the manual three-terminal path, config, and troubleshooting live in
[`capabilities/engagements/ui/README.md`](capabilities/engagements/ui/README.md).

### Optional configuration

Copy `.env.example` to `.env` at the repo root to enable the optional integrations:

- **Live map tiles** — set `AZURE_MAPS_KEY`; the demo rebuilds the map App on start, so a restart
  picks up the key. Without it the map falls back to a schematic dots-and-routes view.
- **LLM planning** — set `AZURE_OPENAI_*` (and `az login`) to use Azure OpenAI; otherwise the
  orchestrator uses a deterministic planner.
- **Azure AI Search backend** — set `RETRIEVAL_BACKEND=search` + `AZURE_SEARCH_*` to index the
  seed data into Azure AI Search; the default `memory` backend needs no cloud resources.

## How it fits together

Three services (plus a distinct sandbox origin). The **one** MCP server has **two clients**: the
agent calls its **tools**, and the browser reads its **`ui://trip-map` App resource** directly.

```
Browser chat host (:8080)                                  chat client + MCP-Apps host
  │
  ├─ POST /ask ─────────────────────►  Orchestrator agent (:3020)   "the brain"
  │  ◄─ { answer, menu[], tripMap }        └─ MCP tools/call ──────┐
  │                                                                ▼
  └─ resources/read ui://trip-map ──────────────────►  Engagements MCP (:3010)
     (rendered in a sandboxed iframe, :8081)             • seed contacts/events/topics
                                                         • persona security trim
                                                         • suggest_candidates / build_itinerary
                                                         • ui://trip-map App resource

  (future · optional)  Personal Context MCP  ◄── the agent calls it with per-user Entra/OBO
                                                 to personalize the itinerary at request time
```

See [`engagement-intelligence/ARCHITECTURE.md`](engagement-intelligence/ARCHITECTURE.md) for the
full design (data model, blob → AI Search indexing, claims-based trim, and the modular
capability architecture) and [`engagement-intelligence/MVP-PLAN.md`](engagement-intelligence/MVP-PLAN.md)
for the milestone roadmap. The future per-user personalization server is designed in
[`docs/personal-context-and-engagement-intelligence-design.md`](docs/personal-context-and-engagement-intelligence-design.md),
and the future area-first / optioned planning flow (geo anchor, topics-in-area, leader selection,
duration + extension options) in
[`docs/area-first-optioned-planning-design.md`](docs/area-first-optioned-planning-design.md).
