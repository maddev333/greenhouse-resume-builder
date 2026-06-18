# AGENT_TASKS.md

## Current Handoff

**Status reviewed:** 2026-06-18
**Build verification:** `npm run build --workspaces` passes across API, Functions, shared, UI, MCP core, all capability MCP servers, agents, and capability UIs.
**Target architecture source:** `TOBE_ARCHITECTURE.md` remains the north-star document for tenant cells, governed MCP tools, artifact manifests, lineage, and PostgreSQL as metadata/control plane.

The repository is no longer a Cosmos-based MVP scaffold. The code now uses PostgreSQL JSONB document tables for the MVP control/data store, managed identity credential precedence for Azure services, a build-clean Durable Functions ingestion pipeline, MSAL/Entra API auth, MCP capability packages, optional governance gating, and a working geospatial MCP projection surface.

## Current Project State Snapshot

### Implemented and build-clean

- Monorepo workspaces are configured and build successfully.
- API routes are wired for ingestion, insights, annotations, relationships, persons, search, stats, and health.
- API persistence uses `api/src/db/pg-client.ts` plus JSONB repositories under `api/src/db/repo`.
- Functions persistence uses `functions/src/persistence/index.ts` with the same JSONB table model.
- Durable orchestrator coordinates activity calls, uses replay-guarded logging, and keeps persistence/indexing I/O behind activities.
- Builder artifacts use deterministic fact IDs and person-aware deterministic bullet IDs.
- Auth middleware verifies Entra tokens with `jose` when configured, fails closed otherwise, and exposes the validated token for OBO-capable downstream calls.
- API service credentials support OBO or managed identity. Azure services use keys only when explicitly supplied for local/dev convenience.
- Search code builds, creates/uses the `resume-facts` index, applies tenant filtering, and redacts sensitive facts unless caller claims permit them.
- Main UI consumes the current API contracts, including flat bullet responses and `/insights/:personId/differences`.
- Geospatial MCP `project_map_pins` geocodes supplied location records and the main UI can render map pins for location-bearing facts.
- MCP capability package layout exists for ingestion, quality, relationships, temporal, geospatial, and discovery.
- `capabilities/mcp-core` includes identity helpers and optional governance wrappers.

### Implemented but not runtime-verified end to end

- Landing page ingestion creation, polling, recent runs, and candidate navigation against a real running API + Functions + PostgreSQL stack.
- Function starter protection and API-to-Functions service token behavior in the intended hosting environment.
- Azure AI Search index creation, document upsert, OData filters, tenant trimming, and redaction against a real service.
- Document Intelligence/Blob upload behavior for non-text files with real Azure credentials.
- Azure Maps browser auth for production. Local map rendering can still depend on a build-time subscription key.

### Target/scaffolded only

- Temporal event extraction, recurrence detection, predictions, recruiter alerts.
- Petabyte-scale immutable artifact lake, artifact manifests, lineage records, tenant-cell routing, and bounded MCP excerpt/cursor/job contracts.
- Most non-geospatial capability MCP handlers are still scaffolds or thin boundaries awaiting real activity/API integration.

## Guidance For The Next Coding Agent

1. Treat `IMPLEMENTATION_STATUS.md` and this file as the current MVP handoff.
2. Treat `TOBE_ARCHITECTURE.md` as the scaling and governance target.
3. Preserve the build-clean baseline. Run the workspace build after edits that touch TypeScript, package wiring, or Vite config.
4. Keep the Durable orchestrator coordinate-only. Put network calls, model calls, PostgreSQL writes, Blob writes, Search writes, and clocks inside activities/services.
5. Do not reintroduce Cosmos-specific tasks. The current MVP store is PostgreSQL JSONB; the next scale step is an artifact/control-plane split, not a return to Cosmos.
6. Prefer vertical fixes that align shared types, API, Functions, UI, MCP handlers, and docs together.

## Priority 0 - Runtime Smoke Test The MVP Path

### Task 0.1 - Start the local stack and record exact runtime blockers

**Why**
The repo builds, but a build pass does not prove the live ingestion workflow.

**Primary surfaces**

- `api/src/server.ts`
- `api/src/routes/ingestion.ts`
- `functions/src/pipeline/orchestrator.ts`
- `ui/src/app.tsx`
- `LOCAL_DEV_SETUP.md`

**Actions**

- Start PostgreSQL with a reachable `resume_builder` database.
- Start API with local auth bypass only in non-production.
- Start Functions host with required local settings.
- Start UI and submit at least one web URL ingestion request.
- Poll run status until `completed` or `failed` and navigate to the resolved candidate.
- Repeat with a small text upload.
- Record exact failures in `IMPLEMENTATION_STATUS.md` if any remain.

**Acceptance criteria**

- A recruiter can submit a source, watch status, and land on a candidate profile, or the blockers are documented with exact failing command/output and file owner.

### Task 0.2 - Verify run failure handling

**Why**
The API now marks runs failed if the Function starter cannot be reached, but that path needs runtime proof.

**Actions**

- Submit ingestion with `FUNCTIONS_HOST` unavailable.
- Confirm the API returns a run immediately.
- Confirm the run later moves to `failed` with a useful `failedReason`.

**Acceptance criteria**

- Failed orchestration starts do not leave runs stuck in `in_progress`.

## Priority 1 - Move Ingestion Toward The TO-BE Artifact Pattern

### Task 1.1 - Stop passing large upload bytes through Durable input

**Why**
The MVP path sends base64 upload bytes inline to the orchestrator. That is acceptable for a small demo but conflicts with the TO-BE artifact-lake pattern and Durable history limits.

**Primary surfaces**

