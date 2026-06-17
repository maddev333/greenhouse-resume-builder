# Greenhouse Resume Builder MVP

> Agentic resume ingestion pipeline that extracts employment, skills, education, summary, relationship, and temporal-event data from uploaded CVs and web profiles — then normalizes everything into cited resume bullets, version diffs, and recruiter-reviewable predictions.

## 🚀 Quick Start

**New to the project? Start here:**

1. **Read the [Setup Summary](./SETUP_SUMMARY.md)** for a quick overview of recent changes
2. **Follow the [Development Guide](./DEVELOPMENT.md)** for detailed setup instructions
3. **Run the quick start script**:
   ```bash
   # Windows
   quick-start.bat
   
   # Linux/Mac
   chmod +x quick-start.sh && ./quick-start.sh
   ```

### Essential Steps

```bash
# 1. Environment setup (already done - .env exists with defaults)
# Edit .env if you need to configure Azure services or PostgreSQL

# 2. Install & build
npm ci
npm run build -w @greenhouse-resume-builder/shared

# 3. Start the API server (Express REST + PostgreSQL)
cd api && npm run dev
# API runs on http://localhost:3001

# 4. Start the React UI (Vite)
cd ui && npm run dev
# UI runs on http://localhost:5173

# 5. (Optional) Start Azure Functions (ingestion pipeline)
cd functions && npm run start:dev
# Functions run on http://localhost:7071
```

### VS Code Debugging

Press `F5` in VS Code and select:
- **Debug Full Stack** - Run API + UI with debugger attached
- **Debug API Server** - Debug the Express API
- **Debug Azure Functions** - Debug Functions runtime

See [DEVELOPMENT.md](./DEVELOPMENT.md) for complete debugging guide.

## Architecture Overview

### Data Layer
- **PostgreSQL** — structured store for persons, source docs, extraction runs, fact versions, bullet mappings, annotations, and relationships (auto-provisioned tables on startup)
- **Azure AI Search** — full-text indexing of resume facts and bullets
- **Azure Blob Storage** — raw document staging container (`raw` by default)

### Services
| Service | Description |
|---------|---|
| **API** (`api/`) | Express REST layer — ingestion, bullets/facts, annotations, relationships, search |
| **Functions** (`functions/`) | Durable Functions orchestration: extraction, deduplication, builder, persistence, indexing |
| **UI** (`ui/`) | React 18 + Vite — landing flow, candidate profile, diff, annotation, relationship, and search views |

### Capability Modules (`capabilities/`)

Each capability is a self-contained, independently deployable unit for IL5 compliance:

| Capability | MCP Servers | UI App |
|------------|-------------|---------|
| [Ingestion](./capabilities/ingestion) | `acquisition`, `extraction` | Ingestion Console |
| [Quality](./capabilities/quality) | `quality` | Review Queue |
| [Relationships](./capabilities/relationships) | `relationships` | Relationship Confirmation |
| [Temporal](./capabilities/temporal) | `temporal` | Prediction Review |
| [Geospatial](./capabilities/geospatial) | `geospatial` | Map Pins |
| [Discovery](./capabilities/discovery) | `search` | Resume + Diff |

Each module bundles:
- **1–2 MCP capability servers** (`mcp/<server>/`) — IL5 Azure Functions apps over Streamable HTTP
- **Agent framework runtime** (`agent/`) — self-hosted Azure OpenAI tool-calling loop
- **MCP UI App** (`ui/`) — recruiter surface (hybrid web + MCP App)

All capabilities share [`mcp-core`](./capabilities/mcp-core/) for IL5 identity, credential precedence, and cloud-configurable scopes.

> See `capabilities/README.md` for per-module build/run instructions.

## Directory Layout

