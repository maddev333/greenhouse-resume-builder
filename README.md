# Strategic Engagements Travel Planner — MVP Demo

A CRM-style planning assistant for U.S. Army senior-leader engagements, delivered as a
**chat UI that hosts MCP UI Apps**. You ask a natural-language question; an orchestrator
agent calls a domain capability (living behind MCP tools) and answers with a menu of
who-to-meet cards plus an interactive **Azure Maps** trip itinerary rendered as a sandboxed
MCP App.

> The "money moment": _"you're already going there"_ — the planner batches stale or
> high-value contacts into a trip a leader is already taking.

> **No access control.** The capability server applies **no** security trim — no tenant
> isolation, no group ACLs, no sensitivity gating. **Any caller sees the entire corpus** the
> configured backend holds. Put access control in front of this stack if you need it.

## What the demo shows

Open the chat host and ask:

> _I'm planning a trip to AUSA — who should I meet on the UAS/drone topic?_

You get an assistant summary, a menu of candidate contacts, and a live trip map. Follow-ups
(_"why these meetings?"_, _"give me a day-by-day breakdown"_) reuse the same plan; the
`Plan a trip` wizard walks an area-first flow deterministically, with no model required.

## Repository layout

```
capabilities/
  engagements/            ← the demo (the only capability wired up)
    mcp/engagements/      MCP capability server: retrieval (seed / Azure AI Search / grounding),
                          the deterministic planner tools, and the ui://trip-map App
    mcp/discovery/        Area Discovery MCP server over Azure Maps POI search
    agent/                TS orchestration gateway + Python MAF/AGT runtime
    ui/                   M6 chat UI + real MCP-Apps host (the interface you run)
  mcp-core/               shared MCP-server and identity/token helpers
shared/                   canonical Strategic Engagements domain schema (framework-free types)
engagement-intelligence/  design docs (ARCHITECTURE, DEMO-DATASET, MVP-PLAN) + seed dataset
governance/               Agent Governance Toolkit policy loaded by the Python runtime
scripts/                  Azure Web App packaging (ZIP artifacts)
```

## Quickstart

Prerequisites: **Node 20+**, npm, and **Python 3.11+**. Install both ecosystems once:

```powershell
# from the repo root, one time:
npm install
npm run build -w @greenhouse-resume-builder/shared -w @greenhouse-resume-builder/mcp-core
npm run setup:python --workspace @greenhouse-resume-builder/cap-engagements-agent
az login          # optional — enables the Azure OpenAI path; a deterministic fallback runs without it
```

`npm install` does **not** compile the two library workspaces; the build step above does. The `demo`
script runs it for you through its `predemo` hook, but any manual/three-terminal run needs it first
or the servers fail with `ERR_MODULE_NOT_FOUND`.

Then start the whole demo. The agent workspace launches its TypeScript gateway and the Python
Microsoft Agent Framework + Agent Governance Toolkit runtime together:

```powershell
npm run demo --workspace @greenhouse-resume-builder/cap-engagements-ui
```

Open **http://localhost:8080**. Press `Ctrl+C` to stop.

Full run details, the manual three-terminal path, config, and troubleshooting live in
[`capabilities/engagements/ui/README.md`](capabilities/engagements/ui/README.md).

## Consuming this repo as an upstream

If you fork this repo to build on top of it, set it up so upstream releases replay **under** your
work instead of colliding with it. Merge conflicts come from overlapping edits, not from the pull
command — so keep `main` a read-only mirror and do your work on a branch.

```powershell
git remote add upstream https://github.com/maddev333/greenhouse-resume-builder
git config pull.rebase true
git config rerere.enabled true     # auto-reuses past conflict resolutions

# never commit on main:
git checkout main
git fetch upstream
git reset --hard upstream/main     # main is a read-only mirror
git push origin main

# your work lives on a branch that replays on top of upstream:
git checkout customer/main
git rebase upstream/main
```

Rebasing replays your commits on top of the new upstream history, so a conflict surfaces once per
commit instead of accumulating into one large merge; `rerere` then auto-applies any resolution you
have already made the next time the same hunk conflicts.

To avoid conflicts entirely, **configure rather than edit**. Every customization point below lives
outside the tracked tree, so upstream can change those files freely:

| To change            | Do this — no tracked file is touched                               |
| -------------------- | ------------------------------------------------------------------ |
| Any setting / secret | Root `.env` (gitignored; copy from `.env.example`)                 |
| Seed dataset         | `ENGAGEMENTS_SEED_DIR=<your-path>`                                 |
| Governance policy    | `AGT_POLICY_PATH` (or `GOVERNANCE_POLICY_PATH`)                    |
| Index declarations   | `ENGAGEMENTS_INDEX_SCHEMAS=<your-path>` — see the next section     |
| New behavior         | A new folder under `capabilities/`, which upstream never writes to |

