"""MCP tool and resource registrations.

All responses are JSON-serialisable dicts so the MCP transport can
encode them without extra effort. The server is **read-only**: the
agent cannot mutate anything through MCP. The two writable
filesystem locations on disk are owned by the operator:

* ``data/corpus/`` — immutable raw sources (PDFs, articles, papers).
* ``data/wiki/`` — LLM-authored markdown notes maintained externally
  (the operator drops files in, typically produced by an agent using
  its host-side file tools). The server indexes both layers and
  exposes the canonical wiki navigation files (``AGENTS.md``,
  ``index.md``, ``log.md``) as ``wiki://schema|index|log`` resources.

Tools follow the Karpathy LLM-Wiki pattern: search → drill in → cite.
The optional ``flavor`` filter (``"raw"`` | ``"wiki"``) lets the agent
scope a query to grounding sources or to the curated wiki itself.
"""

from __future__ import annotations

from dataclasses import asdict
import uuid
from typing import Any

from fastmcp import FastMCP
from fastmcp.tools.tool import ToolResult

from .config import LLMWikiConfig
from .ingest import IngestService
from .lint import lint_wiki as run_lint_wiki
from .models import IngestLogEntry
from .retrieval import read_section, search_wiki
from .storage import Storage
from .validators import check_content_against_wiki
from .watcher import CorpusWatcher


