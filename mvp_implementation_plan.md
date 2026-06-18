# MVP Implementation Plan: Richer Agentic Workflow

## 0. Tech stack

- Frontend/API: React + Express
- Auth: Microsoft Entra ID integration with dev bypass and production `jose` JWT verification
- Orchestration: Azure Durable Functions
- Agent runtime: Durable Functions activities backed by deterministic heuristics first, then a self-hosted Azure OpenAI tool-calling loop behind the same activity boundaries. The managed Foundry Agent Service is intentionally avoided (IL2-only); see `mvp_architecture.md` Section 7.3.
- Modularization: organized as self-contained **capability modules** under `capabilities/`. Each capability bundles **1-2 MCP (Model Context Protocol) capability servers**, an **agent-framework runtime** (the self-hosted Azure OpenAI tool-calling loop), and an **MCP UI App**. Durable Functions owns durability/recurrence; MCP owns modular capability boundaries and interactive surfaces. MCP calls are request/response and never hold long-running state.
- MCP hosting: **IL5-authorized Azure Functions** over Streamable HTTP behind API Management, secured with Entra ID OAuth and managed identity. **Azure Container Apps is intentionally not used (IL2-only).** See `mvp_architecture.md` Section 7.4.
- Compliance target: **DoD SRG Impact Level 5 (IL5)** — IL5 posture is configuration, not a code fork (managed identity + sovereign-cloud endpoints + IL5 region). See `mvp_architecture.md` Section 7.
- Extraction: web snapshot flow, Azure AI Document Intelligence for documents, and schema-constrained extraction agents
- Storage: PostgreSQL JSONB as the current MVP source of truth; TO-BE storage moves large content to immutable artifacts with PostgreSQL metadata/manifests
- Search: Azure AI Search for facts, bullets, annotations, and relationship retrieval
- Temporal intelligence: observed temporal events, detected patterns, predicted future events, and recruiter alerts
- Maps: Azure Maps for UI pins/clusters over database records with location metadata

### 0.1 Capability module layout (IL5, modular reference)

Modular components live under `capabilities/`. Each capability is a self-contained, independently deployable module that bundles **1-2 MCP capability servers**, an **agent-framework runtime** (the self-hosted Azure OpenAI tool-calling loop), and an **MCP UI App**. A shared `capabilities/mcp-core` library provides the reusable MCP server helper, the IL5 identity/token helpers (managed-identity credential precedence + cloud-configurable scopes), and the agent loop — so each capability stays thin and every module follows the same IL5 pattern.

```text
capabilities/
  mcp-core/                     # shared: MCP server helper + agent loop + IL5 identity
  ingestion/
    mcp/
      acquisition/              # Functions-hosted MCP server (Streamable HTTP)
      extraction/               # Functions-hosted MCP server
    agent/                      # agent-framework: self-hosted Azure OpenAI tool-calling loop
    ui/                         # MCP UI App (hybrid web + MCP App)
    README.md
  quality/        { mcp/quality,       agent, ui }
  relationships/  { mcp/relationships, agent, ui }
  temporal/       { mcp/temporal,      agent, ui }
  geospatial/     { mcp/geospatial,    agent, ui }
  discovery/      { mcp/search,        agent, ui }
```

| Capability        | MCP servers             | Agent-framework role                     | MCP UI App                |
| ----------------- | ----------------------- | ---------------------------------------- | ------------------------- |
| **ingestion**     | Acquisition, Extraction | source triage + evidence extraction loop | Ingestion Console         |
| **quality**       | Quality/Citations       | citation + conflict guardrail loop       | Review Queue              |
| **relationships** | Relationships           | relationship inference loop              | Relationship Confirmation |
| **temporal**      | Temporal Intelligence   | event/pattern/prediction loop            | Prediction Review         |
| **geospatial**    | Geospatial              | location-normalize/geocode loop          | Map Pins                  |
| **discovery**     | Search/Discovery        | question -> filtered-search loop         | Resume + Diff             |

Deployment / reference rules:

