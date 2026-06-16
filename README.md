# Greenhouse Resume Builder MVP

> Agentic resume ingestion pipeline that extracts employment, skills, education, summary, relationship, and temporal-event data from uploaded CVs and web profiles — then normalizes everything into cited resume bullets, version diffs, and recruiter-reviewable predictions.

## Project Setup

```bash
# Install and build all packages (monorepo via npm workspaces)
npm ci && npm run build --workspaces

# Start the API server
npm run dev --workspace=@greenhouse-resume-builder/api

# Start the React UI
npm run dev --workspace=@greenhouse-resume-builder/ui
```

## Architecture Overview

- **Cosmos DB** — structured data store for people, source docs, extraction runs, fact versions, bullet mappings, annotations, and relationships
- **Azure Durable Functions** — async ingestion orchestration across extraction, deduplication, builder, persistence, and indexing stages
- **Express API layer** (`api/`) — REST endpoints for ingestion, bullets/facts retrieval, annotations, relationships, and search
- **Azure AI Search** — search/indexing support for resume facts and bullets
- **React 18 + Vite UI** (`ui/`) — landing flow plus candidate profile, diff, annotation, relationship, and search views
- **Target temporal intelligence** — planned TemporalEvent, EventPattern, EventPrediction, and RecruiterAlert flows for recurring candidate activity such as annual conference presentations
- **Target Azure Maps UI** — planned map pins/clusters for database records that include approved location metadata

> Current implementation detail and caveats are tracked in `IMPLEMENTATION_STATUS.md`. Use that file and `NEXT_AGENT.md` as the operational source of truth for the next coding pass.

## Directory Layout

```bash
greenhouse-resume-builder/
├── shared/src/          # Shared types & DTOs
├── functions/
│   ├── src/pipeline/    # Durable Functions orchestration
│   ├── src/activities/  # Section extraction, builder, dedup, summary
│   └── src/persistence/ # Persistence and indexing helpers
├── api/src/
│   ├── db/repo/         # Cosmos repositories
│   ├── middleware/      # Auth middleware
│   ├── routes/          # REST endpoint modules
│   └── search/          # Search helpers/index wiring
├── ui/src/              # React application
└── docs/                # Operational docs
```

## REST API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/v1/ingestion-requests` | Submit source doc(s) for ingestion |
| `GET`  | `/api/v1/ingestion-requests/:runId/status` | Poll ingestion status |
| `GET`  | `/api/v1/ingestion-requests` | List/filter ingestion runs |
| `GET`  | `/api/v1/insights/:personId/bullet-mappings` | Get resume bullets with citations |
| `GET`  | `/api/v1/insights/:personId/facts` | Get extracted fact versions |
| `GET`  | `/api/v1/insights/:personId/differences` | Get bullet-level diffs between runs |
| `PUT/PATCH/DELETE` | `/api/v1/annotations/:id` | Annotation CRUD |
| `GET`  | `/api/v1/inferences/:personId/suggested` | Relationship suggestions |
| `PATCH` | `/api/v1/inferences/:relationshipId` | Confirm/reject relationship suggestions |
| `POST` | `/api/v1/search` | Search bullets/facts |
| `GET`  | `/api/v1/stats` | Runtime document counts and status |
| `GET`  | `/health` | Health probe |

## Authentication

- **Dev mode**: permissive bearer-token bypass for local development
- **Production mode**: `jose`-based JWT verification against remote JWKS in `api/src/middleware/auth.middleware.ts`

Keep dev-mode bypass documented as local-only behavior.

## Current implementation guidance

### Verified moved-forward areas
- Ingestion create responses are documented in current handoff docs as aligned around `sourceDocumentIds`.
- Production auth is now documented as `jose`-based rather than manual/non-cryptographic parsing.
- Builder bullet IDs are documented as including `personId`.
- App root routing is documented as switching between landing and candidate profile views.
- The previously noted duplicate `searchConfigured` stats-field bug is no longer an active top-level issue.

### Highest-value remaining work
1. Validate and harden the landing-page ingestion workflow end to end:
   - submit ingestion requests with auth headers
   - poll run status against a running Functions host
   - navigate to resolved candidate state
   - show loading/error states under real failures
   - populate recent runs from `GET /api/v1/ingestion-requests`
   - stage uploaded files before Document Intelligence processing
2. Run build/type verification across packages and record exact blockers.
3. Keep search implementation notes aligned with verified build/runtime findings.
4. Keep Cosmos `/id` partition-key usage documented as an MVP tradeoff, not a production-optimized design.
5. Implement the newly documented temporal-event and prediction workflow; current temporal intelligence is architecture/plan only.
6. Implement the newly documented Azure Maps/map-pin workflow; current map support is architecture/plan only.

## Known constraints and cautions

- Cosmos containers still appear to use default `/id` partition keys.
- Search integration should not be treated as fully validated until a fresh build/type pass confirms current client usage and query/filter behavior.
- The UI landing page is partially wired, but upload staging, auth/header behavior, runtime polling behavior, and recent-run behavior should still be validated end to end.
- Temporal event extraction, recurrence detection, event prediction, and recruiter alerts are target architecture/implementation-plan items, not verified runtime behavior.
- Azure Maps pins for location-bearing records are target architecture/implementation-plan items, not verified runtime behavior.
- Some docs in the repo may still lag behind `NEXT_AGENT.md` and `IMPLEMENTATION_STATUS.md`; use those two files first when directing the next coding pass.

## Recommended docs to read first

1. `NEXT_AGENT.md` — immediate handoff and current priorities
2. `IMPLEMENTATION_STATUS.md` — code-aligned status by subsystem
3. `AGENT_TASKS.md` — broader backlog and acceptance criteria
4. `mvp_implementation_plan.md` — narrowed execution plan for the next implementation slice
