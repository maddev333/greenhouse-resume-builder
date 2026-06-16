# Operational Runbook — Greenhouse Resume Builder MVP

## 1. Architecture Overview

```
┌─────────────┐     HTTPS      ┌──────────────────┐     HTTP      ┌─────────────────┐
│   React UI   │ ◄────────────► │ Express API (    │ ◄────────────► │ Cosmos DB       │
│             │  :3001/443     │  Azure App Service)│              │                 │
│ (Vite prod) │                │                  │               │ 7 Containers     │
└─────────────┘                │ /api/v1/* routes   │               │ + index schemas  │
                               └────────┬───────────┘               └─────────────────┘
                                        │ POST /search
                                        ▼
                              ┌──────────────────┐     HTTP      ┌─────────────────┐
                              │  Azure AI Search  │◄─────────────│ Resume Facts DB │
                              │                  │              └─────────────────┘
                              └────────┬─────────┘
                                       │
                    ┌──────────────────▼───────────────┐
                    │ Durable Functions (Azure Fn App) │
                    │ IngestCandidateOrchestrator       │
                    │ Pipeline: fetch→normalize→agents →│
                    │   dedup → builder → persist +search│
                    └──────────────────────────────────┘
```

## 2. Deployment Checklist

### 2.1 Prerequisites
- [ ] Azure subscription with access to: App Service, Functions (v4), Cosmos DB, Key Vault, AI Search
- [ ] Microsoft Entra ID app registration for both API and UI
- [ ] Domain/Certificate for HTTPS (or use Azure's .azurewebsites.net default)

### 2.2 Required Resource Creation Order
1. **Resource Group** (`rg-greenhouse-resume`)
2. **Key Vault** (`kv-greenhouse` — all secrets go here, NOT env vars directly)
3. **Cosmos DB** (SQL API, RU target: ~800–1500 read / ~400 write baseline, scaleable)
   - 7 containers (auto-created on boot via `ensureMVPContainersExist`)
4. **Azure AI Search** — Standard tier, replica count≥2 for reliability
5. **App Service plan** — Linux consumption or premium (B1+)
6. **Functions app** — Linux consumption (v4 isolated)
7. **Log Analytics workspace** — linked to App Service and Functions

### 2.3 Environment Variables per Service

| Variable | API (App Service) | Functions App | Key Vault Reference |
|----------|-------------------|---------------|---------------------|
| `COSMOS_ENDPOINT` | ✅ required | ✅ required | `kv-greenhouse/cosmos/endpoint` |
| `COSMOS_AUTH_KEY` | ✅ required | ✅ required | `kv-greenhouse/cosmos/key` |
| `AZURE_SEARCH_SERVICE` | ✅ production | ✅ (best-effort) | `kv-greenhouse/search/service` |
| `AZURE_SEARCH_API_KEY` | ✅ production | ✅ | `kv-greenhouse/search/api-key` |
| `AZURE_AD_JWKS_URI` | ✅ production | — N/A | `kv-greenhouse/aad/jwks-uri` |
| `AAD_ISSUER` | ✅ production | — | — |
| `AZURE_AD_CLIENT_ID` | ✅ production | — | `kv-greenhouse/app-registration/api-client-id` |
| `ENABLE_EXTERNAL_GUEST_ACCOUNTS` | ⚠️ dev-only | — | — |

### 2.4 Deployment Steps
```bash
# 1. Deploy API
npm ci  && npm run build
az appservice plan create --name asp --resource-group $RG \
    --sku B1 --is-linux
az webapp create --name resume-api --plan asp --resource-group $RG \
    --deployment-local-git
git remote add azure <deploy-url>
git push azure main  # or use CI/CD pipeline

# 2. Deploy Functions (use func CLI or Azure portal)
cd functions && npm ci && npm run build
func azure functionapp publish resume-funcs --build remote

# 3. Configure Key Vault references in Azure Portal → App Service / Function → Configuration
```

## 3. Health Checks & Readiness

### 3.1 HTTP Probes
| Endpoint | Purpose | Expected Response |
|----------|---------|-------------------|
| `GET /health` | Server up+ready (Cosmos containers verified) | `200 {"status":"ready","timestamp":"..."}` |
| `POST      /api/v1/search` | Search service health (body `{"query":"test"}`)  | `200 {"results":[],"total":0}` ✅ OR `503 "search not configured"` |
| `GET       /api/v1/stats`    | Runtime document counts                       | `200 {"factsTotal":N,"bulletsTotal":N,...}`          |

### 3.2 Cosmos DB Container Verification
On every API server start, `ensureMVPContainersExist()` verifies:
- All 7 containers exist (persons, sourceDocuments, extractionRuns, factVersions, bulletMappings, annotations, relationships)
- Creates any missing ones before routes are mounted
- Logs warning and continues if connection fails (graceful degradation for local dev)

### 3.3 Search Index Verification
On every API server start, `ensureSearchIndex()` verifies:
- Index `resume-facts` exists with correct fields
- Creates it automatically if missing
- No-op if `AZURE_SEARCH_*` env vars unset (dev mode)

## 4. Monitoring & Alerting

### 4.1 Metrics to Track (Azure Monitor / Application Insights)

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| HTTP 5xx errors | App Service | >0 in 5 min → PagerDuty |
| HTTP response p95 latency | App Service | >2s slow query risk |
| Cosmos DB RU consumed/second | Cosmos DB | >70% provisioned capacity |
| Cosmos DB quota error code 429 | Cosmos DB | Any = scale up RU |
| Durable Function orchestrator rehistory size | Functions App | >10MB → investigate payload blow-up |
| Failed function invocations | Functions App | >3 in 5 min → trigger investigation |
| Search indexing errors (warn log) | App Service logs | Check if env vars configured correctly |
| Stale runs count | Custom query | `status IN ('queued','in_progress')` older than 6h |

### 4.2 Log Query Examples (KQL — Log Analytics Workspace)

```kql
// Recent failed ingested candidates
traces
| where message contains "Error" or level == "Error"
| order by timestamp desc
| project timestamp, message, cloud_RoleName

// Orchestration pipeline duration
traces
| where message startswith "[Orchestrator]"
| extend msg = extractjson("$msg", tostring(customDimensions), typeof(string))
| project timestamp, message

// HTTP latency histogram
requests
| summarize count(), avg(durationMs) by bin(timestamp, 5m)
| render timechart

// Search queries (full-text)
traces
| where message startswith "[Orchestrator] search" or level == "Warning"
// Actually captured in logs as 'Search indexing complete' / failed upserts
```

### 4.3 Custom Alert Rules
1. **"Failed Orchestration Runs"** — Function App → Alerts → Condition: `FailedInvocations` > 0 × window 5 min
2. **"Cosmos RU Saturation"** — Cosmos DB → Alerts → Condition: `Total RU Consumed / Provisioned RU > 80%` × window 10 min  
3. **"Search Index Missing"** — App Service trace filter: `[Orchestrator] search indexing failed` appears in last hour
4. **"Stale Ingestion Runs Over 6h"** — Custom metric query counting runs with status `queued`/`in_progress` older than 6 hours

## 5. Known Operations Procedures

### 5.1 Scaling
- **API tier:** B1 → S1 for concurrent load; switch to P2v3 if >50 RPS sustained
- **Functions consumption:** scales automatically from 0–200 instances per plan limits
- **Cosmos DB:** auto-pilot recommended for MVP, disable auto-pilot if you need precise cost control

### 5.2 Data Migration (Cosmos)
```bash
# Export all Person records
az cosmosdb sql database execute-migration \
    --name resumeBuilder --resource-group $RG \
    --container-name persons --output-file backup-persons.json

# Restore from backup
# ... via Azure Portal → "Import/Export" feature or cosmos-cli tooling
```

### 5.3 Index Rebuild (Azure AI Search)
If the `resume-facts` index diverges from Cosmos DB state:
1. Delete old index in Azure Portal
2. Restart API pod — `ensureSearchIndex()` will recreate it on startup
3. Trigger a re-ingestion of affected candidates via the ingestion API

### 5.4 Emergency Reset
If pipeline is stuck in an infinite loop:
1. Check `ExtractionRun` status for hung runs (`queued`/`in_progress` > 6h)
2. Manual intervention: `PATCH /api/v1/ingestion-requests/{runId}/status` with status=`failed` and `{ reason: "manual-reset" }`
3. The cleanup orchestrator (runs every 6h) will auto-cleanup after the window

## 6. Runbook FAQ

### Q: Why are some search queries returning nothing?
**Check:** Is `AZURE_SEARCH_SERVICE` set in production API? If yes, verify the `resume-facts` index exists in portal and has data documents.

### Q: How do I find why an ingestion run failed?
**Check:** `GET /api/v1/ingestion-requests/{runId}/status` — look for `failedReason`. Also check Functions App logs: `[Orchestrator] Pipeline complete or [Orchestrator] Persistence failed (non-fatal)`

### Q: What's the max payload size per ingestion?
Approximately 5MB of source document content (PDFs + text). The orchestrator batches them as text blocks passed to section agents. Durable Function history limit applies at ~10–20MB for the whole orchestration payload.

### Q: How do I rotate secrets?
All secrets in Key Vault. Update `kv-greenhouse` entries, then restart App Service+Function App instances (they pick up ref changes automatically).
