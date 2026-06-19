# TO-BE Architecture: Petabyte-Scale, IL5-Ready MCP Information Platform

This document is the target-state implementation handoff for the next architecture slice. It
captures the decisions from the architecture review and the user's constraints:

- MCP must serve both UI applications and agents.
- MCP tools should return governed excerpts, citations, handles, cursors, and job IDs, not bulk raw data.
- The data estate includes resumes/documents, web snapshots, embeddings, events, facts, relationships,
  geospatial projections, public/professional event schedules, availability windows, and engagement
  recommendations.
- DoD IL5 remains a hard deployment constraint.
- Tenant isolation must be strong. Prefer hard isolation through tenant cells, not only row-level filters.

The current repository is a useful MVP scaffold, but it is not the petabyte-scale data architecture.
The current PostgreSQL JSONB store should evolve into the metadata/control plane. Large information
must live in an immutable, partitioned artifact lake with rebuildable serving indexes.

## 1. North Star

MCP tools should never expose "the data lake." They should expose governed, cited, bounded views
into the lake.

At petabyte scale, the system should answer these questions efficiently and safely:

1. Where is the relevant information?
2. Who is allowed to see it?
3. Which excerpt can be returned within the caller's purpose, tenant, classification, and byte limits?
4. What source, page, offset, model, run, and policy decision produced that excerpt?
5. Which async job should be started when the work is too large for a synchronous tool call?
6. When and where can a recruiter appropriately meet a candidate, based on governed schedule,
   event, location, and availability signals?

## 2. Target Architecture Summary

```text
UI apps / MCP UI Apps / Agents
  |
  | Entra ID token + purpose + tenant context
  v
API Gateway / APIM / Private Link boundary
  |
  v
MCP Capability Layer
  |-- retrieval tools: search_excerpts, semantic_retrieve, get_source_excerpt
  |-- entity tools: get_entity_profile, query_relationships, query_timeline, query_map_pins
  |-- engagement tools: query_engagement_opportunities, recommend_meeting_slots, get_engagement_plan
  |-- action tools: start_ingestion, start_reindex, start_entity_resolution, start_engagement_projection, start_export
  |-- governance: authz, policy, byte limits, audit, citations, data-class checks
  |
  +--> Serving indexes
  |      |-- keyword / hybrid search index
  |      |-- vector index
  |      |-- graph / relationship projection
  |      |-- temporal / event projection
  |      |-- geospatial projection
  |      |-- engagement / availability projection
  |
  +--> Job control plane
  |      |-- Durable Functions orchestrations
  |      |-- activity workers
  |      |-- index builders
  |
  +--> Metadata control plane
         |-- PostgreSQL metadata catalog
         |-- tenant/cell registry
         |-- artifact manifests
         |-- lineage
         |-- permissions and policy bindings
         |-- job state
         |-- engagement plans and approval state
         |-- retention state

Tenant Cell Data Plane
  |-- Blob / ADLS-style object storage for raw and derived artifacts
  |-- private endpoints and tenant/cell managed identities
  |-- tenant/cell audit stream
  |-- tenant/cell keys and retention policies
```

## 3. Tenant Cell Model

Use a cell-based architecture for hard tenant isolation. A cell is the deployable unit that owns a
bounded set of tenant data and all services that can access it.

### 3.1 Global Control Plane

The global plane should contain no raw customer data. It routes requests and tracks deployment state.

Responsibilities:

- Tenant registry.
- Tenant-to-cell routing table.
- Cell health and deployment metadata.
- Policy catalog versions.
- Cross-cell operational metadata that does not contain source content or extracted facts.

Suggested entities:

```ts
export interface TenantCellRegistryEntry {
  tenantId: string;
  cellId: string;
  cloud: "azure-commercial" | "azure-government" | "azure-dod";
  region: string;
  dataBoundary: "il5" | "commercial";
  apiBaseUrl: string;
  mcpBaseUrl: string;
  status: "active" | "disabled" | "migrating";
  createdAt: string;
  updatedAt: string;
}
```

### 3.2 Tenant Cell

Each tenant cell contains the data, indexes, compute, identities, networking, and audit sinks needed
to serve that tenant or tenant group.

Hard-isolation recommendation:

- Separate storage account per large tenant or per tenant cell.
- Separate search service or at least separate indexes per tenant cell.
- Separate managed identities for API, Functions, MCP, indexers, and export workers.
- Separate encryption keys or key scopes.
- Separate private endpoints.
- Separate audit stream.
- Separate quota and rate-limit policy.
- Separate MCP route namespace.

For small tenants, multiple tenants can share a cell only when the data boundary and accreditation
permit it. Even then, use separate containers/indexes/keys where practical.

## 4. Data Plane: Artifact Lake

All large information must be stored as immutable artifacts in object storage. The metadata catalog
stores pointers and lineage, not the data itself.

Artifact examples:

- Raw uploaded resumes and documents.
- Public web snapshots.
- OCR and Document Intelligence layout output.
- Normalized extracted text.
- Chunked excerpt records.
- Extracted facts.
- Embedding input chunks.
- Embedding vectors or vector index references.
- Relationship evidence artifacts.
- Temporal event artifacts.
- Geospatial projection artifacts.
- Public/professional event schedule artifacts, such as conference agendas, venue maps, session
  times, booth hours, and hosted networking windows.
- Availability snapshots from approved recruiter/team calendars, candidate-provided preferences, or
  governed event attendance signals.
- Engagement recommendation artifacts with candidate, time, place, evidence, scoring rationale, and
  human approval state.
- Model intermediate outputs and validation reports.

Recommended storage path pattern:

```text
/tenantId={tenantId}/cellId={cellId}/sourceType={sourceType}/ingestDate={yyyy-mm-dd}/sourceDocumentId={sourceDocumentId}/artifactType={artifactType}/schemaVersion={schemaVersion}/{artifactId}.{ext}
```

Use immutable artifact IDs and content hashes. Do not overwrite artifact bytes. If content changes,
write a new artifact and link it through lineage.

## 5. Metadata Control Plane

PostgreSQL remains useful, but its role changes. It should store control-plane metadata and pointers,
not petabyte-scale text or binary payloads.

Current repo tables such as `persons`, `source_documents`, `extraction_runs`, `fact_versions`,
`bullet_mappings`, `annotations`, and `relationships` can stay for MVP behavior. Add the following
metadata concepts before scaling the data plane.

### 5.1 Artifact Manifest

```ts
export type ArtifactType =
  | "raw_document"
  | "web_snapshot"
  | "layout_json"
  | "normalized_text"
  | "text_chunks"
  | "facts"
  | "bullets"
  | "embeddings_input"
  | "embeddings_index_ref"
  | "relationship_projection"
  | "temporal_events"
  | "geospatial_projection"
  | "event_schedule"
  | "availability_snapshot"
  | "engagement_projection"
  | "meeting_recommendations"
  | "model_trace"
  | "validation_report";

export interface ArtifactManifest {
  id: string;
  tenantId: string;
  cellId: string;
  sourceDocumentId?: string;
  extractionRunId?: string;
  artifactType: ArtifactType;
  storageUri: string;
  storageContainer: string;
  storagePath: string;
  contentHash: string;
  sizeBytes: number;
  mimeType?: string;
  schemaVersion: string;
  parentArtifactIds: string[];
  securityLabels: string[];
  retentionPolicyId: string;
  createdAt: string;
  createdBy: string;
  status: "active" | "superseded" | "deleted" | "quarantined";
}
```

### 5.2 Artifact Lineage

```ts
export interface ArtifactLineageEdge {
  id: string;
  tenantId: string;
  cellId: string;
  parentArtifactId: string;
  childArtifactId: string;
  transformation: string;
  runId?: string;
  modelDeployment?: string;
  toolName?: string;
  createdAt: string;
}
```

### 5.3 Source Document

Extend `SourceDocument` so it points at artifact manifests rather than carrying file data.

```ts
export interface SourceDocumentV2 {
  id: string;
  tenantId: string;
  cellId: string;
  personId?: string;
  sourceType: "web" | "upload" | "api" | "batch" | "event_feed" | "calendar";
  uri?: string;
  originalFileName?: string;
  mimeType?: string;
  rawArtifactId?: string;
  normalizedTextArtifactId?: string;
  latestLayoutArtifactId?: string;
  createdAt: string;
  createdBy: string;
  securityLabels: string[];
  status: "pending" | "ready" | "failed" | "deleted";
}
```

### 5.4 Excerpt Record

Excerpts are the primary payload returned to MCP callers. They are bounded and citable.

```ts
export interface ExcerptRecord {
  id: string;
  tenantId: string;
  cellId: string;
  sourceDocumentId: string;
  artifactId: string;
  chunkId?: string;
  text: string;
  textHash: string;
  page?: number;
  startOffset?: number;
  endOffset?: number;
  tokenCount?: number;
  securityLabels: string[];
  citation: CitationRef;
}

export interface CitationRef {
  sourceDocumentId: string;
  artifactId: string;
  page?: number;
  startOffset?: number;
  endOffset?: number;
  storageHandle: string;
}
```

### 5.5 Index Job

```ts
export interface IndexJob {
  id: string;
  tenantId: string;
  cellId: string;
  jobType:
    | "chunk"
    | "keyword_index"
    | "vector_index"
    | "graph_projection"
    | "temporal_projection"
    | "geospatial_projection"
    | "engagement_projection";
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  targetIndexName?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failedReason?: string;
}
```

### 5.6 MCP Job

Long-running MCP operations should be async jobs.

```ts
export interface McpJob {
  id: string;
  tenantId: string;
  cellId: string;
  toolName: string;
  requestedByUserId: string;
  purpose: string;
  inputSummary: Record<string, unknown>;
  outputManifestId?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  failedReason?: string;
}
```

### 5.7 Engagement Schedule And Meeting Models

