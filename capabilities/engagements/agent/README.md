# Engagements Orchestrator Agent (`cap-engagements-agent`)

The **chat brain** for the Strategic Engagements Travel Planner (MVP-PLAN **M5**).

It turns a natural-language question —

> *"I'm planning a trip to AUSA, who should I meet on the UAS/drone topic?"*

— into a concrete, **security-trimmed** engagement plan by composing the
[`engagements` capability](../mcp/engagements)'s MCP tools, then returns:

- **`menu`** — the ranked "who to meet" option cards (`suggest_candidates`)
- **`itinerary`** — route + trip-ROI + advisory conflicts (`build_itinerary`)
- **`tripMap`** — the `ui://trip-map` Azure Maps App payload for the chat host to render
- **`answer`** — an EA-ready narrative

## How it works

```
question ──▶ orchestrator ──(MCP tools/call, x-demo-persona)──▶ engagements MCP (:3010)
                │                                                     │ server-side security trim
                │  Azure OpenAI tool-calling loop (mcp-core)          ▼ (Keycloak-claim $filter)
                └─ suggest_candidates ──▶ build_itinerary ──▶ menu + itinerary + trip-map
```

- **Primary path:** an Azure OpenAI tool-calling loop (`runAgentLoop` from `mcp-core`) picks the
  leader, maps the topic phrase to `topicIds`, resolves the anchor event, and composes
  `suggest_candidates → build_itinerary`.
- **Deterministic fallback:** when Azure OpenAI is not configured/reachable, a keyword router runs
  the same tool sequence — so the demo always works offline.
- **Auth boundary:** the caller's **persona** is sent as `x-demo-persona` (stand-in for verified
  Keycloak claims). The capability enforces the trim **server-side**; the orchestrator only ever
  sees authorized rows and reports `redactedCount`.
- **Area-first planning:** the `/plan-options` + `/build` seam (see *2c*) anchors on a region,
  surveys the topics active there, and returns leader / duration / extension **options** via the
  capability's `plan_options` tool — deterministic, so this path runs without Azure OpenAI.
- **Fixed-radius planning:** the `/plan-radius` + `/build-radius` seam (see *2d*) anchors on a
  **company / coordinate / city** for a **fixed number of days** (no event) and fills the trip by
  radius via the capability's `plan_radius` + event-less `build_itinerary` — also deterministic.
- **Topic-first / free-form:** `GET /topics` (see *2b*) ranks the **hottest topics** for the caller
  by live footprint (active contacts + upcoming events, persona-trimmed) so the UI can offer
  *"what's hot in cyber?"* chips. Each ranked topic carries a ready-made natural-language
  `question`; picking one just seeds a free-form `/ask`, so **every entry point stays free-form** —
  the EA can type anything and is never locked into a wizard.

## Run it

**1. Start the engagements capability** (the tools + trip-map app), in one terminal:

```bash
npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements
# listening on http://localhost:3010/mcp
```

**2a. Ask via CLI** (default leader `L1`, persona `EA_BASIC`):

```bash
npm run ask --workspace @greenhouse-resume-builder/cap-engagements-agent -- \
  "I'm planning a trip to AUSA, who should I meet on the UAS/drone topic?" --persona EA_G8
```

Add `ENGAGEMENTS_AGENT_JSON=1` to print the full `PlanResult` (incl. `tripMap`).

**2b. Or run the HTTP service** (the seam the chat UI / M6 calls):

```bash
npm run serve --workspace @greenhouse-resume-builder/cap-engagements-agent
# POST /ask { question, persona?, leaderId?, topN? }  on http://localhost:3020
curl -s localhost:3020/ask -H 'content-type: application/json' \
  -d '{"question":"who should I meet at AUSA on UAS/drone?","persona":"EA_G8"}' | jq

# Hot topics — a topic-first entry point (persona-trimmed). Each item carries a ready-made
# free-form `question`; the UI fires it straight back into /ask, so it never locks the EA in.
curl -s 'localhost:3020/topics?persona=EA_G8' | jq
# → { persona, rejected, redactedCount,
#     topics:[{ topicId, name, score, reason, question, hasApprovedMessage }] }
```

Or list hot topics from the CLI (same ranking, rendered as text):

```bash
npm run ask --workspace @greenhouse-resume-builder/cap-engagements-agent -- \
  --topics --persona EA_G8
# 🔥 T2 Cyber / zero-trust modernization — 8 active · 3 upcoming events · approved message (score …)
```