Additive files in new directories cost nothing at merge time; edits to existing files cost you a
conflict on every release. If you need behavior the repo does not expose, ask for an extension
point upstream rather than patching in place.

## Onboarding a customer's own data

The Quickstart above runs on the bundled demo seed. To point the stack at a customer's **existing**
Azure AI Search index instead:

1. **Clone and install.**

   ```powershell
   git clone <repo-url>
   cd greenhouse-resume-builder
   npm install
   ```

2. **Build the two library workspaces.** Required — a plain `npm install` leaves their `dist/`
   folders empty and every server then fails with `ERR_MODULE_NOT_FOUND`.

   ```powershell
   npm run build -w @greenhouse-resume-builder/shared -w @greenhouse-resume-builder/mcp-core
   ```

3. **Install the pinned Python runtime** (only needed to run the agent).

   ```powershell
   npm run setup:python -w @greenhouse-resume-builder/cap-engagements-agent
   ```

4. **Create the environment file.** Copy `.env.example` to `.env` at the repo root and fill in
   `AZURE_SEARCH_SERVICE` (plus `AZURE_SEARCH_API_KEY`, or leave it blank to use
   `DefaultAzureCredential` / `az login`).

5. **Describe each index in a config file.** Every index the capability reads gets one JSON
   declaration — `id`, `indexName`, `fields[]` and a `mapping` from logical role to the customer's
   own field names. Copy
   [`index-schema.structured.example.json`](capabilities/engagements/mcp/engagements/index-schema.structured.example.json)
   for an index of structured records and
   [`index-schema.grounding.example.json`](capabilities/engagements/mcp/engagements/index-schema.grounding.example.json)
   for a document/chunk RAG index, rename them (files ending in `.example.json` are deliberately
   skipped), and point at them with an **absolute** path:

   ```
   ENGAGEMENTS_INDEX_SCHEMAS=C:\path\to\index-configs      # directory, or a comma-separated file list
   ```

   Use the singular `ENGAGEMENTS_INDEX_SCHEMA` for a single file. Relative paths resolve against the
   process working directory, which differs between `npm run -w` and a deployed Web App — prefer
   absolute.

6. **Validate the registry — offline.**

   ```powershell
   npm run provision:search -w @greenhouse-resume-builder/cap-engagements-mcp-engagements -- validate
   ```

   This makes **no** Azure calls. It prints every declaration with its file, index name, field
   counts, filterable/searchable fields, payload field, grounding field and the record kinds it
   claims. Check that output against the real index before going further.

   > ⚠️ **Never run `provision:search ensure`, `sync` or `reindex` against a customer index.**
   > `ensure` reshapes the index from the declaration, and `sync` pushes demo seed records into it.
   > `validate` is the only safe command against an index you did not create.

7. **Select the backend** with `RETRIEVAL_BACKEND` in `.env`:

   | Value       | Use when                                                               | Result                                                                                                                    |
   | ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
   | `memory`    | No cloud; the bundled demo seed.                                       | Default.                                                                                                                  |
   | `search`    | The index holds **structured records** (contacts, events, leaders, …). | Full deterministic planner.                                                                                               |
   | `grounding` | The index holds **documents/chunks** (an ordinary RAG index).          | Only the `search_grounding` tool; the planner is unavailable because a text corpus has no contacts, geo or leader roster. |

   `search` and `grounding` never read the seed, and requesting either without
   `AZURE_SEARCH_SERVICE` is a hard error rather than a silent fallback to demo data.

   Set it in the **repo-root `.env`** so the orchestrator sees it too, not only the MCP server: the
   orchestrator uses it to decide whether the bundled demo leader roster and topic catalog may be
   injected into the model's system prompt. Against a customer index they must not be — a model whose
   tools come back empty will otherwise answer from those demo records. In `grounding` mode the
   orchestrator detects the corpus from the registered tools, answers through `search_grounding` with
   citations, and requires Azure OpenAI (there is no deterministic planner for a document corpus).

### Step-by-step: use an existing RAG index for grounding

Use this path when the customer's Azure AI Search index contains document chunks rather than the
structured contact/event records required by the trip planner.

1. **Confirm the index has the fields needed for grounding.** It needs a unique key and a searchable
   passage-text field. Citation metadata (`title`, `url`, and a filterable parent-document id) is
   optional but recommended. A vector field is optional; without one, grounding uses keyword search.

   Hybrid search additionally requires the vector field to use an Azure AI Search vector profile
   with a vectorizer that accepts text queries. Semantic ranking requires an existing semantic
   configuration.

