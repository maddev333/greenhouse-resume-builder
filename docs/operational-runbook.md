# Operational Runbook - Greenhouse Resume Builder MVP

## 1. Architecture Overview

```text
React UI / MCP UI Apps
        |
        | HTTPS + Entra token
        v
Express API (App Service or approved IL5 compute)
        |
        +--> PostgreSQL JSONB metadata/control store
        |    - persons, source_documents, extraction_runs
        |    - fact_versions, bullet_mappings, annotations, relationships
        |
        +--> Azure AI Search resume-facts index
        |
        +--> Durable Functions ingestion pipeline
                 |
                 +--> Blob Storage / Document Intelligence / Azure OpenAI
                 +--> PostgreSQL JSONB persistence
                 +--> Azure AI Search best-effort indexing

Capability MCP servers run as independently deployable Functions/App Service/AKS/ACI workloads behind APIM. Geospatial is currently the most complete capability and projects map pins through Azure Maps.
```

For petabyte-scale storage, do not expand JSONB payloads indefinitely. Follow `TOBE_ARCHITECTURE.md`: immutable artifacts in Blob/ADLS-style storage, PostgreSQL metadata/manifests, lineage, and rebuildable serving indexes.

## 2. Deployment Checklist

### 2.1 Prerequisites

- [ ] Node.js 20+
- [ ] PostgreSQL database or approved PostgreSQL hosting for the target boundary
- [ ] Azure Functions v4 runtime
- [ ] Microsoft Entra ID app registrations for UI, API, and optionally Functions
- [ ] Azure AI Search service for search runtime validation
- [ ] Blob Storage for raw artifacts/uploads
- [ ] Document Intelligence for PDF/image/document parsing
- [ ] Azure OpenAI deployment for model-backed activities/agents
- [ ] Azure Maps account for geospatial projection and browser map rendering
- [ ] Key Vault or approved secret/configuration store
- [ ] Log Analytics / Azure Monitor / approved audit sink

### 2.2 Required Resource Creation Order

1. Resource group and network boundary.
2. Key Vault/configuration store.
3. PostgreSQL database and identity/RBAC setup.
4. Storage account/containers for raw uploads, web snapshots, and future artifacts.
5. Azure AI Search service and permissions.
6. Azure OpenAI, Document Intelligence, and Azure Maps resources.
7. App Service/Functions/AKS/ACI hosts for API, Functions, and MCP capability servers.
8. Monitoring/audit sinks and alerts.

For IL5 deployments, verify the selected PostgreSQL hosting pattern is approved for the target environment. The code supports PostgreSQL; the accreditation boundary decides the exact managed or self-managed hosting option.

## 3. Environment Variables

The root `.env.example` is the canonical template. Important production settings include:

| Area                  | Variables                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL            | `DATABASE_URL` or `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE`, `PG_AAD_SCOPE`                                   |
| API auth              | `AZURE_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_JWKS_URI`, `AZURE_AD_VALID_AUDIENCES`, `AZURE_AD_ISSUER_PREFIXES`                      |
| Local dev auth        | `ALLOW_DEV_AUTH_BYPASS=true` only outside production                                                                                      |
| OBO                   | `AZURE_OBO_TENANT_ID`, `AZURE_OBO_CLIENT_ID`, `AZURE_OBO_CERTIFICATE_PATH` or federated managed identity settings                         |
| Functions boundary    | `FUNCTIONS_HOST`, `FUNCTIONS_TOKEN_SCOPE`, `FUNCTIONS_AUTH_AUDIENCE`, `FUNCTIONS_AUTH_ALLOWED_CALLERS`                                    |
| Blob Storage          | `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_ACCOUNT_KEY` or managed identity, `AZURE_STORAGE_CONTAINER`, `AZURE_STORAGE_ENDPOINT_SUFFIX` |
| Search                | `AZURE_SEARCH_SERVICE`, `AZURE_SEARCH_API_KEY` or managed identity, `AZURE_SEARCH_ENDPOINT_SUFFIX`                                        |
| Document Intelligence | `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`, optional `AZURE_DOCUMENT_INTELLIGENCE_KEY`, `AZURE_DOCUMENT_INTELLIGENCE_AUDIENCE`                |
| Azure OpenAI          | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_TOKEN_SCOPE`                                |
| Azure Maps            | `AZURE_MAPS_KEY` for local dev or `AZURE_MAPS_CLIENT_ID` for managed identity, `AZURE_MAPS_ENDPOINT`, `AZURE_MAPS_TOKEN_SCOPE`            |

Keys and connection strings are local-dev conveniences. IL5/prod posture should use managed identity or OBO where the service supports it.

## 4. Build And Startup

### 4.1 Build

```bash
npm ci
npm run build --workspaces
```

The full workspace build passed on 2026-06-18. Main UI and geospatial UI may emit Vite chunk-size warnings; those are performance warnings, not build failures.

### 4.2 Local startup

```bash
# Terminal 1
cd api
npm run dev