- Each `mcp/<server>` is an IL5-authorized Azure Functions app (Streamable HTTP), deployable and versioned on its own behind API Management.
- Each `agent/` is the self-hosted Azure OpenAI tool-calling loop for that capability; it calls only its capability's MCP tools and never the IL2-only Foundry Agent Service.
- Each `ui/` is an MCP UI App that also runs standalone (hybrid pattern) and reaches the source of truth only through tools/resources + the API.
- Capabilities depend on `mcp-core` and `@greenhouse-resume-builder/shared` via npm workspaces; lift a capability folder out with `mcp-core` + `shared` to reuse it elsewhere.
- IL5 is configuration: managed identity (no keys), sovereign-cloud endpoints, IL5 region. Local dev keeps key/heuristic fallbacks.

---

## 1. Current implementation reality

The repository already has the right shape for agentic workflows, and the current workspace build passes across all packages:

- `api/` creates ingestion runs and exposes facts, bullets, diffs, annotations, relationships, search, stats, and health endpoints.
- `functions/src/pipeline/orchestrator.ts` coordinates ingestion with Durable Functions.
- `functions/src/activities/` contains agent-like activity slots for web/document acquisition, section extraction, summary generation, person dedup, resume building, persistence, and relationship inference.
- `shared/src/` defines the core entities: `Person`, `SourceDocument`, `ExtractionRun`, `FactVersion`, `BulletMapping`, `Annotation`, and `Relationship`.
- `ui/src/app.tsx` includes landing, candidate profile, search, diff, annotation, and relationship surfaces.
- `api/src/db/pg-client.ts` and `functions/src/persistence/index.ts` implement the PostgreSQL JSONB document-store path.
- `capabilities/` now contains build-clean MCP server, agent, and UI packages, with geospatial wired to live Azure Maps geocoding.

Important nuance: most current agents are heuristic implementations. The next architecture step is to keep the Durable Functions boundaries, but make the activities richer, model-backed, schema-validated, and evidence-grounded.

Still needing runtime validation or implementation:

- End-to-end local runtime validation across PostgreSQL, API, Functions, and UI.
- Search client/runtime compatibility validation against a real Azure AI Search service.
- File upload staging from the UI into Blob Storage/artifact manifests before Document Intelligence processing.
- Graph-style UI beyond suggested relationship confirm/reject.
- Temporal event extraction, recurrence detection, event prediction, and recruiter alert workflows.
- Production Azure Maps browser auth; the current geospatial MCP server and map projection path are implemented but still need production-hardening.
- Model-backed agent runtime evaluation and prompt contracts beyond the current deterministic/model-adapter mix.
- MCP capability depth: geospatial is wired; most other capability handlers still need delegation to real activity/API logic.

---

## 2. Target agentic workflow

```text
API creates ExtractionRun
        |
        v
Durable Orchestrator
  |
  +-- SourceTriageAgent
  |     chooses web/document routes and flags duplicates
  |
  +-- AcquisitionAgents
  |     WebSnapshotAgent
  |     DocumentIntelligenceAgent
  |
  +-- Parallel EvidenceExtractionAgents
  |     ExperienceAgent
  |     SkillsAgent
  |     EducationAgent
  |     SummaryAgent
  |
  +-- CitationGuardAgent
  |     checks every fact/bullet has evidence where possible
  |
  +-- ConflictQualityAgent
  |     flags low confidence, contradictions, missing fields
  |
  +-- PersonResolverAgent
  |     matches existing Person or returns review candidates
  |
  +-- ResumeBuilderAgent
  |     creates polished bullets with citation mappings
  |
  +-- RelationshipAgent
  |     suggests evidence-backed relationships
  |
  +-- TemporalEventAgent
  |     extracts dated events from sources/facts
  |
  +-- TemporalPatternAgent
  |     detects recurrence, seasonality, sequences, gaps
  |
  +-- EventPredictionAgent
  |     predicts likely future events with confidence/rationale
  |
  +-- RecruiterAlertAgent
  |     creates actionable notifications for recruiters
  |
  +-- LocationEnrichmentAgent
  |     normalizes/geocodes public or professional locations
  |
  +-- MapPinProjection
  |     exposes location-bearing database records as UI pins
  |
  +-- PersistAndIndex
        PostgreSQL JSONB + Azure AI Search
```

Design rule: the orchestrator coordinates state only. Any model calls, network calls, storage I/O, search I/O, and PostgreSQL writes must happen inside activities.

MCP boundary rule: activities call MCP capability-server tools instead of embedding capability logic; the orchestrator never calls MCP directly. Long-running work is fronted by an async job pattern (start → poll → fetch) over Durable Functions, and recurring work is driven by timer-triggered Durable orchestrations/entities. MCP tool calls stay request/response and never hold long-running state.

