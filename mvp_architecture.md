# MVP Architecture: Automated Resume Builder (Azure + M365)

> **Deployment target:** this architecture is designed to run under **DoD SRG Impact Level 5 (IL5)** in Azure Government/DoD regions, while the *same build* also runs in Azure Commercial. The agent and MCP layers are intentionally **modular** so each capability (an agent, an MCP capability server, the identity/network patterns) can be adopted independently as a reference for more complex systems. All IL5 specifics are consolidated in **Section 7**, and the IL5 service authorization status (verified Feb 2026) is summarized in the map in Section 7.2.

## 1. Product goals (MVP)
- Internal recruiters use a web app to ingest candidate sources:
  - Public web URLs (employer profile/news pages)
  - Uploaded documents: PDF, DOCX, images
- Each ingestion runs a richer **agentic workflow**:
  - source triage
  - evidence-grounded section extraction
  - citation and quality checks
  - person resolution
  - resume bullet generation
  - relationship inference
  - temporal pattern detection and event prediction
  - recruiter review support
- Extracted information becomes **versioned facts** with **dated runs** and **diffs**.
- Resume builder renders a **single-page resume** with **citations per bullet**.
- Recruiters can add **simple annotations (comments)** anchored to extracted facts.
- System infers **relationships** (e.g., shared employer) and shows **suggestion cards** for recruiter confirmation.
- Recruiters can create, update, and delete explicit relationships while inferred relationships remain human-confirmable.
- System extracts **temporal events** and predicts likely future events with confidence, evidence, and recruiter-facing alerts.
- Recruiters can view database records with location metadata as **Azure Maps pins**, including candidate events, employers, education, and other public/professional locations.
- Search supports facts, bullets, annotations, and relationship entities; relationship browsing works both ways.

## 2. Key architectural decisions
- **Cosmos DB** is the system of record for:
  - People (deduped), SourceDocuments, ExtractionRuns
  - Versioned FactVersions, BulletMappings, Annotations
  - Relationships and their statuses (suggested/confirmed/rejected)
  - TemporalEvents, EventPatterns, EventPredictions, and RecruiterAlerts
- **Azure Blob Storage** stores raw inputs:
  - Uploaded files
  - Web page snapshots
  - Optional extracted artifacts (normalized text, intermediate JSON)
- **Azure AI Document Intelligence** parses uploaded PDFs/DOCX/images.
- **Web ingestion** stores snapshots and extracts text via a text extraction/cleaning pipeline.
- **Azure Functions (Durable Functions)** orchestrate async ingestion and section agents.
- **Agent activities** are the main extension point:
  - deterministic Durable orchestrator coordinates workflow state
  - side-effecting/model-backed work runs inside activities
  - each agent returns structured JSON, confidence, evidence references, temporal metadata, warnings, and suggested next actions
- **Model-backed agent runtime** uses **Azure OpenAI directly** (tool/function calling) behind a single runtime adapter, preserving the current activity names as stable boundaries. The managed **Microsoft Foundry Agent Service is intentionally avoided** because it is not DoD IL5-authorized (IL2 only); agents are **self-hosted on Durable Functions** instead (see Section 7.3).
- **MCP (Model Context Protocol) modularization** exposes agent capabilities as independently deployable **capability servers** (tools + resources) and recruiter-facing surfaces as **MCP UI Apps**:
  - **Durable Functions owns durability, checkpointing, recurrence, and long-running orchestration state.**
  - **MCP owns modular capability boundaries (tools/resources) and interactive surfaces (UI Apps).**
  - MCP tool calls are request/response and are **not** durable; long-running state stays in Durable Functions and is surfaced through an async job pattern (start → poll → fetch), never a single open tool call.
  - The same activity contracts (e.g. `ExtractMvpExperienceSegment`, `InferRelationshipsForMatchingPersons`) remain the stable boundary; activities become thin clients that call MCP tools, and external agent hosts can call the same tools directly.
- **Azure Maps** powers map visualization for records with normalized location metadata; pin data is served by the API from Cosmos/Search read models.
- **Azure AI Search** indexes:
  - Facts/bullets for hybrid keyword/vector retrieval
  - Annotations for comment search
  - Relationships for entity/edge search
  - Temporal events and event predictions for recruiter discovery and alerts
  - Location-bearing records for map filtering and discovery
- **Entra ID (Microsoft Entra ID) only** for sign-in (tenant-level auth for MVP). Issuer/authority/JWKS settings are **cloud-configurable** (Azure Commercial or Azure Government `login.microsoftonline.us`) so the same build authenticates in either cloud.
- **Managed identity everywhere:** services authenticate with `DefaultAzureCredential` (no account/API keys) in IL5 deployments; keys remain only as a local-dev convenience (see Section 7.5).
- **Doc-level security** is planned for later by consistently storing `tenantId` and provenance metadata.
- **Agent governance (Agent Governance Toolkit):** every tool call can pass through an optional **in-process policy + audit gate** that adopts the Microsoft **Agent Governance Toolkit (AGT)** policy schema and denial semantics — constraining *what* an agent may do (not just *what* it can reach), recording a tamper-evident audit trail, and attributing actions to an agent identity. Disabled by default, IL5-hosted as app code, with a seam to adopt the official AGT SDK (see Section 7.13).

## 3. Agentic workflow architecture

