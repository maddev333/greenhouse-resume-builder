"""FastMCP application factory for the LLMWiki server.

This module is intentionally import-safe: it defines constructors and
middleware helpers, but it does not create a module-level MCP server or
start the filesystem watcher. Entrypoints such as ``server.py`` and
``app.py`` decide when to instantiate the server.
"""

from __future__ import annotations

import atexit
import os
import sys

from fastmcp import FastMCP
from fastmcp.apps.config import AppConfig
from fastmcp.resources import Resource, TextResource
from fastmcp.utilities.mime import UI_MIME_TYPE as MCP_APP_MIME

from .config import load_config
from .ingest import IngestService
from .watcher import CorpusWatcher
from ._logging import get_logger

logger = get_logger("llmwiki.factory")


def create_mcp_server():
    from .backends import (
        create_azure_backend,
        create_resume_facts_backend,
        create_sqlite_backend,
    )
    from .tools import register_tools

    _load_dotenv_if_available()
    config = load_config()

    # Select backend. Explicit 'azure', or 'auto' when an Azure AI Search
    # service URL is configured; 'azure-facts' reads the greenhouse
    # `resume-facts` index read-only; otherwise local SQLite for dev.
    mode = getattr(config, "storage_mode", "auto")
    logger.info(
        "creating MCP server: storage_mode=%s service_url=%s tenant_id=%r",
        mode, config.azure_search_service_url or "(unset)", config.azure_tenant_id,
    )
    if mode == "azure-facts":
        storage = create_resume_facts_backend(
            service_url=config.azure_search_service_url,
            tenant_id=config.azure_tenant_id,
            facts_index=config.azure_facts_index,
            semantic_config=config.azure_facts_semantic_config,
            allow_sensitive=config.facts_allow_sensitive,
        )
    elif mode == "azure" or (mode == "auto" and bool(config.azure_search_service_url)):
        storage = create_azure_backend(
            service_url=config.azure_search_service_url,
            tenant_id=config.azure_tenant_id,
            sections_index=config.azure_sections_index,
            documents_index=config.azure_documents_index,
            concepts_index=config.azure_concepts_index,
            vector_dimensions=config.azure_vector_dimensions,
        )
        if config.azure_auto_provision:
            _provision_azure_indexes(storage)
    else:
        storage = create_sqlite_backend()

    # Read-only backends (e.g. resume-facts) are fed by an external owner; the
    # local corpus watcher/ingest must not run against them.
    read_only = bool(getattr(storage, "read_only", False))
    logger.info(
        "backend selected: %s (read_only=%s)", type(storage).__name__, read_only
    )

    ingest = IngestService(config, storage)
    watcher = CorpusWatcher(
        ingest, interval_seconds=config.watch_interval_seconds
    )

    mcp: FastMCP = FastMCP(
        name="llmwiki",
        instructions=(
            "Search and retrieve grounding content from operator-curated "
            "documents (style guides, policies, reference material). "
            "Start with `search_wiki_sections` to find relevant passages, "
            "then `read_wiki_section` for full text. Use `check_content` "
            "to validate drafts against indexed rules before applying "
            "changes to Office documents."
        ),
    )

    register_tools(
        mcp,
        config=config,
        storage=storage,
        ingest=ingest,
        watcher=watcher,
    )

    # ------------------------------------------------------------------
    # UI resource: interactive wiki browser widget (Phase 1)
    # ------------------------------------------------------------------
    _register_wiki_browser_resource(mcp)

    if read_only:
        # Greenhouse owns ingestion for this index; do not scan the local corpus.
        print(
            "[llmwiki] read-only backend (resume-facts): corpus watcher disabled; "
            "greenhouse-resume-builder owns writes.",
            file=sys.stderr,
        )
    elif config.watch_interval_seconds > 0:
        watcher.start()
        atexit.register(watcher.stop)
    else:
        # Interval 0 means "manual ingest only"; still run one scan so the
        # index is populated for the first request.
        watcher.trigger_once()

    return mcp


