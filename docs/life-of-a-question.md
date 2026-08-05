# The Life of a Question

> How a natural-language trip question travels through the Strategic Engagements Travel
> Planner — every component it touches, and how the data is processed at each hop to produce
> the answer, the option menu, and the interactive trip map returned to the user.
>
> Companion to [`engagement-intelligence/ARCHITECTURE.md`](../engagement-intelligence/ARCHITECTURE.md)
> (the full design) and the three capability READMEs (the as-built demo). This doc is the
> **runtime trace**: it follows one request from keystroke to rendered map.

---

## 0. The question we trace

Ask:

> _I'm planning a trip to AUSA — who should I meet on the UAS/drone topic?_

The user gets three things back: a **prose answer**, a **menu of who-to-meet cards**, and a live
**Azure Maps trip itinerary**. The sections below follow the data that produces each of them.

---

## 1. Cast of components

Four long-running service processes plus a distinct sandbox origin. The **one** MCP server has
two clients: the Python runtime calls its **tools**; the browser reads its **`ui://trip-map` App
resource**.

| #   | Component                      | Process / URL             | Role in a question                                                                                                                      |
| --- | ------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Chat host UI** (M6)          | Browser, `:8080`          | Captures the question + recent turns; POSTs `/ask`; renders answer + menu; hosts the trip-map App                                       |
| 2   | **Sandbox proxy**              | `:8081` (distinct origin) | Isolates the `ui://trip-map` MCP App in a cross-origin sandboxed iframe                                                                 |
| 3   | **Orchestration gateway** (M5) | Node/Express, `:3020`     | Preserves the HTTP/UI contract, deterministic workflows, and final response assembly                                                    |
| 4   | **Agent runtime**              | Python/FastAPI, `:3030`   | Microsoft Agent Framework agent + official Agent Governance Toolkit policy, capabilities, and audit                                     |
| 5   | **Engagements MCP capability** | Node, `:3010/mcp`         | Deterministic planner engine + `ui://trip-map` resource, exposed as MCP tools                                                           |
| 6   | **Seed dataset**               | JSON on disk              | Source of record for the `memory` backend: leaders, contacts, events, topics, messages, regions (pre-geocoded)                          |
| 7   | **Azure OpenAI**               | cloud (optional)          | Reasoning + tool selection for the LLM path; deterministic fallback when absent                                                         |
| 8   | **Azure AI Search**            | cloud (optional)          | Alternate read-model backend — `RETRIEVAL_BACKEND=search` (an index of structured records) or `grounding` (a document/chunk RAG corpus) |
| 9   | **Azure Maps**                 | cloud (optional)          | Tiles/styles for the trip-map App; schematic fallback without a key                                                                     |

```
 Browser chat host (:8080)                                   chat client + MCP-Apps host
   │
   ├─ POST /ask {question, history?} ────────►  TS gateway (:3020)
   │  ◄─ {answer, menu[], itinerary, tripMap}      └─ Python MAF + AGT (:3030) ─┐
   │                                                                            │ governed tools/call
   │                                                                            ▼
   └─ resources/read ui://trip-map ───────────────────────────►  Engagements MCP (:3010)
      (rendered in sandboxed iframe via :8081)                     • stateless: fresh server per request
                                                                   • deterministic planner engine
                                                                   • ui://trip-map App resource
                                                                          │ RETRIEVAL_BACKEND=memory
                                                                          ▼
                                                          Seed JSON  (source of record)
```

---

## 2. Stage 0 — Data at rest (before any question)

Nothing is computed until asked, but the shape of the data governs everything downstream.

- **Source of record** is plain JSON in
  [`engagement-intelligence/seed/`](../engagement-intelligence/seed/) — `leaders`, `contacts`,
  `events`, `topics`, `messages`, `regions`, `config`. All locations are **pre-geocoded at seed
  time**, so the live demo makes **no** geocoding call and cannot fail on a network blip
  (ARCHITECTURE §1).
- **The provenance envelope** is baked onto every record when the read model loads it:
  `applyLabels` → `deriveEnvelope` attaches `{ entityType, source }`
  ([`retrieval/labels.ts`](../capabilities/engagements/mcp/engagements/src/retrieval/labels.ts)).
  The seed stays domain-only; the labels say _what kind of record this is and where it came from_
  (`sharepoint:contacts`, `document-intelligence:afteractions`, …) in one place. They are
  **provenance, not governance** — nothing downstream filters on them. The loader adds `createdAt`
  ([`planner/seed-loader.ts`](../capabilities/engagements/mcp/engagements/src/planner/seed-loader.ts));
  regions are a public gazetteer and get no provenance envelope at all.
