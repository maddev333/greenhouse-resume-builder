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

Keep the persona on **EA · G8** and ask:

> _I'm planning a trip to AUSA — who should I meet on the UAS/drone topic?_

The user gets three things back: a **prose answer**, a **menu of who-to-meet cards** (one
redacted by the security trim), and a live **Azure Maps trip itinerary**. The sections below
follow the data that produces each of them.

---

## 1. Cast of components

Three long-running services plus a distinct sandbox origin. The **one** MCP server has **two
clients**: the orchestrator calls its **tools**; the browser reads its **`ui://trip-map` App
resource**.

| # | Component | Process / URL | Role in a question |
|---|-----------|---------------|--------------------|
| 1 | **Chat host UI** (M6) | Browser, `:8080` | Captures the question + persona; POSTs `/ask`; renders answer + menu; hosts the trip-map App | 
| 2 | **Sandbox proxy** | `:8081` (distinct origin) | Isolates the `ui://trip-map` MCP App in a cross-origin sandboxed iframe |
| 3 | **Orchestrator / agent** (M5) | Node/Express, `:3020` | "The brain" — turns the question into tool calls; LLM loop or deterministic router; assembles the result |
| 4 | **Engagements MCP capability** | Node, `:3010/mcp` | Security trim + deterministic planner engine + `ui://trip-map` resource, exposed as MCP tools |
| 5 | **mcp-core** | in-proc library | Shared Azure OpenAI tool-calling loop, identity, governance gate |
| 6 | **Seed dataset** | JSON on disk | Source of record: leaders, contacts, events, topics, messages, regions (pre-geocoded) |
| 7 | **Azure OpenAI** | cloud (optional) | Reasoning + tool selection for the LLM path; deterministic fallback when absent |
| 8 | **Azure AI Search** | cloud (optional) | Alternate read-model backend (`RETRIEVAL_BACKEND=search`); enforces the same trim as an OData `$filter` |
| 9 | **Azure Maps** | cloud (optional) | Tiles/styles for the trip-map App; schematic fallback without a key |

```
 Browser chat host (:8080)                                   chat client + MCP-Apps host
   │
   ├─ POST /ask {question, persona} ─────────►  Orchestrator (:3020)   "the brain"
   │  ◄─ {answer, menu[], itinerary, tripMap}      └─ MCP tools/call (x-demo-persona) ─┐
   │                                                                                   ▼
   └─ resources/read ui://trip-map ───────────────────────────►  Engagements MCP (:3010)
      (rendered in sandboxed iframe via :8081)                     • per-request security trim
                                                                   • deterministic planner engine
                                                                   • ui://trip-map App resource
                                                                          │ seed only
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
- **The governance envelope** is baked onto every record when the read model loads it:
  `applyLabels` → `deriveEnvelope` attaches `{ source, aclGroups, sensitivity }`
  ([`retrieval/labels.ts`](../capabilities/engagements/mcp/engagements/src/retrieval/labels.ts)).
  The seed stays domain-only; the labels are the demo's need-to-know policy in one place:
  - `C4` → `aclGroups: ['/army/g8/plans']` (a **group-ACL** beat — invisible to a basic EA).
  - `C12` → `sensitivity: 'sensitive'` (a **sensitivity** beat — role-gated regardless of group).
- **The read model is loaded FRESH per tool call** so a live add/update/delete/"reindex" shows
  immediately ([`readmodel.ts`](../capabilities/engagements/mcp/engagements/src/readmodel.ts)).
  Two interchangeable backends sit behind one async contract:
  - `memory` (default) — the in-memory `EngagementIndex`, zero cloud.
  - `search` — Azure AI Search, selected by `RETRIEVAL_BACKEND=search` when a service is
    configured (silently falls back to `memory` otherwise).

---

## 3. Stage 1 — The user asks (chat host UI, `:8080`)

1. The user picks a **persona** and types the question. The persona is the demo stand-in for
   verified Keycloak claims — it drives the entire security trim.
2. On submit, the UI POSTs to the orchestrator
   ([`ui/src/index.tsx`](../capabilities/engagements/ui/src/index.tsx)):

   ```
   POST {orchestratorUrl}/ask
   { "question": "...AUSA...UAS/drone...", "persona": "EA_G8" }
   ```

   `orchestratorUrl` defaults to `http://localhost:3020`
   ([`ui/src/config.ts`](../capabilities/engagements/ui/src/config.ts)).
3. The UI shows a busy state and waits for a single JSON response (`PlanResult`). It does **not**
   yet talk to the MCP server — that happens later, only if a `tripMap` comes back (Stage 9).

