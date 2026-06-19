# LLMWiki Interactive Wiki — MCP App Architecture

**Status**: Design document  
**Created**: 2026-06-19  
**Scope**: Cross-repo survey of LLMWiki-MCP-Server + greenhouse-resume-builder, tool/resource analysis, proposed architecture, data flow design

---

## 1. Purpose

Transform the existing `LLMWiki-MCP-Server` into an interactive MCP App that exposes a wiki browser page as a resource surface alongside its existing tool endpoints. This enables humans to browse, search, and navigate indexed wiki content in real time — while preserving all existing agent-facing tool contracts unchanged.

---

## 2. Cross-Repo Survey: What Exists Today

### 2.1 LLMWiki-MCP-Server Tool Surface (10 Tools)

All tools defined in `LLMWiki-MCP-Server/llmwiki/tools.py` via class-method registration pattern inside `register_tools()`:

| # | Tool Name | Purpose | Returns |
|---|-----------|---------|---------|
| 1 | `search_wiki_sections(query, collection?, doc_type?, flavor?)` | FTS5/BM25 keyword search over sections with collection/doc_type filtering | `SearchHit[]` (section_id, document_id, document_title, collection_id, heading_path, heading, snippet, score, source_path, page_anchor) |
| 2 | `read_wiki_section(section_id, include_neighbors: bool)` | Fetch full section body (+ previous/next sections in same document if flagged) | `SectionResult` extended with prev/next IDs, optional parent doc info, truncated flag |
| 3 | `list_collections()` | Discover all collections with aggregate counts | `CollectionInfo[]` (id, name, description, created_at, document_count, section_count, concept_count, last_ingested_at) |
| 4 | `list_documents(collection_id?, limit)` | List documents in a collection with pagination | `DocumentInfo[]` (id, source_path, title, doc_type, size_bytes, content_hash, parsed_path, metadata_json) |
| 5 | `check_content(content_text, collection?)` | Rule-based compliance checking against indexed rule concepts; lexical keyword matching no LLM call | `Finding[]` (rule_concept_id, rule_name, severity, evidence, suggestion, citation) |
| 6 | `ingest_status(max_entries: 50)` | Poll ingest pipeline status and history | `IngestStatus` (polling_interval, last_poll_time, recent_log[IngestLogEntry[]]) |
| 7 | `trigger_ingest()` | Manual re-index of wiki data directory | string confirming source path ingested |
| 8 | `lint_wiki(max_findings: 100)` | Static health check over wiki directory — finds orphans, broken links, index gaps, missing canonical files | `WikiHealthFinding[]` (kind, severity, page, detail, target) |
| 9 | `manifest()` | Return server metadata, storage mode, total collection/concept counts by kind | dict with server metadata |
| 10 | *(resource methods — see §2.2 below)* | | |

**Entry point chain**: `app.py → create_mcp_server() → register_tools(...)`  
`fastmcp.FastMCP` name = `"llmwiki"`, instructions guide agents to start with `search_wiki_sections`.

### 2.2 LLMWiki Resource Surface (7 Resources)

All registered via `register_tool_or_resource()` in tools.py using wiki:// URI scheme:

| Resource URI | Method | Returns | Purpose |
|-------------|--------|---------|---------|
| `wiki://schema` | schema_resource() | dict — full PostgreSQL JSONB schema of all LLMWiki tables | Schema documentation for callers |
| `wiki://index` | index_resource() | dict — table-of-contents/manifest of collections + documents | Index overview / discovery |
| `wiki://log` | log_resource() | IngestLogEntry[] | Audit/investigate ingestion history |
| `wiki://collection/{id}` | collection_resource(id) | CollectionInfo + document list for that collection | Browse by collection |
| `wiki://document/{id}` | document_resource(id) | DocumentInfo + all sections for that doc | Read a specific document |
| `wiki://section/{id}` | section_resource(id) | SectionResult (heading, body, metadata) with neighbors | Read full section text |