# Terminal 2
cd functions
npm run start:dev

# Terminal 3
cd ui
npm run dev
```

API defaults to port `3001`, Functions to `7071`, and UI to `5173` unless overridden.

## 5. Health Checks And Readiness

| Check                            | Expected result                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /health`                    | `200` with `{ "status": "ready", "timestamp": "..." }`                                  |
| API startup logs                 | `PostgreSQL tables verified`; Search may report no-op when not configured               |
| `GET /api/v1/stats`              | Counts from PostgreSQL plus `searchConfigured`                                          |
| `POST /api/v1/search`            | Results when Search is configured; empty array when no matching records or Search no-op |
| `GET /api/v1/ingestion-requests` | Recent PostgreSQL-backed runs                                                           |

### PostgreSQL verification

On API startup, `ensureMVPTablesExist()` creates/verifies:

- `persons`
- `source_documents`
- `extraction_runs`
- `fact_versions`
- `bullet_mappings`
- `annotations`
- `relationships`

Functions independently ensure the same table set when the persistence helper initializes.

### Search verification

On API startup, `ensureSearchIndex()` creates or verifies the `resume-facts` index when `AZURE_SEARCH_SERVICE` is configured. Search runtime still needs smoke testing against a real service after any schema/document changes.

## 6. Monitoring And Alerts

Track these first:

| Metric                             | Source               | Suggested alert                                         |
| ---------------------------------- | -------------------- | ------------------------------------------------------- |
| API 5xx errors                     | App Service/API host | Any sustained increase over 5 minutes                   |
| API p95 latency                    | App Service/API host | >2s sustained                                           |
| PostgreSQL connections             | PostgreSQL           | Near pool/database limit                                |
| PostgreSQL CPU/storage             | PostgreSQL           | Sustained high CPU or disk pressure                     |
| Failed Functions invocations       | Functions App        | >3 in 5 minutes                                         |
| Durable orchestration history size | Functions App        | Investigate payload blow-up                             |
| Search indexing warnings/errors    | API/Functions logs   | Any repeated indexing failure                           |
| Stale ingestion runs               | PostgreSQL query     | `queued`/`in_progress` older than the cleanup threshold |
| Governance denies/errors           | Audit sink           | Unexpected deny spike or policy evaluation errors       |

Example stale-run query pattern:

```sql
SELECT id, data->>'status' AS status, data->>'createdAt' AS created_at
FROM extraction_runs
WHERE data->>'status' IN ('queued', 'in_progress')
  AND data->>'createdAt' < to_char(now() - interval '6 hours', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
```

## 7. Operations Procedures

### 7.1 Search index rebuild

If the `resume-facts` index diverges from PostgreSQL state:

1. Snapshot or export the current Search index definition if needed.
2. Delete the stale `resume-facts` index in the dev/test service.
3. Restart the API so `ensureSearchIndex()` recreates it.
4. Re-ingest affected candidates or run a future index rebuild job once implemented.

### 7.2 Failed ingestion run

1. Query `GET /api/v1/ingestion-requests/{runId}/status`.
2. Check `failedReason` first; API starter failures are now written back to the run.
3. Check Functions logs for `[Orchestrator]` messages and activity failures.
4. If the run is stuck, use the cleanup orchestration or a controlled PostgreSQL update through the repository/admin path. Avoid ad hoc manual edits except during break-glass recovery.

### 7.3 Secret/key rotation

1. Prefer managed identity/OBO over rotating long-lived keys.
2. For unavoidable local/dev keys, rotate in Key Vault/config store.
3. Restart API/Functions/MCP hosts that cache SDK clients or credentials.
4. Confirm health checks and one search/geospatial/ingestion smoke test.

### 7.4 PostgreSQL backup and restore

Use the approved backup mechanism for the selected PostgreSQL host. For MVP local/dev, `pg_dump`/`pg_restore` is sufficient:

```bash
pg_dump "$DATABASE_URL" --format custom --file backup-resume-builder.dump
pg_restore --clean --if-exists --dbname "$DATABASE_URL" backup-resume-builder.dump
```

## 8. FAQ

### Why did an ingestion run stay in progress?

Check whether the API could reach `FUNCTIONS_HOST`, whether Functions accepted the service token if configured, and whether the orchestrator wrote a later failed/completed status.

### Why are search queries empty?

Confirm `AZURE_SEARCH_SERVICE` is set, the `resume-facts` index exists, documents have been indexed, and the caller has a verified tenant claim. The query helper fails closed when no tenant is available.

### Why is the Map tab missing?

The candidate page only shows the Map tab when facts include keys ending in `.location`. The map also depends on the geospatial MCP endpoint and Azure Maps configuration.

### What is the current largest architecture risk?

Inline upload bytes still travel through the MVP orchestration path. The next storage slice should stage bytes to Blob/artifact manifests and pass only source/artifact IDs to Durable Functions.
