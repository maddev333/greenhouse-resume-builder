# Engagements Agent (`cap-engagements-agent`)

The **chat brain** for the Strategic Engagements Travel Planner (MVP-PLAN **M5**).

It turns a natural-language question —

> _"I'm planning a trip to AUSA, who should I meet on the UAS/drone topic?"_

— into a concrete engagement plan by composing the
[`engagements` capability](../mcp/engagements)'s MCP tools, then returns:

- **`menu`** — the ranked "who to meet" option cards (`suggest_candidates`)
- **`itinerary`** — route + trip-ROI + advisory conflicts (`build_itinerary`)
- **`tripMap`** — the `ui://trip-map` Azure Maps App payload for the chat host to render
- **`answer`** — an EA-ready narrative

The public `/ask` contract remains TypeScript, but Microsoft Agent Framework owns the free-form
decision: intent classification, workflow/tool selection, clarification, and final response stage.
TypeScript projects grounded tool results into the existing UI contract and retains deterministic
workflows for explicit endpoints and model-outage fallback.

## How it works

```
question ──▶ TS gateway (:3020) ──▶ Python runtime (:3030) ──▶ engagements MCP (:3010)
                                            │                         │
                                            │ Microsoft Agent         ▼
                                            │ Framework + AGT
                                            └─ governed tool calls ──▶ menu + itinerary + trip-map
```

- **Agent-first `/ask`:** a Python Microsoft Agent Framework `Agent` uses Azure OpenAI and a
  structured `AgentDecision` to classify each ask as area, event, radius, or lookup; choose among the
  nine governed engagements planning tools (plus `search_businesses` when the optional Area Discovery
  capability is reachable); and decide whether to clarify, return options, build a plan, or answer.