### 2.3 Data Store Surface

| System | Storage Type | What Powers | Key Patterns |
|--------|-------------|-------------|--------------|
| **SQLite + FTS5** (default: local dev) | SQLite `.db` on disk, `sections_fts` virtual table, porter unicode61 tokenizer, TRIGGER-based sync | All wiki search/retrieval via `search_sections()`, CRUD of all entities | Single writer thread (ingest), many readers (tools). Write path: `replace_document(document, sections, concepts, concept_links, section_concepts)` — one atomic transaction covering all 5 entity types. Tables: collections, documents, sections, concepts, concept_links, section_concepts, ingest_log |
| **Azure AI Search** (when `config.storage_mode="azure"`) | 3 Azure indices + blob storage for ingest log | Production search/retrieval, vector similarity over section headings/bodies | Index schema defined in `_wiki_sections_index()`, `_wiki_documents_index()`, `_wiki_concepts_index()` helpers. Hybrid BM25+vector via `openai-profile` (HNSW cosine, 1536 dim). Semantic config title→heading, content→body |
| **Resume Facts Read-Only** (when `config.storage_mode="azure-facts"`) | Reads greenhouse's existing `resume-facts` index via thin adapter — no new indexes created | Browse/search of candidate resume facts through standard wiki tool surface (`search_wiki_sections`, `read_wiki_section` etc.) without creating any additional Azure AI Search indices | Tenant-scoped, fail-closed. Client-side filtering (no filterable fields in greenhouse's index). Sensitive factKey redaction (`event.*` temporal, `*.location` precise geo) via `_is_sensitive_fact_key()`. `_epoch()` helper converts Azure `DateTimeOffset` → epoch seconds for model compat. All write methods raise `NotImplementedError`; factory disables corpus watcher for this backend. |

### 2.4 Azure AI Search Index Definitions (Azure Backend)

#### wiki-sections — Primary search index

| Field | Type | searchable | filterable | vector_search_profile |
|-------|------|-----------|------------|----------------------|
| id | Edm.String | ✓ (key) | - | - |
| documentId | Edm.String | - | ✓, facetable | - |
| collectionId | Edm.String | - | ✓, facetable | - |
| heading | Edm.String | - | ✓ | en.microsoft analyzer |
| headingPath | Edm.String | - | ✓ | en.microsoft |
| body | Edm.String | ✓ (searchable) | - | en.microsoft |
| bodyVector | Collection(Edm.Single), 1536-dim | ✓ | - | openai-profile (HNSW cosine, m=4, ef_construction=200) |
| docType | Edm.String | - | ✓, facetable | - |
| flavor | Edm.String | - | ✓, facetable | - |
| ingestedAt | Edm.DateTimeOffset | - | ✓ | - |

Semantic config: `wiki-semantic-config` — titleField=heading, contentFields=[body weight=1.0].

#### wiki-documents — Metadata catalog/collection store

| Field | Description |
|-------|-------------|
| id (key) | Document ID |
| sourcePath | Path to original file |
| title | Display title (searchable with en.microsoft analyzer) |
| collectionId | FK → wiki-sections.collectionId, filterable/facetable |
| docType | 'txt' \| 'md' \| 'pdf' etc. — filterable/facetable |
| flavor | 'raw' | 'wiki' | - filterable/facetable | - contentHash | Filterable, unique content fingerprint |
| sizeBytes, pageCount | File dimensions |
| _deleted | Edm.Boolean, filterable |

Semantic configuration: titleField=title with body=content.

#### wiki-concepts — Concept knowledge graph store

| Field | Description |
|-------|-------------|
| id (key) | Concept ID |
| collectionId | FK to wiki-documents.collectionId |
| name | Display name (searchable with en.microsoft) |
| slug | Normalized identifier, filterable |
| kind | 'concept' \| 'rule' \| 'entity' \| 'template' — filterable/facetable |
| definition | Concept description (searchable, weighted 1.0) |
| sourceSectionId | Linking back to originating section documentIds: {source_path: Collection(Edm.String)), relatedConceptIds: Collection(Edm.String)) filterable + sortable |

