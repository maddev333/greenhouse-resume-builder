# LLMWiki Interactive Wiki — Implementation Plan

**Sourced from**: `docs/wiki-app-architecture.md` (2026-06-19)  
**Scope**: Phase-by-phase implementation guide for making the LLMWiki-MCP-Server an interactive MCP App with a wiki browser page as a resource surface. No code changes to existing tools/APIs are required or recommended.

---

## Implementation Overview

This plan follows the architecture defined in `docs/wiki-app-architecture.md`. The goal is to expose **one new widget UI** — `ui://wiki-browser.html` — that lets an operator browse LLMWiki's indexed content (collections, documents, sections, concepts) in real time. All 10 existing tools (`search_wiki_sections`, `read_wiki_section`, `list_collections`, etc.) keep working unchanged; the widget is a thin client that calls them via `app.callServerTool()` after page load.

**Key principle**: Add new surface, modify zero existing behavior.

### Effort & Dependencies Summary

| Phase | Effort | Depends On | Risk |
|-------|--------|------------|------|
| **Phase 0** — Foundation (shared types, server detection) | 2-3 hrs | None | Low — follows established patterns |
| **Phase 1** — Server-side additions | 4-6 hrs | Phase 0 setup | Low — widget registration mechanism |
| **Phase 2** — Widget HTML/JS surface | 8-12 hrs | Phase 1 registration | Medium—interactive UI complexity |
| **Phase 3** — React wrapper component | 6-8 hrs | Phase 2 complete | Low - uses bridge pattern verbatim from existing modules |
| **Phase 4** — Integration & Testing | 4-6 hrs | All phases complete | Depends on LLMWiki server state |

Total estimated engineering time: ~3-5 working days.

---

## Phase 0 — Foundation (Shared Contracts & Detection)

### Objective
Establish the shared type contract and widget detection pattern so all layers speak the same language.

### Tasks

#### Task 1.1: Confirm Shared Type Alignment
**File**: `capabilities/llmwiki/shared/src/types.ts` → **already complete**  
**What to verify**: Every data model used by the wiki browser widget already has a matching TypeScript interface. No new shapes need to be defined. Check list (all confirmed present):
- `CollectionInfo` — id, name, description, created_at, document_count, section_count, concept_count, last_ingested_at
- `DocumentInfo` — id, source_path, title, doc_type, content_hash, size_bytes, parsed_path, metadata
- `SectionInfo` | SectionResult extends SectionInfo — heading_path, heading, body, body_chars, page_anchor, metadata
- ConceptKind (enum: 'concept'/'rule'/'entity'/'template') → ConceptInfo — same fields as docs above plus slug and kind
- ConceptLink { src_concept_id | dst_concept_id }
- `SearchHit` — vector_score present when hybrid search active

**Decision**: No new types required. The existing 165-line shared contract already covers every data surface the wiki widget will display.