- **Area `/ask` (category-first policy):** for a **region/city** ask (e.g. _"Plan a trip to Boston —
  who should go, how long, and what's worth doing there?"_), the agent calls `plan_options`, first
  shows the area briefing (hot topics, stale contacts, events, four-audience coverage) and **asks
  which engagement category** to anchor on —
  Congressional / Academia / Industry / Army-internal — hottest recommended. Once you pick (re-send the
  same question with `category`), it builds **one single-audience itinerary** for that audience and then
  **recommends the best senior leader to send** (`leaderShortlist`, ranked by billet fit + score). The
  **leader is the output, not the opening question**, and audiences are never blended into one trip.
  If the ask already names a category ("_industry_ trip"), the clarification is skipped.
- **Event-anchored `/ask` (leader-first policy):** when the agent resolves an **event that is not a
  region** (e.g. _"a trip to AUSA…"_), it first **asks which senior leader** you're planning for
  (a ranked roster, top pick recommended), then returns **multiple full itinerary options with
  meaningfully different scopes** (conference footprint → regional swing), one recommended by grounded
  ROI. It never silently infers a leader. If the ask already names a leader (`leaderId` or a surname),
  it skips straight to the options.
- **Governance:** official AGT 4.1 middleware evaluates the user input, constrains model tool names,
  and records the agent run. The same Python policy/evaluator gates deterministic `/tools/call`
  requests, so fallback code cannot bypass policy.
- **Deterministic fallback:** only when Azure OpenAI is not configured/reachable or cannot return a
  complete grounded decision, the TypeScript fallback runs the same governed tools so the demo works
  offline.
- **Grounded conversational follow-ups:** the chat host sends the recent turns for reference
  resolution plus only the prior event, leader, topic, and selected-contact ids as grounded plan
  references. The model re-resolves those ids with the tools before answering questions such as
  _"which leader will this work best for?"_, _"why these meetings?"_, _"what are the risks?"_, or
  _"give me a day-by-day breakdown."_ If the model is unavailable, a deterministic tool-backed
  fallback covers leader fit, meetings/alternatives, route, ROI, conflicts, nearby leaders, daily
  sequencing, plan summaries, and topic-landscape questions (ranked contacts, geographic activity,
  and approved-message availability). Explicit new topics take precedence over stale plan context;
  only numbered-day mutations bypass Agent Framework. Numbered-day edits such as _"add something to day 3"_ move the
  nearest existing meeting into that slot, state the move explicitly, and persist the
  day assignment for later turns. A standalone follow-up with no prior plan asks for context instead
  of treating the sentence as a new event name.
- **No access control:** the capability applies **no** security trim, so the orchestrator sees the
  whole corpus the capability's retrieval backend holds. AGT governs _what the agent may do_ — it is
  not a data-authorization boundary.
- **Area-first planning:** the `/plan-options` → `/build-options` → `/build` seam (see _2c_) anchors
  on a region, **asks which senior leader** you're planning for, then returns **multiple full
  itinerary options of different lengths** (a short visit → a full regional tour) to compare and
  proceed with — deterministic, so this
  path runs without Azure OpenAI.
- **Fixed-radius planning:** the `/plan-radius` + `/build-radius` seam (see _2d_) anchors on a
  **company / coordinate / city** for a **fixed number of days** (no event) and fills the trip by
  radius via the capability's `plan_radius` + event-less `build_itinerary` — also deterministic.
- **Topic-first / free-form:** `GET /topics` (see _2b_) ranks the **hottest topics**
  by live footprint (active contacts + upcoming events) so the UI can offer
  _"what's hot in cyber?"_ chips. Each ranked topic carries a ready-made natural-language
  `question`; picking one just seeds a free-form `/ask`, so **every entry point stays free-form** —
  the EA can type anything and is never locked into a wizard.

## Run it

**0. Install the pinned Python runtime** (one time, from the repository root):

```powershell
npm run setup:python --workspace @greenhouse-resume-builder/cap-engagements-agent
```

**1. Start the engagements capability** (the tools + trip-map app), in one terminal:

```bash
npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements
# listening on http://localhost:3010/mcp
```

The Python runtime discovers the capability's tool surface on every turn and adapts to it:

| Capability backend  | Tools offered to the model                                                                 | Turn                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `memory` / `search` | the nine planner tools (plus `search_grounding` when the index also declares a RAG corpus) | the full planning workflows below                                                               |
| `grounding`         | `search_grounding` only                                                                    | a cited grounded answer (`intent=lookup`, `stage=answer`); the deterministic planner is refused |

An endpoint that serves neither surface fails with a 502 naming the missing tools, rather than a
model turn with no grounded tool behind it. Under `grounding` the seed's leader roster and topic
catalog are kept OUT of the system prompt (a text corpus has no leaders, and a model handed the demo
roster will answer from it), so Azure OpenAI is required — there is no deterministic path.

**2a. Start the Python runtime** for CLI use:

```powershell
npm run serve:runtime --workspace @greenhouse-resume-builder/cap-engagements-agent
```

Then ask from another terminal (default leader `L1`):

```bash
npm run ask --workspace @greenhouse-resume-builder/cap-engagements-agent -- \
  "I'm planning a trip to AUSA, who should I meet on the UAS/drone topic?"

# Category-first area ask (the default chat flow): pick the audience, THEN get the recommended leader.
npm run ask --workspace @greenhouse-resume-builder/cap-engagements-agent -- \
  "Plan a trip to Boston — who should go, how long, and what's worth doing there?"
#   → stage=clarify: the area briefing + a category menu (Academia / Industry / …), hottest recommended
npm run ask --workspace @greenhouse-resume-builder/cap-engagements-agent -- \
  "Plan a trip to Boston…" --category industry
#   → stage=plan: one single-audience itinerary + "Best senior leader to send: L1 …" (leader = output)
```

Add `ENGAGEMENTS_AGENT_JSON=1` to print the full `PlanResult` (incl. `tripMap`).

**2b. Or run the HTTP service** (the seam the chat UI / M6 calls):

```bash
npm run serve --workspace @greenhouse-resume-builder/cap-engagements-agent
# POST /ask { question, leaderId?, category?, days?, radiusMi?, topN?, context?, history? }  on http://localhost:3020

# Known-region asks are CATEGORY-first: with no `category` this returns the area briefing +
# a category menu (the leader is the OUTPUT, asked LAST):
curl -s localhost:3020/ask -H 'content-type: application/json' \
  -d '{"question":"Plan a trip to Boston — who should go, how long, and what'\''s worth doing there?"}' | jq
#   { stage:"clarify", clarify:"category", categoryBreakdown:[…], questions:[{ id:"category", choices:[…audiences present…] }] }
# Re-send the SAME question with the chosen category → single-audience plan + recommended leader:
curl -s localhost:3020/ask -H 'content-type: application/json' \
  -d '{"question":"Plan a trip to Boston…","category":"industry"}' | jq
# → { stage:"plan", category:"industry", menu:[…single-audience stops…], tripMap,
#     leaderShortlist:[{ leaderId, name, why, recommended }, …] }   ← who should go (leader = output)

# Event-anchored asks (an event that is NOT a region) stay leader-first: with no `leaderId` this returns
curl -s localhost:3020/ask -H 'content-type: application/json' \
  -d '{"question":"who should I meet at AUSA on UAS/drone?"}' | jq
#   { stage:"clarify", clarify:"leader", questions:[{ id:"leader", choices:[…ranked roster…] }] }
# Re-send the SAME question with the chosen leader to get the different-length options:
curl -s localhost:3020/ask -H 'content-type: application/json' \
  -d '{"question":"who should I meet at AUSA on UAS/drone?","leaderId":"L1"}' | jq
# → { stage:"options", leaderName, event, recommendedOptionId,
#     options:[{ id, label, days, roiScore, recommended, contactIds, itinerary, tripMap }, …] }

# Hot topics — a topic-first entry point. Each item carries a ready-made
# free-form `question`; the UI fires it straight back into /ask, so it never locks the EA in.
curl -s localhost:3020/topics | jq
# → { ok, topics:[{ topicId, name, score, reason, question, hasApprovedMessage,
#                   activeCount, prospectCount, eventCount, upcomingEventCount }] }
```

Or list hot topics from the CLI (same ranking, rendered as text):

```bash
npm run ask --workspace @greenhouse-resume-builder/cap-engagements-agent -- --topics
# 🔥 T2 Cyber / zero-trust modernization — 8 active · 3 upcoming events · approved message (score …)
```

**2c. Interactive area-first planning** (the seam the chat UI's _"Plan a trip"_ flow calls):

Instead of one-shot Q→A, anchor on a **geographical area** and let the orchestrator walk the EA
through the trip — always returning **options** so the human decides. Stateless, deterministic
stages (no LLM required, works offline):

```bash
# Stage 1 — area → (asks "which area?" if none anchors, then) "which senior leader?"
curl -s localhost:3020/plan-options -H 'content-type: application/json' \
  -d '{"regionId":"E-BOSTON"}' | jq
# → { stage:"clarify", clarify:"leader", leaderOptions[], questions:[leader], answer:"Which senior leader…" }
#   (omit the area entirely → stage:"clarify", clarify:"area" + region chips)
#   (pass "leaderId" → stage:"options" with questions:[leader|duration|extensions])

# Stage 2 (options) — for the CHOSEN leader, build MULTIPLE full itineraries of DIFFERENT LENGTHS
curl -s localhost:3020/build-options -H 'content-type: application/json' \
  -d '{"regionId":"E-BOSTON","leaderId":"L1"}' | jq
# → { leaderId, leaderName, recommendedOptionId, options:[{ id:"2d", days, label:"2-day trip", summary, itinerary, tripMap, … }] }
#   knobs: optionCount (default 3), maxDays (default 7), targetDays:[2,5,7] (explicit lengths), meetingsPerDay

# Stage 2 (commit) — proceed with one option (or hand-tune duration/extensions) → itinerary + trip map
curl -s localhost:3020/build -H 'content-type: application/json' \
  -d '{"regionId":"E-BOSTON","leaderId":"L1","durationTier":"extended","extensionContactIds":["C20"]}' | jq
# → PlanResult { ok, answer, menu[], itinerary, tripMap, area, today, categoryBreakdown }
```

Or from the CLI — renders the same menus as text:

```bash
npm run ask --workspace @greenhouse-resume-builder/cap-engagements-agent -- \
  --options "plan a trip to Boston"                          # → asks WHICH senior leader
npm run ask --workspace @greenhouse-resume-builder/cap-engagements-agent -- \
  --itineraries --leader L1 --region E-BOSTON                # → different-length itinerary options
# also: --window 2025-10-06..2025-10-31, --count 3, --max-days 7, --target-days 2,5,7, --per-day 2
```

The area is resolved from a seed **region** (id or alias, e.g. `NCR`, `bay area`) or a city named
after a locative preposition (_"in/near/to <City>"_); if nothing anchors, `/plan-options` returns
`stage:"clarify"` (`clarify:"area"`) with the known regions as chips. **Who goes is asked first:**
when the ask names no leader, `/plan-options` returns `stage:"clarify"` (`clarify:"leader"`) with the
ranked roster (top pick recommended) — the UI re-calls it with the picked `leaderId` to advance.
`/build-options` then returns several fully-costed itineraries of **genuinely different lengths**
(a short visit → a full regional tour), packing the best meetings into `days ×
meetingsPerDay` slots; each option carries its own route, trip-ROI, advisory conflicts, **nearby
senior leaders**, and `ui://trip-map`, and the best in-budget ROI is flagged `recommended` — so the
EA compares finished trips of different durations. Lengths auto-spread across the area's stop pool,
or you can pin them with `targetDays`/`optionCount`/`maxDays`. Everything comes straight from the
capability's `build_itinerary` radius fill.

**2d. Fixed-radius planning** (a leader must visit a specific company for a fixed number of days,
**no anchor event**):

When the trip is pinned to a **company / coordinate / city** and a **fixed duration** — _"a senior
leader has to go meet Meridian Robotics and is on the ground for 3 days"_ — the itinerary is filled
by **radius**: capacity is `days × meetingsPerDay` (default 2/day), seeded with the anchor (met
on-site) and then the highest-value contacts inside the radius; whatever overflows
becomes fixed-days **extension options** (_"+1 day unlocks one more meeting on THIS topic — here are
the talking points"_). Unlike area-first planning it is purely geographic and **does not absorb a
nearby conference's roster**. Two stateless stages, deterministic (works offline):

```bash
# Stage 1 — anchor + fixed days → filled trip + who/extend menus.
#   Anchor by any of: company | anchorContactId | lat+lng | city (+ optional radiusMi, default 100).
curl -s localhost:3020/plan-radius -H 'content-type: application/json' \
  -d '{"company":"Meridian Robotics","days":3}' | jq
# → { anchor, area, days, capacity, stops[], leaderOptions[], extensionOptions[], questions[], route, roi }
curl -s localhost:3020/plan-radius -H 'content-type: application/json' \
  -d '{"lat":38.9586,"lng":-77.357,"radiusMi":40,"days":2}' | jq

# Stage 2 — the EA's picks → event-less itinerary + trip map (leaderId + days required)
curl -s localhost:3020/build-radius -H 'content-type: application/json' \
  -d '{"leaderId":"L1","company":"Meridian Robotics","days":3,"extensionContactIds":["C18"]}' | jq
# → PlanResult { ok, answer, itinerary, tripMap }
```

Or from the CLI — renders the same menus as text:

```bash
npm run ask --workspace @greenhouse-resume-builder/cap-engagements-agent -- \
  --radius --company "Meridian Robotics" --days 3
# anchor by coordinate/city instead: --lat 38.9586 --lng -77.357  |  --city Reston --region NCR
# tune the reach/capacity:           --radius-mi 40  (alias --mi)
```

Free-form `/ask` handles the same intent conversationally — _"plan a 2-day trip meeting Meridian
Robotics within 40 mi"_ — the LLM (or the deterministic `parseRadiusAsk` fallback) routes it through
`plan_radius`/`build_itinerary` and honors the radius, so far-away contacts are excluded.

## Config (repo-root `.env`)

| var                                                 | default                        | purpose                                                                                                           |
| --------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `ENGAGEMENTS_MCP_URL`                               | `http://localhost:3010/mcp`    | engagements capability endpoint                                                                                   |
| `ENGAGEMENTS_AGENT_PORT`                            | `3020`                         | HTTP `/ask` port                                                                                                  |
| `ENGAGEMENTS_PYTHON_AGENT_URL`                      | `http://127.0.0.1:3030`        | Microsoft Agent Framework + AGT runtime                                                                           |
| `ENGAGEMENTS_PYTHON_AGENT_TIMEOUT_MS`               | `60000`                        | TypeScript gateway timeout for Python runtime requests                                                            |
| `ENGAGEMENTS_DEFAULT_LEADER`                        | first leader (`L1`)            | leader used when the ask names none                                                                               |
| `ENGAGEMENTS_TOP_N`                                 | `3`                            | candidates routed into the itinerary                                                                              |
| `ENGAGEMENTS_PLAN_WINDOW`                           | seed `today` → `today`+horizon | override the `/plan-options` + `/plan-radius` trip window (`START..END`, ISO dates)                               |
| `ENGAGEMENTS_PLAN_HORIZON_DAYS`                     | `25`                           | default window length when no explicit window is given                                                            |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_DEPLOYMENT` | —                              | enable the LLM path (else deterministic). Auth via `az login` (DefaultAzureCredential) or `AZURE_OPENAI_API_KEY`. |
| `AZURE_OPENAI_API_VERSION`                          | `2024-10-21`                   | Azure OpenAI Chat Completions API version                                                                         |
| `AGENT_REQUEST_TIMEOUT_SECONDS`                     | `45`                           | Python model-run budget and per-MCP-request timeout; keep below the gateway timeout                               |
| `AGT_ENABLED`                                       | `true`                         | enforce the official Agent Governance Toolkit policy                                                              |
| `AGT_POLICY_PATH`                                   | `governance/policy.yaml`       | AGT 4.1 YAML policy                                                                                               |
| `AGT_AUDIT_MAX_ENTRIES`                             | `10000`                        | rotate the bounded in-memory AGT hash chain at this size                                                          |

## Test / typecheck

```bash
npm run typecheck --workspace @greenhouse-resume-builder/cap-engagements-agent
npm test          --workspace @greenhouse-resume-builder/cap-engagements-agent
```

The test command runs the TypeScript orchestration tests and the Python AGT policy, MCP bridge,
Entra client, and Agent Framework tool-contract tests. It needs neither a live model nor MCP server.