- **The read model is loaded FRESH per tool call** so a live add/update/delete/"reindex" shows
  immediately ([`readmodel.ts`](../capabilities/engagements/mcp/engagements/src/readmodel.ts)).
  `RETRIEVAL_BACKEND` selects one of three behind one async contract:
  - `memory` (default) — the in-memory `EngagementIndex` over the seed, zero cloud.
  - `search` — an Azure AI Search index of **structured records**. Contacts, events, leaders,
    topics, messages and regions all come from the index, and `today` is the **real** date rather
    than the seed's month-shifted demo clock. It **never** opens
    `engagement-intelligence/seed`; a kind the index does not carry reads back empty rather than
    being substituted from the seed.
  - `grounding` — a plain **document/chunk RAG** index. That corpus has no structured records, so
    the deterministic planner cannot run: the capability registers **only** the `search_grounding`
    tool and `getReadModel()` throws (`tools.ts`, `readmodel.ts`).
  - Asking for `search` or `grounding` without `AZURE_SEARCH_SERVICE` is a **hard error**, not a
    silent fallback to `memory` — a misconfigured deployment must never serve demo seed data as if
    it were live.
  - The index shapes themselves are **declared in JSON config files**, not hard-coded: a registry
    loaded from [`index-schema.json`](../capabilities/engagements/mcp/engagements/index-schema.json)
    (or `ENGAGEMENTS_INDEX_SCHEMAS`) both provisions the index and validates that a field is
    `filterable` before any OData `$filter` is composed
    ([`retrieval/index-schema.ts`](../capabilities/engagements/mcp/engagements/src/retrieval/index-schema.ts)).

---

## 3. Stage 1 — The user asks (chat host UI, `:8080`)

1. The user types the question. The UI keeps the **last 10 messages** of the thread as a `history`
   array purely so the gateway can resolve conversational references ("add them to day 2"), plus
   the prior grounded plan as `context` when the ask elaborates it.
2. On submit, the UI POSTs to the orchestrator
   ([`ui/src/index.tsx`](../capabilities/engagements/ui/src/index.tsx)):

   ```
   POST {orchestratorUrl}/ask
   { "question": "...AUSA...UAS/drone...", "history": [ { "role": "user", "text": "…" } ] }
   ```

   `leaderId`, `category` and `context` are added only when the turn has them.
   `orchestratorUrl` defaults to `http://localhost:3020`
   ([`ui/src/config.ts`](../capabilities/engagements/ui/src/config.ts)).

3. The UI shows a busy state and waits for a single JSON response (`PlanResult`). It does **not**
   yet talk to the MCP server — that happens later, only if a `tripMap` comes back (Stage 9).

---

## 4. Stage 2 — The orchestrator receives the question (`:3020`)

`POST /ask` is a thin Express handler that validates `question` and calls **`planTrip`**
([`agent/src/main.ts`](../capabilities/engagements/agent/src/main.ts) →
[`agent/src/orchestrator.ts`](../capabilities/engagements/agent/src/orchestrator.ts)).

`planTrip` resolves defaults and opens a **governed Python tool client** for capability validation
and deterministic fallback:

- `makeToolClient` calls Python `/tools/list` to validate the MCP contract, then routes every
  deterministic tool call through Python `/tools/call`.
- The Python bridge evaluates `governance/policy.yaml`, writes AGT audit events, and only then
  forwards the call to the MCP capability.
- `topN` defaults to 3. The first seed leader is only an emergency deterministic fallback; the
  framework does not silently select one when the user needs to make a material leader choice.
- The Python runtime uses Streamable HTTP against `ENGAGEMENTS_MCP_URL`
  (`http://localhost:3010/mcp`) and preserves structured MCP results for final assembly.

It then attempts the Agent Framework path first for every free-form `/ask`.

---

## 5. Stage 3 — The planning brain (agent first, governed fallback)

### 5a. Agent Framework path (primary, when Azure OpenAI is configured)

`isModelConfigured()` gates this. If on, `planTrip` calls Python `/run`, which constructs a
Microsoft Agent Framework `Agent` with the Azure OpenAI Chat Completions provider:

1. **System prompt** = `buildSystemPrompt` — injects the leader roster and topic taxonomy read
   straight from the seed ([`agent/src/catalog.ts`](../capabilities/engagements/agent/src/catalog.ts))
   plus decision policy for area, event, radius, and lookup intents.
2. Nine typed Python function tools expose the complete governed planning surface:
   `search_contacts`, `search_events`, `survey_area`, `suggest_leaders`, `nearby_leaders`,
   `plan_options`, `plan_radius`, `suggest_candidates`, and `build_itinerary`.
3. AGT `AuditTrailMiddleware`, `GovernancePolicyMiddleware`, and
   `CapabilityGuardMiddleware` run around the agent. The governed MCP bridge re-evaluates tool
   arguments before the network call, so an allowed tool cannot carry denied content.
4. The framework returns a typed **`AgentDecision`**: intent, response stage, clarification axis,
   selected category/leader, recommended option, and concise answer. `agentDecisionToPlanResult`
   projects only captured MCP data into the existing UI envelope; it does not reclassify the ask.
5. An incomplete decision (for example, `stage=plan` without a successful `build_itinerary`) is
   rejected and handed to the governed deterministic fallback rather than patched by TypeScript.

> Token hygiene: the heavy `tripMap` payload is **stripped** from the tool result the model
> sees (`makeToolClient`) but retained in `client.captured` for final assembly.

### 5b. Deterministic path (fallback, offline demo)

When the model is unavailable, errors, or returns an incomplete grounded decision, `planTrip`
uses the existing no-LLM workflows (`orchestrator.ts`):

1. `parseRadiusAsk` detects a "fixed-radius" ask ("meet _Company_ for 3 days") → `plan_radius`
   → `build_itinerary`.
2. Otherwise `anchorGuess` extracts the anchor ("AUSA") and `topicIdsFromText` maps keywords →
   topic ids (`UAS/drone → T3`).
3. It calls `suggest_candidates`, widens the topic filter if that zeroed the menu, then calls
   `build_itinerary` with the top-N contact ids.

Either path drives the **same Python AGT policy and MCP bridge** — the only difference is who
picks the arguments (Microsoft Agent Framework vs. the deterministic router).

---

## 6. Stage 4 — Inside the capability: a fresh read model per call (`:3010`)

The MCP server is **stateless**: `main.ts` builds a fresh `McpServer` per HTTP request and
`createServer()` takes **no arguments** — there is no caller context to resolve
([`mcp/engagements/src/main.ts`](../capabilities/engagements/mcp/engagements/src/main.ts),
[`server.ts`](../capabilities/engagements/mcp/engagements/src/server.ts)).

**The capability applies no access control.** There is no tenant check, no group ACL, no
sensitivity gate, no per-caller filter — any caller reaching `:3010/mcp` sees the entire corpus.
The request carries no identity headers, and CORS allows only the MCP transport headers
(`content-type`, `mcp-session-id`, `mcp-protocol-version`, `last-event-id`). The governance in
this system lives one hop earlier, in the AGT policy of Stage 3, and governs _what the agent may
do_, not _what a caller may see_.

1. **Pick the tool surface.** `registerEngagementTools` reads `resolveBackend()` once at
   registration. On `grounding` it registers `search_grounding` **only**; on `search` it registers
   the nine planner tools plus `search_grounding` when a loaded index declaration carries a
   `mapping.grounding` block; on `memory` it registers the nine planner tools
   ([`tools.ts`](../capabilities/engagements/mcp/engagements/src/tools.ts)).
2. **Every tool follows the same contract** (`tools.ts` header comment): load a **fresh** read
   model with `getReadModel()`, then run the pure planner over it. Nothing is cached between
   calls, so a live add/update/delete/"reindex" is visible on the very next tool call.

Recall itself is **recall, then preference narrowing**
([`retrieval/retrieval-index.ts`](../capabilities/engagements/mcp/engagements/src/retrieval/retrieval-index.ts)) —
the LLM only ever influences the query text and the narrowing arguments:

| Step                                   | Rule                                                                                                                                                                                    | Effect on our request                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1. **Status recall** (contacts)        | `status eq 'active' \| 'prospect'` when asked                                                                                                                                           | keep prospects out of a re-engagement ask |
| 2. **Topic recall**                    | `topicIds ∩ query.topicIds` (contacts and events)                                                                                                                                       | restrict to `T3` (UAS/drone) when asked   |
| 3. **Text recall**                     | substring over name / org / SME areas / city / state for contacts, id / name / city / state for events — a keyword stand-in for hybrid search; the `search` backend does the real thing | match "AUSA" to the anchor event          |
| 4. **Preference narrowing** (contacts) | `doNotMeet` ids dropped, `strategicValue ≥ seniorityFloor`                                                                                                                              | caller preferences NARROW/RANK only       |

With no `query` / `topicIds` / `status` at all, `searchContacts` returns **every** contact — the
set `suggest()` then scores. The result shape is identical on the `search` backend, so the same
planner pipeline runs unchanged against the cloud index.

---

## 7. Stage 5 — The deterministic engine ranks and routes

With a candidate set in hand, `suggest_candidates` runs the pure, unit-tested planner
(`runSuggest` in `tools.ts` → [`planner/`](../capabilities/engagements/mcp/engagements/src/planner/)).
This is the "deterministic core, LLM at the edges" principle — the feasibility math is never done
by the model.

1. **Resolve the anchor** through the same event search any caller would get (`resolveEvent` →
   `searchEvents`), so "AUSA" → one `EngagementEvent`.
2. **`suggest()`** unions three candidate sources against the anchor and ranks them
   ([`planner/suggest.ts`](../capabilities/engagements/mcp/engagements/src/planner/suggest.ts)):
   - (a) event **attendees** → on-site, travel ≈ 0, `re-engage`;
   - (b) **nearby** active contacts within radius → off-site (`haversineMi`);
   - (c) exhibitor **prospects** → on-site, `initiate`.
3. **Scoring is transparent** ([`planner/score.ts`](../capabilities/engagements/mcp/engagements/src/planner/score.ts)):
   - `score(active)   = stalenessNorm × valueNorm × topicRelevance`
   - `score(prospect) = valueNorm × topicRelevance` (no staleness — the "initiate" path)
   - `valueNorm = strategicValue/5`; `stalenessNorm = min(daysSince/360, 1)` (0 if never met);
     `topicRelevance = 1.0` on a topic hit, `0.5` with no target, `0.2` on a miss.
   - "Fit" (domain mismatch, level gap) is attached as a **soft flag, never a filter**.

`build_itinerary` then turns the accepted picks into a trip:

4. **Route** — `planRoute` places on-site stops at the venue (no legs) and sweeps off-site stops
   in **nearest-neighbor** order out of the anchor
   ([`planner/route.ts`](../capabilities/engagements/mcp/engagements/src/planner/route.ts)). An
   `etaMinutes` heuristic picks **ground ≤ 300 mi else air**
   ([`planner/distance.ts`](../capabilities/engagements/mcp/engagements/src/planner/distance.ts)).
5. **ROI** — `tripRoi = Σ(accepted scores) − (airfare + perDiem·days + timePenalty·travelHours)`,
   all in score-units so value and cost compare directly
   ([`planner/roi.ts`](../capabilities/engagements/mcp/engagements/src/planner/roi.ts));
   `overBudget = days > leader.daysAwayBudget`.
6. **Conflicts** — `detectFit` / `detectAvailabilityBudget` / `detectOpportunityCost` add
   **advisory** flags; the engine recommends, the human decides ("advisor, not optimizer").

All the tunable numbers (speeds, radius, cost weights, staleness span) are policy-as-data in
[`planner/weights.ts`](../capabilities/engagements/mcp/engagements/src/planner/weights.ts).

---

## 8. Stage 6 — `build_itinerary` emits the map payload

`build_itinerary` is registered as an **App tool** (`registerAppTool`) and tags its result with
**`_meta: { ui: { resourceUri: 'ui://trip-map/trip-map.html' } }`** — the signal that this result
carries geospatial payload the host should render (`tools.ts`).

It returns a `CallToolResult` with:

- **`content`** — a human-readable text block (header + route line + conflicts) that becomes part
  of the prose answer; and
- **`structuredContent`** — `{ today, leader, event, accepted, notMatched, route, duration, roi,
conflicts, categoryCoverage, nearbyLeaders, tripMap }`. The **`tripMap`** is the wire format the
  Azure Maps App consumes: `{ title, origin, stops[], legs[], roiScore?, totalMi? }`, built by
  `buildTripMapFromOrigin` (on-site pins are co-located with the origin so home coordinates don't
  scatter the map).

