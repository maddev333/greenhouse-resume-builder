# LLMWiki MCP Server + Azure AI Search: Architecture & Implementation Plan

## Executive Summary

This plan extends the existing **LLMWiki MCP Server** (FastMCP / Python, SQLite + FTS5) with **Azure AI Search** as the primary backing store, and wraps it in a full **MCP UI App** following the greenhouse-resume-builder capability module pattern. The result is a production-grade, IL5-ready knowledge retrieval service that can be deployed to Azure alongside existing capabilities (ingestion, quality, discovery, etc.).

---

## 1. Current State Assessment

### LLMWiki MCP Server (existing)
| Component | Current Implementation |
|-----------|----------------------|
| **Language** | Python 3.11+, FastMCP |
| **Storage** | SQLite on-disk, WAL mode |
| **Search** | FTS5 with porter unicode61 tokenizer |
| **Tools** (10) | `search_wiki_sections`, `read_wiki_section`, `get_concept`, `find_related_concepts`, `list_collections`, `list_documents`, `check_content`, `ingest_status`, `trigger_ingest`, `lint_wiki` |
| **Resources** (7+) | `wiki://manifest`, `wiki://schema`, `wiki://index`, `wiki://log`, `wiki://collection/{id}`, `wiki://document/{id}`, `wiki://section/{id}` |
| **Ingestion** | Polling watcher + one-shot scripts; pluggable extractors (builtin + Azure Document Intelligence) |
| **Ontology** | Deterministic rule/concept/entity extraction with provenance links |
| **Auth** | None (localhost-only, 127.0.0.1:8765) |

### What needs to change
1. **Storage layer**: SQLite → Azure AI Search (with local fallback via Qdrill/SQLite for dev)
2. **Security**: Unauthenticated → IL5 Entra ID + managed identity + tenant isolation
3. **Hosting**: Standalone Python process → Azure Functions (Streamable HTTP) following the existing mcp-core pattern
4. **UI**: None → MCP UI App (hybrid web + embedded) in a new capability module

---

## 2. Target Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Recruiter / Agent / Operator                      │
│  ┌───────────┐    ┌──────────────┐    ┌───────────────────────────┐ │
│  │ MCP Host  │    │ MCP UI App   │    │ Human editor (Obsidian /  │ │
│  │ (Office AI)│    │ Wiki Browser │    │ VS Code + local watcher)  │ │
│  └─────┬─────┘    └──────┬───────┘    └────────────┬──────────────┘ │
└────────┼──────────────────┼─────────────────────────┼────────────────┘
         │ Streamable HTTP  │ Streamable HTTP         │ File drops
         │ + Entra JWT      │ + streamble HTTP        │ into corpus dir
         ▼                  ▼                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   Azure API Management / Private Link                │