```text
Recruiter
  |
  v
+-----------------------------+
| React + Vite UI             |
| - ingest sources            |
| - review bullets/facts      |
| - annotate evidence         |
| - confirm inferred edges    |
| - create/edit/delete edges  |
| - review event predictions  |
| - map pins with Azure Maps  |
| - search and browse graph   |
+--------------+--------------+
              |
              v
+-----------------------------+
| Express API                  |
| - auth                       |
| - ingestion requests         |
| - facts/bullets/diffs       |
| - annotations                |
| - explicit relationships    |
| - temporal predictions      |
| - map pin projection        |
| - search/stats              |
+------+----------------------+
      |
      | starts runId
      v
+--------------------------------------------------------------+
| Durable Functions: IngestCandidateOrchestrator               |
|                                                              |
|  deterministic coordinator only                              |
|  no direct model calls, storage writes, or network I/O        |
|                                                              |
|  +--------------------+                                      |
|  | Source Triage      |  classify uploads/URLs, route tools   |
|  +---------+----------+                                      |
|            |                                                 |
|  +---------v----------+                                      |
|  | Acquisition Agents |  web snapshots + document parsing     |
|  +---------+----------+                                      |
|            |                                                 |
|  +---------v-----------------------------------------------+  |
|  | Parallel Evidence Extraction Agents                    |  |
|  | - Experience Agent: roles, employers, dates, evidence   |  |
|  | - Skills Agent: skills, proficiency, evidence           |  |
|  | - Education Agent: schools, degrees, dates, evidence    |  |
|  | - Summary Agent: profile summary from extracted facts   |  |
|  +---------+-----------------------------------------------+  |
|            |                                                 |
|  +---------v----------+    +-------------------------------+ |
|  | Citation Guard     |    | Conflict/Quality Agent        | |
|  | evidence coverage  |    | low confidence, contradictions| |
|  +---------+----------+    +---------------+---------------+ |
|            |                               |                 |
|            v                               v                 |
|  +--------------------+    +-------------------------------+ |
|  | Person Resolver    |    | Resume Builder Agent          | |
|  | match or needs     |    | cited bullets + section shape | |
|  | recruiter review   |    |                               | |
|  +---------+----------+    +---------------+---------------+ |
|            |                               |                 |
|            +---------------+---------------+                 |
|                            v                                 |
|  +--------------------+    +-------------------------------+ |
|  | Relationship Agent |    | Temporal Event/Pattern Agents | |
|  | inferred edges     |    | future events + confidence    | |
|  +---------+----------+    +---------------+---------------+ |
|            |                               |                 |
|            +---------------+---------------+                 |
|                            v                                 |
|  +--------------------------------------------------------+  |
|  | Persist + Index + Alert Activities                    |  |
|  | Cosmos DB + Azure AI Search + recruiter notifications |  |
|  +--------------------------------------------------------+  |
+--------------------------------------------------------------+
      |                               |
      v                               v
+-----------------------------+   +-----------------------------+   +-----------------------------+
| Cosmos DB                   |   | Azure AI Search             |   | Azure Maps                  |
| source of truth             |   | retrieval/read model        |   | UI map rendering/geocoding  |
| - persons                   |   | - facts                     |   | - map controls              |
| - sourceDocuments           |   | - bullets                   |   | - pins/clusters             |
| - extractionRuns            |   | - relationships             |   | - optional geocoding        |
| - factVersions              |   | - annotations               |   +-----------------------------+
| - bulletMappings            |   | - temporal/map records      |
| - annotations               |   +-----------------------------+
| - relationships             |
| - temporalEvents            |
| - eventPatterns             |
| - eventPredictions          |
| - recruiterAlerts           |
+-----------------------------+
```

## 4. End-to-end flow (MVP)
1. Recruiter submits an ingestion request in the web UI.
2. App creates an `ExtractionRun` in Cosmos DB and persists `SourceDocuments` metadata.
3. Durable Orchestrator executes agent activities:
  - **Source Triage Agent** classifies inputs and selects acquisition tools.
  - **Acquisition Agents** fetch public URLs, store snapshots, stage uploads, and call Document Intelligence.
  - **Evidence Extraction Agents** run in parallel for Summary, Experience, Skills, and Education using the resume ontology.
  - **Citation Guard Agent** verifies every extracted fact and generated bullet has source evidence where possible.
  - **Conflict/Quality Agent** flags low-confidence facts, contradictory values, missing citations, and schema drift.
  - **Temporal Event Agent** extracts dated events such as conference presentations, publications, certifications, awards, role changes, and education milestones.
4. Section agents produce:
  - Candidate structured facts + bullet text candidates
  - Evidence references to SourceDocuments/extraction outputs
  - Confidence, warnings, and review recommendations
5. Person resolution/dedup uses a **Person Resolver Agent**:
  - System matches existing Person entities (system person-entity resolution)
  - Recruiter can override by selecting an existing Person
6. **Resume Builder Agent** creates recruiter-ready bullets and maps each bullet to source facts/citations.
7. Persist latest **FactVersions** and **BulletMappings**.
8. Compute diffs vs prior latest facts (bullet-level diffs recommended MVP).
9. **Relationship Agent** produces `Relationship(status=suggested)` edges with evidence.
10. **Temporal Pattern Agent** groups historical events, detects recurrence patterns, and creates `EventPrediction(status=suggested)` records with confidence.
11. Recruiters can confirm/reject inferred edges or create/update/delete explicit relationship edges.
12. Recruiters can review, accept, snooze, or dismiss predicted future events.
13. **Location Enrichment / Map Pin Projection** normalizes location-bearing records into map pins when coordinates or geocodable public/professional locations exist.
14. Index upsert into Azure AI Search.