---

## 3. Recommended execution order

### Priority 1 — Define shared agent contracts and validation

**Targets:**

- `shared/src/interfaces.ts`
- new or existing shared helpers under `shared/src/`
- `functions/src/activities/*`

**Goal:**
Introduce common input/output envelopes so every richer agent returns structured, explainable, evidence-grounded results.

**Recommended contract additions:**

- `AgentExecutionContext`: `runId`, `tenantId`, `personId?`, `sourceDocumentIds`, `traceId`
- `EvidenceRef`: `sourceDocumentId`, `blobPath?`, `uri?`, `textSpan?`, `confidence`
- `AgentFinding`: `factKey`, `factValue`, `normalizedValue`, `sectionId`, `confidence`, `evidenceRefs`, `warnings`
- `AgentWarning`: `code`, `message`, `severity`, `sourceDocumentId?`
- `AgentReviewTask`: low-confidence fact, conflicting value, missing citation, possible duplicate person, relationship suggestion
- `TemporalMetadata`: `eventDate?`, `startDate?`, `endDate?`, `temporalGranularity`, `observedAt?`
- `TemporalEvent`, `EventPattern`, `EventPrediction`, `RecruiterAlert`
- `LocationMetadata`: `address?`, `city?`, `region?`, `country?`, `latitude?`, `longitude?`, `locationPrecision`, `locationConfidence`, `locationSource`
- `MapPin`: source record ID/type, coordinates, label, summary, confidence, date window, evidence links

**Acceptance criteria:**

- Agent outputs can be validated before persistence.
- Facts and bullets can be traced back to source evidence.
- Observed temporal events can be traced back to facts and source documents.
- Future-event predictions remain separate from observed facts and include rationale, confidence, and expiration.
- Map pins can be traced back to their source database records and evidence.
- Warnings and review tasks can be shown in the UI later.
- No model-specific types leak into the API or PostgreSQL JSONB data model.

---

### Priority 2 — Add a model-backed agent runtime adapter

**Targets:**

- `functions/src/activities/`
- new `functions/src/agents/` or `functions/src/services/agent-runtime.ts`

**Goal:**
Provide one reusable way for activities to call a model-backed agent while keeping deterministic fallback behavior explicit.

**Needed behavior:**

- Load agent configuration from environment variables.
- Call Azure OpenAI directly (or a compatible model endpoint) from activities only; the managed Foundry Agent Service is avoided for IL5 (IL2-only).
- Require JSON-schema-compatible output.
- Return explicit failure/warning payloads when the model service is unavailable; do not silently pretend success.
- Preserve current heuristic extractors as a local/dev fallback path.

**Acceptance criteria:**

- A section activity can choose `heuristic`, `model`, or `hybrid` execution mode.
- Model results are parsed, validated, and converted into shared agent findings.
- Invalid model output fails visibly or produces review warnings instead of being persisted as trusted facts.

---

### Priority 3 — Upgrade extraction agents

**Targets:**

- `functions/src/activities/experience-segment.ts`
- `functions/src/activities/skills.ts`
- `functions/src/activities/education.ts`
- `functions/src/activities/summary.ts`
- `mvp_ontology.md`

**Goal:**
Move from regex/keyword extraction to richer evidence extraction while retaining deterministic behavior for local development.

**Agent responsibilities:**

- **ExperienceAgent:** employers, titles, dates, locations, responsibilities, achievements, confidence, evidence.
- **SkillsAgent:** technical skills, soft skills, proficiency/context, evidence.
- **EducationAgent:** school, degree, field, dates, certifications, confidence, evidence.
- **SummaryAgent:** generate a grounded profile summary only from extracted facts.
- **TemporalEventAgent:** extract dated events such as conference presentations, publications, certifications, awards, media appearances, role changes, and education milestones.
- **LocationEnrichmentAgent:** normalize location strings and optionally geocode public/professional locations for map display.

**Acceptance criteria:**

- Each section agent emits structured findings with evidence refs.
- Dated findings include normalized temporal metadata.
- Location-bearing findings include normalized location metadata when available.
- The builder can consume the output without guessing field names.
- The UI can eventually expose confidence/warnings without another pipeline redesign.

---

### Priority 4 — Add citation, conflict, and quality agents

**Targets:**