def register_tools(
    mcp: FastMCP,
    *,
    config: LLMWikiConfig,
    storage: Storage,
    ingest: IngestService,
    watcher: CorpusWatcher,
) -> None:
    # ------------------------------------------------------------------
    # Search and retrieval
    # ------------------------------------------------------------------
    @mcp.tool
    def search_wiki_sections(
        query: str,
        collection: str | None = None,
        doc_type: str | None = None,
        flavor: str | None = None,
        max_results: int = 8,
    ) -> dict[str, Any]:
        """Search indexed wiki sections via BM25.

        Returns a compact hit list with section_id, document_title,
        heading_path, page_anchor, snippet and score. Call
        `read_wiki_section` with the section_id to fetch the full body.

        Args:
            query: Free-text query. Punctuation is stripped; tokens are
                OR'd with a phrase match boost.
            collection: Optional collection slug filter (e.g.
                "style-guide"). Use `list_collections` to discover values.
            doc_type: Optional filter: "pdf" | "md" | "txt" | "html".
            flavor: Optional source-layer filter: "raw" restricts to
                immutable corpus documents; "wiki" restricts to the
                LLM-authored wiki notes under data/wiki/. Omit to search
                both.
            max_results: Cap on results returned (1-25, default 8).
        """
        return search_wiki(
            storage,
            query=query,
            collection=collection,
            doc_type=doc_type,
            flavor=flavor,
            max_results=max_results,
        )

    @mcp.tool
    def read_wiki_section(
        section_id: str,
        include_neighbors: bool = False,
        max_chars: int | None = None,
    ) -> dict[str, Any]:
        """Read a single wiki section by id.

        Args:
            section_id: The section identifier returned by
                `search_wiki_sections` or `list_documents`.
            include_neighbors: If true, also returns previous_section_id
                and next_section_id so the caller can walk siblings.
            max_chars: Soft truncation cap on the returned body. Defaults
                to the server's ``LLMWIKI_MAX_READ_CHARS`` setting.
        """
        limit = max_chars if max_chars is not None else config.max_read_chars
        payload = read_section(
            storage,
            section_id=section_id,
            include_neighbors=include_neighbors,
            max_chars=limit,
        )
        if payload is None:
            return {"error": "section_not_found", "section_id": section_id}
        return payload

    @mcp.tool
    def get_concept(concept_id: str) -> dict[str, Any]:
        """Fetch a single concept / rule / entity / template by id."""
        concept = storage.get_concept(concept_id)
        if concept is None:
            return {"error": "concept_not_found", "concept_id": concept_id}
        related = storage.related_concepts(concept_id, limit=25)
        return {
            "concept": asdict(concept),
            "related": [
                {"relation": relation, "concept": asdict(other)}
                for other, relation in related
            ],
        }

    @mcp.tool
    def find_related_concepts(
        concept_id: str, max_results: int = 25
    ) -> dict[str, Any]:
        """List concepts co-occurring with the given concept's source sections."""
        related = storage.related_concepts(
            concept_id, limit=max(1, min(max_results, 100))
        )
        return {
            "concept_id": concept_id,
            "related": [
                {"relation": relation, "concept": asdict(other)}
                for other, relation in related
            ],
        }

    @mcp.tool
    def list_collections() -> dict[str, Any]:
        """List every collection along with document / section / concept counts."""
        return {
            "collections": [asdict(c) for c in storage.list_collections()],
        }

    @mcp.tool
    def list_documents(
        collection: str | None = None,
        flavor: str | None = None,
        max_results: int = 50,
    ) -> dict[str, Any]:
        """List documents, optionally scoped by collection and/or flavor.

        Args:
            collection: Optional collection slug filter.
            flavor: Optional source-layer filter ("raw" | "wiki").
            max_results: Cap on rows returned (1-500, default 50).
        """
        documents = storage.list_documents(
            collection_id=collection,
            flavor=flavor,
            limit=max(1, min(max_results, 500)),
        )
        return {
            "collection": collection,
            "flavor": flavor,
            "document_count": len(documents),
            "documents": [
                {
                    "id": d.id,
                    "title": d.title,
                    "collection_id": d.collection_id,
                    "doc_type": d.doc_type,
                    "flavor": d.flavor,
                    "page_count": d.page_count,
                    "size_bytes": d.size_bytes,
                    "source_path": d.source_path,
                    "ingested_at": d.ingested_at,
                }
                for d in documents
            ],
        }

    # ------------------------------------------------------------------
    # Document/section browsing helpers for the wiki browser widget
    # ------------------------------------------------------------------

    @mcp.tool
    def list_sections_for_document(document_id: str) -> dict[str, Any]:
        """List all wiki sections for a given document.

        Returns lightweight section metadata (ids + headings). To read full
        content, call `read_wiki_section` with the returned `section_id`.
        """

        sections = storage.list_sections_for_document(document_id)
        return {
            "document_id": document_id,
            "sections": [
                {
                    "id": s.id,
                    "ordinal": s.ordinal,
                    "heading": s.heading,
                    "heading_path": s.heading_path,
                    "page_anchor": s.page_anchor,
                    "body_chars": s.body_chars,
                }
                for s in sections
            ],
        }

    # ------------------------------------------------------------------
    # Browse (interactive wiki browser widget)
    # ------------------------------------------------------------------
    @mcp.tool(
        meta={"ui": {"resourceUri": "ui://wiki-browser.html"}},
        tags={"mcp-app"},
    )
    def browse_wiki(
        query: str | None = None,
        collection: str | None = None,
        flavor: str | None = None,
        doc_type: str | None = None,
        section_id: str | None = None,
    ) -> ToolResult:
        """Browse wiki content — drives the `ui://wiki-browser.html` widget.

        When `section_id` is set navigates directly. With a `query` returns ranked
        search-hit previews for the widget. Without query or section_id falls back to
        the collection manifest with per-collection document previews.
        """
        view_uuid = str(uuid.uuid4())
        ui_meta = {
            "ui": {"resourceUri": "ui://wiki-browser.html"},
            "viewUUID": view_uuid,
        }

        if section_id:
            payload = read_section(
                storage,
                section_id=section_id,
                include_neighbors=True,
                max_chars=config.max_read_chars,
            )
            if payload is None:
                payload = {"error": "section_not_found", "section_id": section_id}
            structured = {"mode": "navigation", "payload": payload}

        elif query:
            hits = search_wiki(
                storage,
                query=query,
                collection=collection,
                doc_type=doc_type,
                flavor=flavor,
                max_results=20,
            )
            structured = {
                "mode": "search",
                "query": query,
                "hits": hits.get("results", []),
            }

        else:
            # Default mode: manifest + document previews (widget uses this)
            all_collections = storage.list_collections()
            cols_with_previews: list[dict[str, Any]] = []
            for c in all_collections:
                docs = storage.list_documents(collection_id=c.id, limit=10)
                cols_with_previews.append(
                    {
                        **asdict(c),
                        "document_previews": [
                            {
                                "id": d.id,
                                "title": d.title,
                                "doc_type": d.doc_type,
                                "flavor": d.flavor,
                            }
                            for d in docs[:5]
                        ],
                    }
                )
            structured = {
                "mode": "manifest",
                "collections": cols_with_previews,
                "total_collections": len(all_collections),
            }

        # Text-channel fallback for hosts/models (kept small; widget uses structuredContent).
        mode = structured.get("mode")
        if mode == "manifest":
            content = (
                f"LLMWiki manifest: {structured.get('total_collections', '?')} collections."
            )
        elif mode == "search":
            hits = structured.get("hits") or []
            content = f"LLMWiki search: query='{structured.get('query')}' ({len(hits)} hits)."
        elif mode == "navigation":
            heading = (
                (structured.get("payload") or {}).get("heading")
                or (structured.get("payload") or {}).get("document", {}).get("title")
                or structured.get("payload", {}).get("section_id")
                or "section"
            )
            content = f"LLMWiki section navigation: {heading}"
        else:
            content = "LLMWiki browse"

        return ToolResult(
            content=content,
            structured_content=structured,
            meta=ui_meta,
        )

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------
    @mcp.tool
    def check_content(
        content: str,
        collection: str | None = None,
        max_findings: int = 25,
    ) -> dict[str, Any]:
        """Check drafted content against indexed rules.

        Returns a list of `findings`, each citing the rule's defining
        section. Severity is inferred deterministically from the rule's
        trigger phrasing ("must" / "must not" -> error, "should" ->
        warn, otherwise info).
        """
        return check_content_against_wiki(
            storage,
            content=content,
            collection=collection,
            max_findings=max(1, min(max_findings, 100)),
        )

    # ------------------------------------------------------------------
    # Ingest control
    # ------------------------------------------------------------------
    @mcp.tool
    def ingest_status(max_entries: int = 50) -> dict[str, Any]:
        """Return watcher status and the most recent ingest log entries."""
        return {
            "watcher": watcher.status(),
            "recent": [_log_payload(e) for e in ingest.recent_log(max_entries)],
        }

    @mcp.tool
    def trigger_ingest() -> dict[str, Any]:
        """Run a synchronous scan of the corpus and wiki directories."""
        count = watcher.trigger_once()
        return {"scanned": count, "watcher": watcher.status()}

    # ------------------------------------------------------------------
    # Wiki health (read-only diagnostic)
    # ------------------------------------------------------------------
    @mcp.tool
    def lint_wiki(max_findings: int = 100) -> dict[str, Any]:
        """Run a read-only health-check over data/wiki/.

        Reports orphan pages (no inbound links), broken intra-wiki links,
        pages missing from index.md, and missing canonical files
        (AGENTS.md / index.md / log.md). Does not modify anything.
        """
        return run_lint_wiki(
            config.wiki_dir,
            max_findings=max(1, min(max_findings, 500)),
        )

    # ------------------------------------------------------------------
    # Resources
    # ------------------------------------------------------------------
    @mcp.resource("wiki://manifest")
    def manifest() -> dict[str, Any]:
        collections = storage.list_collections()
        return {
            "server": "llmwiki",
            "schema_version": 1,
            "read_only": True,
            "layers": {
                "raw_corpus": str(config.corpus_dir),
                "wiki": str(config.wiki_dir),
            },
            "collection_count": len(collections),
            "collections": [
                {
                    "id": c.id,
                    "name": c.name,
                    "documents": c.document_count,
                    "sections": c.section_count,
                    "concepts": c.concept_count,
                }
                for c in collections
            ],
            "tools": [
                "search_wiki_sections",
                "read_wiki_section",
                "get_concept",
                "find_related_concepts",
                "list_collections",
                "list_documents",
                "check_content",
                "ingest_status",
                "trigger_ingest",
                "lint_wiki",
            ],
            "resources": [
                "wiki://manifest",
                "wiki://schema",
                "wiki://index",
                "wiki://log",
                "wiki://collection/{collection_id}",
                "wiki://document/{document_id}",
                "wiki://section/{section_id}",
            ],
        }

    @mcp.resource("wiki://schema")
    def schema_resource() -> dict[str, Any]:
        """Return the AGENTS.md / CLAUDE.md schema file from data/wiki/."""
        return _read_canonical_file(
            config.wiki_dir,
            primary="AGENTS.md",
            fallbacks=("CLAUDE.md",),
            max_chars=config.max_read_chars,
            purpose="wiki schema (page conventions, ingest/query/lint workflows)",
        )

    @mcp.resource("wiki://index")
    def index_resource() -> dict[str, Any]:
        """Return data/wiki/index.md (the catalog of wiki pages)."""
        return _read_canonical_file(
            config.wiki_dir,
            primary="index.md",
            fallbacks=(),
            max_chars=config.max_read_chars,
            purpose="wiki index (content catalog)",
        )

    @mcp.resource("wiki://log")
    def log_resource() -> dict[str, Any]:
        """Return data/wiki/log.md (the append-only activity log)."""
        return _read_canonical_file(
            config.wiki_dir,
            primary="log.md",
            fallbacks=(),
            max_chars=config.max_read_chars,
            purpose="wiki log (chronological ingest/query/lint history)",
        )

    @mcp.resource("wiki://collection/{collection_id}")
    def collection_resource(collection_id: str) -> dict[str, Any]:
        documents = storage.list_documents(
            collection_id=collection_id, limit=500
        )
        return {
            "collection_id": collection_id,
            "documents": [
                {
                    "id": d.id,
                    "title": d.title,
                    "doc_type": d.doc_type,
                    "page_count": d.page_count,
                }
                for d in documents
            ],
        }

    @mcp.resource("wiki://document/{document_id}")
    def document_resource(document_id: str) -> dict[str, Any]:
        document = storage.get_document(document_id)
        if document is None:
            return {"error": "document_not_found", "document_id": document_id}
        sections = storage.list_sections_for_document(document_id)
        return {
            "document": {
                "id": document.id,
                "title": document.title,
                "collection_id": document.collection_id,
                "doc_type": document.doc_type,
                "source_path": document.source_path,
                "page_count": document.page_count,
                "size_bytes": document.size_bytes,
            },
            "sections": [
                {
                    "id": s.id,
                    "ordinal": s.ordinal,
                    "heading": s.heading,
                    "heading_path": s.heading_path,
                    "page_anchor": s.page_anchor,
                    "body_chars": s.body_chars,
                }
                for s in sections
            ],
        }

    @mcp.resource("wiki://section/{section_id}")
    def section_resource(section_id: str) -> dict[str, Any]:
        payload = read_section(
            storage,
            section_id=section_id,
            include_neighbors=True,
            max_chars=config.max_read_chars,
        )
        if payload is None:
            return {"error": "section_not_found", "section_id": section_id}
        return payload