## 5. Agent catalog

| Agent | Responsibility | Tools/data | Output |
|-------|----------------|------------|--------|
| Source Triage Agent | Classify source type, choose extraction route, detect duplicates | SourceDocument metadata, content hash | source plan, warnings |
| Web Acquisition Agent | Fetch public pages, clean text, snapshot source | HTTP fetch, Blob Storage | snapshot metadata, text blocks |
| Document Acquisition Agent | Stage uploads and extract text/layout | Blob Storage, Document Intelligence | extracted text/layout, source refs |
| Experience Agent | Extract employers, titles, dates, locations, accomplishments | text blocks, ontology | experience facts + evidence |
| Skills Agent | Extract skills, proficiency, context | text blocks, ontology | skills facts + evidence |
| Education Agent | Extract schools, degrees, dates | text blocks, ontology | education facts + evidence |
| Summary Agent | Generate grounded profile summary | extracted facts | summary fact + bullet candidate |
| Citation Guard Agent | Check fact/bullet evidence coverage | facts, bullets, source refs | validation findings |
| Conflict/Quality Agent | Detect contradictions and low-confidence areas | current/prior facts | warnings, recruiter review tasks |
| Person Resolver Agent | Match or propose candidate person identity | persons, facts, source metadata | personId or match candidates |
| Resume Builder Agent | Compose polished bullets with citations | validated facts, ontology | BulletMappings |
| Relationship Agent | Infer shared-employer or other relationships | persons, facts, relationships | suggested Relationship edges |
| Location Enrichment Agent | Normalize/geocode public or professional location strings | facts, temporal events, Azure Maps geocoding | location metadata + map pin candidates |
| Temporal Event Agent | Extract dated candidate events from sources | text blocks, facts, ontology | TemporalEvents with evidence |
| Temporal Pattern Agent | Detect recurring or sequential patterns | TemporalEvents, FactVersions, prior runs | EventPatterns + confidence |
| Event Prediction Agent | Predict likely future events and timing windows | EventPatterns, source history, confidence rules | EventPredictions + rationale |
| Recruiter Alert Agent | Prioritize predicted events for recruiter review | EventPredictions, annotations, alert history | recruiter alerts |
| Recruiter Review Agent | Prioritize review work and explain uncertainty | annotations, warnings, facts | review queue/suggestions |
| Search/Discovery Agent | Translate recruiter questions into filtered retrieval | Azure AI Search, Cosmos refs | explainable search results |

## 6. MCP modularization and MCP UI Apps

The agent catalog above is **logical**. MCP is how those agents are **packaged, deployed, reused, and surfaced**. The Durable orchestrator already enforces the boundary MCP wants — coordinate-only orchestrator, side effects in activities behind a single agent runtime adapter — so capabilities lift cleanly into MCP capability servers without changing the workflow contract.

### 6.1 Design principle

- **Durable Functions owns durability:** checkpointing, replay, fan-out/fan-in, recurrence, and long-running orchestration state.
- **MCP owns modularity:** bounded-context capability servers (tools + resources) and interactive surfaces (UI Apps).
- **MCP calls are request/response and stateless;** they must never hold long-running state. Long-running work is fronted by an async job pattern; recurring work is fronted by a control-plane only.
- **Cosmos DB remains the single source of truth.** MCP servers read/write through the same repositories and persistence activities; they do not introduce a competing store.

### 6.2 Capability server decomposition

Group tools by bounded context so each server scales, versions, deploys, and is secured independently. Each server is backed by capabilities that already exist (or are already targeted) in the codebase.

| MCP server | Tools | Resources | Backed by (today / target) |
|------------|-------|-----------|----------------------------|
| **Acquisition** | `triage_sources`, `fetch_web_snapshot`, `extract_document`, `normalize_text` | source snapshots | `FetchAndSnapshotWebSources`, `StoreUploadsAndExtract`, Document Intelligence; `SourceTriageAgent`/`NormalizeText` (target) |
| **Extraction** | `extract_experience`, `extract_skills`, `extract_education`, `generate_summary` | resume ontology | `modelExtract*` in `agent-runtime.ts`, section activities |
| **Quality/Citations** | `check_citations`, `detect_conflicts`, `create_review_tasks` | `review-tasks://{personId}` | `CitationGuardAgent`, `ConflictQualityAgent`, `ReviewTaskAgent` (target) |
| **Graph/Relationships** | `infer_relationships`, `confirm_relationship`, `upsert_explicit_relationship` | `relationships://{personId}` | `InferRelationshipsForMatchingPersons`, relationship routes |
| **Temporal Intelligence** | `extract_events`, `detect_patterns`, `predict_events`, `create_alerts` | `predictions://{personId}`, `alerts://{tenantId}` | `ExtractTemporalEvents`, `DetectTemporalPatterns`, `PredictFutureEvents`, `CreateRecruiterAlerts` (target) |
| **Geospatial** | `normalize_location`, `geocode`, `project_map_pins` | `map-pins://{personId}` | `LocationEnrichmentAgent` + map-pin projection (target) |
| **Search/Discovery** | `search_facts`, `search_relationships`, `index_upsert` | — | `api/src/search`, `functions/src/persistence` |

