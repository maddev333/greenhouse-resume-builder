# Greenhouse Resume Builder - Implementation Status

**Last doc refresh:** 2026-06-18
**Verification run:** `npm run build --workspaces` passed on 2026-06-18.
**Architecture handoff:** use `TOBE_ARCHITECTURE.md` for the petabyte-scale tenant-cell and artifact-lake target.

This file reflects the code that exists now. It intentionally replaces the older Cosmos-era status notes with the current PostgreSQL, managed-identity, MCP-capability, and geospatial implementation state.

## 1. Current Source Of Truth

### Implemented

- The monorepo builds across API, Functions, shared, main UI, MCP core, all capability MCP servers, capability agents, and capability UIs.
- The MVP data store is PostgreSQL JSONB, not Cosmos DB. API startup calls `ensureMVPTablesExist()` in `api/src/db/pg-client.ts`; Functions use their own PostgreSQL helper in `functions/src/persistence/index.ts`.
- The implemented JSONB tables are `persons`, `source_documents`, `extraction_runs`, `fact_versions`, `bullet_mappings`, `annotations`, and `relationships`.
- PostgreSQL auth supports local password auth and managed-identity/Entra auth. When `PGPASSWORD` is blank, the code uses `DefaultAzureCredential` with the PostgreSQL AAD scope.

### Constraints

- The JSONB table model preserves the former logical container names in code comments and mappings, but those names are compatibility labels only.
- Temporal entities (`TemporalEvents`, `EventPatterns`, `EventPredictions`, `RecruiterAlerts`) remain target data-model concepts, not implemented database tables.
- `TOBE_ARCHITECTURE.md` correctly describes the target split: PostgreSQL as metadata/control plane, large content in immutable artifacts, and rebuildable serving indexes.

## 2. Build And Package Status

### Verified

- `npm run build --workspaces` passes.
- The build includes:
  - `@greenhouse-resume-builder/api`
  - `@greenhouse-resume-builder/azure-functions`
  - `@greenhouse-resume-builder/shared`
  - `@greenhouse-resume-builder/ui`
  - `@greenhouse-resume-builder/mcp-core`
  - all capability MCP servers, agents, and UIs under `capabilities/`

### Remaining follow-up

- The build result is type/package validation only. It does not prove local runtime wiring, Azure service credentials, search query behavior, or end-to-end ingestion.
- Main UI and geospatial UI production bundles exceed Vite's default 500 KB chunk warning because of Azure Maps and bundled app code. This is not a build failure, but code-splitting is a future performance task.

## 3. API

### Implemented

- Express API startup, route registration, CORS, JSON body limit, health probe, authenticated `/api/v1/*` surface.
- Ingestion routes create PostgreSQL-backed `ExtractionRun` and `SourceDocument` records, return `sourceDocumentIds`, dedupe recent matching requests, trigger the Durable starter, and mark runs failed if the starter cannot be reached.
- Resume insight routes return:
  - flat `ResumeBulletResponse[]` from `/api/v1/insights/:personId/bullet-mappings`
  - section-grouped facts from `/api/v1/insights/:personId/facts`
  - bullet diffs from `/api/v1/insights/:personId/differences`
- Annotation, relationship, person, search, stats, and health routes exist.

### Remaining follow-up

- Several routes still use broad `req: any` typing. This is not blocking the build, but it is a contract-hardening task.
- The API triggers Functions asynchronously after responding to ingestion creation. Runtime validation should confirm the failure-marking path under real unavailable/unauthorized Function host conditions.

## 4. Authentication And Identity

### Implemented

- API auth uses `jose` remote JWKS verification when Entra settings are configured.
- The API fails closed when neither production token verification nor explicit local dev bypass is configured.
- `ALLOW_DEV_AUTH_BYPASS=true` is local-only and ignored in production.
- Verified user claims are surfaced as `req.user`, `req.tenantId`, `req.userId`, and raw validated `req.accessToken` for OBO-capable downstream calls.
- API service auth supports On-Behalf-Of with certificate or federated managed-identity assertion, falling back to `DefaultAzureCredential` when OBO is not configured.

### Remaining follow-up

- Runtime test Entra issuer/audience/JWKS behavior in the intended Commercial/Gov deployment configuration.
- Confirm the Functions starter protection settings (`FUNCTIONS_AUTH_AUDIENCE`, allowed callers, issuer settings) in the actual hosting environment.

## 5. Durable Functions Pipeline

### Implemented

- `IngestCandidateOrchestrator` is a generator orchestrator that coordinates the workflow with `df.callActivity` and `df.Task.all`.
- Orchestrator logging is guarded with `df.isReplaying`.
- Persistence and indexing side effects are activity-bound through `PersistBuilderOutput`, not performed directly in the replayed orchestration body.
- `UpdateExtractionRunStatus` is registered as an activity and handles status transitions.
- The pipeline handles uploads, web snapshots, section extraction, profile extraction, dedup, summary, builder output, persistence, duplicate-person deconfliction, relationship inference, and run completion/failure status updates.