- `api/src/routes/ingestion.ts`
- `functions/src/pipeline/orchestrator.ts`
- `functions/src/activities/document-intelligence.ts`
- `TOBE_ARCHITECTURE.md`
- `mvp_ingestion_pipeline.md`

**Actions**

- Stage uploads to Blob Storage before starting the Durable orchestration.
- Create or extend source document metadata with artifact/blob handles.
- Pass `sourceDocumentIds` and artifact handles to the orchestrator instead of raw bytes.
- Keep a bounded text-only local shortcut only if it is explicit and documented.

**Acceptance criteria**

- Durable orchestration input stays small and contains IDs/handles, not large raw file payloads.

### Task 1.2 - Add artifact manifest metadata for raw and normalized text

**Why**
`TOBE_ARCHITECTURE.md` defines artifact manifests and lineage as the next storage boundary. Add this before more large-data features appear.

**Actions**

- Add MVP JSONB-backed artifact manifest records or a typed metadata table/repository.
- Record raw document artifact, normalized text artifact, source document linkage, content hash, size, MIME type, and status.
- Keep facts and bullets referencing source document/artifact IDs for provenance.

**Acceptance criteria**

- New ingestion outputs can be traced from run to source document to raw/derived artifact IDs.

## Priority 2 - Search Runtime Hardening

### Task 2.1 - Smoke-test Azure AI Search with a real service

**Why**
The TypeScript build passes, but Search SDK behavior depends on real service/schema compatibility.

**Primary surfaces**

- `api/src/search/index.ts`
- `functions/src/persistence/index.ts`

**Actions**

- Create/ensure the `resume-facts` index in a dev Search service.
- Ingest sample facts/bullets and confirm `mergeOrUploadDocuments` writes first-time documents.
- Query by tenant, person, section, and factKey.
- Confirm missing tenant rejects/fails closed.
- Confirm sensitive fact keys are redacted without privileged roles/scopes.

**Acceptance criteria**

- Search works against a real service or the exact incompatibility is documented and fixed.

### Task 2.2 - Consolidate search schema and document construction

**Why**
Search schema, write documents, and query filters should not drift across API and Functions.

**Actions**

- Move shared schema/document helpers into a shared server-only package or a single module consumed by API and Functions.
- Keep the browser-imported `shared` package free of Node/server-only dependencies.

**Acceptance criteria**

- There is one source for index field definitions, document projection, and filter escaping.

## Priority 3 - Production Identity And IL5 Readiness

### Task 3.1 - Verify Entra/OBO flows in deployment config

**Why**
The code supports token verification and OBO, but app registration setup decides whether it works.

**Actions**

- Confirm API accepted audiences and issuer settings in Commercial and Gov patterns.
- Confirm UI token audience matches API settings.
- Confirm API can request a Functions token with OBO or managed identity.
- Confirm Azure OpenAI/Search calls use OBO where intended and managed identity otherwise.

**Acceptance criteria**

- A signed-in user can call the API, trigger Functions, and access allowed downstream Azure services without shared secrets.

### Task 3.2 - Replace production browser Maps key handling

**Why**
The current browser map can use a Vite-baked subscription key. Production should not ship long-lived keys.

**Actions**

- Use Azure Maps AAD anonymous auth or another approved browser-safe auth flow.
- Keep the geospatial MCP server using managed identity/key precedence server-side.
- Document local-dev key behavior separately from production.

**Acceptance criteria**

- Production map rendering does not require a baked subscription key.

## Priority 4 - MCP Capability Depth

### Task 4.1 - Wire non-geospatial MCP handlers to real logic

**Why**
The capability layout builds, but several handlers are still scaffolds.

**Actions**

- Start with ingestion acquisition/extraction tools because they map directly to existing activities.
- Keep canonical facts/bullets writes inside Durable/API persistence boundaries.
- Return bounded, governed tool outputs: excerpts, citations, handles, cursors, and job IDs instead of bulk raw data.

**Acceptance criteria**

- At least one non-geospatial capability server delegates to the real activity/API logic and has a local smoke path.

### Task 4.2 - Route governance audit to an approved sink

**Why**
The governance layer exists, but console audit is not enough for production.

**Actions**

- Add an audit sink for Azure Monitor or the approved IL5 audit stream.
- Preserve the hash-chain/tamper-evident semantics.
- Document environment flags and failure behavior.

**Acceptance criteria**

- Governance decisions can be retained outside process logs in the target environment.

## Priority 5 - Temporal Intelligence

### Task 5.1 - Implement observed temporal events before predictions

**Why**
Predictions must never masquerade as observed facts.

**Actions**

- Add `TemporalEvent` persistence/projection first.
- Extract observed dated events from facts/text with evidence links.
- Add API/UI review surfaces before generating future predictions.

**Acceptance criteria**

- Observed events have evidence, confidence, status, and provenance, and are queryable without any prediction logic.

### Task 5.2 - Add event patterns and predictions behind review status

**Why**
Predictions need confidence, rationale, expiration, and recruiter feedback loops.

**Actions**

- Implement patterns from observed events.
- Create predictions with status `suggested`, confidence band, rationale, evidence, and review/expiration windows.
- Add accept/snooze/dismiss flows without converting predictions into observed facts.

**Acceptance criteria**

- Recruiters can review predictions as suggestions, and the system keeps observed data separate from speculative output.

## Current Definition Of Done

For the next implementation pass, success means:

1. The workspace still builds with `npm run build --workspaces`.
2. At least one real runtime smoke path is completed or exact blockers are documented.
3. Any new ingestion/storage work moves toward artifact handles and lineage, not larger Durable payloads.
4. Docs stay aligned with the verified state.