Notes:
- **Person resolution and resume building** can be exposed as tools (`resolve_person`, `build_resume`), but **persistence of the source of truth stays activity-bound** (`PersistBuilderOutput`) so writes remain inside the durable boundary.
- Tools keep the **same strict JSON schemas** already used by the model adapter (e.g. the `{"experience":[...]}` contract), so existing validation/fallback behavior is preserved.

### 6.3 MCP UI Apps

Recruiter-facing aspects become embeddable **MCP UI Apps** that also run standalone, so the existing React investment in `ui/` carries over (hybrid web + MCP App).

| MCP UI App | Purpose | Reuses |
|------------|---------|--------|
| **Ingestion Console** | Submit sources, watch long-running run progress, recent runs | landing flow |
| **Review Queue** | Triage low-confidence facts, conflicts, and missing citations | facts view + new |
| **Relationship Confirmation** | Suggestion cards + graph; confirm/reject/create edges | relationship view |
| **Prediction Review** | Accept / snooze / dismiss predicted future events | new (temporal) |
| **Map Pins** | Azure Maps pins/clusters with filters and evidence drill-in | new (maps) |
| **Resume + Diff** | Single-page cited resume and version diffs | profile/diff views |

### 6.4 Long-running work over MCP (async job pattern)

Single ingestion runs and batch recomputes can exceed request/response lifetimes, so MCP fronts Durable Functions rather than executing the work itself:

```text
start_ingestion(sources)        -> { runId }          (Durable startNew)
get_ingestion_status(runId)     -> { status, personId? }
get_ingestion_result(runId)     -> { facts, bullets, warnings }
```

- Mirrors the existing `POST /ingestion-requests` → `GET /:runId/status` contract.
- Emit **MCP progress notifications** for in-flight feedback when the host supports it; never depend on a tool call staying open for minutes.

### 6.5 Recurring work over MCP (control plane only)

Recurrence is already proven in-repo by the 6-hour `cleanupStaleRuns` timer. Extend that pattern; MCP exposes only the **control plane**, not the schedule executor:

- **Timer-triggered Durable orchestrations:** nightly temporal-prediction recompute + stale-prediction expiry, periodic re-snapshot of watched URLs (change detection → new `ExtractionRun`), search-index consistency sweeps.
- **Durable Entities:** per-candidate long-lived state (e.g. a `CandidateMonitor` tracking watched sources and last-checked timestamps).
- **Eternal orchestrations** (`continueAsNew`): unbounded monitoring loops.
- **MCP control-plane tools:** `list_scheduled_jobs`, `trigger_reindex`, `refresh_predictions(personId)`.

### 6.6 Hosting and security (IL5)

- **Host:** an **IL5-authorized compute** service — Azure Functions, App Service, AKS, or Container Instances. **Azure Container Apps is intentionally not used: it is IL2-only and not IL5-authorized.** Pick one host per capability server for independent scaling.
- **Gateway:** front the servers with **API Management (IL5)** for OAuth, rate limiting, and centralized logging to Azure Monitor.
- **Transport:** Streamable HTTP over TLS, **inside the VNet/Private Link boundary** (remote; never stdio, never public).
- **Identity:** **managed identity** (`DefaultAzureCredential`) for all service-to-service calls; **Microsoft Entra ID OAuth** for user/agent callers, with cloud-configurable issuers; propagate `tenantId`/provenance for future doc-level security.
- **Governance:** optionally wrap each tool with the **policy + audit gate** (`governServer`/`governTool` from `mcp-core`) so a capability server enforces an Agent Governance Toolkit policy regardless of caller; denied calls return an `isError` result and are audited (see Section 7.13).
- **Consumers:** VS Code/Copilot, the internal Durable activities, and any **self-hosted IL5 agent host** (an Azure OpenAI tool-calling loop) call the same servers. The managed **Foundry Agent Service is not a consumer** under IL5 (IL2-only); agentic routing is performed by the self-hosted loop while Durable keeps replay safety. See Section 7 for the full IL5 model.

### 6.7 Topology

```text
+-------------------------------------------------------------+
| Agent hosts (IL5; no Foundry Agent Svc - IL2 only)          |
| VS Code / Copilot  |  self-hosted OpenAI lp  |  internal     |
+------------+----------------------+-------------------------+
            |                      |
            | calls tools          | renders UI Apps
            v                      v
+-----------------------------+   +-----------------------------+
| MCP capability servers      |   | MCP UI Apps                 |
| (IL5 host + Entra MI)       |   | Ingestion / Review / Graph  |
| Acquisition                 |   | Prediction / Map / Resume   |
| Extraction                  |   +--------------+--------------+
| Quality                     |                  |
| Relationships               |                  |
| Temporal                    |                  |
| Geospatial                  |                  |
| Search                      |                  |
+--------------+--------------+                  |
            ^  | tools                            |
 activities |  |                                  |
            |  v                                  v
+-----------------------------+   +-----------------------------+
| Durable Functions           |   | Cosmos DB + Azure AI Search |
| orchestration + timers +    |-->| source of truth + read model|
| entities (durability)       |   |                             |
+-----------------------------+   +-----------------------------+
```

## 7. DoD IL5 compliance architecture (modular reference)

This section makes the system deployable under **DoD SRG Impact Level 5 (IL5)** and is written as a **modular reference**: each subsection is a self-contained pattern (agent host, MCP host, identity, network, data protection) that another team can lift independently when building more complex systems. Sections 5 and 6 define *what* the agents and MCP servers are; this section defines *how* they run compliantly.