Engagements are recruiter-facing opportunities to meet candidates. They are derived from temporal
events, geospatial places, approved availability signals, and public/professional event schedules.
They must remain separate from observed candidate facts and from confirmed calendar meetings.

Use cases:

- A candidate is presenting at a conference in Washington, DC next Tuesday; recommend nearby public
  meeting places and open recruiter time windows around the session.
- A recruiter team is attending a career fair; show candidates with matching event attendance,
  likely availability windows, booth hours, and low-travel meeting places.
- A candidate has a predicted annual conference appearance; create a suggested engagement task, not
  a confirmed meeting, until a recruiter reviews it.

```ts
export interface EngagementEvent {
  id: string;
  tenantId: string;
  cellId: string;
  eventType:
    | "conference"
    | "career_fair"
    | "meetup"
    | "interview_loop"
    | "company_visit"
    | "other";
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
  venueName?: string;
  location?: GeoPointRef;
  sourceDocumentId?: string;
  sourceArtifactId?: string;
  citation?: CitationRef;
  securityLabels: string[];
  status: "observed" | "predicted" | "cancelled" | "superseded";
}

export interface AvailabilityWindow {
  id: string;
  tenantId: string;
  cellId: string;
  ownerType: "candidate" | "recruiter" | "team" | "venue";
  ownerId?: string;
  sourceType:
    | "calendar"
    | "event_schedule"
    | "self_reported"
    | "public_event"
    | "recruiter_input";
  startAt: string;
  endAt: string;
  timezone: string;
  location?: GeoPointRef;
  confidence?: number;
  evidence?: CitationRef[];
  visibility: "private" | "team" | "tenant" | "public_professional";
  status: "active" | "tentative" | "expired" | "revoked";
}

export interface GeoPointRef {
  latitude?: number;
  longitude?: number;
  placeId?: string;
  formattedAddress?: string;
  locationPrecision: "exact_venue" | "campus" | "city" | "region" | "unknown";
}

export interface MeetingPlaceCandidate {
  id: string;
  tenantId: string;
  cellId: string;
  eventId?: string;
  name: string;
  placeType:
    | "conference_venue"
    | "booth"
    | "meeting_room"
    | "public_space"
    | "office"
    | "virtual"
    | "other";
  location?: GeoPointRef;
  availableWindows?: Array<{
    startAt: string;
    endAt: string;
    timezone: string;
  }>;
  evidence?: CitationRef[];
  securityLabels: string[];
}

export interface EngagementRecommendation {
  id: string;
  tenantId: string;
  cellId: string;
  personId: string;
  eventId?: string;
  recommendedWindow: { startAt: string; endAt: string; timezone: string };
  placeCandidateId?: string;
  score: number;
  rationale: string;
  evidence: CitationRef[];
  constraints: {
    minDurationMinutes?: number;
    bufferMinutes?: number;
    maxTravelMeters?: number;
    avoidPrivateLocations: boolean;
    requiresHumanApproval: boolean;
  };
  status:
    | "suggested"
    | "accepted"
    | "snoozed"
    | "dismissed"
    | "scheduled"
    | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export interface EngagementPlan {
  id: string;
  tenantId: string;
  cellId: string;
  recruiterId: string;
  eventId?: string;
  recommendationIds: string[];
  status: "draft" | "reviewed" | "approved" | "archived";
  createdAt: string;
  updatedAt: string;
}
```

Engagement records should store references to calendars, event schedules, citations, and map places;
they should not copy full calendar bodies or expose unrelated private calendar details.

## 6. Serving Indexes

Indexes are read models. They must be rebuildable from the artifact lake and metadata catalog.

### 6.1 Required Serving Models

1. Keyword and hybrid search index.
   - Stores excerpt metadata, citable snippets, source IDs, security labels, and ranking fields.
   - Does not store full raw documents.

2. Vector index.
   - Stores embedding vectors for approved chunks/excerpts.
   - Stores source and citation references.
   - Must apply tenant/cell routing and security filters before returning results.

3. Graph projection.
   - Stores person, employer, school, organization, and relationship edges.
   - Edges point to evidence excerpts and fact artifacts.

4. Temporal projection.
   - Stores observed events, detected patterns, predictions, and recruiter alert states.
   - Predictions must remain separate from observed facts.

5. Geospatial projection.
   - Stores approved public/professional map pins.
   - Avoid exact personal/home locations by default.

6. Engagement projection.
   - Stores candidate/event matches, availability windows, meeting place candidates, and recommendation
     scoring fields.
   - Composes temporal and geospatial projections with approved recruiter/team availability and event
     schedule artifacts.
   - Keeps suggested recommendations separate from recruiter-approved or calendar-confirmed meetings.
   - Avoids exact personal/home locations and unrelated private calendar details by default.

### 6.2 Shared Search Adapter

The repo currently has search behavior split between API and Functions. The TO-BE design should use
one shared adapter for query construction, index document conversion, credentials, and endpoint
resolution.

Recommended location options:

- `shared/src/search-contracts.ts` for contracts only.
- `api/src/search/adapter.ts` for API-only implementation if Functions call API for search.
- `capabilities/discovery/mcp/search/src/search-adapter.ts` if MCP owns discovery.
- A new workspace package such as `packages/search-adapter` if shared runtime code is preferred.

Acceptance criteria:

- One source of truth for search document schema.
- One source of truth for OData filter escaping.
- One source of truth for SearchClient construction.
- API, Functions, and MCP do not each hand-build their own incompatible query logic.

## 7. MCP Layer TO-BE Design

MCP is the governed access layer for both UI and agents. It should present stable product APIs,
not raw internal helper functions.

### 7.1 MCP Tool Categories

Retrieval tools:

```text
search_excerpts
semantic_retrieve
get_source_excerpt
get_artifact_manifest
get_entity_profile
query_relationships
query_timeline
query_map_pins
query_engagement_opportunities
recommend_meeting_slots
get_engagement_plan
```

Action tools:

```text
start_ingestion
start_reindex
start_embedding_job
start_entity_resolution
start_relationship_inference
start_temporal_projection
start_engagement_projection
start_meeting_recommendation_job
create_engagement_hold
confirm_engagement
cancel_engagement
start_export
get_job_status
get_job_result_manifest
```

Administrative tools, if allowed, should be separate and more tightly governed:

```text
list_artifacts
quarantine_artifact
apply_retention_policy
start_cell_reindex
```

### 7.2 Required Request Envelope

Every MCP tool should accept or derive this context. Do not let the client supply trusted tenant/user
identity when it can be derived from the verified token.

```ts
export interface McpToolRequestContext {
  tenantId: string;
  cellId: string;
  userId: string;
  agentId?: string;
  purpose: string;
  traceId: string;
  securityLabels?: string[];
  maxResults?: number;
  maxBytes?: number;
}
```

Tool-specific payloads should include filters and cursors, not raw document bodies.

```ts
export interface ExcerptSearchRequest extends McpToolRequestContext {
  query: string;
  filters?: {
    personId?: string;
    sourceDocumentId?: string;
    sectionId?: string;
    artifactType?: ArtifactType;
    dateRange?: { from?: string; to?: string };
  };
  cursor?: string;
  includeCitations?: boolean;
}
```

Engagement tools should accept bounded filters and constraints, not raw calendar bodies.

```ts
export interface MeetingRecommendationRequest extends McpToolRequestContext {
  personIds?: string[];
  eventId?: string;
  dateRange: { from: string; to: string };
  location?:
    | { latitude: number; longitude: number; radiusMeters?: number }
    | { placeId: string; radiusMeters?: number };
  constraints?: {
    minDurationMinutes?: number;
    bufferMinutes?: number;
    maxTravelMeters?: number;
    avoidPrivateLocations?: boolean;
    requireRecruiterAvailability?: boolean;
    requireCandidateProvidedAvailability?: boolean;
  };
  cursor?: string;
}
```

### 7.3 Required Response Shape

```ts
export interface ExcerptSearchResponse {
  results: Array<{
    excerptId: string;
    sourceDocumentId: string;
    artifactId: string;
    text: string;
    score: number;
    citation: CitationRef;
    provenance: {
      extractionRunId?: string;
      modelDeployment?: string;
      confidence?: number;
      generatedAt?: string;
    };
    securityLabels: string[];
  }>;
  nextCursor?: string;
  totalEstimate?: number;
  policyDecisionId: string;
}
```

Engagement recommendation responses must explain why each slot/place is suggested.

```ts
export interface MeetingRecommendationResponse {
  recommendations: Array<{
    recommendationId: string;
    personId: string;
    eventId?: string;
    window: { startAt: string; endAt: string; timezone: string };
    place?: MeetingPlaceCandidate;
    score: number;
    rationale: string;
    evidence: CitationRef[];
    constraintsSatisfied: string[];
    warnings?: string[];
  }>;
  nextCursor?: string;
  policyDecisionId: string;
}
```

### 7.4 MCP Guardrails

Every tool call must enforce:

- Verified caller identity.
- Tenant-to-cell routing.
- Authorization for tenant, purpose, tool, and data class.
- Result count limits.
- Returned byte limits.
- Cursor-based pagination.
- Citation references for returned text.
- Tamper-evident audit logging.
- No raw bulk data in synchronous responses.
- Async job pattern for expensive operations.
- Engagement recommendations remain suggestions until a recruiter explicitly approves a hold or
  confirmed meeting.
- Calendar writes, outbound invitations, and candidate contact require an explicit audited action;
  recommendations must not send messages or book meetings automatically.
- Engagement tools must not reveal unrelated private calendar details or exact personal/home
  locations.

### 7.5 MCP UI Apps

MCP UI Apps should use the same MCP tools as agents. The UI may render richer controls, but it should
not use a privileged data path that bypasses MCP governance for large-data retrieval.

Allowed UI direct API calls:

- Auth/session bootstrap.
- Small control-plane status calls.
- Upload intent creation.
- Job status polling.

Preferred UI MCP calls:

