# Engagements Chat UI (M6) — a real MCP‑Apps host over the M5 orchestrator

A chat window that drives the **M5 orchestrator** and renders the
`ui://trip-map` **MCP App** in a sandboxed iframe — the interface the MVP calls for:
_"a chat UI that supports MCP UI apps."_

```
Browser (chat host page :8080)
  │  chat composer
  │
  ├─► free-form is the PRIMARY path — type anything (Enter / "Ask ▸") — POST :3020/ask { question, leaderId?, category?, context?, history? }
  │      ⇒ { answer, menu[], itinerary, tripMap, mode }
  │      OR (known-region, CATEGORY-first) stage:"clarify" { clarify:"category", categoryBreakdown[], questions:[{ id:"category", choices[] }] }
  │         → pick a category → re-ask with category ⇒ stage:"plan" { category, menu[], tripMap, leaderShortlist:[{ …, why, recommended, selected }] }  ← leader = OUTPUT
  │            (recommended leader is overridable: click an alternate → re-ask with category + leaderId ⇒ re-plans for that leader, marks it selected)
  │      OR (event-anchored, leader-first) stage:"clarify" { questions:[{ id:"leader", choices[] }] }
  │         → pick a leader → re-ask with leaderId ⇒ stage:"options" { options:[different-scope itineraries], recommendedOptionId }
  │   render: assistant text + candidate cards (chat‑native); category chips → single-audience plan + recommended-leader panel;
  │           leader chips → option cards; select one to drill into its full detail (meetings, trip-ROI, advisories, nearby leaders, map)
  │      typed follow-ups carry the last 10 turns for reference resolution plus the prior
  │      plan's ids as `context`; the agent re-resolves those ids with tools before answering
  │
  ├─► quick-start chips just *seed* a free-form /ask (they never lock you into a flow):
  │     ├─ 🔥 hot topics — GET :3020/topics
  │     │      ⇒ ranked [{ topicId, name, reason, question, hasApprovedMessage }]
  │     │      click → ask(topic.question)   ("what's hot in cyber?" → the agent)
  │     └─ 📍 areas — click a region chip → ask("Plan a trip to <area> …")
  │
  ├─► opt-in "Plan a trip" (deterministic area-first wizard) — POST :3020/plan-options { regionId | question }
  │     │     ⇒ stage:"clarify" (region chips)  OR
  │     │       stage:"options" { area, window, areaSurvey[], questions:[leader|duration|extensions] }
  │     │   render: option cards — who should go (radios) · how long (core/extended) · extensions (checkboxes)
  │     └─ POST :3020/build { leaderId, durationTier, extensionContactIds[], regionId }
  │           ⇒ { answer, menu[], itinerary, tripMap }
  │
  └─ when a tripMap comes back, embed the REAL sandboxed app:
       ├─ MCP Client → http://localhost:3010/mcp
       │     readResource("ui://trip-map/trip-map.html")  → app HTML + CSP
       ├─ load sandbox proxy iframe → http://localhost:8081/sandbox.html?csp=…   (distinct origin)
       ├─ AppBridge.connect(PostMessageTransport)          (ext-apps host bridge)
       ├─ AppBridge.sendSandboxResourceReady({ html, csp })
       └─ AppBridge.sendToolResult({ structuredContent: { tripMap } })
             → the app's `ontoolresult` renders the Azure Maps trip
```

The orchestrator decides the itinerary server‑side; this host only reads the app shell and hands the
returned `tripMap` to the sandboxed app. The map is the same `ui://trip-map` App a compliant MCP host
(e.g. Claude Desktop) would render.

**No access control.** Neither this host nor the capability behind it applies any security trim, so
every caller sees the entire corpus the retrieval backend holds.

## Why a custom two‑port host (not `vite dev`)

The sandbox proxy (`src/sandbox.ts`) must run on a **different origin** from the host page — its
security self‑test deliberately fails if it can reach `window.top`. So, like the ext‑apps
`basic-host`, this package builds two single‑file bundles (`index.html`, `sandbox.html`) and
serves them on two ports via `serve.ts`, which also sets the sandbox **CSP HTTP header** (so Azure
Maps tiles from `*.atlas.microsoft.com` are allowed).

## Prerequisites

- **Node 20+** (developed on Node 24) and npm. This is an npm‑workspaces monorepo — run
  `npm install` **once at the repo root**, not inside this folder.