```bash
greenhouse-resume-builder/
├── api/src/                  # Express REST API
│   ├── db/pg-client.ts       # PostgreSQL connection + auto-provisioned tables
│   ├── db/repo/              # Repository layer (persons, facts, bullets, etc.)
│   ├── middleware/           # Auth middleware (jose JWT / dev bypass)
│   ├── routes/               # REST endpoint modules
│   └── search/index.ts       # Azure AI Search index + query helpers
├── functions/src/
│   ├── pipeline/             # Durable Functions orchestrator + HTTP trigger
│   ├── activities/           # Section extraction, builder, dedup, summary, diff
│   ├── persistence/          # Cosmos → PG sync helper
│   └── services/             # Agent runtime bridge
├── capabilities/
│   ├── mcp-core/             # Shared MCP server + IL5 identity helpers
│   ├── ingestion/            # Acquisition + extraction MCP servers
│   ├── quality/              # Citation + conflict guardrails
│   ├── relationships/        # Inferred / recruiter-edited relationship edges
│   ├── temporal/             # Temporal pattern detection + event prediction
│   ├── geospatial/           # Azure Maps projection
│   └── discovery/            # Natural-language talent search + resume assembly
├── ui/src/                   # React 18 + Vite application
├── shared/src/               # Shared types & DTOs
└── docs/                     # Operational docs
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
| `POST` | `/api/v1/search` | Search bullets/facts (Azure AI Search) |
| `GET`  | `/api/v1/stats` | Runtime document counts and status |
| `GET`  | `/health` | Health probe |

## Authentication

- **UI sign-in**: the Vite app uses MSAL and `VITE_AZURE_AD_CLIENT_ID` to sign in with Microsoft Entra ID, then requests an API token for `VITE_API_SCOPE` or `api://VITE_API_CLIENT_ID/.default`.
- **API validation**: the Express API verifies Entra access tokens with `jose`, remote JWKS, accepted audiences, issuer prefixes/exact issuers, and tenant/user claims (`api/src/middleware/auth.middleware.ts`). Production verification activates when `AZURE_AD_JWKS_URI` is set, or `AZURE_TENANT_ID` **plus** an audience (`AZURE_AD_CLIENT_ID`/`AZURE_AD_AUDIENCE`/`AZURE_AD_VALID_AUDIENCES`) is set.
- **Token propagation**: all UI REST calls use the same MSAL access-token provider. The API exposes the validated user as `req.user` and keeps the raw token as `req.accessToken` for OBO-capable downstream calls.
- **Nested SSO**: Azure AI Search calls use OBO when the API has OBO configuration. The Functions starter call uses OBO or managed identity via `FUNCTIONS_TOKEN_SCOPE`; Durable orchestration receives only user/tenant metadata, not raw bearer tokens, so tokens are not persisted in Durable history.
- **Function boundary**: the Durable HTTP starter authenticates the calling API (trusted-subsystem) before trusting the forwarded tenant/user identity. Enable it by setting `FUNCTIONS_AUTH_AUDIENCE` (to the resource of `FUNCTIONS_TOKEN_SCOPE`); when unset it is not enforced, so otherwise protect the endpoint with platform auth (EasyAuth/APIM) or network isolation (`functions/src/pipeline/validate-caller.ts`).
- **Dev mode**: `ALLOW_DEV_AUTH_BYPASS=true` is a local-only bypass — it is ignored when `NODE_ENV=production`. With neither the bypass nor a JWKS audience configured the API **fails closed** (rejects requests) rather than trusting unverified token claims.

## Database (PostgreSQL)

Tables are auto-created on API startup. Each entity stores its data in a JSONB column:

```sql
CREATE TABLE persons (id TEXT PRIMARY KEY, data JSONB NOT NULL);
-- + 6 more tables
```

Supported tables: `persons`, `source_documents`, `extraction_runs`, `fact_versions`, `bullet_mappings`, `annotations`, `relationships`.

Connection supports both password auth and AAD managed identity (default for IL5). When `PGPASSWORD` is blank, the API uses `DefaultAzureCredential` to request an AAD token per connection.

## Current implementation guidance

### Verified moved-forward areas
- Ingestion create responses are documented in current handoff docs as aligned around `sourceDocumentIds`.
- Production auth is now documented as `jose`-based rather than manual/non-cryptographic parsing.
- Builder bullet IDs are documented as including `personId`.
- App root routing is documented as switching between landing and candidate profile views.
- The previously noted duplicate `searchConfigured` stats-field bug is no longer an active top-level issue.

### Highest-value remaining work
1. Run build/type verification across packages and record exact blockers.
2. Validate the landing-page ingestion workflow end to end:
   - submit ingestion requests with auth headers
   - poll run status against a running Functions host
   - navigate to resolved candidate state
   - show loading/error states under real failures
   - populate recent runs from `GET /api/v1/ingestion-requests`
   - stage uploaded files before Document Intelligence processing
3. Wire MCP server handlers in each capability module to the real `functions/src/activities` logic.
4. Validate search implementation (Azure AI Search query/filter behavior) with a fresh build/type pass.
5. Implement Azure Maps/map-pin workflow; current map support is architecture/plan only.

## Known constraints

- Search integration should not be treated as fully validated until a fresh build/type pass confirms current client usage and query/filter behavior.
- The UI landing page is partially wired — upload staging, auth/header behavior, runtime polling behavior, and recent-run behavior need end-to-end validation.
- Temporal event extraction, recurrence detection, event prediction, and recruiter alerts are target architecture/implementation-plan items, not verified runtime behavior.
- Azure Maps pins for location-bearing records are target architecture/handle only — unimplemented.
- Some docs in the repo may lag behind `NEXT_AGENT.md` and `IMPLEMENTATION_STATUS.md`; use those two files first when directing the next coding pass.

## Recommended docs to read first

1. `NEXT_AGENT.md` — immediate handoff and current priorities
2. `IMPLEMENTATION_STATUS.md` — code-aligned status by subsystem
3. `AGENT_TASKS.md` — broader backlog and acceptance criteria
4. `mvp_implementation_plan.md` — narrowed execution plan for the next implementation slice