- new activities under `functions/src/activities/`
- `functions/src/pipeline/orchestrator.ts`
- `functions/src/activities/builder-agent.ts`

**Goal:**
Make the workflow explainable and recruiter-safe before facts become resume bullets.

**Needed agents:**

- **CitationGuardAgent:** verifies that facts and bullets have source document support.
- **ConflictQualityAgent:** compares current extraction with prior facts and flags contradictions.
- **ReviewTaskAgent:** creates review tasks for low-confidence or conflicting data.

**Acceptance criteria:**

- Low-confidence facts are persisted with warnings/review status rather than hidden.
- BulletMappings include citation fact/source IDs.
- Builder output includes `warnings`, `metrics`, and `reviewTasks` or a documented equivalent.

---

### Priority 5 — Upgrade ResumeBuilderAgent

**Target:**

- `functions/src/activities/builder-agent.ts`

**Goal:**
Turn extracted facts into polished, recruiter-ready bullets without losing provenance.

**Needed behavior:**

- Generate section-specific bullets from validated facts.
- Preserve deterministic bullet IDs and signatures.
- Attach citations to every bullet.
- Include builder diagnostics: `warnings`, `dedupedCounts`, `groups`, `buildVersion`, `metrics`.
- Optionally tailor bullets to a job description later, but keep that out of the MVP unless requested.

**Acceptance criteria:**

- Bullets are explainable through `citationFactVersionIds` and `citationSourceDocumentIds`.
- Generated bullets do not introduce unsupported claims.
- Diffs still work through stable `bulletSignature` values.

---

### Priority 6 — Relationship agent and explicit relationship editing

**Targets:**

- `functions/src/activities/relationships.ts`
- `api/src/routes/relationships.ts`
- relationship repositories under `api/src/db/repo/`
- `ui/src/app.tsx` or a new relationship graph component

**Goal:**
Support both inferred and recruiter-authored relationships.

**Needed behavior:**

- RelationshipAgent suggests `shared_employer`, `worked_together`, or other configured relationship types with evidence.
- API supports:
  - create explicit relationship
  - update relationship type/status/evidence
  - delete explicit relationship
  - confirm/reject inferred relationship
- UI shows a graph-style view of people as nodes and relationships as edges.
- Recruiter changes are stored as explicit/auditable edges, not overwritten by future inference.

**Acceptance criteria:**

- Suggested edges remain human-confirmable.
- Explicit recruiter-created edges can be created, updated, and deleted.
- Relationship documents retain evidence and audit fields where applicable.
- PostgreSQL JSONB remains the MVP source of truth; a graph database remains optional unless multi-hop traversal becomes a core requirement.

---

### Priority 7 — Temporal pattern and event prediction agents

**Targets:**

- new temporal activities under `functions/src/activities/`
- `shared/src/interfaces.ts`
- `mvp_data_model.md`
- `mvp_ontology.md`
- `api/src/routes/` for prediction review endpoints
- `ui/src/app.tsx` or a new temporal insights component

**Goal:**
Detect historical temporal patterns and predict likely future candidate events with explainable confidence.

**Needed behavior:**

- Store observed `TemporalEvent` records derived from dated facts and source evidence.
- Detect `EventPattern` records by grouping temporal events by person and normalized recurrence key.
- Predict future events as `EventPrediction` records, not as facts.
- Compute confidence from:
  - number of observed events
  - cadence regularity
  - recency
  - source quality/evidence strength
  - event-name normalization strength
- Generate `RecruiterAlert` records for actionable medium/high-confidence predictions.
- Let recruiters accept, dismiss, snooze, or mark predictions as confirmed when evidence arrives.

**Example:**

```text
Observed:
  2022: Presented at ContosoConf
  2023: Presented at ContosoConf
  2024: Presented at ContosoConf

Pattern:
  annual conference presentation, usually September-October

Prediction:
  likely ContosoConf presentation in fall 2025
  confidence: 0.72
  rationale: three recent annual observations with similar event names
```

**Acceptance criteria:**

- Predictions are visibly labeled as predictions, not facts.
- Every prediction has evidence links, rationale, confidence, status, and expiration.
- Recruiter feedback is stored and suppresses repeated dismissed alerts.
- Low-confidence predictions remain searchable but do not trigger proactive alerts by default.

---

### Priority 8 — Azure Maps and map-pin UI

**Targets:**