def _provision_azure_indexes(storage) -> None:
    """Ensure the Azure AI Search indexes exist before ingest runs.

    Creates any missing index using the backend's configured schema. Logs to
    stderr (stdout is reserved for the MCP protocol). Failures are surfaced
    but non-fatal so the server can still serve reads against pre-existing
    indexes or be provisioned out-of-band.
    """
    provision = getattr(storage, "provision_indexes", None)
    if not callable(provision):
        return
    try:
        created = provision() or []
        if created:
            print(f"[llmwiki] provisioned Azure AI Search indexes: {', '.join(created)}", file=sys.stderr)
        else:
            print("[llmwiki] Azure AI Search indexes already present", file=sys.stderr)
    except Exception as exc:  # pragma: no cover - depends on live service/creds
        print(
            "[llmwiki] WARNING: could not provision Azure AI Search indexes "
            f"({type(exc).__name__}: {exc}).\n"
            "  Index management needs the 'Search Service Contributor' role; "
            "document read/write needs 'Search Index Data Contributor'.\n"
            "  Set LLMWIKI_AZURE_SEARCH_AUTO_PROVISION=false once indexes exist.",
            file=sys.stderr,
        )


def get_cors_middleware():
    from starlette.middleware import Middleware
    from starlette.middleware.cors import CORSMiddleware

    origins_str = os.environ.get("CORS_ORIGINS", "*")
    origins = [o.strip() for o in origins_str.split(",") if o.strip()]
    allow_credentials = os.environ.get(
        "CORS_ALLOW_CREDENTIALS", "true"
    ).lower() in ("1", "true", "yes")
    if "*" in origins and allow_credentials:
        allow_credentials = False
    return [
        Middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_methods=["*"],
            allow_headers=["*"],
            allow_credentials=allow_credentials,
            expose_headers=["Mcp-Session-Id"],
        )
    ]


def install_cors_on(server) -> None:
    original_http_app = server.http_app

    def http_app_with_cors(
        path: str | None = None,
        middleware: list | None = None,
        json_response: bool | None = None,
        stateless_http: bool | None = None,
        transport: str = "http",
        event_store=None,
        retry_interval: int | None = None,
    ):
        combined = list(middleware or []) + get_cors_middleware()
        return original_http_app(
            path=path,
            middleware=combined,
            json_response=json_response,
            stateless_http=stateless_http,
            transport=transport,
            event_store=event_store,
            retry_interval=retry_interval,
        )

    server.http_app = http_app_with_cors  # type: ignore[method-assign]


def _load_dotenv_if_available() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv()


def _register_wiki_browser_resource(mcp: FastMCP, cfg: AppConfig | None = None) -> None:
    """Serve the interactive wiki-browser.html as a ui:// resource.

    MCP hosts supporting MCP Apps (io.modelcontextprotocol/ui) discover the
    ``ui://wiki-browser.html`` resource via FastMCP's ``list_resources()``
    endpoint and render it inline alongside any tool whose AppConfig
    declares ``resourceUri = "ui://wiki-browser.html"``.
    ``TextResource`` is used so ``read_resource`` returns the HTML content.
    """
    from pathlib import Path as _Path

    html_path = None
    for p in [
        _Path(__file__).resolve().parent.parent / "static" / "ui" / "wiki-browser.html",
        _Path.cwd() / "static" / "ui" / "wiki-browser.html",
    ]:
        if p.is_file():
            html_path = p
            break

    default_cfg = AppConfig(
        resource_uri="ui://wiki-browser.html",
        visibility=["model", "app"],  # visible to both model and app contexts
    )
    cfg = cfg or default_cfg

    if html_path is None:
        # No widget available — advertise the resource anyway so hosts know it
        # exists (but serve a placeholder).  browse_wiki will fall back to JSON.
        hint = (
            "[llmwiki] wiki browser widget unavailable. Place wiki-browser.html "
            "in static/ui/ or invoke browse_wiki without query for manifest data.\n"
            "Use ``manifest()`` to see available collections/documents."
        )
        mcp.add_resource(
            TextResource(
                uri=cfg.resource_uri,
                name="LLMWiki Browser Widget (offline)",
                text=hint,
                mime_type=MCP_APP_MIME,
            ),
        )
    else:
        html = html_path.read_text(encoding="utf-8")
        mcp.add_resource(
            TextResource(
                uri=cfg.resource_uri,
                name="LLMWiki Browser Widget",
                text=html,
                mime_type=MCP_APP_MIME,
            ),
        )