---

## 9. Stage 7 — The orchestrator assembles the answer

Back in `planTrip`, **`assemble`** reads the captured tool results and packages the final
`PlanResult` (`orchestrator.ts`):

```jsonc
{
  "ok": true, "mode": "llm", "deterministicReason": null,
  "question": "I'm planning a trip to AUSA — who should I meet on the UAS/drone topic?",
  "answer":  "…prose menu + one-line itinerary…",   // model text, or rendered from tool text
  "toolCalls": [ { "name": "suggest_candidates" }, { "name": "build_itinerary" } ],
  "menu":    [ /* suggest_candidates candidates — the option cards */ ],
  "itinerary": { "leader": …, "event": …, "accepted": …, "route": …, "roi": …,
                 "conflicts": …, "nearbyLeaders": …, "categoryCoverage": … },
  "tripMap": { "title": …, "origin": …, "stops": …, "legs": … }   // for the host to render
}
```

`ok` is `true` when a menu **or** an itinerary came back; `deterministicReason` is non-null only on
the `deterministic` path and explains why the LLM loop wasn't used. The leader-first flow adds
`stage` / `clarify` / `options` / `leaderShortlist` / `questions` to the same envelope. This single
JSON object is the HTTP response to the UI's `/ask`.

---

## 10. Stage 8 — The UI renders answer + menu

The chat host drops the response into the thread (`index.tsx`):

- **`answer`** → the assistant prose bubble.
- **`menu[]`** → the who-to-meet **cards** (`MenuCard`): name, org, city, placement, strategic
  value, staleness, score, fit flags.
- **`itinerary`** → the route / ROI / conflicts summary, and the plan context the next turn
  elaborates.

If `tripMap` is `null` (a clarify turn, or a build that produced no route), the flow ends here
with prose + cards.

---

## 11. Stage 9 — The trip-map MCP App (the second MCP client)

When `tripMap != null`, the UI mounts **`<TripMapHost>`**, which performs the MCP-Apps host
handshake ([`ui/src/implementation.ts`](../capabilities/engagements/ui/src/implementation.ts)):

1. **Connect a second MCP client** to `:3010` (`connectToServer` — plain Streamable HTTP, no extra
   headers) used **only** to `resources/read` the App HTML (`getUiResource`). It does
   **not** call tools; the itinerary was already decided by the orchestrator.
2. **Read `ui://trip-map/trip-map.html`** — the single-file Azure Maps App, plus its
   `_meta.ui.csp` declaring the `*.atlas.microsoft.com` origins the sandbox may reach
   (`registerAppResource` in `tools.ts`).
3. **Load the sandbox proxy** at `:8081` (a **distinct origin**) into a sandboxed iframe, then
   open an **`AppBridge`** (`@modelcontextprotocol/ext-apps`) over `postMessage`.
4. **Deliver the App HTML**, wait for `initialized`, then hand the orchestrator's `tripMap` to the
   App as a **synthetic tool result** (`sendToolResult`). The App plots origin/stop **pins** and
   **leg polylines** and fits the bounds.

The result the user sees — pins, colored route, ROI — is the same sandboxed App a fully compliant
MCP host would render, and the App itself never calls a tool: it only ever plots the payload the
orchestrator already computed.

---

## 12. End-to-end sequence

```
User        Chat host (:8080)     Orchestrator (:3020)      Engagements MCP (:3010)     Seed / Azure
 │  ask            │                      │                          │                       │
 │────────────────►│  POST /ask           │                          │                       │
 │                 │─────────────────────►│  planTrip()              │                       │
 │                 │                      │  makeToolClient()        │                       │
 │                 │                      │  ── MAF decision ───────► │                       │
 │                 │                      │  tools/call suggest_…    │                       │
 │                 │                      │  (via Python AGT) ──────►│  getReadModel()       │
 │                 │                      │                          │  recall → narrow      │◄─ seed (fresh)
 │                 │                      │                          │  suggest()/score      │
 │                 │                      │  ◄─────────────── menu   │                       │
 │                 │                      │  tools/call build_… ────►│  route/roi/conflicts  │
 │                 │                      │                          │  + tripMap + _meta.ui │
 │                 │                      │  ◄──── itinerary+tripMap │                       │
 │                 │  ◄── PlanResult JSON │  assemble()              │                       │
 │  answer + menu  │◄─────────────────────│                          │                       │
 │◄────────────────│                      │                          │                       │
 │                 │  resources/read ui://trip-map ──────────────────►│  App HTML + CSP       │
 │                 │  sandbox iframe (:8081) ◄── AppBridge ── tripMap│                       │
 │  🗺  trip map    │◄── Azure Maps pins/route ───────────────────────────────────────────► atlas.microsoft.com
```