- **Free ports:** `8080` and `8081` (chat host + sandbox), `3010` (engagements MCP), `3011`
  (area discovery MCP), `3020` (orchestrator), `3030` (Python runtime).
- **(Optional) `az login`** — enables the Azure OpenAI LLM path. Without it the orchestrator falls
  back to a deterministic planner, so the demo still runs fully offline.
- **(Optional) live map tiles** — set `AZURE_MAPS_KEY` in the repo‑root `.env`. The `demo` script
  rebuilds the map App on every start, so just (re)start the demo — no separate build step. Without a
  key the trip map degrades to a **schematic view** (dots + routes, no basemap).

```powershell
# from the repo root, one time:
npm install
npm run build -w @greenhouse-resume-builder/shared -w @greenhouse-resume-builder/mcp-core
npm run setup:python --workspace @greenhouse-resume-builder/cap-engagements-agent
az login          # optional (enables the LLM path)
```

The library build is **required** — `npm install` does not compile `shared` / `mcp-core`, and the
servers import their `dist/`. `npm run demo` runs it for you via its `predemo` hook; the manual
three-terminal path below does not.

## Quickstart — one command

From the repo root, build the host bundles and start the engagements MCP server, the area discovery
MCP server, the TypeScript gateway, the Python MAF/AGT runtime, and the chat host with
colour-labelled output in a single window:

```powershell
npm run demo --workspace @greenhouse-resume-builder/cap-engagements-ui
```

Then open **http://localhost:8080**. Press `Ctrl+C` to stop all processes.

## Run manually (three terminals)

