# Strategic Engagements Travel Planner — Architecture

> **Status:** DRAFT for review. Companion to [`MVP-PLAN.md`](./MVP-PLAN.md) (what/why) and
> [`DEMO-DATASET.md`](./DEMO-DATASET.md) (the choreographed data). This doc is the **how**:
> components, data flows, Azure services, the engine internals, and the one-week build sequence.
> Every "reuse" claim below is grounded in a real file in this repo.

---

## 1. Guiding principles

1. **Reuse-first.** The live capability is **geocoding** (Azure Maps via the Geospatial MCP) and the
   **map is already wired** in the UI. Summarization, Document Intelligence, and version-diff exist.
   We build a **deterministic planner engine** and a **chat-rendered MCP-App widget** on top — not a
   new platform.
2. **Deterministic core, LLM at the edges.** Distance, batching, route ordering, conflicts, and ROI
   are pure, unit-testable functions. The LLM (Azure OpenAI) is used only for pre-brief prose and
   message-consistency — never for the feasibility math.
3. **Advisor, not optimizer.** The engine flags and recommends; the human decides (fit never blocks).
4. **Offline-reliable demo.** All locations are **pre-geocoded once at seed time** and baked into the
   JSON **blobs** (mirrored into the **AI Search** index), so the live demo makes **no** Maps geocode
   call and can't fail on a network blip.
5. **Chat-native delivery (MCP Apps).** The interface is a **chat UI that renders MCP UI apps.** The
   planner ships as **one `engagements` capability** — a tabbed **hybrid web + MCP App** widget —
   exactly like the repo's six existing capability modules (discovery, geospatial, llmwiki, quality,
   relationships, temporal). The host is a **web page** — the ext-apps **`basic-host`** reference
   shell — that renders the widget in a **sandboxed iframe** via the **official MCP Apps SDK**
   (`@modelcontextprotocol/ext-apps`); not a standalone SPA.

---

## 2. System context & components

```
 ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 │  WEB CHAT HOST (ext-apps basic-host shell) renders MCP Apps in a sandboxed iframe           │
 │   chat thread · model composes tools · pushes each tool result to the widget                │
 │   ┌─────────────────────────────────────────────────────────────────────────────────────┐  │
 │   │  ENGAGEMENTS WIDGET  (one hybrid web+MCP App, tabbed)  ◀── ui://engagements-widget.html│  │
 │   │   [ Trip Planner ★ | Conference Roster | Pre-brief / Consistency ]                     │  │
 │   │   map (atlas: pins + leg lines) · itinerary · conflict badges · ROI · roster · brief    │  │
 │   │   official MCP Apps SDK (ext-apps): App / useApp over the ui/ postMessage channel       │  │
 │   └───────────────────────────────────────────────┬─────────────────────────────────────┘  │
 └─────────────────────────────────────────────────────┼───────────────────────────────────────┘
     tools/call  +  resources/read (ui:// widget)       │  each tool result carries _meta.ui.resourceUri
                                                         ▼
 ┌─────────────────────────────────────────────────────────────┐      ┌───────────────────────────┐
 │  ENGAGEMENTS MCP CAPABILITY  (capabilities/engagements/)      │      │  Geospatial MCP (LIVE)     │
 │  mcp-core server (Streamable HTTP) — tools/* + resources/*    │ seed │  geocode · project_map_pins│
 │  ┌────────────────────────────────────────────────────────┐  │─────▶│  (Azure Maps, cap 25/call) │
 │  │ PLANNER ENGINE (api/src/planner/, deterministic)        │  │ only └───────────────────────────┘
 │  │ distance·score·suggest·route·conflicts·roi·slots        │  │      ┌───────────────────────────┐
 │  └────────────────────────────────────────────────────────┘  │─────▶│ Azure OpenAI (prose/verdict)│
 │  prebrief (REUSE summary) · afteraction (REUSE DI+diff)       │      │ Azure Document Intelligence│
 │  Durable retrieval orchestrator · serves the ui:// widget     │      └───────────────────────────┘
 └───────────────────────────┬─────────────────────────────────┘
                             ▼
   ┌────────────────────────────────────────────────────────────────────────────┐
   │  Blob Storage — JSON, one blob per record = source of record                 │
   │  sources/{leaders,contacts,events,topics,messages,engagements,afteractions}/ │
   └───────────────────────────────┬────────────────────────────────────────────┘
          per-source indexer + integrated-vectorization skillset (manual reindex)
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────────┐
   │  Azure AI Search index `engagements` — vectors + filterable trim fields      │
   │  (tenantId · aclGroups · sensitivity · source) ◀─ Keycloak-claim $filter     │
   └────────────────────────────────────────────────────────────────────────────┘
```

**The only live external call during the demo is the pre-geocode at seed time.** Everything on the
demo path (nudge → build → evaluate → pre-brief) runs off cached data + the local engine + Azure OpenAI.

**Delivery = one MCP-App capability.** The planner is packaged as `capabilities/engagements/`,
following the repo's six existing capability modules: a **hybrid web + MCP App** widget with three
**tabs** (Trip Planner ★, Conference Roster, Pre-brief + Consistency), served to the chat host as the
`ui://engagements-widget.html` resource and surfaced by each tool's **`_meta.ui.resourceUri`**. The
host's model **composes the deterministic planner tools** and narrates in the chat thread; the widget
renders the result and can call tools back through the **official MCP Apps SDK**
(`@modelcontextprotocol/ext-apps` — `App`/`useApp` over the `ui/` postMessage channel; server side uses
`registerAppTool`/`registerAppResource`). The engine stays deterministic; the model is the LLM edge
(see §4, §9 and `MVP-PLAN.md` §11).

---

## 3. Reuse vs. net-new (grounded in real files)