### 7.1 Design intent — IL5 as configuration, not a fork
- The codebase stays **cloud-agnostic**: one build runs in Azure Commercial or Azure Government/DoD.
- IL5 posture is selected by **configuration** — managed identity instead of keys, sovereign-cloud endpoints, and an IL5 region — never by branching code.
- Every module follows a **credential-precedence rule**: if a key/connection string is supplied, use it (local dev); otherwise acquire a token via `DefaultAzureCredential` (managed identity = the IL5 path).

### 7.2 Service authorization map (verified Feb 2026 audit scope)

Only services carrying a DoD **IL5** provisional authorization may process IL5 data. The map is scoped to the agent/MCP/data footprint of this system.

| Layer | Service | IL5 | Notes |
|-------|---------|-----|-------|
| Model | **Azure OpenAI** | ✅ (also IL6) | Tool/function calling = native agent primitive |
| Agent host | **Azure Functions** (Durable) | ✅ (also IL6) | Current orchestrator/agent loop |
| Agent/MCP host | **App Service** | ✅ | Alternate host |
| Agent/MCP host | **AKS / Container Instances** | ✅ (also IL6) | Container host |
| Gateway | **API Management** | ✅ (also IL6) | AI/MCP gateway: auth, throttle, log |
| Parsing | **Document Intelligence** | ✅ | Foundry *Tool* API |
| Retrieval | **Azure AI Search** | ✅ (also IL6) | Hybrid/vector index |
| System of record | **Cosmos DB** | ✅ (also IL6) | |
| Raw storage | **Blob Storage** | ✅ (also IL6) | |
| Secrets | **Key Vault** | ✅ (also IL6) | |
| Identity | **Microsoft Entra ID** | ✅ | Gov authority/issuers |
| Maps | **Azure Maps** | ✅ | |
| Telemetry | **Azure Monitor / Sentinel** | ✅ | |
| — | **Azure Container Apps** | ❌ IL2 only | **Do not host MCP here** — use Functions/AKS/ACI |
| — | **Microsoft Foundry portal + Agent Service** | ❌ IL2 only | **Do not use hosted Agents** — self-host the loop |
| — | **Microsoft Copilot Studio** | ❌ IL4 max | Not IL5 |
| — | **Azure AI Content Safety** | ❌ IL2 only | Use Azure OpenAI built-in content filtering |

**Key nuance — Foundry is split.** The Foundry *portal and Agent Service* are IL2-only, but the **Foundry Tools APIs** (AI Search, Document Intelligence, Speech, Vision, Language, Translator) are IL5. This system consumes those APIs directly and never routes through the Foundry agent/portal layer.

### 7.3 The IL5 agent pattern (self-hosted, not managed)

Because the Foundry Agent Service is not IL5, agents are implemented as **self-hosted orchestration over Azure OpenAI tool-calling** — which is exactly the existing boundary:

- **Durable Functions** owns the loop, state, replay, fan-out/fan-in, and recurrence.
- **Azure OpenAI** provides reasoning + tool/function calling; the runtime adapter issues tool calls and validates strict-JSON results.
- **MCP capability servers** are the tool surface the loop (and external IL5 agent hosts) call.

```text
            (no Foundry Agent Service - IL2 only)
                          X
Durable Functions loop ------> Azure OpenAI (IL5)
        |  tool calls                ^
        v                            | function-calling results
MCP capability servers (IL5 compute) +
        |
        v
IL5 data plane (Cosmos / Search / Blob / Document Intelligence)
```

This preserves agentic behavior (planning, tool selection, multi-step extraction) while staying entirely on IL5-authorized services.

### 7.4 IL5 MCP hosting

MCP is a protocol, not an Azure service, so it never appears on the authorization list. An MCP server is IL5 only when **all three** hold:

1. **Hosted on IL5 compute** — Functions, App Service, AKS, or Container Instances. **Not Container Apps.**
2. **Every tool target is IL5** — Cosmos, AI Search, Blob, Document Intelligence, Key Vault.
3. **Data stays in the boundary** — managed identity + Private Link/VNet; no egress to commercial endpoints.

Front the capability servers with **API Management (IL5)** as the MCP/AI gateway for OAuth, rate limiting, and request logging into Monitor.

### 7.5 Identity and secrets (no keys)
- All service-to-service auth uses **managed identity** via `DefaultAzureCredential`; account/API keys are omitted in IL5 deployments.
- **Microsoft Entra ID** is cloud-configurable: issuer prefixes, JWKS URI, and authority host are environment-driven (commercial vs. `login.microsoftonline.us`).
- Any unavoidable secrets live in **Key Vault (IL5)** with RBAC + soft-delete/purge protection.
- The API auth middleware **fails closed**: unverified tokens are rejected unless an explicit local-dev bypass flag is set.

### 7.6 Network isolation
- All PaaS data/AI services are reachable only through **Private Endpoints (Azure Private Link)**; public network access disabled.
- Compute runs in a **VNet** (Functions Premium/ASE, App Service VNet integration, or AKS) with egress controlled by **Azure Firewall**/NSGs.
- MCP transport is **Streamable HTTP over TLS** inside the VNet/Private Link boundary — never stdio, never public.