> **Note**: `relatedConceptIds` array is now persisted on Azure (resolved from concept links during ingest). However the **relation type** between linked concepts (e.g., 'related_to', 'applies_to') is stored only in SQLite's `concept_links` table and silently dropped during Azure ingestion — this remains a data model gap.

### 2.5 Our greenhouse-resume-builder Surface

#### Express API Routes (api/dist/routes/ — compiled JS)
- `annotations.js` — CRUD operations for resume annotations 
- `ingestion.js` — Candidate ingestion pipeline controller (calls Durable Functions) 
- `persons.js` — Person/entity management in pg |
| `relationships.js` | Resume-bullets.js | Candidate-to-candidate relationship inference and confirmation |

#### Azure AI Search Indexes (our repo)

| Index | Fields | Semantic Config |
|-------|--------|-----------------|
| resume-facts | id, tenantId, personId, extractionRunId, sectionId(Col String), factKey, factValue(☐ searchable), bulletText(☐ searchable), normalizedValue, createdAt(Edm DateTimeOffset) | semantic-config: title=factValue, content=[bulletText] |

#### Durable Functions Pipeline
- `Pipeline/index.ts` → 614-line pg pool layer with CRUD for persons, fact_versions, bullet_mappings, annotations, relationships via JSONB
- `functions/src/persistence/` table names: persons|extraction_runs│source_documents│fact_versions│bullet_mappings│annotations│relationships | 
- Orchestration flow (functions): UI submits resume → Express validates JWT+writes PG metadata, triggers IngestCandidateOrchestratorHttpStart → parallel pipeline orchestrates experience extraction skills→education→summary—persistence layer writes to pg JSONB syncs to Azure Search

### 2.6 Existing UI Capability Module Pattern

All 6 capability modules follow identical architecture: React + Vite SPA with hybrid web+MCP App pattern via `mcpHost` detection and MCP bridge interface, each connecting through a specific server URL injected by vite/config.ts from env vars → defaults to localhost port (e.g., 7077 for search/Discovery, 7076 for Geospatial).