- `ui/src/app.tsx` or a new map component
- `ui/package.json`
- `api/src/routes/` for map-pin endpoints
- `api/src/db/repo/` queries over location-bearing containers
- `shared/src/interfaces.ts`
- optional location enrichment activity under `functions/src/activities/`

**Goal:**
Show database records with location information as Azure Maps pins in the recruiter UI.

**Needed behavior:**

- Add Azure Maps to the UI.
- Provide a map tab or panel on the candidate profile and/or discovery page.
- Add an API projection endpoint that returns map pins from location-bearing records:
  - temporal events with venues/locations
  - employment facts with employer office/city data when available
  - education facts with school locations when available
  - relationship evidence tied to shared locations when available
- Normalize map pins into a common shape:
  - `id`
  - `sourceType`: `factVersion | temporalEvent | relationship | sourceDocument | eventPrediction`
  - `sourceId`
  - `personId`
  - `label`
  - `summary`
  - `latitude`, `longitude`
  - `locationPrecision`
  - `locationConfidence`
  - `eventDate` or date window when applicable
  - evidence IDs for drill-in
- Support filters:
  - person
  - source type
  - event type
  - date window
  - confidence band
  - relationship type
- Link pin popups back to the underlying facts/events/relationships/source documents.

**Azure Maps integration notes:**

- Use Azure Maps Web SDK in the React UI.
- Keep Azure Maps keys/config in environment variables.
- Consider server-side geocoding only for public/professional locations; avoid sending sensitive personal addresses to geocoding services unless product policy explicitly allows it.
- Store `locationPrecision` and `locationConfidence` so pins can be rendered as exact venue, city-level, region-level, or approximate.
- Prefer clustered pins for dense candidate/event views.

**Recommended API additions:**

- `GET /api/v1/map-pins`
- `GET /api/v1/insights/:personId/map-pins`
- optional `POST /api/v1/locations/geocode` for controlled server-side geocoding of approved public/professional locations

**Acceptance criteria:**

- A recruiter can view Azure Maps pins for records that have coordinates or approved geocodable locations.
- Pins are filterable and link back to evidence.
- The UI distinguishes exact pins from approximate city/region pins.
- Sensitive personal/home locations are not displayed precisely by default.
- Missing or ungeocodable locations do not break the candidate profile.

---

### Priority 9 — Search and discovery agent

**Targets:**

- `api/src/search/index.ts`
- `functions/src/persistence/index.ts`
- `mvp_search_indexes.md`
- future UI search/discovery panel

**Goal:**
Use Azure AI Search as the read model for facts, bullets, annotations, and relationships, then optionally add an agent that translates recruiter questions into filtered searches.

**Acceptance criteria:**

- Facts and bullets index reliably.
- Relationship and annotation indexing is either implemented or clearly scoped as follow-up.
- Temporal events and event predictions are indexed or explicitly scoped as follow-up.
- Location-bearing records can be searched or projected into map pins.
- Search results are explainable and link back to person, fact, bullet, relationship, temporal event, prediction, and source IDs.

---

### Priority 10 — Validation and operational readiness

**Targets:**

- package builds across `shared`, `api`, `functions`, and `ui`
- `docs/operational-runbook.md`
- `IMPLEMENTATION_STATUS.md`
- `README.md`

**Goal:**
Convert architecture intent into verified implementation knowledge.

**Acceptance criteria:**

- Workspace packages are either build-clean or have a short exact blocker list.
- Agent failures, low-confidence outputs, and malformed model responses are observable.
- Docs distinguish implemented behavior from planned richer-agent behavior.

---

### Priority 11 — Extract bounded-context MCP capability servers

**Targets:**

- new `capabilities/<capability>/mcp/<server>/` Functions apps (built on `capabilities/mcp-core`)
- `functions/src/services/agent-runtime.ts`
- `functions/src/activities/*`
- `shared/src/interfaces.ts`

**Goal:**
Modularize agent capabilities into independently deployable, IL5-hosted MCP servers without changing the Durable workflow contract.

**Recommended decomposition (start with the lowest-risk server first):**