---

## 13. Where the LLM is — and is not

- **LLM decides:** intent, workflow, whether a grounded clarification is needed, which allowed
  tools to call and with what arguments, option recommendation, and final prose
  (system prompt + Microsoft Agent Framework).
- **LLM never decides:** which tools it is allowed to call at all (the AGT policy), the candidate
  scores, the route, the ROI, or the conflicts — all pure deterministic functions. Turning the
  model off swaps in the deterministic fallback behind the same UI contract.
- **The model never sees the heavy payload:** `makeToolClient` strips `tripMap` from the tool
  result the model reads and keeps it in `client.captured` for final assembly.

## 14. Failure modes and fallbacks

| Situation                                                               | What happens                                                                                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure OpenAI absent/errors/timeout                                      | Python `/run` fails explicitly → the TypeScript gateway runs its governed deterministic router                                                |
| Framework returns an incomplete planning decision                       | Gateway rejects it and runs the governed deterministic fallback                                                                               |
| `RETRIEVAL_BACKEND=search` or `grounding` but no `AZURE_SEARCH_SERVICE` | `resolveBackend()` **throws** — it will not fall back to `memory` and serve the demo seed as if it were live                                  |
| `RETRIEVAL_BACKEND=grounding`                                           | Only `search_grounding` is registered; `getReadModel()` throws, because a document/chunk corpus carries no structured records for the planner |
| `RETRIEVAL_BACKEND` set to anything else                                | `resolveBackend()` throws naming the three valid values                                                                                       |
| Azure Maps key absent                                                   | Trip-map App renders a schematic dots-and-routes fallback                                                                                     |
| Python runtime or MCP server unreachable                                | `planTrip` returns a dependency error; the combined agent launcher starts `:3020` and `:3030` together                                        |

---

## 15. Citation index (follow the code)

| Stage                                                           | File                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| UI submit `/ask`, render menu + map                             | `capabilities/engagements/ui/src/index.tsx`, `.../config.ts`                                         |
| MCP-Apps host handshake                                         | `capabilities/engagements/ui/src/implementation.ts`                                                  |
| Orchestrator entry / HTTP routes                                | `capabilities/engagements/agent/src/main.ts`                                                         |
| `planTrip`, `agentDecisionToPlanResult`, deterministic fallback | `capabilities/engagements/agent/src/orchestrator.ts`                                                 |
| TypeScript governed-runtime client                              | `capabilities/engagements/agent/src/python-runtime.ts`, `.../tools.ts`                               |
| Seed roster/topic grounding                                     | `capabilities/engagements/agent/src/catalog.ts`                                                      |
| Microsoft Agent Framework runtime                               | `capabilities/engagements/agent/engagements_agent/runtime.py`                                        |
| AGT policy, middleware, audit                                   | `capabilities/engagements/agent/engagements_agent/governance.py`, `governance/policy.yaml`           |
| Governed MCP bridge                                             | `capabilities/engagements/agent/engagements_agent/mcp_client.py`                                     |
| MCP server (stateless, fresh server per request)                | `capabilities/engagements/mcp/engagements/src/main.ts`, `.../server.ts`                              |
| Tool handlers + `ui://trip-map` resource                        | `capabilities/engagements/mcp/engagements/src/tools.ts`                                              |
| Read-model backends (memory / search / grounding)               | `capabilities/engagements/mcp/engagements/src/readmodel.ts`                                          |
| Azure AI Search queries + provisioning                          | `capabilities/engagements/mcp/engagements/src/retrieval/search-backend.ts`                           |
| Index-shape registry (JSON config)                              | `capabilities/engagements/mcp/engagements/index-schema.json`, `.../src/retrieval/index-schema.ts`    |
| Recall + preference narrowing, provenance labels                | `capabilities/engagements/mcp/engagements/src/retrieval/retrieval-index.ts`, `.../labels.ts`         |
| Ranking / route / ROI / weights                                 | `capabilities/engagements/mcp/engagements/src/planner/{suggest,score,route,roi,distance,weights}.ts` |