### 7.7 Data protection and provenance
- **Customer-managed keys (CMK)** for Cosmos, Storage, and AI Search where required (mandatory in US Gov regions; see 7.9).
- Encryption in transit (TLS 1.2+) and at rest everywhere.
- The existing **`tenantId` + provenance** metadata becomes the basis for IL5 data segmentation and future doc-level security trimming in AI Search.

### 7.8 Content safety and guardrails
- Standalone **Azure AI Content Safety is not IL5**; use **Azure OpenAI's built-in content filtering** (part of the IL5 Azure OpenAI service) for input/output moderation.
- Keep the existing **Citation Guard** and **Conflict/Quality** agents as deterministic guardrails — they run in IL5 compute and add evidence-grounding independent of any model service.

### 7.9 Regions
- **US DoD regions** (US DoD Central / US DoD East): IL5 **by default**.
- **US Gov regions** (US Gov Arizona / Texas / Virginia): IL5 requires **CMK + compute isolation** (dedicated hosts / isolation configuration) per Microsoft's IL5 isolation guidance.

### 7.10 Cloud-configurable endpoints (implemented)

The code selects cloud by environment variable, so a single artifact targets either cloud:

| Setting | Commercial | Government / DoD |
|---------|------------|------------------|
| Storage suffix | `core.windows.net` | `core.usgovcloudapi.net` |
| Search suffix | `search.windows.net` | `search.azure.us` |
| OpenAI/Cognitive token scope | `cognitiveservices.azure.com/.default` | `cognitiveservices.azure.us/.default` |
| Document Intelligence audience | (default) | `https://cognitiveservices.azure.us` |
| Entra authority host | `login.microsoftonline.com` | `login.microsoftonline.us` |
| Entra issuer prefixes | `sts.windows.net/`, `login.microsoftonline.com/` | `login.microsoftonline.us/`, `sts.windows.net/` |

Cosmos, OpenAI, and Document Intelligence endpoints are supplied as full per-cloud URLs (`*.documents.azure.us`, `*.openai.azure.us`, `*.cognitiveservices.azure.us`).

### 7.11 Modular reuse

Each box is independently adoptable so other teams can build more complex systems on the same patterns:
- **Capability-server module** — a bounded-context MCP server (tools + resources) deployable on its own to IL5 compute, swappable without touching the orchestrator.
- **Agent-runtime module** — the Azure OpenAI tool-calling adapter (credential precedence + strict-JSON validation) reusable by any agent loop.
- **Identity module** — `DefaultAzureCredential` precedence + cloud-configurable Entra settings.
- **Network module** — Private Link + VNet + APIM gateway blueprint.
- **Durability module** — Durable orchestration/entities/timers for any long-running or recurring agent work.
- **Governance module** — the Agent Governance Toolkit policy + audit gate (`governedToolCaller` for agent-side, `governServer`/`governTool` for server-side) wrapping any tool call, with a structured `governance.toolkit/v1` policy and a seam to the official AGT SDK.

A new system reuses the contracts (strict-JSON tool schemas, async job pattern, control-plane recurrence) and replaces only the domain logic inside each capability server.

### 7.12 IL5 reference topology

```text
                         Recruiter / Agent host (Entra OAuth, IL5)
                                    |
                          API Management (IL5 gateway)
                                    |  Private Link
        +---------------------------+---------------------------+
        |                           |                           |
   Express API (IL5)         Durable Functions (IL5)       MCP capability servers
   App Service/Functions     self-hosted agent loop        Functions / AKS / ACI (IL5)
        |                           |   tool calls               |
        |                           v                            |
        |                   Azure OpenAI (IL5)                   |
        |                   built-in content filter              |
        +---------------------------+---------------------------+
                                    | managed identity + Private Link
                                    v
   Cosmos DB | Blob Storage | AI Search | Document Intelligence | Key Vault  (all IL5, CMK)
                                    |
                          Azure Monitor / Sentinel (IL5)

  Region: US DoD (IL5 default) or US Gov (IL5 + CMK + compute isolation)
  Excluded (IL2-only): Container Apps, Foundry portal/Agent Service, Content Safety, Copilot Studio
```

### 7.13 Agent governance (Agent Governance Toolkit)