Prefer separate terminals (e.g. to isolate one server's logs)? Run these from the repo root:

```powershell
# 1) engagements MCP capability — binds ENGAGEMENTS_MCP_PORT ?? PORT ?? 3010
$env:ENGAGEMENTS_MCP_PORT=3010
npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements

# 2) M5 agent — starts the Python MAF/AGT runtime and TypeScript gateway together
npm run serve --workspace @greenhouse-resume-builder/cap-engagements-agent

# 3) this chat host (builds both bundles, then serves :8080 host + :8081 sandbox)
npm run start --workspace @greenhouse-resume-builder/cap-engagements-ui
```

## Try it

Open **http://localhost:8080** and keep the persona on **EA · G8**.

**Free-form is the primary path** — type anything and press **Ask ▸** (or just **Enter**). For a
**known-region** ask (like the Boston example below) the agent is **category-first**: it shows the
area briefing and a menu of the **engagement categories present** there (Congressional / Academia /
Industry / Army-internal, hottest recommended) as chips. Pick one and it builds **one single-audience
itinerary** for that audience and **recommends the best senior leader to send** — the **leader is the
output, asked last**, and audiences are never blended into one trip. The recommended leader is a
starting point, not a lock-in: the shortlist is **clickable**, so you can **pick any alternate to
re-plan the same single-audience trip for them** (the itinerary stops stay the same; ROI/availability
re-tune to the chosen leader). For an **event-anchored** ask
(like the AUSA example below) the agent is instead **leader-first**: it first shows a ranked roster of
senior leaders ("which senior leader are you planning for?") as chips; pick one and it returns
**multiple different-length itinerary options** (conference footprint → regional swing → full regional
tour, one recommended). **Select any option to drill into its full detail** — the meetings (candidate
cards), route, trip-ROI breakdown, advisories, nearby senior leaders, and the live trip map. For any
typed follow-up such as _"which leader will this work best for?"_, _"why these meetings?"_, or
_"give me a day-by-day breakdown,"_ the host carries the last 10 turns and the prior event
plan's ids forward. The agent re-resolves the ids with its tools before answering; it does not
reinterpret the follow-up sentence as a new event search. Explicit new topics override stale plan
context, so a hot-topic question starts a fresh governed lookup even after an itinerary turn. For
other asks it resolves the
leader/topic/anchor itself and returns assistant text + candidate cards (and a live trip map when one
applies):

Numbered-day edits are stateful: _"add something to day 3"_ moves the nearest existing
off-site meeting into Day 3, explains the move, and carries that assignment into subsequent turns.

> _Plan a trip to Boston — who should go, how long, and what's worth doing there?_
>
> _I'm planning a trip to AUSA — who should I meet on the UAS/drone topic?_
>
> _What's hot in cyber right now, and is there an approved message?_

**Quick-start chips just _seed_ that free-form ask — they never lock you into a flow:**

- **🔥 Hot topics** — the ranked-hottest topics (from `GET /topics`, scored by
  live footprint: active contacts + upcoming events). Click one to fire _"what's hot in <topic>?"_
  into the agent.
- **📍 Areas** — click a region chip to fire _"Plan a trip to <area> …"_ — still free-form, so you
  can keep steering the conversation afterwards.

**Opt-in — "Plan a trip" (deterministic area-first wizard):** prefer a guided flow? Press
**Plan a trip** to anchor on an area and answer three selectable **option cards**:

- **who should go** — ranked senior leaders (radio; the top pick is pre-selected)
- **how long** — **core** vs **extended** duration tiers (stops + trip-ROI per tier)
- **extend the trip?** — each add-on shows _"+N day(s) → meet <entity> on <topic>"_ with its
  approved-vs-coordinate talking points (checkboxes)

Pick a leader/duration, optionally tick an extension, then **Build itinerary ▸** — you get the
menu + live trip map. If you type something with no recognizable area, the planner
first asks _"which area?"_ and shows region chips.

During development use `npm run dev` (rebuilds on change + restarts `serve.ts`).

## Troubleshooting

| Symptom                                                              | Likely cause / fix                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP capability won't start, or the trip‑map chip shows `unavailable` | Port collision, or a stray `PORT` in the environment. The engagements MCP binds `ENGAGEMENTS_MCP_PORT ?? PORT ?? 3010`, so set `ENGAGEMENTS_MCP_PORT=3010` explicitly (the `demo` script already does).                                         |
| Trip map shows dots/lines with no basemap                            | No valid `AZURE_MAPS_KEY` baked into the App → schematic‑view fallback. Set it in the repo‑root `.env`, **restart the demo** (the map App is rebuilt on start), then **hard‑refresh the browser** (Ctrl+Shift+R) to drop the cached app iframe. |
| `EADDRINUSE` on start                                                | One of `8080` / `8081` / `3010` / `3020` is already in use (often a previous `demo` run). Stop it and retry.                                                                                                                                    |
| Menu cards appear but the map never loads                            | The host can't reach the MCP server on `:3010`. Confirm terminal 1 is up and `ENGAGEMENTS_MCP_URL` matches.                                                                                                                                     |

## Config (optional env for `serve.ts`)

| Var                   | Default                     | Purpose                                  |
| --------------------- | --------------------------- | ---------------------------------------- |
| `HOST_PORT`           | `8080`                      | chat host page                           |
| `SANDBOX_PORT`        | `8081`                      | sandbox proxy (distinct origin)          |
| `ORCHESTRATOR_URL`    | `http://localhost:3020`     | M5 orchestrator `/ask`                   |
| `ENGAGEMENTS_MCP_URL` | `http://localhost:3010/mcp` | engagements MCP (reads the app resource) |

These are advertised to the browser via `GET /api/config`.

## Files

| File                                 | Role                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.tsx`                      | Chat UI: messages, free-form composer (**Ask ▸** primary), 🔥 hot-topic + 📍 area quick-start chips (free-form kickoffs, hot topics from `GET /topics`), menu cards, `<TripMapHost>`, and the opt-in area-first planner (`OptionsBubble` — leader/duration/extension option cards → `/build`) |
| `src/implementation.ts`              | Host wiring: MCP client, resource read, sandbox proxy, `AppBridge`, `renderTripMapApp` (delivers the orchestrator's `tripMap` as a tool result)                                                                                                                                               |
| `src/sandbox.ts`                     | Sandbox proxy (outer iframe) — double‑iframe isolation + message relay                                                                                                                                                                                                                        |
| `serve.ts`                           | Two‑port server (host + CSP‑header sandbox) + `/api/config`                                                                                                                                                                                                                                   |
| `src/theme.ts`, `src/host-styles.ts` | Host theme + MCP style variables passed to the app                                                                                                                                                                                                                                            |
| `src/config.ts`                      | Client config loader (`/api/config` with localhost fallbacks)                                                                                                                                                                                                                                 |

`src/sandbox.ts`, `src/theme.ts`, `src/host-styles.ts`, and the `serve.ts` CSP logic are adapted
from the MCP `@modelcontextprotocol/ext-apps` **basic-host** reference.