- Search and retrieval.
- Excerpt inspection.
- Timeline and map projections.
- Relationship exploration.
- Review queue loading.
- Engagement opportunity and meeting-slot recommendation.

Recommended MCP UI Apps:

- **Search And Evidence Explorer:** cited retrieval and source inspection.
- **Timeline And Map Explorer:** event and location projections with evidence drill-in.
- **Review Queue:** low-confidence facts, conflicts, and missing citations.
- **Engagement Planner:** candidate/event matching, recommended meeting windows, recommended public
  places, recruiter approval, and schedule hold review.

## 8. IL5 Deployment Requirements

The architecture must keep IL5 as a hard constraint.

Allowed posture:

- Azure Functions, App Service, AKS, or ACI for compute when authorized in the target environment.
- Durable Functions for long-running orchestration.
- Azure Blob Storage / ADLS-style storage for artifacts.
- Azure AI Search where authorized for the target environment.
- Azure OpenAI direct model calls where authorized.
- Azure Maps only for approved data classes and target environment.
- Calendar and event-feed connectors only when they are authorized in the target cloud and brokered
  through governed ingestion; otherwise, treat conference/event schedules as uploaded or web-snapshot
  artifacts.
- Entra ID, managed identity, Private Link, VNet integration, APIM, Key Vault, Azure Monitor.

Avoid as runtime dependencies for IL5:

- Azure Container Apps when the target IL5 authorization does not permit it.
- Foundry Agent Service as the production agent runtime if it is not IL5-authorized.
- Shared secrets or account keys in production.
- Publicly reachable MCP servers without validated gateway or in-process token enforcement.
- Consumer calendar, consumer mapping, or public place APIs for IL5 data unless the target
  authorization explicitly permits them.

Required security behavior:

- Production startup fails closed when required auth/audience/gateway configuration is absent.
- Managed identity is the default credential path.
- Key-based credentials are local-development exceptions only.
- Tenant/user are derived from verified tokens, not trusted from request bodies.
- Every MCP call emits an audit event with caller, tenant, purpose, tool, policy decision, input
  summary, returned excerpt IDs, and byte count.
- Every engagement action emits an audit event with candidate/person IDs, event IDs, recommendation
  IDs, calendar write intent, human approval state, and policy decision.

## 9. Ingestion TO-BE Flow

The current MVP path passes base64 file data through the UI, API, and Durable starter. That pattern
must be replaced before scaling.

Target flow:

```text
1. UI asks API for upload intent.
2. API authenticates caller and resolves tenant/cell.
3. API creates SourceDocumentV2 + raw ArtifactManifest in pending state.
4. API returns a short-lived upload URL or brokered upload instruction.
5. UI uploads directly to Blob/object storage.
6. UI/API confirms upload completion with artifact ID and content hash.
7. API marks SourceDocumentV2 ready and starts Durable orchestration with sourceDocumentIds/artifactIds only.
8. Activities read artifacts from storage, produce derived artifacts, update manifests, and enqueue index jobs.
9. MCP tools retrieve excerpts from serving indexes and artifact handles.
```

Durable orchestration input must stay small:

```ts
export interface IngestionOrchestrationInputV2 {
  runId: string;
  tenantId: string;
  cellId: string;
  requestedByUserId: string;
  sourceDocumentIds: string[];
  rawArtifactIds: string[];
  personOverride?: string;
}
```

Do not pass file bytes, full text, embeddings, or large model outputs through orchestration input or
custom status. Pass IDs and store large outputs as artifacts.

## 10. Implementation Plan For The Next Agent

This section is intentionally concrete. Start here when implementing.

### Phase 0: Guardrails And Alignment

Goal: prevent new scale-hostile code while adding the new architecture.

Files to inspect/update:

- `README.md`
- `IMPLEMENTATION_STATUS.md`
- `AGENT_TASKS.md`
- `functions/src/pipeline/http-start.ts`
- `api/src/routes/ingestion.ts`
- `ui/src/app.tsx`

Tasks:

1. Add explicit docs that uploads are moving to artifact staging.
2. Ensure production auth fails closed for API, Functions starter, and MCP deployments.
3. Ensure tenant/user are derived from verified token claims in new code paths.
4. Keep the old inline-upload path only as local/dev compatibility while the staged path lands.

Acceptance criteria:

- New code paths do not add more large payloads to API or Durable inputs.
- New code paths do not trust tenant IDs from browser request bodies.

### Phase 1: Shared Contracts

Goal: add types without changing runtime behavior yet.

Files to update:

- `shared/src/interfaces.ts`
- `shared/src/index.ts`
- optionally new `shared/src/artifacts.ts`
- optionally new `shared/src/mcp-contracts.ts`

Add contracts:

- `TenantCellRegistryEntry`
- `ArtifactManifest`
- `ArtifactLineageEdge`
- `SourceDocumentV2`
- `ExcerptRecord`
- `CitationRef`
- `IndexJob`
- `McpJob`
- `EngagementEvent`
- `AvailabilityWindow`
- `MeetingPlaceCandidate`
- `EngagementRecommendation`
- `EngagementPlan`
- `McpToolRequestContext`
- `ExcerptSearchRequest`
- `ExcerptSearchResponse`