| Concern                | Reuse? | Where it lives today                                                       | What we add                                                     |
| ---------------------- | ------ | -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Map rendering**      | ✅ reuse | `ui/src/MapView.tsx` (azure-maps-control `atlas`, HtmlMarkers, bounds-fit) | Ported into the widget's **Trip tab**: **trip-colored pins** + **leg polylines** |
| **Geocoding**          | ✅ reuse | `ui/src/geo.ts` → Geospatial MCP `project_map_pins` (`capabilities/geospatial/mcp/geospatial/src/tools.ts`, **cap 25**) | A **seed script** that geocodes the dataset in chunks of ≤25 and caches lat/lng |
| **API shell**          | ✅ reuse | `api/src/server.ts` (Express, `/api/v1/*`, `authMiddleware` on `/api/`)     | Engine hosted as **MCP tools** on the `engagements` capability (primary); Express `/api/v1/*` optional for the widget's **standalone-web** fallback |
| **Persistence (source of record)** | ✅ reuse pattern | Repo already does **AAD/MI blob access** (`functions/src/activities/document-intelligence.ts`); storage account has shared-key **disabled** (RBAC only) | **One JSON blob per record**, foldered by source; **no Postgres** for the MVP (§5) |
| **MCP Apps SDK (official)** | ❌ new (deps present) | `@modelcontextprotocol/ext-apps` already in root `package.json`; `mcp-bridge.ts` is a hand-rolled precedent | **Client:** `App`/`useApp`. **Server:** `registerAppTool`/`registerAppResource`. `mcp-bridge.ts` reused only for the standalone-web fallback |
| **Summarization**      | ✅ reuse | `functions/src/activities/summary.ts` (Azure OpenAI, `max_completion_tokens`) | Call it from a **pre-brief service** (per-stop)                |
| **Doc Intelligence**   | ✅ reuse | `functions/src/activities/document-intelligence.ts` (Form Recognizer)      | Call it from an **after-action ingest** endpoint               |
| **Message drift**      | ✅ reuse | `functions/src/activities/version-diff.ts`                                 | Diff **actual vs. approved** talking points                    |
| **Auth (UI → API trust boundary)** | ✅ **already wired** | `api/src/middleware/auth.middleware.ts` **already supports `AUTH_PROVIDER=keycloak`** (RS256 vs realm JWKS, `keycloakClaimsToUser` maps sub/groups/roles/`tenant_id`) | Add 2 Keycloak protocol mappers (`tenant_id` claim + Group Membership); build the `SecurityContext` (§5.4). Demo bypass flag optional |
| **Read model / indexing** | ❌ new (Azure config) | `api/src/search/index.ts`, `functions/src/persistence/index.ts` (push model, **no vector field**) | **Per-source blob indexer + integrated-vectorization skillset** → one `engagements` index; **fix the 2 latent query bugs** (§5.2) |
| **Semantic search tool** | ✅ reuse skeleton | `capabilities/discovery/mcp/search/src/tools.ts` (`search_facts`, backing `rawResults=[]`) | Wire live `searchClient.search(query, { filter })`; return **trimmed** snippets |
| **Security trim** | ✅ reuse | `capabilities/mcp-core/src/security.ts` (`buildFactSecurityFilter`, `isSensitiveFactKey`) | Add the **`aclGroups/any(g: search.in(g,…))`** clause; wire into every retrieval call (§5.4) |
| **Retrieval orchestration** | ✅ reuse pattern | `functions/src/pipeline/orchestrator.ts` (`df.Task.all` fan-out/in) + `http-start.ts` (trusted-subsystem seam) | **Retrieval orchestrator** fanning out to per-capability search sub-agents (§5.3) |
| **Personal notes (stretch)** | ✅ reuse OBO | `api/src/services/entra-token.ts` (`getOboToken`) | Separate **Entra-ID-authenticated MCP client**, decoupled from Keycloak (§5.4) |
| **Distance / routing** | ❌ new  | — (repo has geocoding only; **no routing**)                                | **haversine** + ETA heuristic; optional Azure Maps Route Matrix |
| **Planner engine**     | ❌ new  | —                                                                          | `api/src/planner/*` deterministic modules (§6)                 |
| **MCP-App resource serving** | ❌ new | **designed only** (`docs/wiki-app-architecture.md`); deps present (`@modelcontextprotocol/ext-apps`, `@mcp-ui/server`); `mcp-core/mcp-server.ts` is **tools-only** | **net-new in `mcp-core`**: `resources/list`+`resources/read` for `ui://…` + `_meta.ui.resourceUri` on tool results |
| **Engagements widget** | ❌ new (pattern reuse) | 6 capability UIs are templates (`capabilities/*/ui`, hybrid web+MCP App) | **One tabbed hybrid web+MCP App** (`capabilities/engagements/ui`): Trip / Roster / Pre-brief tabs |

**Note on the 25-pin cap:** `project_map_pins` slices to 25 locations per call. The seed (~6 home
bases + 20 contacts + 3 events ≈ 29 places) is geocoded in **2 chunks** at seed time — never on the
demo path.

---

## 4. Where the net-new engine lives (decision)

