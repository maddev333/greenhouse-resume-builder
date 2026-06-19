"""FastMCP application factory for the LLMWiki server.

This module is intentionally import-safe: it defines constructors and
middleware helpers, but it does not create a module-level MCP server or
start the filesystem watcher. Entrypoints such as ``server.py`` and
``app.py`` decide when to instantiate the server.
"""

from __future__ import annotations

import atexit
import os

from .config import load_config
from .ingest import IngestService
from .watcher import CorpusWatcher


def create_mcp_server():
    from fastmcp import FastMCP

    from .backends import create_backend, create_sqlite_backend
    from .tools import register_tools

    _load_dotenv_if_available()
    config = load_config()

    # Phase 1: select backend (SQLite by default → Azure AI Search).
    if hasattr(config, "storage_mode") and config.storage_mode == "azure":
        storage = create_backend(storage_mode="azure")
    else:
        # 'auto' or 'sqlite': use SQLite for local dev.
        storage = create_sqlite_backend()

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

    if config.watch_interval_seconds > 0:
        watcher.start()
        atexit.register(watcher.stop)
    else:
        # Interval 0 means "manual ingest only"; still run one scan so the
        # index is populated for the first request.
        watcher.trigger_once()

    return mcp


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