---

## 4. Stage 2 — The orchestrator receives the question (`:3020`)

`POST /ask` is a thin Express handler that validates `question` and calls **`planTrip`**
([`agent/src/main.ts`](../capabilities/engagements/agent/src/main.ts) →
[`agent/src/orchestrator.ts`](../capabilities/engagements/agent/src/orchestrator.ts)).

`planTrip` resolves defaults and **opens one MCP client bound to the persona**:

- `persona` → `x-demo-persona` header on every request via `makeToolClient`
  ([`agent/src/tools.ts`](../capabilities/engagements/agent/src/tools.ts)). This single header is
  what makes the capability enforce the same server-side trim the real Keycloak claims would.
- `leaderId` defaults to the first seed leader; `topN` defaults to 3.
- The client is a `StreamableHTTPClientTransport` MCP client pointed at
  `ENGAGEMENTS_MCP_URL` (`http://localhost:3010/mcp`).

Then it chooses one of two planning paths.

---

## 5. Stage 3 — The planning brain (two paths, same tools)

### 5a. LLM path (primary, when Azure OpenAI is configured)

`isModelConfigured()` gates this. If on, `planTrip` runs **`runAgentLoop`**
([`mcp-core/src/agent-loop.ts`](../capabilities/mcp-core/src/agent-loop.ts)) — a **self-hosted
Azure OpenAI tool-calling loop** (the IL5-compliant "app owns the loop" pattern; the managed
Foundry Agent Service is never used):