**Decision:** implement the engine as **pure TypeScript modules in `api/src/planner/`**,
framework-free and trivially unit-testable (critical — the demo's credibility is the math).

**Delivery (decided — in week 1):** the same pure modules are **registered as MCP tools** on the
**`engagements` capability server** (built on `@greenhouse-resume-builder/mcp-core`, like the six
existing capabilities). That server also **serves the widget** as the `ui://engagements-widget.html`
resource, and each user-facing tool tags its result with **`_meta.ui.resourceUri`** so the chat host
renders the widget. Inside the host, **the model is the agent**: it composes the deterministic tools
and narrates (nudge, pre-brief prose, consistency verdict); the widget renders results and calls tools
back via the official SDK (`useApp`). Keeping the modules framework-free means the same code also backs an
optional Express `/api/v1/*` surface for the widget's **standalone-web** mode — no duplication.

**Widget tabs (who owns which tab + tools):**

| Tab (in the one widget) | Team | Tools it calls | Produces |
| ----------------------- | ---- | -------------- | -------- |
| **Trip Planner** ★ | T2 | `suggest` · `distance` · `route` · `conflicts` · `roi` | proactive nudge, ordered itinerary, conflict recs, ROI rationale |
| **Conference Roster** | T3 | `conference_roster` · `on_site_slot_plan` · `score` · `who_to_invite` | attendees on-site + slot plan, light prospecting, invite ranking |
| **Pre-brief / Consistency** | T4 | `summarize` (reuse) · `extract_document` (DI) · `diff_versions` (version-diff) | per-stop pre-brief w/ citations, after-action drift verdict |

The **Platform team (T1)** owns the **`engagements` capability server** (tools + `ui://` resource
serving added to mcp-core), the **widget shell** (tabs + ext-apps `App`/`useApp` + single-file build + text
fallback), the **data spine**, and the optional agent-runtime host — see the build sequence in §12.

---

## 5. Data plane, indexing & authorization

> **MVP decision (locked): no Postgres.** Raw records are **JSON in Blob Storage** (the system of
> record); **Azure AI Search** is the queryable **read model** (vectors + server-side security trim).
> The demo explicitly shows **add / update / delete JSON + manual reindex, per data source.** Entity
> fields are specified in `MVP-PLAN.md` §6.

### 5.1 Storage layout — Blob (source of record)

**One JSON blob per record**, foldered by **data source** so each source can be reindexed
independently, in a single `sources` container:

```
sources/leaders/L1.json          sources/contacts/C1.json         sources/events/E-AUSA.json
sources/engagements/EX-003.json  sources/topics/T1.json           sources/messages/M-T1-v2.json
sources/afteractions/AA-drift.json                                sources/trips/<runId>.json …
```

Because there is **no loader/ETL step**, each blob **bakes in the envelope** the indexer maps to
filterable trim fields — `tenantId`, `source`, `aclGroups[]`, `sensitivity` — alongside the domain
fields. Geocoded `lat/lng` stays baked in at seed time (no runtime geocode).

| Source folder (`sources/…`) | Entity | In seed? |
| --------------------------- | ------ | -------- |
| `leaders/`      | Leader — Pool A (SME, level, home base, days-away budget)              | ✅ |
| `contacts/`     | Contact — Pool B (`status active\|prospect`, `source`; prospects have no `lastInteractionDate`) | ✅ |
| `events/`       | Event — travel anchors (`attendingContactIds[]`, `exhibitorProspectIds[]`, `topicIds[]` = the on-site/prospect rosters) | ✅ |
| `topics/`       | Topic — meeting subjects                                               | ✅ |
| `messages/`     | Message — approved per-topic talking points (versioned)               | ✅ |
| `engagements/`  | Engagement — meetings (contact × leaders × topic)                     | ✅ |
| `afteractions/` | AfterActionNote — Document-Intelligence-ingested notes (supporting)   | ✅ |
| `trips/` · `stops/` · `legs/` · `prebriefs/` | Runtime planner output                   | ✖ (written back at runtime, then reindexed) |

All records carry `tenantId` (reuse the tenant-scoping already in `server.ts`/middleware).

### 5.2 Indexing & reindex (Blob → indexer → AI Search)

**One AI Search index per capability** (`engagements`), populated by **per-source blob indexers** (all
writing the same index, distinguished by the `source` field). Each indexer:

- `parsingMode: "json"` — **one blob = one document**; maps `id` → a globally-unique index key
  (`contact_C1`, `event_E-AUSA`), so records from different sources never collide.
- attaches an **integrated-vectorization skillset** (`AzureOpenAIEmbeddingSkill`) that embeds
  `searchText` into `contentVector` **at index time** — no manual embedding code, no drift between add
  and vector.
- carries a **soft-delete deletion policy** — `SoftDeleteColumnDeletionDetectionPolicy`,
  `softDeleteColumnName: "IsDeleted"`, `softDeleteMarkerValue: "true"` (read from blob **metadata**).

**The search document — the flattened, indexable projection:**

| Field | Attribute | Purpose |
| ----- | --------- | ------- |
| `id`                                                    | **key**        | globally unique (`<entity>_<recordId>`) |
| `entityType`, `source`                                  | **filterable** | per-capability routing / **per-source reindex** |
| `tenantId`                                              | **filterable** | mandatory row trim (fail-closed) |
| `aclGroups` (`Collection(Edm.String)`)                  | **filterable** | group ACL trim via `search.in` |
| `sensitivity`                                           | **filterable** | role-gated need-to-know |
| `topicIds` (`Collection`)                               | **filterable** | topic-relevance narrowing |
| `searchText`                                            | **searchable** | keyword + semantic recall |
| `contentVector` (`Collection(Edm.Single)` + vectorizer) | **vector**     | hybrid / vector recall |
| `name, city, lat, lng, strategicValue, lastInteractionDate…` | retrievable | display only |

> ⚠️ The repo's existing query path has **two latent bugs** that make **every** trimmed query silently
> return `[]` — both must be fixed: `searchResumeContents` (`api/src/search/index.ts`) omits the
> `INDEX_NAME` arg to `new SearchClient(...)`, and the current `resume-facts` index sets **no** field
> `filterable: true`, so any `$filter` is rejected. (Functions-side `indexFactsToSearch` already passes
> the index name correctly; the bug is query/API-side.)

**Reindex demo (manual, per source):**

- **add / update** — create/edit the blob → **Run** that source's indexer (change-tracked by blob
  `LastModified`) → the doc appears/updates (re-embedded automatically).
- **delete** — `az storage blob metadata update … --metadata IsDeleted=true` → **Run** the indexer →
  the doc is removed from the index (hard-delete the blob later). Editing one JSON record and re-running
  one indexer is the on-stage "reindex per data source" beat.