- **Extraction server** (start here): `extract_experience`, `extract_skills`, `extract_education`, `generate_summary` — reuse the existing strict JSON schemas from `agent-runtime.ts` verbatim.
- **Acquisition server:** `triage_sources`, `fetch_web_snapshot`, `extract_document`, `normalize_text`.
- **Quality server:** `check_citations`, `detect_conflicts`, `create_review_tasks`.
- **Relationships server:** `infer_relationships`, `confirm_relationship`, `upsert_explicit_relationship`.
- **Temporal server:** `extract_events`, `detect_patterns`, `predict_events`, `create_alerts`.
- **Geospatial server:** `normalize_location`, `geocode`, `project_map_pins`.
- **Search server:** `search_facts`, `search_relationships`, `index_upsert`.

**Needed behavior:**

- Each tool keeps a strict JSON schema and the deterministic/heuristic fallback contract.
- Durable activities become thin MCP clients; the orchestrator still only coordinates.
- Persistence of the source of truth stays activity-bound (`PersistBuilderOutput`); MCP servers do not own direct PostgreSQL writes for canonical facts/bullets.
- Servers run on **IL5-authorized Azure Functions** over Streamable HTTP behind API Management, secured with Entra ID OAuth and managed identity (not Container Apps; see `mvp_architecture.md` Section 7.4).

**Acceptance criteria:**

- At least the Extraction server is implemented and called by its matching activity with zero behavior change vs. the in-process path.
- A server can be deployed and versioned independently of the Functions app.
- External hosts (VS Code/Copilot and any self-hosted IL5 Azure OpenAI agent loop) can call the same tools. The managed Foundry Agent Service is excluded (IL2-only).
- `tenantId`/provenance flows through tool calls for future doc-level security.

---

### Priority 12 — Async-job and recurring-task control plane over MCP

**Targets:**

- new MCP control-plane server/tools
- `functions/src/pipeline/http-start.ts`
- `functions/src/activities/cleanup-orchestrator.ts`
- new timer-triggered Durable orchestrations/entities under `functions/src/`

**Goal:**
Expose long-running and recurring work through MCP without moving durable state into MCP.

**Needed behavior:**

- **Async job pattern** for long-running runs:
  - `start_ingestion(sources) -> { runId }` (Durable `startNew`)
  - `get_ingestion_status(runId) -> { status, personId? }`
  - `get_ingestion_result(runId) -> { facts, bullets, warnings }`
  - emit MCP progress notifications when the host supports them.
- **Recurring work** stays in Durable Functions (extend the existing 6-hour `cleanupStaleRuns` pattern):
  - nightly temporal-prediction recompute + stale-prediction expiry
  - periodic re-snapshot of watched URLs (change detection → new `ExtractionRun`)
  - search-index consistency sweeps
  - optional per-candidate `CandidateMonitor` Durable Entity tracking watched sources and last-checked timestamps
- **Control-plane tools only:** `list_scheduled_jobs`, `trigger_reindex`, `refresh_predictions(personId)`.

**Acceptance criteria:**

- No MCP tool call holds long-running state; all durability lives in Durable Functions.
- A recruiter/host can start a run, poll it, and fetch results entirely through MCP tools.
- Recurring jobs run on a schedule and are observable/triggerable through the control plane.
- Recurring re-snapshots create new versioned `ExtractionRun`s rather than mutating prior runs.

---

### Priority 13 — Ship recruiter surfaces as MCP UI Apps

**Targets:**

- `ui/` (hybrid web + MCP App)
- new MCP UI resource registration per app
- relevant capability/control-plane servers from Priorities 11–12

**Goal:**
Surface each recruiter aspect as an embeddable MCP UI App that also runs standalone, reusing the existing React UI.

**Recommended apps (start with a net-new one to avoid regression):**

- **Prediction Review** (start here — net-new, no existing surface to regress): accept / snooze / dismiss predicted events.
- **Review Queue:** triage low-confidence facts, conflicts, and missing citations.
- **Relationship Confirmation:** suggestion cards + graph; confirm/reject/create edges.
- **Map Pins:** Azure Maps pins/clusters with filters and evidence drill-in.
- **Ingestion Console:** submit sources and watch long-running run progress.
- **Resume + Diff:** single-page cited resume and version diffs.

**Needed behavior:**

- Each app registers a UI resource and remains usable standalone (hybrid pattern).
- Apps read/write only through MCP tools/resources and the existing API, not directly against PostgreSQL.
- Long-running progress uses the async-job tools from Priority 12.

**Acceptance criteria:**

- At least the Prediction Review app renders inside a supporting host and standalone.
- Apps reuse existing React components/views where one already exists.
- No app bypasses the capability/control-plane servers to reach the source of truth.