2. **Grant the application read access.** Prefer managed identity and assign the identity running the
   engagements MCP server the **Search Index Data Reader** role. For local development, run
   `az login`; alternatively, set `AZURE_SEARCH_API_KEY` to a query key.

3. **Edit the checked-in grounding declaration:**

   ```text
   capabilities\engagements\mcp\engagements\config\rag-index.json
   ```

   This file is included in `engagements-mcp.zip` as `config/rag-index.json`, so changes are carried
   by the next package and redeploy. It contains no credentials and is safe to keep in source
   control.

4. **Describe the real index fields** in that file. Replace the example names with the names and
   capabilities from the existing index:

   ```json
   {
     "id": "customer-rag",
     "indexName": "customer-documents",
     "fields": [
       {
         "name": "chunk_id",
         "type": "Edm.String",
         "key": true,
         "filterable": true
       },
       { "name": "parent_id", "type": "Edm.String", "filterable": true },
       { "name": "chunk", "type": "Edm.String", "searchable": true },
       { "name": "title", "type": "Edm.String", "searchable": true },
       { "name": "url", "type": "Edm.String" },
       {
         "name": "text_vector",
         "type": "Collection(Edm.Single)",
         "retrievable": false
       }
     ],
     "mapping": {
       "key": "chunk_id",
       "grounding": {
         "content": "chunk",
         "title": "title",
         "url": "url",
         "parentId": "parent_id",
         "vector": "text_vector",
         "semanticConfiguration": "default"
       }
     }
   }
   ```

   Remove `vector` when the index has no compatible vector field. Remove
   `semanticConfiguration` when semantic ranking is not configured. The `content` field must be
   searchable, and `parentId` must be filterable when supplied.

5. **Configure the repo-root `.env`.** Grounding mode requires Azure OpenAI because a document corpus
   has no deterministic planning path:

   ```dotenv
   RETRIEVAL_BACKEND=grounding
   AZURE_SEARCH_SERVICE=https://<search-service>.search.windows.net
   AZURE_SEARCH_API_KEY=
   ENGAGEMENTS_INDEX_SCHEMA=<repo-root>\capabilities\engagements\mcp\engagements\config\rag-index.json

   AZURE_OPENAI_ENDPOINT=https://<openai-resource>.openai.azure.com/
   AZURE_OPENAI_DEPLOYMENT=<chat-deployment-name>
   AZURE_OPENAI_API_VERSION=2024-10-21
   AZURE_OPENAI_API_KEY=
   ```

   Blank API-key values select `DefaultAzureCredential`, which uses `az login` locally and managed
   identity when deployed to Azure.

6. **Validate the declaration without calling Azure:**

   ```powershell
   npm run provision:search -w @greenhouse-resume-builder/cap-engagements-mcp-engagements -- validate
   ```

   Confirm that the reported index name and grounding field match the customer index. Do not run
   `ensure`, `sync`, or `reindex` against an existing customer index.

7. **Start the application** and open the chat host:

   ```powershell
   npm run demo -w @greenhouse-resume-builder/cap-engagements-ui
   ```

   Open `http://localhost:8080` and ask a question about the indexed documents. The agent calls
   `search_grounding`, retrieves ranked passages, collapses duplicate chunks by parent document, and
   generates a cited answer from those results.

8. **Deploy the same configuration to Azure.** Rebuild and deploy `engagements-mcp.zip`, then add this
   App Service application setting to the engagements MCP Web App:

   ```text
   ENGAGEMENTS_INDEX_SCHEMA=/home/site/wwwroot/config/rag-index.json
   ```

   The file is already in the ZIP; no storage mount or separate upload is required.

> **Production security:** grounding currently applies no tenant, group, ACL, or sensitivity trim.
> Every caller can search the entire configured index. Add server-side authorization filtering before
> exposing an index containing restricted customer data.

Details of the registry, its validation rules and the two caveats worth knowing are in
[`capabilities/engagements/mcp/engagements/README.md`](capabilities/engagements/mcp/engagements/README.md).

## Build Azure Web App ZIPs

Create the four deployment artifacts from the repository root:

```powershell
npm run package:webapps
```