│              (Entra OAuth, rate limit, CORS, TLS)                    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│               LLMWiki MCP Capability Module (IL5)                    │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Azure Functions App (Streamable HTTP MCP endpoint)         │    │
│  │                                                              │    │
│  │  ┌───────────┐     ┌──────────────┐     ┌──────────────┐   │    │
│  │  │ Storage   │     │ Retention /  │     │ Ontology     │   │    │
│  │  │ Abstraction│    │ Security     │     │ Engine       │   │    │
│  │  └─────┬─────┘     └──────┬───────┘     └──────┬───────┘   │    │
│  └────────┼──────────────────┼─────────────────────┼───────────┘    │
│           │                  │                     │                 │
│           ▼                  ▼                     ▼                 │
│  ┌───────────────┐  ┌──────────────┐   ┌──────────────┐            │
│  │ Azure AI      │  │ Entra ID     │   │ Deterministic│            │
│  │ Search        │  │ Policy Engine│   │ rule engine  │            │
│  └───────────────┘  └──────────────┘   └──────────────┘            │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               ▼ (document API calls)
┌─────────────────────────────────────────────────────────────────────┐
│                         Azure AI Search Service                      │
│                                                                      │
│  Index: wiki-sections          ── hybrid keyword + vector           │
│  Index: wiki-concepts        ── filtered by tenant/collection       │
│  Index: wiki-documents       ── metadata catalog                    │
│  Index: ingest-log             – audit trail                       │
│                                                                      │
│  Fields (per-section doc):                                        │
│    - id, documentId, collectionId, tenantId (filterable)          │
│    - heading, headingPath, body     (searchable)                   │
│    - snippet                      (computed on retrieve)           │
│    - score, bm25Score, vectorScore  (returned by hybrid query)     │
│    - docType, flavor              (filterable)                     │
│    - pageAnchor, ordinal          (sortable)                       │
│    - embedding                    (vector field, optional)         │
└─────────────────────────────────────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                     ▼
┌───────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Blob Storage  │  │ Azure Document   │  │ Managed Identity │
│ (corpus raw)  │  │ Intelligence     │  │ (no keys in IL5) │
│               │  │ (premium OCR)    │  │                  │
└───────────────┘  └──────────────────┘  └──────────────────┘
```

---

## 3. Capability Module Layout

Following the existing `capabilities/` pattern:

```
capabilities/llmwiki/          # New capability module
├── README.md
├── mcp/
│   └── llmwiki/
│       ├── host.json           # Azure Functions routing
│       ├── local.settings.json
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts        # MCP server registration (Python → TS adapter)
│       │   ├── tools.ts        # 10 rewritten MCP tools over Azure AI Search
│       │   └── storage-adapter.ts  # Abstraction: Azure AI Search / local fallback
│       └── dist/
├── agent/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       └── agent.ts            # LLM-powered wiki maintenance loop
├── ui/
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── src/
│   │   ├── main.tsx            # MCP UI App entry point
│   │   ├── components/         # Wiki browser, search, concept explorer
│   │   └── styles.css          # Shared styling
│   └── dist/
└── shared/                     # Re-usable Python types adapted for TypeScript
    ├── package.json
    └── src/
        └── llmwiki-types.ts    # TS equivalents of llmwiki models.py dataclasses
```

---

## 4. Storage Abstraction Layer (Critical Design)

### Interface

The key abstraction that lets us swap SQLite → Azure AI Search:

```typescript
// capabilities/llmwiki/mcp/llmwiki/src/storage-adapter.ts

/** Abstract storage interface — the contract all tools depend on. */
interface WikiStorage {
  // Collections
  listCollections(): Promise<CollectionInfo[]>;
  
  // Documents
  getDocuments(opts?: { collectionId?: string; flavor?: 'raw' | 'wiki'; limit?: number }): Promise<DocumentInfo[]>;
  getDocument(documentId: string): Promise<DocumentInfo | null>;
  