---

## 4. UI/API changes required for the richer workflow

Recommended API additions:

- `POST /api/v1/relationships`
- `PATCH /api/v1/relationships/:relationshipId`
- `DELETE /api/v1/relationships/:relationshipId`
- `GET /api/v1/insights/:personId/review-tasks`
- `GET /api/v1/insights/:personId/temporal-events`
- `GET /api/v1/insights/:personId/event-predictions`
- `PATCH /api/v1/event-predictions/:eventPredictionId`
- `GET /api/v1/alerts`
- `PATCH /api/v1/alerts/:alertId`
- `GET /api/v1/map-pins`
- `GET /api/v1/insights/:personId/map-pins`
- optional `GET /api/v1/insights/:personId/agent-runs`

Recommended UI additions:

- relationship graph view: people as nodes, relationships as edges
- explicit relationship editor
- low-confidence fact/review-task queue
- evidence drawer for a bullet or fact
- candidate timeline view
- predicted events panel with confidence bands and rationale
- recruiter alert queue for likely upcoming events
- Azure Maps view with pins/clusters for location-bearing records
- map pin popup with links to evidence and source records
- agent diagnostics panel for admins/devs

Recommended MCP additions:

- Capability modules under `capabilities/` (each = 1-2 MCP servers + agent-framework + MCP UI App): ingestion, quality, relationships, temporal, geospatial, discovery — IL5-hosted on Azure Functions (Streamable HTTP, Entra ID OAuth, managed identity, behind API Management; not Container Apps)
- Async-job tools fronting Durable Functions: `start_ingestion`, `get_ingestion_status`, `get_ingestion_result`
- Recurring control-plane tools: `list_scheduled_jobs`, `trigger_reindex`, `refresh_predictions`
- MCP UI Apps (hybrid web + MCP App): Ingestion Console, Review Queue, Relationship Confirmation, Prediction Review, Map Pins, Resume + Diff

---

## 5. Guardrails for implementation

- Do not put model calls, PostgreSQL writes, Blob writes, Search writes, or HTTP fetches inside the Durable orchestrator body.
- Keep agent output schema-constrained and validation-first.
- Treat citations and evidence as first-class data, not optional display fields.
- Keep recruiter overrides authoritative over inferred suggestions.
- Keep recruiter prediction feedback authoritative over repeated agent alerts.
- Never persist a predicted future event as an observed fact unless evidence confirms it.
- Treat map pins as projections over source records, not independent facts.
- Do not display exact personal/home locations by default; prefer coarse location display for sensitive data.
- Preserve PostgreSQL JSONB as the MVP system of record while moving large payloads toward artifact manifests and immutable storage.
- Do not introduce a graph database until relationship traversal/path-finding becomes a product requirement.
- Keep deterministic local/dev fallback behavior explicit and visible.
- Keep Durable Functions as the only owner of durability, checkpointing, recurrence, and long-running state; MCP tool calls stay request/response and never hold that state.
- Do not call MCP from the orchestrator body; activities are the MCP clients, and persistence of canonical facts/bullets stays activity-bound.
- Secure every MCP server with Entra ID OAuth and propagate `tenantId`/provenance through tool calls.
- Keep MCP tool schemas identical to the existing strict-JSON agent contracts so validation and fallback behavior are preserved.
- Keep MCP UI Apps working standalone (hybrid pattern); apps reach the source of truth only through tools/resources and the API.

---

## 6. Definition of success for the richer-agent pass

A strong pass should:

1. Add shared agent contracts and validation.
2. Upgrade at least one section agent to the hybrid heuristic/model-backed pattern.
3. Add citation/quality warnings to the builder flow.
4. Add explicit relationship CRUD design or implementation.
5. Add temporal event/prediction design or implementation.
6. Add Azure Maps/map-pin design or implementation.
7. Extract at least one bounded-context MCP capability server (start with Extraction) and call it from its matching activity with no behavior change.
8. Ship at least one MCP UI App (start with Prediction Review) and/or the async-job control plane over Durable Functions.
9. Produce concrete build/type validation findings.
10. Leave `mvp_architecture.md`, `mvp_ingestion_pipeline.md`, `mvp_data_model.md`, `mvp_ontology.md`, `mvp_search_indexes.md`, `IMPLEMENTATION_STATUS.md`, and `README.md` aligned with verified reality.
