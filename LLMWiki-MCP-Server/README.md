# LLMWiki MCP Server

A self-contained, **read-only** [FastMCP](https://github.com/PrefectHQ/fastmcp) server that indexes operator-curated documents and LLM-authored notes on the local filesystem and exposes them to the Office AI agent.

The design follows the [Karpathy LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): two on-disk layers (raw sources and an LLM-maintained markdown wiki) with a tiny schema-defining file the agent reads first. **This server never writes through MCP** — the agent has search, read, citation, and lint tools, but no write tools. The operator (or the agent's host-side file tools, used outside MCP) maintains the wiki on disk.

- **Read-only MCP surface.** No write/edit/append/delete tools. Trust boundary stays obvious.
- **No external dependencies by default.** Storage is the local filesystem of the server. Search and indexing are done with Python's stdlib `sqlite3` + FTS5.
- **Pluggable extractors.** Built-in `txt`/`md`/`html` work out of the box. `pypdf` adds basic PDF text. Opt in to Azure Document Intelligence for premium OCR + layout, plus image (`png|jpg|tif|bmp|heif`) and Office (`docx|xlsx|pptx`) support — see [Extractors](#extractors).
- **Two indexed layers.** `data/corpus/` for raw sources (immutable), `data/wiki/` for LLM-authored notes. Both are searchable; queries can be scoped to either with a `flavor` filter.
- **Canonical wiki files** (`AGENTS.md`, `index.md`, `log.md`) are exposed as dedicated `wiki://schema|index|log` resources so the agent can orient itself in one round-trip.
- **Background ingestion.** A polling watcher parses, chunks, and indexes new files automatically.
- **Ontology layer.** Deterministic rule/concept/entity extraction with provenance — every concept points back to a section + source file.
- **Local-only by default.** Binds to loopback (`127.0.0.1:8765`) and runs unauthenticated. To expose it on a LAN you must explicitly set `LLMWIKI_HOST=0.0.0.0` **and** front it with a reverse proxy or copy the `MultiAuth` pattern from [`../MCP-Server/server.py`](../MCP-Server/server.py) — never bind to all interfaces without an auth layer.

## The three layers

| Layer | Path | Who owns it | What it contains |
|---|---|---|---|
| Raw sources | `data/corpus/` | Operator | `txt`, `md`, `html`, `pdf` always; `png`/`jpg`/`tif`/`bmp`/`heif` images + `docx`/`xlsx`/`pptx` Office docs when Document Intelligence is enabled. |
| LLM wiki | `data/wiki/` | LLM (via tools **outside** this server) | Markdown summaries, entity pages, concept pages, the index, the log. |
| Schema | `data/wiki/AGENTS.md` | Operator + LLM (co-evolved) | Page conventions, ingest/query/lint workflows. The agent reads this first. |

The wiki layer is populated by the agent using its host-side file tools (in Office AI, that's the bash + `write_file`/`edit_file` tools). This MCP server only **reads** from `data/wiki/`; it has no authority to mutate it.

## Layout

```
LLMWiki-MCP-Server/
├── server.py                     # CLI / fastmcp entrypoint
├── app.py                        # Lazy ASGI entry for gunicorn/azure
├── llmwiki/
│   ├── mcp_factory.py            # Import-safe FastMCP factory + CORS helpers
│   ├── config.py                 # paths + env knobs (incl. Document Intelligence)
│   ├── models.py                 # dataclasses (Document, Section, Concept, ...)
│   ├── storage.py                # sqlite + FTS5 schema and DAO
│   ├── extractors.py             # pluggable extractor registry + builtins
│   ├── extractors_doc_intel.py   # optional Azure Document Intelligence extractor
│   ├── chunking.py               # heading-aware section splitter
│   ├── ontology.py               # rule/concept/entity extraction
│   ├── retrieval.py              # search, read, related
│   ├── validators.py             # check_content_against_wiki
│   ├── lint.py                   # read-only wiki health checker
│   ├── ingest.py                 # ingestion pipeline (scans both roots)
│   ├── watcher.py                # background filesystem poller
│   └── tools.py                  # MCP tool + resource registrations
├── scripts/
│   ├── ingest_once.py            # one-shot scan + index
│   └── reset_index.py            # blow away the sqlite db
├── data/
│   ├── corpus/                   # raw sources (operator drops files here)
│   ├── wiki/                     # LLM-authored markdown notes
│   ├── parsed/                   # canonical markdown (machine-generated)
│   └── index/                    # sqlite db (machine-generated)
└── tests/
```

## Quick Start

```bash
python3.11 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
# Optional: only needed if you want to ingest PDFs.
pip install "pypdf>=4.0.0"
# Optional: opt in to Azure Document Intelligence for premium OCR + layout
# and to ingest images / DOCX / XLSX / PPTX. See "Extractors" below.
# pip install "azure-ai-documentintelligence>=1.0.0" "azure-identity>=1.17.0"

# 1. Drop raw sources (txt/md/html/pdf) into data/corpus/
# 2. Optionally write data/wiki/AGENTS.md, data/wiki/index.md, data/wiki/log.md
#    plus any topic/entity/concept pages you (or your agent) author.
# 3. Index everything:
python scripts/ingest_once.py

# Run the server (background watcher starts automatically):
python server.py
# or:
fastmcp run server.py --transport http --port 8765
```

The MCP endpoint is `http://localhost:8765/mcp`.

## MCP Tool Surface (10 tools, all read-only)

| Tool | Purpose |
|---|---|
| `search_wiki_sections(query, collection?, doc_type?, flavor?, max_results?)` | BM25 search over indexed sections. `flavor="wiki"` scopes to LLM-authored notes; `flavor="raw"` scopes to raw corpus. |
| `read_wiki_section(section_id, include_neighbors?, max_chars?)` | Full text of one section + citation metadata. |
| `get_concept(concept_id)` | Authoritative definition of a rule/concept/entity plus its source citation. |
| `find_related_concepts(concept_id, max_results?)` | Walk the deterministic ontology links from a concept. |
| `list_collections()` | All ingested collections + counts + last indexed timestamps. |
| `list_documents(collection?, flavor?, max_results?)` | Documents with metadata, optionally scoped by collection and/or flavor. |
| `check_content(content, collection?, max_findings?)` | Lint draft text against extracted rules; returns findings with severity + citation. |
| `ingest_status(max_entries?)` | Watcher status + recent ingest log entries. |
| `trigger_ingest()` | Force a synchronous rescan of both roots. |
| `lint_wiki(max_findings?)` | **Read-only** diagnostic over `data/wiki/`: orphan pages, broken intra-wiki links, gaps in `index.md`, missing canonical files. Does not modify anything. |

## MCP Resources

| Resource URI | Returns |
|---|---|
| `wiki://manifest` | High-level server metadata: layers, collections, tool/resource list. |
| `wiki://schema` | Contents of `data/wiki/AGENTS.md` (falls back to `CLAUDE.md`). The agent should read this first. |
| `wiki://index` | Contents of `data/wiki/index.md` (catalog of wiki pages). |
| `wiki://log` | Contents of `data/wiki/log.md` (append-only activity log). |
| `wiki://collection/{collection_id}` | Documents and rule counts for a collection. |
| `wiki://document/{document_id}` | Sections + extracted concepts for one document. |
| `wiki://section/{section_id}` | Full canonical markdown for a section. |

The canonical-file resources read directly from disk on every request, so they always reflect the operator's latest commit — no re-ingest needed.

## Office AI Connection Config

Add to your Office AI MCP connections config:

```json
{
  "id": "llmwiki",
  "label": "LLM Wiki",
  "description": "Local PDF/Markdown knowledge base with ontology-aware retrieval.",
  "transport": "streamable_http",
  "endpoint": "http://localhost:8765/mcp",
  "enabled": true,
  "alwaysActive": true,
  "parallelSafeRemoteTools": [
    "search_wiki_sections",
    "read_wiki_section",
    "get_concept",
    "find_related_concepts",
    "list_collections",
    "list_documents",
    "ingest_status",
    "lint_wiki"
  ]
}
```

`alwaysActive: true` is appropriate because the tool count stays small (10). If you connect multiple knowledge servers, turn on `agentTuning.mcpLazyLoading` in Office AI's `runtime-config.json`.

## Why read-only

The Karpathy pattern describes the wiki as *LLM-authored*, but the writes can happen anywhere — a separate CLI tool, the agent's bash/`write_file` tools, an Obsidian session, manual edits. Keeping this MCP server read-only:

- **Preserves the trust boundary.** Nothing reachable via MCP can mutate the corpus or the wiki. The operator audits the wiki by reading the markdown files, not by reviewing tool call logs.
- **Avoids tool-surface bloat.** A write surface needs `write_page`, `update_page`, `append_log`, `rewrite_index`, plus path-safety validation and a journal. None of that is needed if the agent writes through its existing host tools.
- **Decouples authorship from retrieval.** Multiple agents (or humans) can write the wiki concurrently; this server just indexes whatever lands on disk.

If you do want a write surface, fork this server and add explicit `wiki_write_*` tools scoped strictly to `config.wiki_dir`. Document the path-safety check in the tool docstring.

## Design Choices

1. **SQLite FTS5 over a vector store.** SQLite ships with Python; FTS5 is built in. Hybrid retrieval is good enough for style-guide / policy / documentation lookups and removes all infra cost. Embeddings can be added later as a `vectors` table without breaking the contract.
2. **No LLM-driven ontology extraction.** Concept/rule extraction is deterministic and rule-based to avoid hallucinating policy. Every extracted concept points to a section. Drift is fixed by editing the source document, not by retraining a model.
3. **Polling watcher, not OS notifications.** Cross-platform, zero deps, and predictable. Default poll interval is 30s.
4. **Heading-aware chunking, not fixed-token windows.** Sections preserve `heading_path` ("Chapter 2 > Style > Tone"), which is what users cite and what hybrid search ranks well.
5. **Pluggable extractors with a fallback chain.** Builtins keep the zero-deps default working, while premium backends (Azure Document Intelligence today, others later) can be opted in per deployment without forking the ingest pipeline. The active extractor is captured on every document for audit.
6. **Lint is read-only.** It reports orphans, broken links, and index gaps but never edits. The agent fixes them through its own write tools, outside MCP.
7. **Unauthenticated by default.** This server is meant to be local and binds to `127.0.0.1` out of the box. If you expose it remotely, set `LLMWIKI_HOST=0.0.0.0` only after wrapping it behind a reverse proxy or adding the same `MultiAuth` pattern used in [`../MCP-Server/server.py`](../MCP-Server/server.py).
8. **Import-safe ASGI hosting.** Shared hosts import `app:app`, which creates the FastMCP server lazily on the first request. This avoids starting an extra watcher just by importing `server.py`.

## Extractors

Extractors are pluggable. The registry keeps an ordered fallback chain per `doc_type`, so you can stack a premium OCR/layout backend on top of the built-ins without changing call sites. The extractor that produced a document is recorded on `Document.metadata["extractor"]` for auditability.

| Backend | Handles | Install | Notes |
|---|---|---|---|
| `builtin.text` | `txt`, `md` | none | stdlib |
| `builtin.html` | `html`, `htm` | none | strips tags, preserves paragraphs |
| `builtin.pypdf` | `pdf` | `pip install "pypdf>=4.0.0"` | basic text extraction; no OCR, no layout |
| `azure.documentintelligence` | `pdf`, `image` (png/jpg/jpeg/tif/tiff/bmp/heif), `docx`, `xlsx`, `pptx`, optionally `html` | `pip install "azure-ai-documentintelligence>=1.0.0" "azure-identity>=1.17.0"` | premium OCR + table/figure layout via the `prebuilt-layout` model. Returns markdown with page-break markers that map back to source pages. |

### Built-in PDF support (`pypdf`)

If a PDF lands in `data/corpus/` and `pypdf` is not installed, the file is recorded in `ingest_log` with status `skipped`:

```bash
pip install "pypdf>=4.0.0"
python scripts/ingest_once.py
```

### Premium OCR (Azure Document Intelligence)

Opt in to Azure Document Intelligence for: high-accuracy OCR on scanned PDFs, image ingestion, Office-file ingestion (`docx`/`xlsx`/`pptx`), and layout-aware markdown with page anchors.

```bash
pip install "azure-ai-documentintelligence>=1.0.0" "azure-identity>=1.17.0"
```

Configure with environment variables:

| Variable | Default | Notes |
|---|---|---|
| `LLMWIKI_DOC_INTEL_ENDPOINT` | unset | e.g. `https://your-resource.cognitiveservices.azure.com/`. Setting this turns the extractor on. |
| `LLMWIKI_DOC_INTEL_API_KEY` | unset | If set, authenticated with `AzureKeyCredential`. If unset, `DefaultAzureCredential` is used (Managed Identity, Entra, az login, etc.). |
| `LLMWIKI_DOC_INTEL_MODEL` | `prebuilt-layout` | Any DI prebuilt or custom model id. |
| `LLMWIKI_DOC_INTEL_FOR` | `pdf,image` | Comma-separated `doc_type`s the DI extractor handles. Valid values: `pdf`, `image`, `docx`, `xlsx`, `pptx`, `html`. |
| `LLMWIKI_DOC_INTEL_FALLBACK` | `false` | If `true`, keep `pypdf` as a second-tier PDF fallback. If `false` (default), DI is the only PDF extractor and failures surface loudly in `ingest_log`. |
| `LLMWIKI_DOC_INTEL_TIMEOUT_SECONDS` | `300` | Poller timeout per file. |

**Trust boundary.** Document bytes are sent to your Azure tenant. Document Intelligence bills per page. Don't enable this for sensitive corpora without reviewing the [Azure AI privacy and data-protection guidance](https://learn.microsoft.com/azure/ai-services/document-intelligence/concept-privacy).

**Fail-loud by default.** When DI is enabled and `LLMWIKI_DOC_INTEL_FALLBACK=false`, `pypdf` is evicted from the registry for PDFs. This is intentional — silently dropping to lower-quality extraction would corrupt the index. To preserve `pypdf` as a fallback for transient DI failures, set `LLMWIKI_DOC_INTEL_FALLBACK=true`.

## Release Status

### Phase 1 — Storage Abstraction (done)
- `WikiStorage` ABC defines the interface all backends must implement.
- `WikiSQLiteSearchBackend` is the local SQLite FTS5 backend (zero-deps default).
- Factory: `create_sqlite_backend()` and `create_azure_backend()` in `backends/base.py`.

### Phase 2 — Azure AI Search Integration (done)
- **Azure AI Search backend** (`backends/azure_backend.py`) with full method parity to SQLite DAO.
- **Hybrid BM25 + vector search** configured via index schemas with `bodyVector` field (1536-dim OpenAI).
- **Tenant isolation**: all queries enforce `_require_tenant()` guard; unverified callers are blocked (fail-closed).
- **Embedding generation** (`embeddings.py`) for local dev when Azure built-in vectorization isn't configured.
- **OData escaping unified**: `_esc_str()` eliminated, only module-level `_esc()` used.
- **Section metadata fix**: `sec_doc["metadataJson"]` no longer corrupted by doc-level meta overwrite in `replace_document()`.
- **Bicep template** (`bicep/search.bicep`) for provisioning Azure AI Search + Blob Storage.

### Ongoing — Phase 3 (Microsoft Planner)
- Port the Python FastMCP server to follow the team's TypeScript MCP pattern, create `capabilities/llmwiki/mcp/` module.

## Architecture Plan

Full target architecture is documented in [`llmwiki-azure-arch-plan.md`](../llmwiki-azure-arch-plan.md). The plan covers:
- Target capability module layout (`capabilities/llmwiki/`)
- Storage abstraction layer spec (TypeScript)
- Index schema mapping (SQLite → Azure AI Search)
- Deployment strategy (Azure Functions / Bicep)

### ## Tests

```bash
python -m unittest discover -s tests -v
```

Tests cover the chunker, the storage layer (schema + FTS5 round-trip + flavor filter), the deterministic ontology extractor, and the read-only wiki linter. They run with no network and no fixtures beyond the repo.