**2c. Interactive area-first planning** (the seam the chat UI's *"Plan a trip"* flow calls):

Instead of one-shot Q→A, anchor on a **geographical area** and let the orchestrator ask
*who should go, how long, and what each extra day unlocks* — always returning **options** so the
EA decides. Two stateless stages, both deterministic (no LLM required, works offline):

```bash
# Stage 1 — area → option menus (leader / duration tiers / extension add-ons)
curl -s localhost:3020/plan-options -H 'content-type: application/json' \
  -d '{"regionId":"E-BOSTON","persona":"EA_G8"}' | jq
# → { stage:"options", area, window, areaSurvey[], questions:[leader|duration|extensions], redactedCount }
# (omit the area to get stage:"clarify" + region chips to pick from)

# Stage 2 — the EA's picks → security-trimmed itinerary + trip map
curl -s localhost:3020/build -H 'content-type: application/json' \
  -d '{"regionId":"E-BOSTON","persona":"EA_G8","leaderId":"L1","durationTier":"extended","extensionContactIds":["C20"]}' | jq
# → { answer, menu[], itinerary, tripMap, redactedCount, rejected }
```

Or from the CLI — renders the same menus as text:

```bash
npm run ask --workspace @greenhouse-resume-builder/cap-engagements-agent -- \
  --options "plan a trip to Boston" --persona EA_G8
# also: --region E-BOSTON, --window 2025-10-06..2025-10-31
```

The area is resolved from a seed **region** (id or alias, e.g. `NCR`, `bay area`) or a city named
after a locative preposition (*"in/near/to <City>"*); if nothing anchors, `/plan-options` returns
`stage:"clarify"` with the known regions as chips. Duration tiers (**core** / **extended**) and
**extension add-ons** (each `+N day(s)` unlocks another meeting, with approved-vs-coordinate
talking points) come straight from the capability's `plan_options` tool — the security trim is
still enforced server-side, so `/build` re-authorizes every stop.

**2d. Fixed-radius planning** (a leader must visit a specific company for a fixed number of days,
**no anchor event**):

When the trip is pinned to a **company / coordinate / city** and a **fixed duration** — *"a senior
leader has to go meet Meridian Robotics and is on the ground for 3 days"* — the itinerary is filled
by **radius**: capacity is `days × meetingsPerDay` (default 2/day), seeded with the anchor (met
on-site) and then the highest-value **authorized contacts inside the radius**; whatever overflows
becomes fixed-days **extension options** (*"+1 day unlocks one more meeting on THIS topic — here are
the talking points"*). Unlike area-first planning it is purely geographic and **does not absorb a
nearby conference's roster**. Two stateless stages, deterministic (works offline):

```bash
# Stage 1 — anchor + fixed days → filled trip + who/extend menus.
#   Anchor by any of: company | anchorContactId | lat+lng | city (+ optional radiusMi, default 100).
curl -s localhost:3020/plan-radius -H 'content-type: application/json' \
  -d '{"company":"Meridian Robotics","days":3,"persona":"EA_G8"}' | jq
# → { anchor, area, days, capacity, stops[], leaderOptions[], extensionOptions[], questions[], redactedCount }
curl -s localhost:3020/plan-radius -H 'content-type: application/json' \
  -d '{"lat":38.9586,"lng":-77.357,"radiusMi":40,"days":2,"persona":"EA_G8"}' | jq

# Stage 2 — the EA's picks → event-less itinerary + trip map (leaderId + days required)
curl -s localhost:3020/build-radius -H 'content-type: application/json' \
  -d '{"leaderId":"L1","company":"Meridian Robotics","days":3,"persona":"EA_G8","extensionContactIds":["C18"]}' | jq
# → { answer, itinerary, tripMap, redactedCount, rejected }
```

Or from the CLI — renders the same menus as text:

```bash
npm run ask --workspace @greenhouse-resume-builder/cap-engagements-agent -- \
  --radius --company "Meridian Robotics" --days 3 --persona EA_G8
# anchor by coordinate/city instead: --lat 38.9586 --lng -77.357  |  --city Reston --region NCR
# tune the reach/capacity:           --radius-mi 40  (alias --mi)
```

Free-form `/ask` handles the same intent conversationally — *"plan a 2-day trip meeting Meridian
Robotics within 40 mi"* — the LLM (or the deterministic `parseRadiusAsk` fallback) routes it through
`plan_radius`/`build_itinerary` and honors the radius, so far-away contacts are excluded.


## The security-trim beat (why persona matters)

The same question returns different menus per caller — the trim is enforced by the capability, not
the orchestrator:

| `--persona`    | AUSA / UAS menu (top picks) | Note |
| -------------- | --------------------------- | ---- |
| `EA_BASIC`     | `P2, C3`                    | `C4` redacted (need-to-know group) |
| `EA_G8`        | `P2, C4, C3`                | reads `/army/g8/plans` (C4) |
| `NO_TENANT`    | *access rejected*           | fail-closed (no tenant claim) |
| `CROSS_TENANT` | *empty*                     | tenant isolation trims every Army row |

## Config (repo-root `.env`)

| var | default | purpose |
| --- | ------- | ------- |
| `ENGAGEMENTS_MCP_URL` | `http://localhost:3010/mcp` | engagements capability endpoint |
| `ENGAGEMENTS_AGENT_PORT` | `3020` | HTTP `/ask` port |
| `ENGAGEMENTS_DEFAULT_LEADER` | first leader (`L1`) | leader used when the ask names none |
| `ENGAGEMENTS_DEMO_PERSONA` | `EA_BASIC` | default caller persona |
| `ENGAGEMENTS_TOP_N` | `3` | candidates routed into the itinerary |
| `ENGAGEMENTS_PLAN_WINDOW` | seed `today` → `today`+horizon | override the `/plan-options` + `/plan-radius` trip window (`START..END`, ISO dates) |
| `ENGAGEMENTS_PLAN_HORIZON_DAYS` | `25` | default window length when no explicit window is given |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_DEPLOYMENT` | — | enable the LLM path (else deterministic). Auth via `az login` (DefaultAzureCredential) or `AZURE_OPENAI_API_KEY`. |

## Test / typecheck

```bash
npm run typecheck --workspace @greenhouse-resume-builder/cap-engagements-agent
npm test          --workspace @greenhouse-resume-builder/cap-engagements-agent
```

The unit tests cover the pure helpers (catalog, topic mapping, anchor extraction, tool surface,
prompt) and need neither a live server nor Azure OpenAI.