  // Sections — search and retrieve
  searchSections(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
  getSection(sectionId: string, includeNeighbors?: boolean): Promise<SectionResult | null>;
  
  // Concepts / ontology
  getConcept(conceptId: string): Promise<ConceptInfo | null>;
  findRelatedConcepts(conceptId: string, limit?: number): Promise<[ConceptInfo, string][]>;
  
  // Validation
  checkContentAgainstRules(content: string, opts?: { collectionId?: string }): Promise<Finding[]>;
  
  // Ingest controls
  getIngestStatus(): Promise<IngestStatus>;
  triggerIngest(): Promise<number>;
  
  // Wiki lint (read-only diagnostic)
  lintWiki(): Promise<WikiHealthFinding[]>;
}

/** Local dev mode: SQLite FTS5 fallback. */
function createLocalStorage(dbPath: string): WikiStorage;

/** Production mode: Azure AI Search backed. */
function createAzureSearchStorage(
  serviceUrl: string,
  credential: TokenCredential,
  tenantId?: string
): WikiStorage;
```

### Azure AI Search Index Schema

Following `mvp_search_indexes.md` patterns but tailored for wiki content:

```typescript
// capabilities/llmwiki/mcp/llmwiki/src/azure-search-schema.ts

const wikiSectionsIndex = {
  name: 'wiki-sections',
  fields: [
    { name: 'id', type: 'Edm.String', key: true, retrievable: true },
    { name: 'documentId', type: 'Edm.String', filterable: true, facetable: true },
    { name: 'collectionId', type: 'Edm.String', filterable: true, facetable: true },
    { name: 'tenantId', type: 'Edm.String', filterable: true, searchable: false }, // security trim target field
    { name: 'heading', type: 'Edm.String', sortable: true, filterable: true, facetable: true, analyzer: 'en.microsoft' },
    { name: 'headingPath', type: 'Edm.String', sortable: true, filterable: true, analyzer: 'en.microsoft' },
    { name: 'body', type: 'Edm.String', searchable: true, retrievable: true, analyzer: 'en.microsoft' },
    { name: 'snippet', type: 'Edm.String', retrievable: true, analyzer: 'en.microsoft' }, // computed by skill layer or on-the-fly
    { name: 'bodyVector', type: 'Collection(Edm.Single)', searchable: true, dimensions: 1536, vectorSearchProfile: 'openai-profile' }, // Azure OpenAI embeddings
    { name: 'docType', type: 'Edm.String', filterable: true, facetable: true },
    { name: 'flavor', type: 'Edm.String', filterable: true, facetable: true },
    { name: 'pageAnchor', type: 'Edm.Int32', sortable: true },
    { name: 'ordinal', type: 'Edm.Int32', sortable: true },
    { name: 'score', type: 'Edm.Double', sortable: true, retrievable: false }, // BM25 score from rankHybrid
    { name: 'ingestedAt', type: 'Edm.DateTimeOffset', sortable: true },
    { name: 'metadataJson', type: 'Edm.String', retrievable: true }, // JSON blob of document-level metadata
  ],
  searchProfiles: [
    {
      name: 'hybrid-profile',
      vectorSearchProfile: { name: 'openai-profile', vectorFieldName: 'bodyVector' },
      semantic: { configuration: { name: 'wiki-semantic-config' } }
    }
  ],
  suggestions: [{ name: 'suggestion-profile', analyzer: 'en.microsoft' }],
  semantic: {
    configurations: [{
      name: 'wiki-semantic-config',
      prioritizedFields: { titleField: { fieldName: 'heading' }, contentFields: { fields: [{ fieldName: 'body', weight: 1.0 }] } }
    }]
  },
  vectorSearch: {
    algorithms: [
      { name: 'hnw-algorithm', kind: 'hnsw', hnwParameters: { metric: 'cosine', dimensionCount: 1536, m: 4, efConstruction: 200 } }
    ],
    profiles: [
      { name: 'openai-profile', algorithm: 'hnw-algorithm' }
    ]
  }
};

// wiki-concepts index (separate for tenant-safe concept lookup)
const wikiConceptsIndex = {
  name: 'wiki-concepts',
  fields: [ /* similar but concept-focused: id, collectionId, tenantId, name, slug, kind, definition, sourceSectionId */ ],
  // ... 
};
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Hybrid mode by default** | Azure AI Search for IL5 production; SQLite FTS5 for local dev. Storage abstraction decouples tools from backing store. |
| **BM25 + hybrid vector search** | The existing LLMWiki uses FTS5 BM25. Azure AI Search preserves keyword relevance while adding semantic retrieval via OpenAI embeddings. |
| **Tenant isolation** | Follow mvp_search_indexes.md: `tenantId` as a mandatory filter field on every index. Never trust caller-supplied tenant — always use the verified Entra claim (same pattern as existing `discovery/mcp/search`). |
| **No write tools through MCP** | Preserve read-only contract. Ingestion happens via file drops to Blob Storage or Azure Functions HTTP trigger. |
| **Streaming wiki resources** | Keep `wiki://...` URI resources — they map cleanly to Azure AI Search document retrieval and always serve from the index. |

---

## 5. Tool Surface (unchanged + enhanced)

### Existing tools (preserved, backend swapped):

| Tool | Backing Change |
|------|---------------|
| `search_wiki_sections(query?, collection?, doc_type?, flavor?, max_results?)` | SQLite FTS5 MATCH → Azure AI Search `search()` with `rankHybrid` + OData filters |
| `read_wiki_section(section_id, include_neighbors?, max_chars?)` | SQLite JOIN → Azure AI Search `$expand` / single-doc lookup + sibling docs |
| `get_concept(concept_id)` | SQLite concepts table → wiki-concepts index |
| `find_related_concepts(concept_id, max_results?)` | concept_links JOIN → vector-similarity or graph traversal over wiki-concepts index |
| `list_collections()` | collections JOIN documents → Azure AI Search aggregated query |
| `list_documents(collection?, flavor?, max_results?)` | SQLite WHERE → Azure AI Search with OData filters |
| `check_content(content, collection?, max_findings?)` | Rule matching logic unchanged; hits come from wiki-concepts index |
| `ingest_status(max_entries?)` | ingest_log table → Azure Table Storage or blob-based log |
| `trigger_ingest()` | Ingestion orchestration: Blob trigger functions scan corpus dir |
| `lint_wiki(max_findings?)` | File-system walk over `data/wiki/` — unchanged, no DB dep |

### New tools (enabled by Azure capabilities):

| Tool | Purpose |
|------|---------|
| `search_wiki_hybrid(query, top?, collection?, flavor?)` | **Hybrid** keyword + vector search (replaces plain `search_wiki_sections` in IL5). Returns BM25 score, vector similarity, semantic rank. |
| `get_wiki_document(document_id)` | Get full wiki document with all sections from the index (vs file-system read) |
| `list_wiki_history(query?, collection?, max_results?)` | Temporal query over `ingestedAt` fields in Azure AI Search for version auditing |

---

## 6. MCP UI App: Design

### Component Structure

```
capabilities/llmwiki/ui/src/components/
├── SearchBar.tsx            # Query input with collection/flavor filters
├── HitList.tsx              # Ranked results panel (snippet + score)
├── SectionViewer.tsx        # Full text with heading navigation, neighbor links
├── ConceptExplorer.tsx      # Concept detail + related concepts graph (simple node-link)
├── CollectionBrowser.tsx    # Left sidebar: collections → documents → sections tree
├── WikiHealthPanel.tsx      # Output from lint_wiki tool as color-coded findings
├── HistoryTimeline.tsx      # Ingest timeline from ingest_status
└── DocumentUpload.tsx       # Drag-and-drop corpus upload (to staging Blob SAS)
```

### UI States & Flow
```
1. Landing: collection sidebar + search bar — user chooses scope
2. Search results: ranked hits appear in main panel
3. Section detail: click hit → full text with heading nav + parent doc context
4. Concept drill-in: related concepts rendered as linkable nodes
5. wiki health / history: separate panels behind tabs
6. Upload: drag-and-drop raw docs to corpus staging area
```

### Hybrid Mode (embedded + standalone)
Same pattern as existing `discovery/ui` and `quality/ui`:
- **Embedded**: `(globalThis as any).mcpHost.callTool(name, args)` — host-provided bridge
- **Standalone**: Direct HTTP JSON-RPC to the Azure Functions MCP endpoint
- The UI App lives behind APIM with Entra ID when deployed; local dev uses CORS headers from mcp-core

---

## 7. Deployment & Hosting

### Azure Functions (production / IL5)

Following the existing `capabilities/*/mcp/*/host.json` pattern:

```json
{
  "version": "4",
  "functionFactoryOptions": {},
  "extensions": {
    "http": {
      "routePrefix": ""
    }
  },
  "concurrency": {
    "dynamicConcurrencyEnabled": true,
    "snapshotPersistenceEnabled": true
  }
}
```

The MCP server is a single HTTP Function registered via `registerMcpServer()` from mcp-core:
- `authLevel: 'anonymous'` — gateway/APIM handles all auth in IL5
- Inherits tenant/role/scopes/group claims from APIM headers (same as existing pattern)
- Managed identity to Azure AI Search and Blob Storage

### Container / Docker (alternative IL5 hosting)

If Functions is not preferred, deploy the Python LLMWiki server as a container image:
- Azure App Service or AKS (IL5 authorized; NOT Container Apps — IL2-only)
- Same Streamable HTTP transport, same MCP tool surface
- Entrusted to APIM for auth; connects to Azure AI Search via managed identity

---

## 8. Implementation Phases

### Phase 1: Storage Abstraction & Local Dev Parity (Weeks 1-2)
**Goal**: Define the storage interface + implement both adapters, zero tool changes needed

Steps:
1. Create `capabilities/llmwiki/shared/` with TypeScript types mirroring `llmwiki/models.py` dataclasses
2. Implement `WikiStorage` interface in TS
3. Build `SQLiteStorage` adapter (wraps the existing Python SQLite logic via a local REST proxy OR rewrites the DAO directly in TS)
4. Build `AzureSearchStorage` adapter with:
   - Azure AI Search service creation (Bicep ARM template)
   - Index schema definition (wiki-sections, wiki-concepts, wiki-documents, ingest-log)
   - Document indexing pipeline using `IndexBatch` uploads
5. Wire up dependency inversion in tool layer — pass storage via factory at boot
6. Run all 10 existing tools against both backends — verify identical JSON output

**Deliverable**: `python server.py` still works locally; new `npm run dev -w @llmwiki-server` also serves identically over the same MCP endpoint.

### Phase 2: Azure AI Search Integration (Weeks 3-4)
**Goal**: Production-ready Azure AI Search back-end with hybrid search

Steps:
1. Create Bicep template for Azure AI Search service:
   - S1 tier (IL5 minimum)
   - Built-in vectorization (no manual embedding generation needed — AI Hub feature)
   - Semantic ranking configured on hybrid queries
2. Configure indexer to automatically scan Blob Storage container (`wiki-corpus`) and push to `wiki-sections` index
3. Implement the ingestion pipeline:
   - Document Intelligence OCR trigger (Blob function → parse → chunk → index)
   - Wiki layer indexing (LLM-authored notes indexed separately with `flavor: "wiki"`)
4. Add Azure OpenAI embedding generation for `bodyVector` field
5. Security: enforce `tenantId` filter on all search queries, fail-closed pattern matching existing discovery module

**Deliverable**: Azure AI Search indexes populated from Blob Storage; hybrid queries return ranked results with vector similarity.

### Phase 3: MCP Server TS Migration (Weeks 5-6)
**Goal**: Port the Python FastMCP server to follow the team's TypeScript MCP pattern

Steps:
1. Create `capabilities/llmwiki/mcp/llmwiki/` capability module
2. Implement 10 tools using `registerMcpServer()` from mcp-core (same pattern as discovery, quality, etc.)
3. Each tool uses `WikiStorage` abstraction — delegates to Azure AI Search in prod, SQLite in dev
4. Add security layer: built-in tenant trimming, role-gated sensitive concept filtering
5. Resource handlers (`wiki://...` URIs) implemented as function-backed resources

**Deliverable**: Full MCP tool surface serving over Streamable HTTP via Azure Functions; all 10 tools + 7+ resources verified against both backends.

### Phase 4: MCP UI App Build (Weeks 7-8)
**Goal**: Recruiter-facing wiki browser that works embedded in MCP host or standalone

Steps:
1. Scaffold `capabilities/llmwiki/ui/` following existing UI pattern (Vite + React 19 + createRoot)
2. Implement component hierarchy per the design above:
   - SearchBar + HitList → main interaction loop
   - SectionViewer → detail panel with heading nav
   - ConceptExplorer → graph of related concepts
   - CollectionBrowser → tree sidebar
3. McpBridge pattern: embedded mode via `mcpHost.callTool`, standalone via HTTP JSON-RPC
4. Styling: system-ui font, code-style syntax highlighting for markdown sections
5. Embedding surface: MCP App SDK registration in `vite.config.ts`

**Deliverable**: `npm run dev -w @llmwiki-ui` serves a functional wiki browser; embedded mode works through any MCP host.

### Phase 5: Agent-Loop Integration (Weeks 9-10)
**Goal**: Self-hosted Azure OpenAI agent loop for automated wiki maintenance

Steps:
1. Create `capabilities/llmwiki/agent/` following the existing agent-loop.ts pattern
2. Agent capabilities:
   - Auto-generate index.md entries for new documents
   - Detect and fix broken intra-wiki links (from lint output)
   - Suggest concept merges when duplicates are detected
   - Periodic health reports to wiki log
3. Agent calls only its own MCP tools and never writes directly through the service

**Deliverable**: Agent loop that autonomously maintains wiki quality using the same tool surface the UI uses.

### Phase 6: Integration Testing & Deployment (Weeks 11-12)
**Goal**: End-to-end validation and IL5 deployment readiness

Steps:
1. Local dev pipeline: Blob emulator + Azure AI Search emulator (Azurite compatible layer) + all three packages linked via npm workspaces
2. Integration tests: end-to-end corpus → document intelligence → index → search → UI rendering
3. Security audit: tenant isolation, role-based redaction, bearer token propagation
4. Bicep deployment pipeline to Azure IL5 environment
5. Documentation: README for the new capability module, operator guide for corpus management

**Deliverable**: Zero-downtility deployment to IL5 Azure; full documentation and runbook.

---

## 9. Risk Assessment & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Python-to-TypeScript surface parity | High | Keep the same JSON contract on all tools; add integration tests comparing outputs from both SQLite and Azure backends |
| Vector search quality vs FTS5 | Medium | Start BM25-only in hybrid mode, gradually weight vector component based on user feedback |
| Azure AI Search costs at scale | Medium | Use S1 tier minimum; leverage built-in vectorization (no separate embedding cost); monitor index/document count thresholds |
| Tenant isolation gaps | Critical | Follow the identical pattern used by `discovery/mcp/search` — mandatory tenant from verified claim, never trust caller input; fail-closed |
| MCP resource streaming limits | Low | Page results via `max_results`; implement cursor-based pagination for large document sets |

---

## 10. Environment Variables (new additions)

Add to `.env.example`:

```bash
# ── LLMWiki Capability ────────────────────────────────────────
LLMWIKI_MCP_URL=http://localhost:7080/api/mcp/llmwiki   # local dev endpoint for UI
LLMWIKI_STORAGE_MODE=auto                                # 'azure' | 'sqlite' | 'auto' (detects AZURE_SEARCH_SERVICE)
# Azure AI Search settings pass through existing AZURE_SEARCH_* vars from .env.example
LLMWIKI_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small
```

---

## 11. Package Dependencies

### New packages needed:

| Package | Purpose |
|---------|---------|
| `@azure/search-documents` (v11+) | Azure AI Search client library |
| `@azure/identity` | Managed identity / Entra auth |
| `openai` (optional) | Embedding generation if not using built-in vectorization |

### npm workspace additions:

```jsonc
// package.json workspaces (add these entries):
{
  "workspaces": [
    // ... existing ...
    "capabilities/llmwiki/mcp/llmwiki",
    "capabilities/llmwiki/agent", 
    "capabilities/llmwiki/ui",
    "capabilities/llmwiki/shared"
  ]
}
```

---

## 12. Files That Already Exist (Reuse)

The following existing files from the LLMWiki MCP Server should be **ported directly** with minimal changes:

| Source File | Port Target | Changes Needed |
|------------|-------------|---------------|
| `llmwiki/models.py` | `shared/src/llmwiki-types.ts` | dataclass → TS interface, zero logic change |
| `llmwiki/chunking.py` | `mcp/llmwiki/src/chunker.ts` | Python → TS port of heading-aware splitter |
| `llmwiki/extractors.py` | `mcp/llmwiki/src/extractors.ts` | Registry pattern stays; plugging in Azure DI SDK |
| `llmwiki/ontology.py` | `mcp/llmwiki/src/ontology.ts` | Deterministic rule engine is pure logic — straightforward port |
| `llmwiki/lint.py` | `mcp/llmwiki/src/wiki-linter.ts` | File-system walk — identical logic in node:fs |
| `llmwiki/config.py` | `mcp/llmwiki/src/config.ts` | Env var reading via Node process.env |
| `llmwiki/watcher.py` | `mcp/llmwiki/src/watcher.ts` | fs.watch API replacement for polling |

The Python server (`server.py`, `app.py`) is **not ported** — it serves as reference architecture. The new TS implementation follows the mcp-core pattern used by other capabilities. The Python version remains useful for local development (SQLite mode) or can be kept as a coexistence option during transition.

---

## 13. Index Schema Mapping: SQLite → Azure AI Search

| SQLite Table / FTS5 | Azure AI Search Index | Notes |
|---------------------|----------------------|-------|
| `collections` table | Derived from aggregated document queries — not a separate index | Use search on documents grouped by collectionId |
| `documents` table | `wiki-documents` index (metadata-only, searchable for list_documents) | Lightweight: id, title, collectionId, docType, flavor, pageCount, sizeBytes, ingestedAt, sourcePath |
| `sections` + `sections_fts` FTS5 | `wiki-sections` index (primary search index) | Full content stored here; bodyVector for hybrid |
| `concepts` + `concepts_fts` FTS5 | `wiki-concepts` index | name, slug, kind, definition searchable; metadata_json for filters |
| `concept_links` | Graph computed from wiki-concepts → stored as derived field on concepts docs | Each concept doc has a `relatedConceptIds[]` array populated by graph join |
| `section_concepts` | Derivation step during indexing — not directly indexed | Mapped into section documents' `conceptIds[]` and concept docs' `sourceSectionIds[]` |
| `ingest_log` | Azure Table Storage or blob-based append-only log | Not searchable via AI Search — use Table Storage for query performance |

---

## 14. Quick Start (After Implementation)

```bash
# Build all new capability packages
npm install
npm run build -w @llmwiki-shared
npm run build -w @llmwiki-server

# Run MCP server locally (auto-detects SQLite vs Azure)
cd capabilities/llmwiki/mcp/llmwiki && func start --port 7080

# Run UI App
npm run dev -w @llmwiki-ui
# → opens http://localhost:5173

# Deploy to IL5 Azure
bicep build templates/wasm-deploy.bicep
az deployment group create --name llmwiki-il5 --resource-group <il5-rg> --template-file templates/wasm-deploy.bicep
```

---

## 15. Success Criteria

- [ ] All 10 existing MCP tools work identically over Azure AI Search as over SQLite
- [ ] Hybrid search returns BM25 + vector results with semantic ranking
- [ ] `wiki://` resources serve from index (not file system) in production mode
- [ ] MCP UI App works embedded in any MCP host AND standalone via HTTP
- [ ] Tenant isolation: unverified tenant claims → fail-closed on every query
- [ ] Zero keys in IL5 environment — all Azure services use managed identity
- [ ] Agent loop maintains wiki quality without human intervention
- [ ] Full npm workspace build passes across the new llmwiki capability module