#### Task 0.2: Add LLMWiki Browser Tool Detection Pattern
**Where**: New utility file at `capabilities/llmwiki/ui/src/mcp-bridge.ts` (sibling to existing modules' bridge patterns)  
**What to add**: A reusable detection + bridge factory matching the established pattern found in Discovery, Geospatial, and Relationship UI modules:

```typescript
// capabilities/llmwiki/ui/src/mcp-bridge.ts - establishes McpBridge interface used everywhere else.
interface McpBridge {
  embedded: boolean;   // true when in MCP host iframe, false when standalone web
  callTool(name: string, args: any): Promise<any>;
}

function createMcpBridge(serverUrl: string): McpBridge {
  const host = (globalThis as any).mcpHost;
  if (host && typeof host.callTool === 'function') {
    return { embedded: true, callTool: (n, a) => host.callTool(n, a) };
  let id = 1;
  return {
    embedded false,
    async callTool(name, args) { // JSON-RPC POST to MCP server with structuredContent fallback.
```

**Reuse verbatim**: This matches exact logic found in:

- `capabilities/discovery/ui/src/main.tsx` (Resume Diff)  
- `capabilities/geospatial/ui/src/main.tsx` (Azure Maps Pins)  
- `capabilities/relationships/ui/src/main.tsx` (Relationship Confirmation)  

#### Task 0.3: Configure Vite Env Var for LLMwiki Server URL
**File**: `capabilities/llmwiki/ui/vite.config.ts` → new file, mirrors existing modules' vite configs | 
| **What to add:**
```typescript
VITE_LLMWIKI_MCP_URL: process.env.LLMWIKI_MCP_URL || 'http://localhost:8765/api/mcp/llmwiki',
```
- **Server defaults to port `8765`** (as defined in `LLMWiki-MCP-Server/app.py`).

---

## Phase 1 — Server-Side Additions (Widget Registration + Browse Tool)

### Objective
Add two items to the LLMWiki MCP server: a new tool that wraps existing search/browse endpoints and references a widget resource URI, plus the widget HTML itself served as a widget resource.

**Files modified**: `LLMWiki-MCP-Server/llmwiki/tools.py` (one new tool class method), `LLMWiki-MCP-Server/llmwiki/mcp_factory.py` (resource registration). No other files touched.

#### Task 1.2: Register Browse Tool in tools.py 
**Path**: `LLMWiki-MCP-Server/llmwiki/tools.py` — add a new registration inside the existing `register_tools()` factory pattern at its end (same class-based structure used by all 10 existing tools).

```python
@register_wiki_tool(
    "browse_wiki", 
        description="Browse wiki content. Returns interactive browse widget when available. When no section_id provided, shows the collection manifest + initial document previews. When section_id is provided, navigates directly to that section.",
        input_schema={
            "section_id": {"type": "string"},
            "query": {"type": "string"} # triggers search mode | collection_filter: {"type": "string" } # restricts results by collection ID
        },
    resource_uri="ui://wiki-browser.html",  # tells MCP host to render widget iframe
)

async def browse_wiki(ctx, section_id=None, query=None):
    """Browse wiki content (wraps existing tools)."""
    if query:
        data = search_sections(query=query, limit=20) 
    else |
        data = { "manifest": list_collections(), collections_with_preview } |  # each collection's preview is first 10 docs' titles/counts
    
    return json.dumps(data),
```

**Decision**: The browse tool uses exactly the same `ctx` pattern, JSON serialization, and class-based registration structure as every other tool in `register_tools()`. No new serialization logic needed — reuse existing patterns.

#### Task 1.3: Register Widget Resource URI for HTML Delivery
**Path**: `LLMWiki-MCP-Server/llmwiki/mcp_factory.py` → add resource registration alongside existing tools/resource setup in `create_mcp_server()` function (the one that also sets up fastmcp server).

```python
@server.register_app_resource(
    "LLMWiki Browser Widget",
    "ui://wiki-browser.html",
    csp={
        "connectDomains": ["localhost:8765"],  # widget's own API calls go here
        "resourceDomains": [],  # no external APIs from browser iframe | 
    },
    domain=["localhost"],   # cors origin for local dev.
)

def wiki_browser_resource():
    """Deliver the interactive wiki browser widget HTML."""
    html_template = _load_wiki_browser_html()  # read from static dir or embed
    return { "uri": "ui://" |"wiki-browser.html", "mimeType": TEXT_HTML_MIME_TYPE, "label": "LLMWiki Browser", "text": html_template }

```

**Key decision point**: The widget HTML file lives as a standalone `.html` resource (served verbatim via read_resource API) rather than inlined into server code. This mirrors how other web servers serve static assets. The MCP host's iframe renders this HTML, and the browser-side JS calls `app.callServerTool` to fetch data from the LLMWiki tools at runtime.

---


## Phase 2 — Widget HTML/JS Surface (Interactive Browser) 

### Objective
Build the actual wiki browser page that will render inside the MCP host iframe. This is the main UI deliverable. It should use D3.js for any graph visualization, a search input box, and fetch data from LLMwiki tools via `app.callServerTool()`.

**File**: `LLMWiki-MCP-Server/static/ui/wiki-browser.html` — single self-contained HTML file with inlined CSS/JS (no build step). The widget is served directly through the MCP resource URI. 

#### Task 2.1: Scaffold Wiki Browser HTML
Structure the page layout matching the design from §3.4 of the architecture doc:

```html
<div class="wiki-browser">
    <sidebar> <!-- Collection tree view --> </aside>
    <results-panel />
    <content-area /> <!-- Section body + prev/next --> 
    <graph-panel />  <!-- Concept graph hover/explore -->
</div>
```

Use existing LLMWiki Python tool calls from the browser JS via `app.callServerTool('browse_wiki', args)` | **Key pattern**: All data fetching from the widget happens client-side after page load, using `app.callServerTool()` to talk back to the LLMwiki MCP server's tools (unchanged: search_sections, list_collections, get_concept, etc.). 

#### Task 2.2: Implement Collection Tree View
The sidebar renders recursively by calling `list_collections()` on initial load and every time a collection node is expanded. Each node displays collection name, document count badge, last_ingested_at date.

#### Task 2.3: Implement Search + Results Panel
Search input → user types → triggers debounced call to `search_sections(query=typed_text)` (existing tool). Results panel shows snippet of search hits sorted by score (as `SearchHit[]` from existing tools). Clicking a result updates both Section body view and related content display.

#### Task 2.4: Implement Section Body View
On any section selection or click: calls `read_wiki_section(section_id=<selected>, include_neighbors=true)` → renders full section heading + body in the main content area with prev/next buttons | 

### Task 2.5: Implement Concept Graph Panel (Hover to explore)
When user hovers over a concept name/section mention, fetches the related_concept_ids array from `get_concept(concept_id)` and renders an edge network graph (D3 force-directed or simple node-link SVG). Each node shows concept name + kind badge. Clicking a node → expands definition view in adjacent panel.

---

## Phase 3 — React Wrapper Component (Embeddable) 

### Objective
Wrap the widget HTML into a React component that can be used inside any of our existing capability modules or standalone MCP App UI. This mirrors how all six other capability UI modules are implemented: single-page SPA wrapping a server tool call with McpBridge for communication.

**File**: `capabilities/llmwiki/ui/src/main.tsx` + supporting components
**Pattern**: Follows exact same architecture as Discovery Resume Diff, Geospatial Map Pins, Relationship Confirmation, Quality Review Queue, and Temporal Predictions UI modules — all follow identical React→bridge→MCP server pattern.

### Task 3.1: Create main.tsx Scaffold
```tsx
// capabilities/llmwiki/ui/src/main.tsx - entry point for wiki browser module

/** LLMWiki Browser — MCP UI App (hybrid web + MCP App). Runs **embedded in MCP host or standalone.** */

export function App() { const [bridge] = useMcpBridge(VITE_LLMWIKI_MCP_URL); return <WikiBrowser bridge={bridge} />; }
```
Follow established pattern from all 6 capability modules' main.tsx files: detect MCP host vs standalone → use `createRoot` from React DOM.

### Task 3.2: Build Wiki Browser as a React Component
Props-based wrapper around the HTML widget with search, collection tree, results panel, Section body area and graph exploration panels — all connected via bridge interface to LLMwiki tool calls. Renders inside iframe provided by MCP host. Uses identical bridge pattern found in existing modules' main.tsx files.

### Task 3.3: Create Vite Config for React App
**File**: `capabilities/llmwiki/ui/vite.config.ts` — mirrors discovery-ui.tsx patterns exactly:
- Dev server on port (e.g., 5173)
- Injects env vars via `import.meta.env.VITE_LLMWIKI_MCP_URL` 
- Proxy to MCP server at `localhost:8765` for local dev

### Task 3.4: Add Wiki Browser to Package.json scripts
Ensure capability module is added to npm/yarn workspaces alongside all six existing modules (Discovery, Geo, Quality, Relationship, Temporal, Ingestion).

---


## Phase 4 — Integration & Testing 

### Objective
Verify the complete flow works end-to-end in both standalone and embedded modes, across SQLite local dev mode and Azure Search production mode.

### Task 4.1: Test Standalone Mode (No MCP Host)
Steps:
1. Start local LLMwiki server (Python): `python LLMWiki-MCP-Server/server.py` → port 8765
2. Start React app: `npm run dev --prefix capabilities/llmwiki/ui` → port 5173
3. Navigate to `localhost:5173` in browser → should load widget + data fetches via JSON-RPC bridge to Python server at :8765

Expected results: Collection tree loads, search works, section body renders, concept graph appears when relevant sections with concept mentions are selected. 

### Task 4.2: Test Embedded Mode (In MCP Host)
Steps | 
1. Configure test MCP host app that injects `globalThis.mcpHost = { callTool ... }` bridge interface.
2. Run React app with `mcpHost.callTool("list_collections", {})` → returns Collection[] from real LLMwiki server.
3. Browse collections, sections, concepts — verify every interaction works identically to standalone mode.

### Task 4.3: Test With Azure Backend (Production Simulation)
Steps:
1. Set `config.storage_mode="azure"` in LLM wiki config
2. Run with real Azure credentials → ensure widget shows data from Azure indices instead of SQLite | 
| **Expected**: Widget should show same UI surface, just querying different backend source at runtime | 

### Task 4.4: Verify Existing Tools Unchanged
**Critical test**: Run all 10 existing tools (search_sections, read_section, list_collections, check_content, etc.) in their original tool-calling scenarios. Confirm tool responses are **identical to before any changes**. The browse_wiki tool should not break any existing behavior. Use MCP server's `tools/list` endpoint at `/api/mcp/llmwiki/tools/list` to verify only the new tool was added and nothing removed.

---

## Task Sequence: What to Do First | 

### Execution Order (sequential dependencies):
1. Phase 0 Tasks 1.1 + 1.2 (verify types match, add bridge utility) → **no other changes needed yet**| 2. Phase 1 Task 1.2 (add browse_wiki tool) | 
3. Phase 1 Task 1.3 (register widget resource) |
4. Phase 2 Tasks 2.1-2.5 (build HTML/JS widget in static/html dir) → build step needed for CSS/JS bundling if any imports exist
5. Phase 3 Tasks 3.1-3.4 (React wrapper, vite config, package.json scripts) | 
6. Phase 4 Test Standalone + Embedded Azure backend |

---

## Risk Register & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Widget HTML cannot fetch from local dev MCP server | High | Medium | Use CORS headers on LLMWiKI server |
| Widget iframe gets blocked by CSP in some hosts | Medium | Medium | Inline all CSS/JS, no external CDN deps. Use `__SELF_HOSTED__` flag for local dev |
| Search results format changes between SQLite/Firefox/Azure backends | Low | High | All tool responses go through same JSON serialization; verify search hits structure in test 2.4 |
| Browser iframe cannot call MCP tools via JSON-RPC | Medium | Critical | Provide HTTP fallback URL (`VITE_LLMWIKI_MCP_URL`) for widget to fetch data when mcpHost.callTool isn't available |
| Merging browse tool with existing tools.py is error-prone | Low | Low | Add it as last method in existing `register_tools()` call chain — uses same ctx/serialization pattern. Verify via MCP's tools/list endpoint before testing | 
## Deliverables Checklist

- [ ] ✅ docs/wiki-app-architecture.md (this document) | **Done** ✓
- [ ] ❌ Phase 0: bridge.ts + vite-env configured → capabilities/llmwiki/ui/src/mcp-bridge.ts |
- [ ] ❌ Phase 1: browse_wiki tool registered → LLM Wiki-MCP-Server/llmwiki/tools.py
| - [❌ Phase 2: Widget HTML delivered → wiki-browser.html static resource served via MCP resource URI. 
- [] ❌ Phase 3: React wrapper component built → capabilities/llmwiki/ui/src/main.tsx + vite.config.ts |
— [ ] ❌ Phase 4: All tests passed (standalone, embedded Azure) → verification complete | 

---

## References

1. `docs/wiki-app-architecture.md` — full cross-repo survey & design specs | 
2. `LLMWiki-MCP-Server/llmwiki/tools.py` — 10 existing tool definitions + register_tools pattern |
3. `LLMWiki-MCP-Server/app.py` — app entry point (ASGI, port 8765) | 
4. `api/src/search/index.ts` — resume-facts index field/semantic config |
|5. `functions/src/persistence/` → pg JSONB CRUD for persons, fact_versions, etc. |

### Appendix A: Existing Module Quick Reference (for pattern matching)

For implementing the widget/React UI, reference these files verbatim for established patterns:
- `capabilities/discovery/ui/src/main.tsx` — resume diff + MCP bridge pattern 
| -  `capabilities/geospatial/ui/src/main.tsx` — Azure Maps pins | McpBridge interface pattern |
|6. `capabilities/relationships/ui/src/main.tsx` — confirmed_mcp_host detection pattern
- `capabilities/mcp-core/src/types.ts` — shared JSON schema + tool result types |

--- 

**END OF IMPLEMENTATION PLAN**