The command writes self-contained artifacts beneath `.deploy\`:

| Artifact                        | Web App runtime | Startup           |
| ------------------------------- | --------------- | ----------------- |
| `engagements-agent-gateway.zip` | Node.js 20+     | `npm start`       |
| `engagements-agent-runtime.zip` | Python 3.11+    | `bash startup.sh` |
| `engagements-mcp.zip`           | Node.js 20+     | `npm start`       |
| `engagements-ui.zip`            | Node.js 20+     | `npm start`       |

The gateway and MCP artifacts bundle their production dependencies plus the seed JSON; the UI
artifact bundles `serve.ts` and the browser bundles only. The Python artifact contains
`requirements.txt`, the Agent Governance Toolkit policy, and its startup script; enable
App Service build automation with `SCM_DO_BUILD_DURING_DEPLOYMENT=true` so Oryx installs the Python
dependencies during ZIP deployment. Configure the Python Web App startup command as
`bash startup.sh`. App settings and `.env` files are deliberately not included in any archive.

`engagements-mcp.zip` carries the editable grounding declaration at `config/rag-index.json`. For a
grounding deployment, set `ENGAGEMENTS_INDEX_SCHEMA=/home/site/wwwroot/config/rag-index.json` on the
MCP Web App. Other customer index declarations can still be supplied through
`ENGAGEMENTS_INDEX_SCHEMA(S)`; the default `memory` backend never loads the registry.

Build only one artifact with `npm run package:webapp:gateway`,
`npm run package:webapp:runtime`, `npm run package:webapp:mcp`, or
`npm run package:webapp:ui`.

The UI artifact bundles `serve.ts` plus both single-file browser bundles. Because the MCP App
sandbox must be a **distinct origin**, `serve.ts` binds two ports (`HOST_PORT` 8080 and
`SANDBOX_PORT` 8081) and a single App Service routes only one — deploy the ZIP to two Web Apps, or
front them with a gateway exposing both origins. `scripts/package-ui-webapp.ps1` wraps the same
packaging step and adds `az webapp deploy`.

### Optional configuration

Copy `.env.example` to `.env` at the repo root to enable the optional integrations:

- **Live map tiles** — set `AZURE_MAPS_KEY`; the demo rebuilds the map App on start, so a restart
  picks up the key. Without it the map falls back to a schematic dots-and-routes view.
- **Agent planning** — set `AZURE_OPENAI_*` (and `az login`) so Microsoft Agent Framework owns
  intent/workflow decisions; otherwise the gateway uses its deterministic planner.
- **Agent governance** — enabled by default through `AGT_ENABLED=true`; policy is loaded from
  `governance/policy.yaml` before model execution and every MCP tool call. This is the Agent
  Governance Toolkit (prompt-injection / tool-call policy) and is unrelated to data access control.
- **Azure AI Search backend** — set `RETRIEVAL_BACKEND=search` or `grounding` plus `AZURE_SEARCH_*`
  and an index schema config; the default `memory` backend needs no cloud resources. See
  [Onboarding a customer's own data](#onboarding-a-customers-own-data).

## How it fits together

Four service processes (plus a distinct sandbox origin). The **one** MCP server has **two
clients**: the Python agent runtime calls its **tools**, and the browser reads its
**`ui://trip-map` App resource** directly.

```
Browser chat host (:8080)                                  chat client + MCP-Apps host
  │
  ├─ POST /ask ─────────────────────►  TS orchestration gateway (:3020)
  │  ◄─ { answer, menu[], tripMap }        │
  │                                         ▼
  │                              Python MAF + AGT runtime (:3030)
  │                                         └─ governed MCP tools/call ─┐
  │                                                                     ▼
  └─ resources/read ui://trip-map ──────────────────►  Engagements MCP (:3010)
     (rendered in a sandboxed iframe, :8081)             • contacts/events/topics from the
                                                           configured retrieval backend
                                                         • suggest_candidates / build_itinerary
                                                         • ui://trip-map App resource

  (future · optional)  Personal Context MCP  ◄── the agent calls it with per-user Entra/OBO
                                                 to personalize the itinerary at request time
```

An **Area Discovery MCP** server (`capabilities/engagements/mcp/discovery`, port 3011) is also
started by the `demo` script; it surfaces public Azure Maps POIs around a travel anchor.

See [`engagement-intelligence/ARCHITECTURE.md`](engagement-intelligence/ARCHITECTURE.md) for the
original design (data model, blob → AI Search indexing, and the modular capability architecture) and
[`engagement-intelligence/MVP-PLAN.md`](engagement-intelligence/MVP-PLAN.md) for the milestone
roadmap — both carry a status note where they diverge from the code. The runtime trace of one
request is in [`docs/life-of-a-question.md`](docs/life-of-a-question.md). The future per-user
personalization server is designed in
[`docs/personal-context-and-engagement-intelligence-design.md`](docs/personal-context-and-engagement-intelligence-design.md),
and the area-first / optioned planning flow (geo anchor, topics-in-area, leader selection,
duration + extension options) in
[`docs/area-first-optioned-planning-design.md`](docs/area-first-optioned-planning-design.md).