### Remaining follow-up

- End-to-end local runtime validation is still needed with PostgreSQL, API, Functions host, and UI running together.
- Upload handling currently sends base64 file data inline to the orchestrator for the MVP path. The target architecture should move large bytes to Blob/artifact manifests before starting Durable work.

## 6. Builder Agent And Persistence

### Implemented

- Builder artifacts are generated in `functions/src/activities/builder-agent.ts`.
- Fact IDs are deterministic from person, run, section, key, and value.
- Bullet IDs include `personId`, section, and normalized text to reduce cross-person collision risk.
- Builder output includes profile, experience, skills, education, and summary facts/bullets with citation fact/source IDs.
- Persistence uses upsert semantics in PostgreSQL, so reruns with stable IDs do not create uncontrolled duplicates.

### Remaining follow-up

- Timestamps are generated at activity time. This is replay-safe, but exact created/extracted timestamps can differ across logical reruns.
- `latestForBullet` is written, but older bullets are not globally superseded in the current persistence helper. Treat latest/current semantics as MVP-level until hardened.

## 7. Search

### Implemented

- API search index creation and query helpers exist in `api/src/search/index.ts`.
- Functions persistence indexes facts and bullets best-effort after build output persistence.
- Search credential precedence supports API key for local/dev and Entra/managed identity or OBO for IL5 posture.
- Query helper applies a mandatory tenant filter and redacts sensitive fact keys unless roles/scopes permit access.

### Remaining follow-up

- Build validation passes, but runtime Azure AI Search behavior still needs a smoke test with a real index/service.
- Search schema and document construction should continue moving toward a single shared source of truth, as already called out in `TOBE_ARCHITECTURE.md`.

## 8. UI

### Implemented

- The React/Vite app conditionally renders the landing ingestion flow or candidate profile based on URL state.
- The candidate page handles the current flat bullet response by grouping it client-side.
- Diff calls use `/api/v1/insights/:personId/differences`, matching the implemented route.
- Facts, annotations, relationship suggestions, search, and optional map tab are wired into the candidate profile surface.
- MSAL-based token acquisition is wired through the API client when UI auth is configured.

### Remaining follow-up

- Validate the landing page ingestion workflow end to end against running API + Functions + PostgreSQL.
- Confirm recent-run listing, polling, failure display, and candidate navigation with real pipeline runs.
- Replace inline upload-to-orchestrator bytes with artifact/blob staging as part of the target architecture slice.

## 9. MCP Capabilities And Governance

### Implemented

- Capability module structure exists for ingestion, quality, relationships, temporal, geospatial, and discovery.
- `capabilities/mcp-core` contains shared MCP helpers, identity helpers, OBO/Azure OpenAI auth precedence, and optional governance wrappers.
- Agent Governance Toolkit-compatible local policy/audit gating exists and is disabled by default.
- The geospatial MCP server implements live Azure Maps-backed `normalize_location`, `geocode`, and `project_map_pins` tools.

### Remaining follow-up

- Several capability MCP handlers remain typed scaffolds or thin wrappers. Wire them progressively to the real Functions activities/API contracts.
- Governance audit currently has a console sink by default; production should route it to the approved audit/monitoring sink.

## 10. Geospatial

### Implemented

- The main UI extracts facts whose keys end in `.location` and calls the geospatial MCP `project_map_pins` tool.
- The candidate profile shows the Map tab only when location-bearing facts exist.
- `project_map_pins` geocodes up to 25 supplied locations and returns coarse map pin projections. Pins are not stored as independent facts.

### Remaining follow-up

- Production map rendering should use Azure Maps AAD/anonymous auth rather than a Vite-baked subscription key.
- Sensitive personal/home location handling should remain conservative: prefer city/region precision and evidence-backed public/professional locations.

## 11. Temporal Intelligence

### Current status

- Temporal intelligence is documented in MVP/TO-BE architecture, data model, and capability layout.
- Runtime implementation of temporal extraction, recurrence detection, future-event prediction, and recruiter alerts is not yet present.

### Guardrail

- Keep observed facts/events separate from predictions. Predictions need evidence, rationale, confidence, status, expiration, and review windows.

## 12. Highest-Value Remaining Work

1. Run an end-to-end local smoke test: PostgreSQL + API + Functions + UI, using both web URL and upload paths.
2. Move large ingestion bytes toward the TO-BE artifact manifest pattern: Blob first, Durable receives IDs/handles.
3. Runtime-test Azure AI Search index creation, upsert, tenant-filtered queries, and sensitive fact redaction.
4. Replace production map key handling with Azure Maps AAD/anonymous auth.
5. Wire capability MCP handlers to real activity/API contracts beyond geospatial.
6. Implement temporal events/predictions behind the documented activity/MCP boundaries.

## Definition Of Done For The Next Coding Pass

The next pass should be considered successful if it produces a concrete runtime validation result for the MVP path, records exact blockers, and advances the artifact-lake migration without weakening the current build-clean baseline.