### 5.3 Retrieval path (orchestrator → sub-agents → trim)

The chat host's model invokes the `engagements` capability, which runs a **Durable Functions retrieval
orchestrator** modeled on the repo's `ingestCandidateOrchestrator` (`functions/src/pipeline/`): it
**fans out** (`df.Task.all`) to per-capability **retrieval sub-agents**, each calling a
`search_facts`-style MCP tool (`capabilities/discovery`) that queries the index **security-trimmed**
(§5.4), then **fans in** to compose an answer from **only the returned, already-authorized** snippets.
The deterministic planner engine (§6) reads the same records for the feasibility math; the Maps MCP UI
app (§5.4) renders the trimmed result at fan-in.

**Temporary storage (in-flight):** the **Durable Task Hub** in `AzureWebJobsStorage` (queues + tables +
blobs) checkpoints each sub-agent's **return value** into orchestration history for deterministic
replay; large payloads overflow to blob; `cleanup-orchestrator` discards it after the run. Because each
sub-agent trims **before** it returns, this transient store only ever holds authorized data — the
filter is never re-applied to it.

### 5.4 Authorization & the security trim

**Keycloak** authenticates the **UI**; the **API / Express tier is the trust boundary** — and it is
**already wired**: `api/src/middleware/auth.middleware.ts` supports `AUTH_PROVIDER=keycloak`, verifies
the RS256 token against the realm JWKS, and maps claims (`keycloakClaimsToUser`) into a
**`SecurityContext { tenantId, userId, aclGroups[], roles[] }`**. Because a Keycloak token is **not** an
Azure OBO assertion, `oboAssertion` is left undefined → **downstream Azure (Search, Maps, OpenAI) is
reached with the API's managed identity** (the trusted-subsystem pattern). The `SecurityContext` is
forwarded to the Durable orchestrator as **immutable input** (Functions trust it only because they
authenticated the API's service token — `http-start.ts` / `validate-caller.ts`) and threaded into
**every** sub-agent's search call.

**Enforcement — `buildFactSecurityFilter(ctx)` in `capabilities/mcp-core/src/security.ts`:** the claims
become an OData `$filter` that **Azure AI Search evaluates server-side before returning any row** — for
keyword, semantic, and vector/hybrid queries alike:

```
$filter =  tenantId eq 'army'                                        ← mandatory; fail-closed if absent
       and aclGroups/any(g: search.in(g, '/army/g8,/army/g8/plans')) ← group ACL      (NET-NEW clause)
       [and topicIds/any(t: search.in(t, '…'))]                      ← optional narrowing
```

A second layer (`canReadSensitiveAttributes` + `isSensitiveFactKey`) redacts sensitive **fields** by
role/scope. The **LLM controls only the query text — never the `$filter`**, so prompt injection can
change what is *asked*, not what is *authorized*. Trimming happens **at retrieval, server-side — never**
by asking the model to drop rows.

**Two adjacent auth planes:**

- **Personal notes (stretch):** a **separate MCP client that authenticates with Entra ID** — its own
  token, fully **decoupled** from Keycloak (no cross-IdP brokering) — fetches per-user free-form notes
  (e.g. history of a past interaction) and folds them into the pre-brief. The API's OBO plumbing
  (`entra-token.ts`, `getOboToken`) already exists; the notes store must be one the user is
  **personally** authorized to read.
- **Maps render:** the **geospatial MCP UI app** (`capabilities/geospatial`) is invoked by the
  orchestrator **at fan-in, over already-trimmed data**, so it needs **no user identity**. Its server
  authenticates to Azure Maps with a **key** (`AZURE_MAPS_KEY`) / MI; the **raw key stays server-side**,
  the browser map control uses Azure Maps **AAD** auth (not the subscription key) with a CSP allowlist
  for `atlas.microsoft.com` (§10, §15).

---

## 6. The planner engine (`api/src/planner/`)

Pure, deterministic, unit-tested modules:

| Module         | Responsibility                                                                 |
| -------------- | ------------------------------------------------------------------------------ |
| `distance.ts`  | `haversineKm(a,b)`; `etaMinutes(a,b)` heuristic (ground vs. air)               |
| `score.ts`     | `stalenessNorm`, `valueNorm`, `topicRelevance`; `suggestionScore = product/weighted` |
| `suggest.ts`   | Given `(leader, anchor, window)` → candidate stops from **3 sources** — event **attendees** (travel≈0), **nearby** contacts, topic-matched **prospects** — ranked + tagged `re-engage\|initiate` / `on-site\|off-site` |
| `route.ts`     | `greedyOrder(anchor, stops)` nearest-neighbor (+ optional 2-opt); emits legs   |
| `conflicts.ts` | The 5 detectors (fit, double-book, travel, availability/budget, opportunity-cost) |
| `roi.ts`       | `tripRoi = Σ(suggestionScore) − (airfare + perDiem·days + timePenalty)`; budget check |

**ETA heuristic (tunable; the honest stand-in for real routing):**
- **Ground** when haversine ≤ ~500 km: `distanceKm / 90 kmh + 0.5 h` buffer.
- **Air** otherwise: `1.5 h` (airport/security) `+ distanceKm / 800 kmh + 1.0 h` arrival buffer.
- **Optional upgrade:** Azure Maps **Route Matrix** (same account/key) swaps in real drive times behind
  the same `etaMinutes()` interface — a one-file change, off by default.

**Suggestion score** = `stalenessNorm × valueNorm × topicRelevance` (per `MVP-PLAN.md` §5.1), filtered
by radius + availability; **fit is attached as a flag, never a filter**. Weights are config, and the
UI **shows the math** (the three factors per suggestion).

**Candidate sources & on-site scheduling (conference-as-magnet):** the suggester unions (a) event
**attendees** (`event.attendingContactIds`) — location = the venue, so **travel cost ≈ 0** and legs
are omitted; (b) **nearby** contacts within radius; (c) topic-matched **prospects**
(`event.exhibitorProspectIds`, `status='prospect'`) scored by `valueNorm × topicRelevance` with **no
staleness term** (the **initiate** path). On-site stops are packed into venue **time-slots** across the
event days by a simple slot scheduler (no travel legs between them); only **off-site** stops get
legs/ETAs.

**Conflict detectors (deterministic):**
1. **Fit** — `leader.domain ≠ contact.domain` → domain flag; `|Δlevel| ≥ 2` → level flag (both soft).
2. **Double-book** — stop time-window overlaps another stop / existing engagement for the leader.
3. **Travel-infeasible** — for consecutive stops, `arrive(next) < depart(prev) + etaMinutes(prev,next)`.
4. **Availability/budget** — stop outside `leader.availability`, or `Σ trip days > daysAwayBudget`.
5. **Opportunity-cost** — `tripRoi < threshold`, or a long leg serves a low-value stop while a
   high-value **nearby** cluster is unstaffed.

---

## 7. Tool & API surface

Every operation below is exposed as an **MCP tool** on the `engagements` capability — the **primary**
path: the host's model composes them, and each **user-facing** tool tags its result with
**`_meta.ui.resourceUri`** so the chat host renders the engagements widget. The same handlers are
**also** mounted as Express `/api/v1/*` routes to back the widget's **standalone-web** fallback (§9).
Tool names drop the path prefix (e.g. `planner/suggest` → tool `suggest`).

| Method & path                         | Purpose                                                            |
| ------------------------------------- | ----------------------------------------------------------------- |
| `POST /planner/suggest`               | `{leaderId, anchorId}` → **nudge cards** (nearby opportunities + extend-stay trade) |
| `POST /planner/build-itinerary`       | `{leaderId, anchorId, stopIds[]}` → ordered trip (legs, ETAs, conflicts, ROI) |
| `POST /planner/evaluate`              | `{trip}` (edited) → recomputed conflicts + ROI (for drag/edit)    |
| `GET  /planner/who-to-invite/:eventId`| Ranked contacts for an event (staleness × value × topic-relevance) |
| `GET  /planner/conference/:eventId`   | Roster + prospecting for an event anchor → **attendees** (on-site), exhibitor **prospects** (initiate), and a suggested **on-site slot plan** |
| `GET/POST/PATCH /trips[...]`          | Trip CRUD (draft→proposed→approved)                               |
| `POST /prebrief/:stopId`              | Generate a per-stop pre-brief (REUSE summary); `?send=true` → Graph `sendMail` (optional) |
| `POST /afteraction/:engagementId`     | Upload PDF → Document Intelligence extract → structure → consistency (REUSE version-diff) |
| `POST /seed`                          | (dev) write `DEMO-DATASET.md` records as **per-source JSON blobs** (envelope baked in); pre-geocode via Geospatial MCP in ≤25 chunks; then **Run each source indexer** |
| `POST /reindex/:source`               | (dev, optional) **Run** the named source's AI Search indexer — the on-stage add/update/delete-then-reindex beat |

---

## 8. Key data flows

**Seed (once, offline-prep):**
```
dataset JSON ─▶ seed ─▶ Geospatial MCP project_map_pins (×2 chunks) ─▶ cache lat/lng
             ─▶ write per-source JSON blobs (envelope baked in) ─▶ Run indexers ─▶ AI Search
```

**Answer a question (security-trimmed retrieval):**
```
host model ─▶ engagements capability ─▶ Durable retrieval orchestrator
   fan-out df.Task.all ─▶ per-capability search sub-agents
      each: search_facts(query, $filter = tenantId + aclGroups)   ← Keycloak SecurityContext
   fan-in ─▶ compose from trimmed snippets ─▶ Maps MCP UI render ─▶ widget
```

**Proactive nudge (demo entry point):**
```
open Trip tab / ask the host ─▶ suggest tool {leader, anchor}
   engine: filter nearby ∩ available ─▶ score ─▶ extend-stay trade vs. days-away budget
   ─▶ widget Trip tab nudge: "stay +2 days, batch these N — ROI ↑"  (+ model narration in chat)
```

**Build itinerary (accept the nudge):**
```
Trip tab "Build itinerary" CTA / model ─▶ build-itinerary tool
   engine: greedyOrder ─▶ legs+ETAs ─▶ conflicts ─▶ tripRoi ─▶ persist Trip (blob + reindex)
   ─▶ widget Trip tab: pins + leg polylines, timeline, ROI badge
```

**Conference roster & prospecting (magnet):**
```
event anchor ─▶ conference tool {eventId}
   engine: attendees(travel≈0) ∪ nearby ∪ topic-matched prospects ─▶ score/tag ─▶ on-site slot plan
   ─▶ widget Roster tab: "6 attending — engage on-site; 3 exhibitors — want intros?" + venue-day slot lane
```

**Edit / drag (interactive advisor):**
```
Trip tab: drag stop / add C6(Austin) ─▶ evaluate tool ─▶ conflict badges + recommendations (live)
```

**Per-stop pre-brief (supporting):**
```
Pre-brief tab: select stop / model ─▶ prebrief tool ─▶ summary(Azure OpenAI) over history + approved message
   ─▶ brief w/ citations ─▶ (optional) Graph sendMail to demo mailbox
```

**After-action + consistency (supporting, closes the loop):**
```
upload PDF ─▶ afteraction tool ─▶ Document Intelligence extract ─▶ structure
   ─▶ version-diff(actual vs. approved M-T1) ─▶ "on message ✅" / drift flag ─▶ feeds next pre-brief
```

---

## 9. UI architecture

The delivery surface is **one hybrid web + MCP App**: `capabilities/engagements/ui`, built with the
same React + Vite pattern as the repo's six existing capability UIs and bundled to a **single file**
(`vite-plugin-singlefile` + the ext-apps bundle) so it can be served as the
`ui://engagements-widget.html` resource with **no CDN/CSP escape**. The chat host renders it in an
iframe whenever a tool result carries `_meta.ui.resourceUri`.

**One widget, three tabs** (teams own tabs — see §4, `MVP-PLAN.md` §11):

- **Trip Planner ★ (T2):** the money moment. **`MapView` ported from `ui/src/MapView.tsx`**
  (azure-maps `atlas`, HtmlMarkers, bounds-fit) **+** a new **line layer** for legs
  (`atlas.layer.LineLayer` over a `DataSource`), pins colored by trip / stale-value; the proactive
  **nudge** + extend-stay math + "Build itinerary" CTA; **itinerary timeline** + unassigned-engagement
  rail; **conflict badges** + recommendations from `evaluate` rendered inline.
- **Conference Roster (T3):** for an event anchor — attendee list with **on-site / zero-travel**
  badges and an **on-site slot plan** lane (venue-day columns, no legs) as the **headline**; a small
  **prospects** strip (topic-matched exhibitors) with an **"Introduce"** CTA as a **secondary add-on**;
  plus the **who-to-invite** ranking.
- **Pre-brief / Consistency (T4):** per-stop **pre-brief** with citations; after-action **drift
  verdict** ("on message ✅" / flag). Supporting layer.

**Tool calling — official MCP Apps SDK:** the widget uses `@modelcontextprotocol/ext-apps` — the React
`useApp` hook (or the `App` class) manages the `ui/` postMessage handshake and delivers tool results
via `ontoolresult`, and user actions call server tools through the SDK. The server registers the tools
+ the widget resource with `registerAppTool`/`registerAppResource` (each user-facing tool tags
`_meta.ui.resourceUri`). The repo's hand-rolled `mcp-bridge.ts` is kept only as the **standalone-web**
fallback (HTTP JSON-RPC against the optional Express `/api/v1/*` surface, §7). Geocoding is baked in at
seed time, so the widget never calls the Geospatial MCP live.

**Text fallback (required):** every user-facing tool also returns a `content[]` text block (nudge
summary, roster list, brief) so hosts that don't render MCP UI apps still get a usable answer — the
demo degrades to chat-only, never to nothing.

**Host:** the demo runs **inside a web page** — the ext-apps **`basic-host`** reference shell
(decided) — which acts as the MCP host and embeds the widget in a **sandboxed iframe** via the official
SDK's host side. Because we control the host, MCP-App support is guaranteed; the text fallback still
covers any non-App renderer. The main open item is the widget's CSP allowlist for Azure Maps — see §15.

---

## 10. Azure services & configuration

| Service                      | Role                                   | Auth (demo → prod)                             |
| ---------------------------- | -------------------------------------- | ---------------------------------------------- |
| **Azure Maps**               | Geocode at seed (opt. Route Matrix)    | `AZURE_MAPS_KEY` (dev) → `AZURE_MAPS_CLIENT_ID` MI; `AZURE_MAPS_ENDPOINT` for Gov |
| **Azure OpenAI**             | Pre-brief prose, consistency, **+ embeddings** (integrated vectorization) | key (dev) → MI; `max_completion_tokens`        |
| **Azure Document Intelligence** | After-action PDF extract            | key or MI (`document-intelligence.ts` supports both) |
| **Blob Storage**             | JSON **source of record** (one blob/record, foldered by source) | **MI / RBAC** (shared-key disabled → `Storage Blob Data *`) |
| **Azure AI Search**          | **Read model**: per-source indexer + vectorizer skillset; query-time `$filter` trim | key (dev) → **MI**; OData `$filter` server-side |
| **App Service (Windows)**    | API host (iisnode; `PORT` is a pipe)   | —                                              |
| **App Service (static)**     | UI host (Vite `VITE_*` baked at build) | —                                              |
| **Azure Functions**          | Geospatial MCP (+ existing pipeline)   | anonymous MCP + bearer presence check          |
| **Keycloak**                 | **UI auth** (OIDC); origin of `SecurityContext` claims | `AUTH_PROVIDER=keycloak` (RS256 vs realm JWKS) — **already wired** |
| **Entra ID**                 | **Notes MCP client** (OBO); **optional** Graph `sendMail` | jose (API) / OBO (`entra-token.ts`); app-reg + Mail.Send (stretch) |

---

## 11. Security / IL5 posture

- **Managed identity everywhere in prod** (Maps, OpenAI, DI, **Blob**, **AI Search**) — no shared keys.
  Consistent with repo memories (storage shared-key disabled → RBAC; Maps via client-id MI).
- **Authorization = server-side trim, never LLM redaction.** Keycloak authenticates the UI; the **API
  is the trust boundary** (already wired) and mints a `SecurityContext`; retrieval applies an OData
  `$filter` (`buildFactSecurityFilter`) **inside AI Search before any row returns**, **fail-closed** on a
  missing tenant (§5.4).
- **Gov-cloud aware:** `AZURE_MAPS_ENDPOINT` (and OpenAI/DI endpoints) are configurable; the
  Geospatial `maps.ts` already parameterizes the cloud.
- **Demo shortcuts (explicitly scoped):** auth-bypass flag on the API; dev keys; unclassified
  synthetic data only. None of these touch the real **Keycloak/Entra/MI** code paths, which stay intact.
- **No secrets in source;** the pre-brief email (if enabled) sends only to a controlled demo mailbox.
- **Data sensitivity:** geocoding is coarse (city/region), matching the Geospatial tool's stated
  guidance; sensitive/home locations are out of scope.

---

## 12. Build sequence (maps to `MVP-PLAN.md` §11)

| Day | Platform (T1) | Trip Planner ★ (T2) | Conference Roster (T3) | Pre-brief (T4) |
| --- | ------------- | --------------------- | ---------------------- | ---------------------------- |
| 0   | Maps key + Azure OpenAI reachable; **OpenAI prose smoke** | — | — | — |
| 1   | **seed as per-source JSON blobs (envelope baked in) + pre-geocode** (pins); **AI Search index + per-source indexers + vectorizer skillset (Run/reindex)**; **Keycloak realm + `tenant_id`/groups mappers + `SecurityContext` at the API**; **retrieval-orchestrator scaffold**; **engagements capability scaffold + mcp-core `resources/read` (`ui://`) + stub tools tagged `_meta.ui`**; **widget shell** (tabs + ext-apps `App`/`useApp` + single-file + text fallback); **ext-apps `basic-host` shell**; publish **schemas + mocks** | scaffold Trip tab vs. stubs; canned nudge round-trips | scaffold Roster tab vs. stubs; canned roster | scaffold Pre-brief tab vs. stubs; canned pre-brief |
| 2   | real `distance/score/suggest` tools; trip persistence (**blob + reindex**); **wire `search_facts` live + `buildFactSecurityFilter` trim**; results tag `_meta.ui.resourceUri` | Trip-tab nudge v1 from real suggest | attendee list + who-to-invite v1 | pre-brief v1 (reuse `summary`) |
| 3   | `route/conflicts/roi/on_site_slot_plan` tools; leg-polyline data | ordering + 5 conflicts + ROI "shows the math"; drag/evaluate | on-site slot plan + prospecting one-liner | after-action DI → version-diff → **drift** |
| 4   | wire E2E; recommendation plumbing; _(opt)_ `sendMail` | integrate nudge→itinerary→ROI on map/timeline | Roster tab integrated | consistency view; loop feeds next pre-brief |
| 5   | freeze seed; harden; **run full E2E** | beat tests (planner beats) | beat tests (roster/invite, **1b**) | beat tests (pre-brief/drift); _(stretch)_ 2nd host |

**Contracts-first:** T1 publishes **tool schemas + the `_meta.ui` resource contract + mock responses**
by end of Day 1, so T2–T4 never block on T1's real tools. **Critical path:** T1 seed + pins + widget
shell + contracts (Day 1) → all three tabs. **Top prerequisite:** an Azure Maps key (dev, seed-time
only) + a reachable Azure OpenAI deployment for pre-brief prose + consistency. **Test strategy:** each
beat in `DEMO-DATASET.md` §7 (incl. **1b** conference roster) ships as a unit/integration test asserting
the expected flag/rank/ROI/verdict — a data tweak that breaks a beat fails CI, not the live demo.
**Cut-lines (star protected):** standalone-web fallback → real `sendMail` → Route Matrix →
live DI (pre-extracted fallback) → prospecting one-liner.

---

## 13. Risks & mitigations

| Risk                                             | Mitigation                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| Live geocode flakiness during the demo           | **Pre-geocode at seed**; demo path makes no Maps call             |
| ETA heuristic looks unrealistic                  | Calibrated buffers; optional **Route Matrix** for real drive times |
| Scope creep into a real optimizer                | Greedy + advisory only; solver explicitly out (§10 plan)          |
| App-reg/Mail.Send blocked in gov tenant          | Pre-brief **preview-first**; real `sendMail` is optional/stretch  |
| Web host must implement the MCP Apps host side    | **Start from the official SDK host utilities / ext-apps `basic-host`** (§9, §15); the **required text fallback** covers any non-App renderer |
| `mcp-core` serves tools only (no `resources/*`)   | **Net-new Day-1 task (T1):** add `resources/list`+`resources/read` for `ui://` + `_meta.ui` on tool results (§3, §12) |
| Data doesn't fire a beat                          | Beat-keyed unit tests (§12) catch it before rehearsal             |
| Trimmed query silently returns `[]`               | **Fix the 2 latent bugs (§5.2):** pass `INDEX_NAME` to `SearchClient`; add `filterable` trim fields; smoke-test a `$filter` on Day 1 |
| Deleted record lingers in the index               | **Soft-delete metadata policy** + Run indexer (§5.2); one-blob-per-record makes deletes per-doc |
| Over-broad access (claim not enforced)            | Server-side `$filter` **fail-closed** on missing tenant; **never** ask the LLM to drop rows (§5.4) |

---

## 14. Post-demo productization (noted, not in week 1)

- **Harden the `capabilities/engagements` MCP** (built in week 1) — tool auth, rate limits, richer
  server-side agent orchestration for hands-free planning; add **standalone-web / Teams / SharePoint
  embeds** of the same widget over the optional Express surface.
- **Live Graph reads** behind the existing adapter seam (`MVP-PLAN.md` §6.1): SharePoint lists,
  Outlook calendars, the Kanban — replacing the synthetic seed incrementally.
- **Azure Maps Route Matrix** for true multi-stop travel times; per-diem/airfare cost tables.
- Full auth/MI hardening and IL5 review; real Azure AI Search index for interaction history at scale
  (**see §16 for the scaling & data-labeling model**).

---

## 15. Open architecture questions

1. **Widget CSP allowlist** — the host shell is the ext-apps **`basic-host`** reference (decided).
   Confirm the `_meta.ui.csp` origins the widget needs — chiefly the **Azure Maps** `atlas` SDK +
   tile/style endpoints (and the Gov-cloud variants) — so the sandboxed iframe can load the map (§9, §10).
2. **Route realism** — ship with the ETA heuristic, or wire **Route Matrix** in week 1?
3. **Trip persistence granularity** — one `trips/<id>.json` blob with **embedded** stops/legs, vs.
   separate `stops/`+`legs/` blobs. Recommend **one embedded trip blob** (clean soft-delete + a single
   indexer Run per trip) unless the Kanban needs stop-level queries.
4. **Auth for the demo** — Keycloak is the decided UI IdP (**already wired**). Bypass flag, or a seeded
   demo user + realm groups through the **real Keycloak** path? Confirm realm + group→`aclGroups` seeding.

---

## 16. Scaling & data labeling (post-MVP, forward-looking)

The MVP is a one-week build with a one-week planning outlook; production is an **always-on** system
serving leaders / EAs / XOs who travel ~70% of the time, with data **pulled in and ETL'd continuously**
(deferred here — §14). Two rules keep that scalable and **modular**, so *new data that unlocks a new
capability is additive, never a refactor*.

### 16.1 Two orthogonal axes

- **Physical segmentation** — *what an agent is pointed at*: the **index** and its **data-source +
  indexer**. Governs relevance tuning, per-capability ACL, and reindex blast-radius.
- **Logical labeling** — *facets on every record*: the metadata agents filter/rank on and governance
  enforces. Governs retrieval, authorization, and **behavior** (e.g. cooldown).

Segmentation decides *where* a fact lives; labels decide *who sees it and how agents reason about it*.
Conflating them is the root of most scaling pain.

### 16.2 Segmentation — capability = index, source = label

- **One index per capability / agent** — `contacts`, `events`, `interactions`, `guidance` (messages),
  `signals` (news), `notes`. **Not** one mega-index (kills per-capability ACL + tuning), **not** one
  index per origin system.
  - **Modularity payoff:** a new capability = **new index + new retrieval sub-agent + register it with
    the orchestrator (§5.3)**. Existing capabilities are untouched — that is the whole point of the
    fan-out / fan-in shape.
- **Within an index, each origin system = its own AI Search data-source + indexer** (SharePoint list,
  Kanban, exhibitor directory, Outlook). `source` is a **label**, so one origin reindexes independently
  — the §5.2 add/update/delete loop, at scale.
- **Blob container / folder per source** is the ETL landing zone; the deferred "pull-in" (§14) lands
  here with **zero** downstream change.

### 16.3 Labeling — one consistent envelope on every record

Generalizes the §5 envelope (and the existing `tenantId / personId / sectionId / factKey` precedent in
the `resume-facts` index). Three tiers; **tiers 1–2 are identical for every source**, so anything ETL
pulls in is trim-able and governable on day one:

| Tier | Purpose | Fields |
| ---- | ------- | ------ |
| **Identity & provenance** | segmentation + change tracking | `id` (`<entityType>_<rid>`), `entityType`, `source`, `sourceRecordId`, `schemaVersion`, `ingestedAt`, `contentHash`, `IsDeleted` |
| **Governance** (the `$filter` trim, fail-closed) | who may see it | `tenantId`, `aclGroups[]`, `sensitivity`, `retentionClass` / `legalHold` |
| **Semantics & behavior** | agent match / rank / react | `topicIds[]`, `smeAreas[]`, `domain`, `geo` (`Edm.GeographyPoint`), `strategicValue`, `lastInteractionDate`, `validFrom` / `validUntil`, `freshnessTier`, **`nextEligibleDate` (derived)**, `lifecycleState` |

Every Tier-1/2 facet (and any behavior label an agent trims on) must be **`filterable`** in the index —
today's `resume-facts` has none, so *making the envelope filterable is itself part of "labeling"* (§5.2).

### 16.4 Stateless agents, state as labels — the cooldown pattern

The rule that makes behaviors like *"don't re-recommend a just-met high-value contact for X days"* both
correct and modular: **agents never remember; state lives as labels on the data.**

1. **Append-only `interactions` source** — every touch is an immutable `Interaction` event
   (`contactId`, `occurredAt`, `kind`, `topicId`), landed from Outlook / Kanban. Never mutated.
2. **A projection / enrichment step** (an ETL job or an AI Search skill) rolls the latest events into
   **derived labels** on the contact doc: `lastInteractionDate = max(occurredAt)` and
   `nextEligibleDate = lastInteractionDate + cooldownDays`.
3. **`cooldownDays` is policy-as-data** — a `CadencePolicy` record
   (`appliesTo {minStrategicValue | contactType | topicId}` → `cooldownDays`), so cadence
   (value-5 → 90d, value-2 → 270d) is a **data edit, not a deploy**.
4. **The contacts agent just filters / ranks** — `nextEligibleDate le <today>` to suppress, or return
   with a `cooldownRemainingDays` penalty so the contact is **shown-but-deprioritized** (advisory — the
   planner never hard-blocks, `MVP-PLAN.md` §4.1).

Because the label is recomputed on **reindex**, "a meeting happened → suppress for X days" is automatic,
auditable, and needs **no agent memory and no record mutation**. The same pattern models every derived
signal — `freshnessTier` (staleness), a `hot` topic flag, message `drift` — as a **projected label, not
agent logic**. New signal ⇒ new projection + one filter/rank clause.

### 16.5 Two rules that fall out of scale

- **Bitemporal labels** (`validFrom` / `validUntil` + `ingestedAt`) — with continuous ETL and 70%
  travel you need *as-of* pre-briefs ("what did we know on the brief date") and correct expiry of
  message versions / guidance. Model both **valid time** (when a fact is true) and **ingest time** (when
  we learned it).
- **No server-side joins in AI Search** — **denormalize** the hot labels an agent needs onto its own doc
  (project `nextEligibleDate` onto contacts); when a live cross-capability join is genuinely required,
  the **orchestrator** fans out (contacts + interactions agents) and joins at fan-in (§5.3).

### 16.6 Anti-patterns

- One **mega-index** for everything → no per-capability ACL, no relevance tuning, huge reindex
  blast-radius.
- **Index-per-origin-system** → join explosion; origin belongs as a `source` **label** inside a
  capability index.
- **Mutating records to hold state** → loses auditability and breaks as-of briefs; always **append +
  project**.
- **Derived-only / unlabeled facets** the index can't filter → the trim or behavior can't be enforced
  server-side; every governance + behavior label must be `filterable`.