Acceptance criteria:

- `npm run build --workspaces` passes.
- No runtime behavior changes are required in this phase.

### Phase 2: Metadata Catalog Tables And Repositories

Goal: store artifact and job metadata in PostgreSQL.

Files to update:

- `api/src/db/pg-client.ts`
- `api/src/db/repo/base-repo.ts`
- `api/src/db/repo/index.ts`
- new `api/src/db/repo/artifact-repo.ts`
- new `api/src/db/repo/index-job-repo.ts`
- new `api/src/db/repo/mcp-job-repo.ts`
- `functions/src/persistence/index.ts`

Add logical tables:

- `artifact_manifests`
- `artifact_lineage`
- `index_jobs`
- `mcp_jobs`
- `engagement_events`
- `availability_windows`
- `meeting_place_candidates`
- `engagement_recommendations`
- `engagement_plans`
- optionally `tenant_cells` if this repo owns cell routing locally

Recommended indexes:

```sql
CREATE INDEX ON artifact_manifests ((data->>'tenantId'));
CREATE INDEX ON artifact_manifests ((data->>'cellId'));
CREATE INDEX ON artifact_manifests ((data->>'sourceDocumentId'));
CREATE INDEX ON artifact_manifests ((data->>'extractionRunId'));
CREATE INDEX ON artifact_manifests ((data->>'artifactType'));
CREATE INDEX ON artifact_manifests ((data->>'status'));
CREATE INDEX ON artifact_lineage ((data->>'parentArtifactId'));
CREATE INDEX ON artifact_lineage ((data->>'childArtifactId'));
CREATE INDEX ON index_jobs ((data->>'tenantId'), (data->>'status'));
CREATE INDEX ON mcp_jobs ((data->>'tenantId'), (data->>'status'));
CREATE INDEX ON engagement_events ((data->>'tenantId'), (data->>'startAt'));
CREATE INDEX ON availability_windows ((data->>'tenantId'), (data->>'startAt'));
CREATE INDEX ON meeting_place_candidates ((data->>'tenantId'), (data->>'eventId'));
CREATE INDEX ON engagement_recommendations ((data->>'tenantId'), (data->>'personId'));
CREATE INDEX ON engagement_recommendations ((data->>'tenantId'), (data->>'status'));
```

Acceptance criteria:

- API and Functions can both create/read artifact manifests.
- Table creation is idempotent.
- Repositories enforce table allow-lists.

### Phase 3: Upload Intent And Artifact Staging

Goal: move file bytes out of API and Durable payloads.

Files to add/update:

- `api/src/routes/ingestion.ts`
- new `api/src/routes/artifacts.ts` or `api/src/routes/uploads.ts`
- new `api/src/services/artifact-storage.ts`
- `ui/src/app.tsx`
- `ui/src/api.ts`
- `ui/src/auth/api-auth.ts` if upload calls need helper support

New API shape:

```text
POST /api/v1/uploads/intent
POST /api/v1/uploads/complete
POST /api/v1/ingestion-requests
```

Example intent request:

```ts
export interface CreateUploadIntentRequest {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash?: string;
  sourceType: "upload";
  securityLabels?: string[];
}
```

Example intent response:

```ts
export interface CreateUploadIntentResponse {
  sourceDocumentId: string;
  artifactId: string;
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders?: Record<string, string>;
}
```

Implementation note:

- For local development, direct API upload can remain behind an explicit dev flag.
- For production, use direct-to-storage upload or a brokered upload endpoint that streams to storage
  without storing bytes in Durable history.

Acceptance criteria:

- UI uploads bytes to storage before starting ingestion.
- `POST /api/v1/ingestion-requests` accepts source document IDs/artifact IDs.
- Durable starter body contains IDs only.

### Phase 4: Durable Orchestration Refactor

Goal: make orchestration artifact-reference based.

Files to update:

- `functions/src/pipeline/http-start.ts`
- `functions/src/pipeline/orchestrator.ts`
- `functions/src/activities/document-intelligence.ts`
- `functions/src/activities/fetch-web-snapshot.ts`
- `functions/src/persistence/index.ts`

Tasks:

1. Replace `documentBlobs` input with `sourceDocumentIds` and `rawArtifactIds`.
2. Add activity helpers to read artifact manifests and stream bytes from storage.
3. Write normalized text/layout/chunk artifacts back to storage.
4. Store lineage edges for every transformation.
5. Keep orchestrator output small.

Acceptance criteria:

- Durable history does not contain raw document bytes or full extracted text.
- Each derived artifact has a manifest and lineage parent.
- Existing MVP extraction can still run from staged artifacts.

### Phase 5: Chunking And Excerpt Generation

Goal: create citable, bounded retrieval units.

Files to add/update:

- new `functions/src/activities/chunk-text.ts`
- new `shared/src/chunking.ts` or `shared/src/retrieval.ts`
- `functions/src/pipeline/orchestrator.ts`
- search/indexing adapter files from Phase 6

Tasks:

1. Split normalized text into chunks with stable IDs.
2. Preserve page and offset references where available.
3. Store chunks as `text_chunks` artifacts.
4. Produce `ExcerptRecord` entries or index documents.

Acceptance criteria:

- Every searchable text result has a citation back to source document and offsets/page.
- Chunks have stable IDs based on artifact ID and offset/hash.

### Phase 6: Shared Retrieval And Indexing Adapter

Goal: one retrieval system for API, Functions, and MCP.

Files to add/update:

- `api/src/search/index.ts`
- `functions/src/persistence/index.ts`
- `capabilities/discovery/mcp/search/src/tools.ts`
- optionally new shared runtime package/module

Tasks:

1. Define one index document shape for excerpts.
2. Fix SearchClient construction in one place.
3. Add safe OData filter construction and escaping.
4. Support keyword, filter, and semantic/vector retrieval as separate methods.
5. Return `ExcerptSearchResponse` shapes.

Acceptance criteria:

- Discovery MCP tools call the same adapter as API search.
- Search responses include citations and policy decision IDs.
- Search never returns unbounded raw document text.

### Phase 6A: Engagement Projection And Recommendations

Goal: turn event schedules, candidate temporal events, map places, and approved availability into
auditable meeting recommendations.

Files to add/update:

- new `shared/src/engagements.ts`
- new `api/src/db/repo/engagement-repo.ts`
- new `functions/src/activities/project-engagements.ts`
- new `functions/src/activities/recommend-meeting-slots.ts`
- new `capabilities/engagements/mcp/engagements/src/tools.ts`
- new `capabilities/engagements/ui/src/main.tsx` or an engagement planner route in `ui/src/app.tsx`

Tasks:

1. Ingest public/professional event schedules as artifacts, including conference dates, session
   times, venue names, booth hours, and source citations.
2. Normalize event times to timezone-aware windows and normalize public/professional locations to
   `GeoPointRef` values.
3. Project candidate attendance or relevance from observed temporal events, recruiter-selected
   targets, and candidate-provided preferences.
4. Join candidate/event signals with approved recruiter/team availability and meeting place
   candidates.
5. Generate `EngagementRecommendation` records with score, rationale, evidence, warnings, and
   explicit human-approval requirements.
6. Keep recommendation, hold, and confirmed meeting states separate.

Acceptance criteria:

- Recommendations explain the event, candidate relevance, time window, place, and constraints used.
- No recommendation exposes private calendar details beyond busy/free windows allowed by policy.
- No action sends an invite or contacts a candidate without an explicit recruiter-approved tool call.
- Recommendations are rebuildable from artifacts, metadata, temporal projections, and geospatial
  projections.

### Phase 7: MCP Tools Become Real Product APIs

Goal: replace stub MCP tools with governed implementations.

Files to update:

- `capabilities/mcp-core/src/mcp-server.ts`
- `capabilities/mcp-core/src/governance.ts`
- `capabilities/discovery/mcp/search/src/tools.ts`
- `capabilities/ingestion/mcp/acquisition/src/tools.ts`
- `capabilities/ingestion/mcp/extraction/src/tools.ts`
- `capabilities/relationships/mcp/relationships/src/tools.ts`
- `capabilities/temporal/mcp/temporal/src/tools.ts`
- `capabilities/geospatial/mcp/geospatial/src/tools.ts`
- `capabilities/engagements/mcp/engagements/src/tools.ts`

Tasks:

1. Add request context extraction from validated identity/gateway headers.
2. Enforce `maxResults` and `maxBytes` defaults centrally.
3. Add `search_excerpts`, `semantic_retrieve`, `get_source_excerpt`.
4. Add `query_engagement_opportunities`, `recommend_meeting_slots`, and `get_engagement_plan`.
5. Convert long-running tools to `start_*` plus `get_job_status`.
6. Audit every MCP call.

Acceptance criteria:

- MCP read tools return excerpts, citations, cursors, and policy decision IDs.
- MCP action tools return job IDs and never block on long-running work.
- Engagement tools return recommendations, evidence, warnings, and policy decision IDs.
- Stub tools are either removed, renamed as dev-only, or explicitly disabled in production.

### Phase 8: Tenant Cell Routing And Hard Isolation

Goal: route every request to the correct isolated cell.

Files to add/update:

- new `api/src/services/tenant-cell-router.ts`
- new `capabilities/mcp-core/src/tenant-cell.ts`
- `api/src/middleware/auth.middleware.ts`
- `api/src/routes/*`
- MCP server registrations

Tasks:

1. Resolve `tenantId` from verified token claims or trusted gateway claims.
2. Resolve `cellId` from tenant registry.
3. Select storage/search/identity endpoints by cell.
4. Add guardrails preventing cross-cell artifact/index access.

Acceptance criteria:

- No new production path trusts tenant ID from browser body.
- Artifact IDs are validated against tenant and cell before use.
- Search filters always include tenant and cell constraints.

### Phase 9: Observability, Audit, And Operations

Goal: make petabyte-scale behavior visible and governable.

Files to add/update:

- `docs/operational-runbook.md`
- `capabilities/mcp-core/src/governance.ts`
- new audit sink implementation if needed
- API and Functions logging helpers

Metrics to emit:

- Bytes ingested per tenant/cell/day.
- Artifacts created by type.
- Index lag by artifact type.
- MCP tool calls by tenant/tool/purpose.
- Excerpts returned and bytes returned.
- Engagement recommendations created, accepted, snoozed, dismissed, and scheduled.
- Engagement recommendation lead time, stale recommendation age, and calendar-write failures.
- Denied policy decisions.
- Search p95 latency and result counts.
- Durable orchestration history size.
- Failed and stale jobs.

Acceptance criteria:

- Operators can answer what data was returned, to whom, by which tool, and why.
- Stale jobs and index lag are visible.
- Durable history growth is monitored.

## 11. First Concrete Coding Slice

If another agent starts implementing immediately, the safest first slice is:

1. Add shared contracts for artifacts, excerpts, index jobs, MCP jobs, and tenant cell routing.
2. Add Postgres JSONB tables/repositories for artifact manifests and lineage.
3. Add upload intent/complete API endpoints.
4. Change ingestion request creation to accept pre-staged artifact IDs.
5. Keep existing inline upload path behind a dev-only flag until the UI has migrated.
6. Update the UI to stage uploads first.
7. Change the Durable starter to receive only IDs.
8. Run `npm run build --workspaces`.

First engagement slice after the foundation:

1. Add shared engagement contracts and PostgreSQL JSONB repositories.
2. Add event schedule ingestion for uploaded or URL-based conference agendas.
3. Add an engagement projection activity that creates `EngagementEvent`, `AvailabilityWindow`, and
   `MeetingPlaceCandidate` records.
4. Add a recommendation activity that scores candidate/time/place options and writes
   `EngagementRecommendation` records.
5. Add MCP tools for `query_engagement_opportunities`, `recommend_meeting_slots`, and
   `get_engagement_plan`.
6. Add an Engagement Planner UI surface for recruiter review and approval.

Suggested file order:

```text
shared/src/artifacts.ts
shared/src/mcp-contracts.ts
shared/src/index.ts
api/src/db/pg-client.ts
api/src/db/repo/artifact-repo.ts
api/src/db/repo/index.ts
api/src/services/artifact-storage.ts
api/src/routes/uploads.ts
api/src/routes/ingestion.ts
functions/src/pipeline/http-start.ts
functions/src/pipeline/orchestrator.ts
functions/src/activities/document-intelligence.ts
ui/src/api.ts
ui/src/app.tsx
```

## 12. Anti-Patterns To Avoid

- Do not pass file bytes through Durable orchestration input.
- Do not pass full extracted text through Durable custom status.
- Do not return bulk raw documents from MCP tools.
- Do not trust tenant IDs supplied by the browser when a verified token is available.
- Do not create separate search query builders in API, Functions, and MCP.
- Do not use production account keys or shared secrets when managed identity is available.
- Do not make MCP tools long-running synchronous calls.
- Do not store predictions as observed facts.
- Do not display exact personal/home geospatial locations by default.
- Do not infer or expose private candidate availability from unrelated personal data.
- Do not auto-send invitations, emails, or messages from recommendation generation.
- Do not treat suggested engagement recommendations as confirmed meetings.
- Do not treat PostgreSQL JSONB tables as the petabyte-scale data store.

## 13. Compatibility With Current MVP

The current MVP can continue to exist while this architecture lands incrementally.

Recommended compatibility stance:

- Existing `FactVersion` and `BulletMapping` tables remain serving records for recruiter views.
- New artifacts become the durable source of large raw/derived data.
- Existing activities are refactored to read artifacts instead of inline payloads.
- Existing MCP capability folders remain the package boundaries, but stub tools are replaced with
  governed retrieval/action tools over time.
- New engagement capability folders can be added alongside temporal and geospatial capabilities;
  recommendations should compose those read models rather than duplicating them.
- Existing API endpoints can remain, but new large-data paths should go through artifact IDs and MCP
  excerpt retrieval.

## 14. Definition Of Done For TO-BE Foundation

The foundation is ready when:

- Uploads are staged to object storage before ingestion starts.
- Durable orchestration payloads contain only IDs and small control metadata.
- Artifact manifests and lineage are created for raw and derived artifacts.
- MCP retrieval tools return bounded excerpts with citations and cursors.
- MCP action tools return async job IDs.
- Search/index code is centralized behind one adapter.
- Engagement recommendations are generated from governed event, availability, temporal, and
  geospatial projections with citations and human approval state.
- Tenant-to-cell routing is enforced before data access.
- Production auth fails closed if gateway/audience/identity configuration is absent.
- All new paths build with `npm run build --workspaces`.
