# Functions — Durable ingestion pipeline

Azure **Durable Functions** app (Node v4 programming model) that runs the resume
ingestion pipeline: fetch/extract source documents, segment sections, run the
builder agent, deduplicate persons, persist to PostgreSQL, and index to Azure AI
Search.

| Item | Value |
| --- | --- |
| Runtime | Node.js 20/22/24 on Functions **v4** |
| Hosting (recommended) | **Flex Consumption** (Linux) |
| Durable task hub | `resumeBuilderHub` (`host.json`) |
| HTTP triggers | `POST /api/orchestrators/IngestCandidateOrchestrator`, `POST /api/deconflict` |
| Deploy package | `.deploy/ghresume-functions-deploy.zip` (self-contained, `node_modules` bundled) |

The deploy zip is produced by `functions/scripts/package-zip.mjs`. Because this is
an npm-workspaces monorepo, that script assembles an **isolated, production-only**
package (the `@greenhouse-resume-builder/shared` workspace is shipped as a local
tarball) so the zip carries a complete `node_modules` and runs with **no build
step on the server**.

---

## Prerequisites

- **Azure CLI** ≥ 2.60 — `az version` (run `az upgrade` if older). `az login` first.
- **Node.js** 20+ and a clean `npm install` at the repo root.
- An Azure subscription with these resources reachable by the app (see
  [App settings reference](#app-settings-reference)):
  PostgreSQL Flexible Server, Storage account, Azure AI Document Intelligence,
  and (recommended) Azure OpenAI + Azure AI Search.
- *(Optional)* **Azure Functions Core Tools** v4 (`func`) for local `func start` and log streaming.

---

## Redeploy (the common loop)

Once the Function App exists (see [one-time setup](#one-time-azure-setup) below),
every code change is just **two steps** run from the **repo root**:

```powershell
# 1. Build shared + functions and produce the self-contained zip at .deploy\
npm run package:zip --workspace functions

# 2. Push the zip to the existing Function App
az functionapp deployment source config-zip --resource-group $RG --name $APP --src .deploy\ghresume-functions-deploy.zip
```

No `--build-remote` is needed — the zip already bundles `node_modules`.

> Set `$RG` / `$APP` for your environment, e.g. `$RG = "ghresume-rg"`, `$APP = "ghresume-functions"`.
> On bash, use `RG=...`, `APP=...`, and `--src .deploy/ghresume-functions-deploy.zip`.

Then [verify the deployment](#verify).

> **Why not `func azure functionapp publish`?** In this hoisted npm-workspaces
> monorepo the runtime deps live in the **root** `node_modules` and the `shared`
> package is unpublished, so a plain `func` publish (or remote `npm install`) ships
> an incomplete tree and fails. Always deploy the `package:zip` output, which
> bundles a complete `node_modules`.

---

## One-time Azure setup

Skip this if the Function App already exists.

```powershell
# ── Variables (edit these) ──────────────────────────────────────────
$RG       = "ghresume-rg"           # reuse your existing resource group
$LOCATION = "eastus2"               # match your API / PG / Search / OpenAI region
$STORAGE  = "ghresumefuncsa"        # 3–24 lowercase alphanumerics, globally unique
$APP      = "ghresume-functions"    # globally unique function-app name
```

### 1. Create the resources

```powershell
# Confirm the region supports Flex Consumption
az functionapp list-flexconsumption-locations --query "sort_by(@, &name)[].{Region:name}" -o table

az group create --name $RG --location $LOCATION

az storage account create --name $STORAGE --resource-group $RG --location $LOCATION --sku Standard_LRS --allow-blob-public-access false

az functionapp create --resource-group $RG --name $APP --storage-account $STORAGE --flexconsumption-location $LOCATION --runtime node --runtime-version 22 --functions-version 4

# Recommended: managed identity so PG / Search / OpenAI / Document Intelligence / Blob use the passwordless path
az functionapp identity assign --resource-group $RG --name $APP
```

`az functionapp create` automatically sets `AzureWebJobsStorage` (required by
Durable Functions), `FUNCTIONS_EXTENSION_VERSION=~4`, `FUNCTIONS_WORKER_RUNTIME=node`,
and provisions an Application Insights instance.

> If the CLI rejects `--runtime-version 22`, run `az upgrade` or use `20`. Node `24` also works.

### 2. Configure app settings

The app starts without these but fails at runtime — set them before deploying.
Fill values from your `.env`; omit the `*_KEY` settings to rely on managed identity.

```powershell
az functionapp config appsettings set --resource-group $RG --name $APP --settings `
  "PGHOST=<pg-host>" "PGUSER=<user-or-MI-name>" "PGDATABASE=resume_builder" "PGSSLMODE=require" `
  "AZURE_STORAGE_ACCOUNT_NAME=$STORAGE" `
  "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=<di-endpoint>" `
  "AZURE_OPENAI_ENDPOINT=<aoai-endpoint>" "AZURE_OPENAI_DEPLOYMENT=<deployment>" `
  "AZURE_SEARCH_SERVICE=<search-name>" `
  "AZURE_TENANT_ID=<tenant-guid>"
```

### 3. (If using managed identity) grant data-plane roles

Assign these to the Function App's identity (`az functionapp identity show` for the principal ID):

| Resource | Role |
| --- | --- |
| Storage account | Storage Blob Data Contributor |
| Azure OpenAI + Document Intelligence | Cognitive Services User |
| Azure AI Search | Search Index Data Contributor |
| PostgreSQL Flexible Server | Provisioned Entra role / AD admin for `PGUSER` |

### 4. Deploy

Run the [redeploy loop](#redeploy-the-common-loop) above.

---

## Verify

```powershell
# Functions should register (2 HTTP triggers, the orchestrator, and ~15 activities)
az functionapp function list --resource-group $RG --name $APP -o table
```

Expect to see `IngestCandidateOrchestratorHttpStart`, `DeconflictPersonsHttp`,
`IngestCandidateOrchestrator`, and the activities (`StoreUploadsAndExtract`,
`ResumeBuilderAgent`, `PersistBuilderOutput`, …). An **empty list** means the app
failed to load — see [Troubleshoot](#troubleshoot).

Smoke-test the HTTP starter (it's protected when `FUNCTIONS_AUTH_AUDIENCE` is set —
send a valid Bearer token, otherwise expect `202` with an empty body):

```powershell
curl -X POST "https://$APP.azurewebsites.net/api/orchestrators/IngestCandidateOrchestrator" -H "Content-Type: application/json" -d '{"runId":"smoke","tenantId":"t","webUrls":[]}'
```

---

## Troubleshoot

```powershell
# Live log stream
az webapp log tail --resource-group $RG --name $APP

# Confirm required settings exist (AzureWebJobsStorage, PG*, AZURE_*)
az functionapp config appsettings list --resource-group $RG --name $APP -o table

# Runtime errors / traces from Application Insights (most reliable on Flex Consumption)
az monitor app-insights query --resource-group $RG --apps $APP --analytics-query "union traces,exceptions | order by timestamp desc | take 50"
```

Common issues:

- **`function list` is empty / app won't start** — usually a bad or missing
  `AzureWebJobsStorage`, or a broken `dist`/`node_modules` in the zip. Rebuild with
  `npm run package:zip --workspace functions` and redeploy.
- **`28P01` / Postgres auth failed** — `PGUSER` must be a provisioned Entra principal
  when `PGPASSWORD` is empty (the built-in `postgres` role is password-only).
- **No facts from uploaded files** — `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` missing,
  so document extraction is skipped.
- **Lower-quality extraction** — `AZURE_OPENAI_ENDPOINT`/`AZURE_OPENAI_DEPLOYMENT`
  unset, so the agent falls back to heuristics.
- **Caller rejected (401)** — the API must present a valid token for
  `FUNCTIONS_AUTH_AUDIENCE`; set `FUNCTIONS_HOST`/`FUNCTIONS_TOKEN_SCOPE` on the API side.

---

## App settings reference

`AzureWebJobsStorage`, `FUNCTIONS_EXTENSION_VERSION`, `FUNCTIONS_WORKER_RUNTIME`
are set automatically by `az functionapp create`. Every Azure dependency accepts
**either** a key/connection string **or** managed identity (`DefaultAzureCredential`).

| Group | Setting | Required | Notes |
| --- | --- | --- | --- |
| PostgreSQL | `PGHOST`, `PGUSER`, `PGDATABASE` | ✅ | `PGDATABASE` defaults to `resume_builder` |
| | `PGPASSWORD` | ⬜ | Leave empty to use managed identity (Entra token) |
| | `PGSSLMODE`, `PG_AAD_SCOPE`, `PG_POOL_MAX`, `DATABASE_URL` | ⬜ | `PGSSLMODE=require` for Azure PG |
| Blob storage | `AZURE_STORAGE_ACCOUNT_NAME` | ✅ | Containers `raw` / `web-snapshots` auto-created |
| | `AZURE_STORAGE_ACCOUNT_KEY`, `AZURE_STORAGE_CONNECTION_STRING` | ⬜ | Omit for managed identity |
| | `AZURE_STORAGE_CONTAINER`, `AZURE_WEB_SNAPSHOT_CONTAINER`, `AZURE_STORAGE_ENDPOINT_SUFFIX` | ⬜ | Defaults `raw`, `web-snapshots`, `core.windows.net` |
| Document Intelligence | `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` | ✅ | Required to extract text from uploads |
| | `AZURE_DOCUMENT_INTELLIGENCE_KEY`, `AZURE_DOCUMENT_INTELLIGENCE_AUDIENCE` | ⬜ | Omit key for MI; audience for sovereign clouds |
| Azure OpenAI | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` | 🟡 | Recommended; without it the agent uses heuristics |
| | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_TOKEN_SCOPE`, `AZURE_OPENAI_TIMEOUT_MS`, `AGENT_MODE` | ⬜ | Omit key for MI |
| Azure AI Search | `AZURE_SEARCH_SERVICE` | 🟡 | Needed for the search feature / indexing |
| | `AZURE_SEARCH_API_KEY`, `AZURE_SEARCH_ENDPOINT_SUFFIX` | ⬜ | Omit key for MI (needs Search Index Data Contributor) |
| Caller auth | `AZURE_TENANT_ID` | ✅ | Validates the API→orchestrator call |
| | `FUNCTIONS_AUTH_AUDIENCE`, `FUNCTIONS_AUTH_JWKS_URI`, `FUNCTIONS_AUTH_ISSUER_PREFIXES`, `FUNCTIONS_AUTH_VALID_ISSUERS`, `FUNCTIONS_AUTH_ALLOWED_CALLERS` | ⬜ | When unset, caller auth is **not** enforced — protect via APIM / network isolation |

✅ required · 🟡 recommended · ⬜ optional

---

## Local development

```bash
# from repo root
cd functions && npm run start:dev   # tsc --watch + func start on http://localhost:7071
```

Local settings live in `functions/local.settings.json` (`AzureWebJobsStorage=UseDevelopmentStorage=true`
via Azurite). This file is **never** shipped in the deploy zip.