1. **System prompt** = `buildSystemPrompt` — injects the leader roster and topic taxonomy read
   straight from the seed ([`agent/src/catalog.ts`](../capabilities/engagements/agent/src/catalog.ts))
   plus the routing rules ("map 'UAS/drone' → T3", "always follow `suggest_candidates` with
   `build_itinerary`").
2. **Tool specs** = `AGENT_TOOLS` — JSON-schema mirrors of the capability's tools so the model
   emits valid arguments (`agent/src/tools.ts`).
3. The loop POSTs to Azure OpenAI (`temperature: 0`, `max_completion_tokens: 1800`,
   `tool_choice: 'auto'`, up to 8 iterations). Each tool call the model requests is dispatched
   through `client.callTool(name, args)` — i.e. straight into the MCP capability (Stage 4) — and
   the result is fed back as a `tool` message so the model can chain the next call.
4. **`ensureItinerary`** is a safety net: if the model produced a menu but forgot to call
   `build_itinerary`, the orchestrator auto-builds from the top-N so a route + map always exist.

> Token hygiene: the heavy `tripMap` payload is **stripped** from the tool result the model
> sees (`makeToolClient`) but retained in `client.captured` for final assembly.

### 5b. Deterministic path (fallback, offline demo)

When the model is unavailable or errors, `planTrip` calls **`deterministicPlan`** — a no-LLM
router that mirrors what the model would compose (`orchestrator.ts`):

1. `parseRadiusAsk` detects a "fixed-radius" ask ("meet _Company_ for 3 days") → `plan_radius`
   → `build_itinerary`.
2. Otherwise `anchorGuess` extracts the anchor ("AUSA") and `topicIdsFromText` maps keywords →
   topic ids (`UAS/drone → T3`).
3. It calls `suggest_candidates`, widens the topic filter if that zeroed the menu, then calls
   `build_itinerary` with the top-N contact ids.

Either path drives the **same** MCP client and the **same** tools — the only difference is who
picks the arguments (the model vs. the deterministic router).

---

## 6. Stage 4 — Inside the capability: security trim FIRST (`:3010`)

The MCP server is **stateless**: `main.ts` builds a fresh `McpServer` **and a fresh caller
context** per HTTP request ([`mcp/engagements/src/main.ts`](../capabilities/engagements/mcp/engagements/src/main.ts)).

1. **Resolve the caller.** `resolveSecurityContext(req.headers)` turns the request headers into a
   verified `SecurityContext` ([`context.ts`](../capabilities/engagements/mcp/engagements/src/context.ts)).
   Resolution order: `x-demo-persona` → header-built claims (`x-tenant-id` / `x-user-groups` /
   `x-user-roles` / …) → default persona. For our request, `x-demo-persona: EA_G8` resolves to
   `{ tenantId: 'army', aclGroups: ['/army', '/army/g8/plans'] }`.
2. **Every tool follows the same four-step contract** (`tools.ts` header comment):
   (a) resolve the caller's claims, (b) load a **fresh** read model,
   (c) **let the trim run server-side BEFORE any recall/scoring**, and
   (d) report the exact `$filter` + `redactedCount` so the trim is observable on stage.

The trim itself is `buildEngagementSecurityFilter`
([`retrieval/security.ts`](../capabilities/engagements/mcp/engagements/src/retrieval/security.ts)),
which builds **both** an OData `$filter` (for Azure AI Search) and an in-memory `predicate` (for
the memory backend) from the **same** claims so they can never diverge. Four layers, all
server-side — the LLM only ever influences query text, never the filter:

| Layer | Rule | Effect on our request |
|-------|------|-----------------------|
| 1. **Tenant isolation** | `tenantId eq '<tid>'`; **no tenant claim ⇒ rejected (fail-closed)** | `army` rows only |
| 2. **Group ACL** (deny-by-default) | `aclGroups/any(g: search.in(g, <caller groups>))` | EA·G8 holds `/army/g8/plans` ⇒ **`C4` is visible** |
| 3. **Sensitivity gate** | `sensitivity eq 'unclassified'` unless a privileged role/scope | EA·G8 lacks `ClearedReviewer` ⇒ **`C12` stays hidden** |
| 4. **Topic narrowing** | optional `topicIds/any(...)` — recall convenience, never widens access | restrict to `T3` when asked |

The read model applies the trim in the right order — **recall, then trim, then preference
narrowing** — and returns a `TrimmedResult { items, filter, redactedCount }`
([`retrieval/retrieval-index.ts`](../capabilities/engagements/mcp/engagements/src/retrieval/retrieval-index.ts)).
`redactedCount = recalled − authorized` is the number the answer reports as "N contact(s)
redacted by trim." **Authorized rows are the only thing that ever leaves the index**, so no
scoring or prose is ever computed over data the caller may not see.

---

## 7. Stage 5 — The deterministic engine ranks and routes

With an authorized candidate set in hand, `suggest_candidates` runs the pure, unit-tested planner
(`runSuggest` in `tools.ts` → [`planner/`](../capabilities/engagements/mcp/engagements/src/planner/)).
This is the "deterministic core, LLM at the edges" principle — the feasibility math is never done
by the model.

1. **Resolve the anchor** through the same trimmed event search (`resolveEvent`), so "AUSA" →
   one authorized `EngagementEvent`.
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
- **`structuredContent`** — `{ leader, event, accepted, route, roi, conflicts, redactedCount,
  filter, tripMap }`. The **`tripMap`** is the wire format the Azure Maps App consumes:
  `{ title, origin, stops[], legs[], roiScore, totalMi, caller }`, built by
  `buildTripMapFromOrigin` (on-site pins are co-located with the origin so home coordinates don't
  scatter the map).

---

## 9. Stage 7 — The orchestrator assembles the answer

Back in `planTrip`, **`assemble`** reads the captured tool results and packages the final
`PlanResult` (`orchestrator.ts`):

```jsonc
{
  "ok": true, "mode": "llm", "persona": "EA_G8",
  "answer":  "…prose menu + one-line itinerary…",   // model text, or rendered from tool text
  "toolCalls": [ { "name": "suggest_candidates" }, { "name": "build_itinerary" } ],
  "menu":    [ /* candidate cards from suggest_candidates */ ],
  "itinerary": { "leader": …, "route": …, "roi": …, "conflicts": … },
  "tripMap": { "origin": …, "stops": …, "legs": … },   // for the host to render
  "redactedCount": 1,                                   // trim made visible
  "rejected": false
}
```

`rejected` is `true` when the trim fail-closed (e.g. `NO_TENANT`); `redactedCount` surfaces the
hidden rows. This single JSON object is the HTTP response to the UI's `/ask`.

---

## 10. Stage 8 — The UI renders answer + menu

The chat host drops the response into the thread (`index.tsx`):
- **`answer`** → the assistant prose bubble.
- **`menu[]`** → the who-to-meet **cards** (`MenuCard`): name, org, city, placement, strategic
  value, staleness, score, fit flags.
- **`redactedCount`** → the "N redacted by trim" note that changes as you switch personas.

If `tripMap` is `null` (e.g. a rejected persona), the flow ends here with prose + the trim beat.

---

## 11. Stage 9 — The trip-map MCP App (the second MCP client)

When `tripMap != null`, the UI mounts **`<TripMapHost>`**, which performs the MCP-Apps host
handshake ([`ui/src/implementation.ts`](../capabilities/engagements/ui/src/implementation.ts)):

1. **Connect a second MCP client** to `:3010` — this one carrying the same `x-demo-persona` —
   used **only** to `resources/read` the App HTML (`connectToServer` + `getUiResource`). It does
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
MCP host would render; the security trim that decided its contents was enforced server-side long
before any pixels.

---

## 12. End-to-end sequence

```
User        Chat host (:8080)     Orchestrator (:3020)      Engagements MCP (:3010)     Seed / Azure
 │  ask + persona  │                      │                          │                       │
 │────────────────►│  POST /ask           │                          │                       │
 │                 │─────────────────────►│  planTrip()              │                       │
 │                 │                      │  makeToolClient(persona) │                       │
 │                 │                      │  ── LLM loop OR router ─► │                       │
 │                 │                      │  tools/call suggest_…    │                       │
 │                 │                      │  (x-demo-persona) ──────►│  resolveSecurityCtx   │
 │                 │                      │                          │  trim FIRST ─► recall │◄─ seed (fresh)
 │                 │                      │                          │  suggest()/score      │
 │                 │                      │  ◄──────── menu + filter │                       │
 │                 │                      │  tools/call build_… ────►│  route/roi/conflicts  │
 │                 │                      │                          │  + tripMap + _meta.ui │
 │                 │                      │  ◄──── itinerary+tripMap │                       │
 │                 │  ◄── PlanResult JSON │  assemble()              │                       │
 │  answer + menu  │◄─────────────────────│                          │                       │
 │◄────────────────│                      │                          │                       │
 │                 │  resources/read ui://trip-map (x-demo-persona) ►│  App HTML + CSP       │
 │                 │  sandbox iframe (:8081) ◄── AppBridge ── tripMap│                       │
 │  🗺  trip map    │◄── Azure Maps pins/route ───────────────────────────────────────────► atlas.microsoft.com
```

---

## 13. Where the LLM is — and is not

- **LLM decides:** which tool to call and with what arguments; the final prose narrative
  (system prompt + `runAgentLoop`).
- **LLM never decides:** who is authorized (the security trim), the candidate scores, the route,
  the ROI, or the conflicts — all pure deterministic functions. Turning the model off swaps in
  the deterministic router and yields the **same** structured plan, only with terser prose.
- **The model never sees hidden data:** the trim runs server-side before recall, and the heavy
  map payload is stripped from the model's view.

## 14. Failure modes and fallbacks

| Situation | What happens |
|-----------|--------------|
| Azure OpenAI absent/errors/timeout | `runAgentLoop` returns `null` → deterministic router runs (offline-reliable) |
| Model returns a menu but no itinerary | `ensureItinerary` auto-builds from top-N so a map always exists |
| `RETRIEVAL_BACKEND=search` but no service | Read model silently falls back to `memory` |
| Azure Maps key absent | Trip-map App renders a schematic dots-and-routes fallback |
| `NO_TENANT` persona | Trim fail-closes → `rejected: true`, empty menu, no map |
| `CROSS_TENANT` persona | Tenant isolation → empty result (0 cards) |
| MCP server unreachable | `planTrip` returns a friendly error telling you to start `:3010` |

---

## 15. Citation index (follow the code)

| Stage | File |
|-------|------|
| UI submit `/ask`, render menu + map | `capabilities/engagements/ui/src/index.tsx`, `.../config.ts` |
| MCP-Apps host handshake | `capabilities/engagements/ui/src/implementation.ts` |
| Orchestrator entry / HTTP routes | `capabilities/engagements/agent/src/main.ts` |
| `planTrip`, deterministic router, `assemble` | `capabilities/engagements/agent/src/orchestrator.ts` |
| Tool specs + persona-bound MCP client | `capabilities/engagements/agent/src/tools.ts` |
| Seed roster/topic grounding | `capabilities/engagements/agent/src/catalog.ts` |
| Azure OpenAI tool-calling loop | `capabilities/mcp-core/src/agent-loop.ts` |
| MCP server (stateless, per-request ctx) | `capabilities/engagements/mcp/engagements/src/main.ts`, `.../server.ts` |
| Caller claims from headers/persona | `capabilities/engagements/mcp/engagements/src/context.ts` |
| Tool handlers + `ui://trip-map` resource | `capabilities/engagements/mcp/engagements/src/tools.ts` |
| Read-model backends (memory / search) | `capabilities/engagements/mcp/engagements/src/readmodel.ts` |
| Security trim (filter + predicate) | `capabilities/engagements/mcp/engagements/src/retrieval/security.ts`, `.../personas.ts` |
| Trim-first recall | `capabilities/engagements/mcp/engagements/src/retrieval/retrieval-index.ts`, `.../labels.ts` |
| Ranking / route / ROI / weights | `capabilities/engagements/mcp/engagements/src/planner/{suggest,score,route,roi,distance,weights}.ts` |