**Key architectural details:**
- `globalThis.mcpHost` — if present → embedded mode, direct tool calling to host; otherwise `embedded: false` → JSON-RPC over HTTP |
- Server URL via Vite env var injected at build time (e.g., `VITE_SEARCH_MCP_URL`) |
- Each module is a top-level directory under capabilities/*. ui/src/main.tsx with `mcpHost.callServerTool(name, args)` → JSON-RPC to MCP server → structured content returned.

### 2.7 Shared Contract Types Across the System

#### LLMWiki shared TypeScript types (capabilities/llmwiki/shared/types.ts)
- CollectionInfo|DocumentInfo|SectionInfo|SectionResult extends SectionInfo |ConceptKind=concept'│ rule'│ 'entity' │ template ConceptLink, SearchHit(v_score for hybrid), SearchOptions(docType/flavor filters), Finding|IngestLogEntry(in status: queued/parsing/indexed/error/skipped)|WikiHealthFinding(kind, severity, page, detail).

#### MCP Core types (capabilities/mcp-core/src/types.ts)
- JsonSchema (type/object/properties with additionalProperties bool), ToolCallContext(tenantId, userId, roles[], groups[], scopes[], traceId, invocation), ToolContent(type:text/text), ToolResult(content: []/structuredContent/?/isError?:bool)|McpTool<TArgs>(name/description/inputSchema/handler), |McServerDef(name/version/tools[]).

---

## 3. Proposed Architecture: Wiki Browser — An MCP App Widget

### 3.1 Problem Statement
LLMWiki tools only expose text+structured data results today. The agent layer parses JSON/text; there's no resource surface for a human operator to browse, explore, or visualize indexed wiki content interactively.

## 3.2 Solution
Expose two interaction layers: **agent-facing (existing tools unchanged + tool wrapper)** and operator-facing (new widget via `_meta.ui.resourceUri` protocol). 

### 3.3 Component Diagram — Widget Surface + Server Backend

```
┌─────────────────────── Interactive wiki page ───────────────────┐
│              MCP Host (Claude/ChatGPT) — iframe rendered     │  │   
│                                                        │      │
│  Chat thread with tool results        Wiki-Browser-HTML   │    │
│  Claude calls browse_wiki()          → widget resource   │    │
│  Claude reads text + UI actions                              │
├───────────────────────────────────────────────────────────────┤
│                     LLMWiki MCP Server                        │
│                                                               │
│     [Tools — unchanged]                    [Tool Wrapper]    │
│     search_wiki_sections()   → Browse_wiki()                 │
│     read_wiki_section()          → returns wiki-browse.html  │
│     list_collections()         → widget JSON data payload +  │
│     get_concept()/related_      _meta.ui.resourceUri prop    │
│                                    (triggers iframe render)  │   
│                                                               │
│     [Resources — unchanged]                                 │
│     wiki://schema / index / log / ...                        │
├───────────────────────────────────────────────────────────────┤
│                    Data Layer — unchanged                     │
│                                                               │
│  ┌ SQLite FTS5 (dev)       ─→ All CRUD + search_sections()   │
│  └ Azure AI Search (prod)     wiki-sections/wiki-documents    │
│                                /wiki-concepts indices          │
└───────────────────────────────────────────────────────────────┘

### 3.4 Wiki Page Widget: Layout & Data Mapping

```
┌─ LLMWiki Browser ───────────────────────────────────────────┐
│ Search bar [ Find sections in corpus ▸ ]                    │
│ Filters All Collections ▼ | Flavor raw/wiki                │
│                                                              │
│ ┌ Sidebar: Collection Tree     ─── Results Panel ───────┐  │
│ │ Default Collection (47 docs)                           │ ├───Results[5 hits for "Python"]────────┤
│ ├─ Overview.md         [82]                    │ │      │ │   [1] Experience Section (.94)          │ │ 
| | └ Policies/                                  │ │   │ │    "Experience extraction uses..."        │ │
| ├── AGENTS.md                      [57]     │ │      | │                                     │ │
│ └─ ...                                           │ │    | ├──────────┬───────┼──────────────┤  │
│ ───────────────────────────────────────────┘  │ │     │   Docs▼     │  Content Area      │  │
│ ┌────────── Search + Filters ──────────────┐  │ │     | ┌─Section Body───────┐              │  │
│ │ All Collections ▼    ⚙️ Sort: Score       │  │ │     │ # Experience              │  │   │
| │ Raw/Wiki/All        🔤 A-Z/Filesize      │  │ │     | ## Current Role          │  │  │
└ ───────────────────────────────────────────┘  │ │     | └─────────────────────────┘           │ 
│                                                │ └──────────── Prev │Next ─────────────────────────┘

| Data Surface Mapping (existing tools → rendered UI):|
| Collection list/tree    →   list_collections()      ✓
| Documents in collection →   list_documents(collection, limit) ✓
| Section body + neighbors→  read_wiki_section(id, include_neighbors=True) ✓
│ Search results           →   search_sections(query, filters) ✓ | concept ontology graph (hover/explore) |
| Concept nodes            →   get_concept(id) / related_concepts() ✓
| Document table          →   list_documents(collection?, limit?) ✓
| Wiki log/history       →   ingest_status(max_entries=50) ✓

### 3.5 Interaction Model — Two-Layer Architecture

#### Layer 1: Agent-Facing Surface (Existing Tools, Unchanged
All 10 tools keep working identically for any MCP client Claude uses search_wiki_sections, read_wiki_section, etc. in its tool-calling loop exactly as today. No migration risk. 

### 3.6 Data Flow: End-to-End from Azure Search → Widget Rendering

```
Our Express API POST /api/v1/search
    │ (hybrid keyword + vector over resume-facts index)
    ▼
Azure Search Resume-Facts Index ("resume-facts"): id, tenantId, sectionId factKey(factValue bulletText(✅ searchable) createdAt
    
LLMWiki Browser Widget(in iframe) 
│ app.callServerTool("search_sections", {query}) │ 
| search with filters: collection? docType? flavor? |
│  ┌──────────────> LLMWiki Backend (azure/search_sections(query, col?) → vector_score + snippet ──┐

Result flows back into widget's results panel ← same tool result format ↔ text fallback for Claude | 

### 3.7 Architecture Summary Diagram

```
Claude / MCP Host Surface
───────────────────────
Chat thread with tool results      Interactive Widget
(text fallback for non-widget hosts)   wiki-browser.html (iframe)
                          ┌────┼────────────────────────────────┤
                          │    │                                  │ 
                          ▼    ▼                                 │
                   +------+--------+                             │
                   | LLMWiki Widget |←── bidirectional        │
                   | (App class)   │       callServerTool     │
                   └──┬───────────┘                           │ 
                      │ resources/read                       │
┌──────────┐  tools/call   ▼                                │
│ Claude   │──────→>+──────────────────────────┐    │
│ reasoning◄│               Widget renders              │    │ 
│ model      |                Indexed data views             │   
└───────────┘                                                │    │
                                                              │  │
+--------+------> LLMWiki MCP Server (Azure Fn) ──┼────┐    |
|                    Tools surface:                 |     |
| browse_wiki, search_sections, read_section        |      | 
| list_collections/documents/concepts               |       |
+-----------|-----> wiki://resources ←──→ data model─────────┘

│   Our Repo UI Surface ────────────────────────────────┐
│  Discovery/Geospatial/Quality/Relationships/Temporal   │
│    each a separate React Vite SPA calling MCP servers    |
└───────────────────────────────────────────────────────┘   

### 3.8 Architectural Decisions & Trade-offs

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Widget HTML delivery method | Resource URI (ui://wiki-widget.html) served from LLMWiki server, inlined with ext-apps bundle | MCP spec requires resources to be fetchable via read_resource; inline avoids external CDN dependency which browser sandbox blocks via CSP |
| Data fetching strategy | Widget calls server tools itself (app.callServerTool) after page loads rather than server-rendering HTML fragments | Client maintains UI state (scroll position, collapsed trees, search query); server stays thin — just the 10 existing python tools unchanged |
| Widget granularity | One unified browser widget with tabbed views (Browse/Search/Concepts graph) instead of N separate widgets per data surface | Reduces mental model for users; wiki surfaces are inherently interconnected anyway |
| Search mode toggle inside widget | Client manages search query state, pushes to server via browse_wiki(query=...) tool call or direct API search_sections | Keeps widget interactive sub-second latency without full page refresh |
| Concept graph visualization | D3 force-directed rendered from relatedConceptIds[] stored per concept in Azure index; fetch edges on hover via get_concept + find_related_concepts() | Azure backend stores relatedConceptIds[] array; fetch via get_concept() → render edges client-side |

---


## 4. What This Does NOT Change (Preservation Guarantees)

- All 10 existing Python tools keep working exactly as before for any MCP client. 
- Existing resource URIs: `wiki://manifest, wiki://schema`, wiki://document/{id}, etc. remain unchanged and unmodified
- Azure Search indices & data models are completely untouched — widget queries the same backends | 
- Durable Functions ingestion pipeline + PostgreSQL JSONB + Express API routes all unaffected

## 5. What This Adds

A **single widget: `ui://wiki-browser.html`** that presents LLMWiki's indexed data as an interactive knowledge browser presenting collections documents sections, concepts graph running inside the chat surface calling same python tools powering everything else today.--- END OF ARCHITECTURE DOCUMENT ---


Now let me create the implementation plan.