Managed identity (§7.5) controls *which services* an agent can reach; it does not constrain *what the agent does* once connected. The **Agent Governance Toolkit (AGT, https://microsoft.github.io/agent-governance-toolkit/)** adds that missing layer — per-tool-call **policy enforcement**, **agent identity** ("which agent did this"), and a **tamper-evident audit trail** — which maps directly onto the evidence an IL5 ATO needs (OWASP Agentic AI Top 10, NIST AI RMF, SOC 2).

**Where it plugs in.** The self-hosted agent pattern (§7.3) funnels every tool call through two chokepoints, so governance is a thin wrapper at each:
- **Agent-side gate** — wrap the loop's `callTool` with `governedToolCaller` (or `governedMcpToolCaller(serverUrl)`); every model-driven tool call is policy-checked before dispatch and a denied call raises `GovernanceDenied`.
- **Server-side gate** — wrap each MCP tool handler with `governTool` / `governServer`, so a capability server enforces policy regardless of which agent calls it; a denied call returns an `isError` tool result.

Both live in `capabilities/mcp-core/src/governance.ts` and reuse the existing `tenantId`/`traceId` provenance already threaded through `ToolCallContext`.

**How it runs (IL5).** AGT is *app code / a library* — like MCP itself it never appears on the FedRAMP/IL5 service list, so the §7.4 rule applies: host on IL5 compute, evaluate **in-process**, keep data in the boundary.
- **Provider** — the default `local` provider evaluates an AGT `governance.toolkit/v1` policy (`governance/policy.yaml`) in-process: priority-ordered rules with `deny` / `require_approval`, using a **safe membership/regex matcher (no expression `eval`)** so the gate can never become an injection sink. A documented seam (`GOVERNANCE_PROVIDER=agt-sdk`) lets you back it with the official `@microsoft/agent-governance-sdk` once that package is vendored and IL5-reviewed — the same "swap in the official SDK later" approach used for the MCP transport (§6.x).
- **Audit** — each decision is written as a **hash-chained** record (integrity-linked to the prior entry); the default sink logs it, and in production the sink targets **Azure Monitor / IL5 storage** for a queryable, tamper-evident trail.
- **Posture** — **disabled by default** (`GOVERNANCE_ENABLED` unset) so local dev and existing servers are unchanged; **fail-closed** (deny) on evaluation error; the YAML parser is an *optional* dependency loaded only when the gate is enabled.

```text
self-hosted loop / MCP host
        |  callTool(name, args)   /   tools/call
        v
  [ governance gate ] --evaluate--> policy (governance.toolkit/v1, in-process)
        | allow              \--deny / require_approval--> GovernanceDenied / isError
        v                                       |
  tool executes (MCP server / data plane)        +--> hash-chained audit --> Azure Monitor (IL5)
```

| Setting | Default | Purpose |
|---------|---------|---------|
| `GOVERNANCE_ENABLED` | `false` | Master switch; off = pass-through (no behavior change) |
| `GOVERNANCE_POLICY_PATH` | `governance/policy.yaml` | Policy document (AGT `governance.toolkit/v1`) |
| `GOVERNANCE_PROVIDER` | `local` | `local` in-process evaluator, or `agt-sdk` seam |
| `GOVERNANCE_FAIL_OPEN` | `false` | Keep fail-closed (deny) on evaluation error |

> AGT is an evolving open-source toolkit with **no independent IL/FedRAMP authorization of its own**; it is vendored and reviewed as application code. The in-process `local` provider keeps the IL5 review surface minimal until the official SDK is adopted.

## 8. Azure component map
### Web app/API
- **Azure App Service** (or equivalent):
  - UI for candidate pages, facts, diff view, annotation CRUD, relationship suggestions, explicit relationship editing, temporal prediction review, and Azure Maps map pins
  - API endpoints currently implemented around ingestion, bullets/facts, diffs, annotations, relationships, search, stats, and health; temporal prediction and map-pin endpoints are target additions
  - The landing-page ingestion UI flow is partially wired; upload staging, auth/header behavior, runtime verification, and any remaining UI/API contract drift should still be validated

### Authentication
- **Microsoft Entra ID** using MSAL/OIDC
- App maps authenticated users to Cosmos `User` records.

### Async orchestration
- **Azure Durable Functions**:
  - Orchestrator: `IngestCandidateOrchestrator(runId)`
  - Source-reviewed activity usage currently includes names such as:
    - `StoreUploadsAndExtract`
    - `FetchAndSnapshotWebSources`
    - `ExtractMvpExperienceSegment`
    - `ProcessMvpSkillsSection`
    - `ProcessEducationSection`
    - `ProcessSummarySection`
    - `ResumeBuilderCandidateMatches`
    - `ResumeBuilderAgent`
    - `PersistBuilderOutput`
    - `InferRelationshipsForMatchingPersons`
    - `UpdateExtractionRunStatus`
  - Target temporal activities:
    - `ExtractTemporalEvents`
    - `DetectTemporalPatterns`
    - `PredictFutureEvents`
    - `CreateRecruiterAlerts`
  - Target richer-agent activities should keep the same orchestration boundary pattern:
    - orchestrator coordinates
    - activities call model/tool services
    - activities return schema-validated payloads
    - persistence/indexing remains activity-bound
  - A separate build/runtime verification pass should still confirm that every referenced activity is registered and triggerable as named

### MCP capability servers and UI Apps
- **IL5-authorized compute (Azure Functions, App Service, AKS, or Container Instances)** hosts the bounded-context MCP capability servers (Acquisition, Extraction, Quality, Relationships, Temporal, Geospatial, Search) over **Streamable HTTP**, secured with **Microsoft Entra ID OAuth** and **managed identity**, behind **API Management**. **Azure Container Apps is not used (IL2-only).**
- Durable activities call MCP tools as thin clients; external hosts (VS Code/Copilot and any **self-hosted Azure OpenAI agent loop**) call the same tools directly. The managed **Foundry Agent Service is excluded (IL2-only)**.
- Tool calls optionally pass through the **Agent Governance Toolkit policy + audit gate** (`mcp-core` governance module): in-process policy evaluation with hash-chained audit to Azure Monitor, hosted as IL5 app code and disabled by default (see Section 7.13).
- MCP UI Apps (Ingestion Console, Review Queue, Relationship Confirmation, Prediction Review, Map Pins, Resume + Diff) are served as hybrid web + MCP App surfaces reusing the existing React UI.
- Long-running runs are fronted by an async job pattern (start → poll → fetch); recurring jobs are driven by timer-triggered Durable orchestrations/entities and surfaced only through a control plane.

### Storage
- **Blob Storage**
  - `raw/` uploads
  - `web-snapshots/` html/text snapshots
  - `artifacts/` normalized text/intermediate json
- **Cosmos DB**
  - Containers for Persons, SourceDocuments, ExtractionRuns, FactVersions, BulletMappings, Annotations, Relationships, TemporalEvents, EventPatterns, EventPredictions, RecruiterAlerts

### AI services
- **Azure AI Document Intelligence**
  - Parse PDFs/DOCX/images
- **Azure OpenAI** (IL5-authorized; used directly, **not** via the IL2-only Foundry Agent Service)
  - Model-backed extraction, reasoning, validation, relationship inference, temporal pattern detection, event prediction, and recruiter-review agents
  - Agents use strict JSON schemas and evidence-first prompts, and rely on **Azure OpenAI built-in content filtering** for guardrails (standalone Azure AI Content Safety is not IL5)
  - The individual **Foundry Tools APIs** consumed here (Document Intelligence, Azure AI Search) are IL5-authorized; only the Foundry portal/Agent Service orchestration layer is excluded
- **Azure Maps**
  - UI map rendering for database records with coordinates/location metadata
  - Optional geocoding for public/professional locations such as conference venues, schools, employer offices, and event locations
  - Pin clustering, filtering, and popup summaries in the recruiter UI
- **(Optional later) Embeddings** for vector search
  - Use Azure OpenAI embeddings or integrated vectorization in Azure AI Search

### Search
- **Azure AI Search** intent docs mention indexes for facts, annotations, and relationships
- Target search design should include temporal event and prediction indexes so recruiters can search for "upcoming likely conferences" or "candidates with recurring annual presentations"
- Target search/design should expose location-bearing records for map filtering, but Cosmos remains the source of truth for pin provenance.
- Current source-reviewed implementation appears centered on a `resume-facts` index, while annotation and relationship search remain more architectural intent than verified runtime behavior

## 9. Temporal intelligence model

Temporal intelligence separates **observed events** from **predicted events**:

```text
Source evidence
   |
   v
FactVersions with dates
   |
   v
TemporalEvents
  e.g. "Presented at ContosoConf 2022"
       "Presented at ContosoConf 2023"
       "Presented at ContosoConf 2024"
   |
   v
EventPatterns
  cadence: annual
  confidence: based on event count, date regularity, source quality, recency
   |
   v
EventPredictions
  e.g. "Likely to present at ContosoConf 2025"
  predictedWindow: 2025-09-01 to 2025-10-31
  confidence: 0.72
  rationale + evidence links
   |
   v
RecruiterAlerts
  review / accept / snooze / dismiss
```

Rules:
- Predictions are never treated as facts unless later confirmed by evidence; recruiter action changes prediction status but does not create observed facts by itself.
- Every prediction must include evidence event IDs, a rationale, a confidence score, and an expiration/review window.
- Confidence should decrease when evidence is stale, cadence is irregular, or event names/sources are weakly matched.
- Recruiter decisions should be stored so future agents can avoid repeatedly surfacing dismissed predictions.

## 10. Azure Maps / geospatial UI model

Map rendering is a **UI/read-model projection**, not a new source of truth.

```text
Cosmos location-bearing records
  - FactVersions with location fields
  - TemporalEvents with event location/venue
  - Relationships with evidence tied to locations
  - SourceDocuments with public source URLs/metadata
        |
        v
Location Enrichment / Map Pin Projection
  - normalize location text
  - attach latitude/longitude when available
  - optionally geocode public/professional locations with Azure Maps
  - preserve confidence, precision, and provenance
        |
        v
GET /api/v1/map-pins
        |
        v
React UI + Azure Maps
  - pins and clusters
  - filters by person, event type, confidence, date window, source type
  - popup links back to facts/events/relationships/source docs
```

Rules:
- Only show pins for records with explicit coordinates or geocodable public/professional locations.
- Store or return `locationPrecision` and `locationConfidence` so the UI can distinguish exact venues from city/region-level locations.
- Avoid surfacing exact personal/home addresses unless product policy explicitly allows it; prefer coarse city/region display for sensitive candidate-provided locations.
- Every pin must link back to its source record and evidence so recruiters can understand why it appears.

## 11. Data ownership and provenance
- Every FactVersion links to:
  - `extractionRunId`
  - one or more SourceDocument IDs (evidence)
- BulletMappings link to the exact FactVersions used to render a bullet.
- Relationships link to evidence FactVersions/SourceDocuments when inferred; explicit recruiter-created relationships store creator/update metadata and status.
- TemporalEvents link to observed FactVersions/SourceDocuments.
- EventPredictions link to EventPatterns and observed TemporalEvents; they do not replace observed facts.
- Map pins link to their source record IDs and evidence; coordinates should carry source, precision, and confidence.
- This enables:
  - citations per bullet
  - diffs that reference changed evidence
  - relationship review and auditability
  - prediction explanations and recruiter notification auditability
  - map-pin provenance and safe location display

## 12. MVP→future security planning
- MVP uses tenant-level visibility for recruiters.
- Future doc-level authorization requires:
  - permission metadata per SourceDocument
  - propagation to indexed records
  - enforcement via Azure AI Search document-level access control or security trimming filters.

---

# Implementation Artifact Index
See additional files in uploads directory:
- `mvp_ontology.md`
- `mvp_data_model.md`
- `mvp_search_indexes.md`
- `mvp_ingestion_pipeline.md`
- `mvp_implementation_plan.md`