def _log_payload(entry: IngestLogEntry) -> dict[str, Any]:
    return {
        "id": entry.id,
        "source_path": entry.source_path,
        "status": entry.status,
        "message": entry.message,
        "started_at": entry.started_at,
        "finished_at": entry.finished_at,
    }


def _read_canonical_file(
    wiki_dir,
    *,
    primary: str,
    fallbacks: tuple[str, ...],
    max_chars: int,
    purpose: str,
) -> dict[str, Any]:
    """Read a canonical wiki file from disk, with helpful absent payload."""
    from pathlib import Path  # local import keeps the public surface clean

    candidates: list[Path] = [Path(wiki_dir) / primary]
    for fallback in fallbacks:
        candidates.append(Path(wiki_dir) / fallback)
    for path in candidates:
        if path.exists() and path.is_file():
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as exc:
                return {
                    "path": str(path),
                    "error": "read_failed",
                    "detail": str(exc),
                }
            truncated = False
            if max_chars and len(text) > max_chars:
                text = text[:max_chars]
                truncated = True
            return {
                "path": str(path),
                "purpose": purpose,
                "chars": len(text),
                "truncated": truncated,
                "content": text,
            }
    return {
        "path": str(Path(wiki_dir) / primary),
        "error": "missing",
        "purpose": purpose,
        "detail": (
            f"Create {primary} under {wiki_dir} so the agent has a stable "
            "navigation surface. This server will not write it for you."
        ),
    }
