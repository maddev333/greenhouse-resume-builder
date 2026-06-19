"""ASGI entry point for shared hosting (e.g. Gunicorn + Uvicorn).

The wrapper is lazy so the module imports cleanly without opening the
SQLite database or starting the watcher. The server is created on the
first ASGI request.

Usage::

    gunicorn --bind=0.0.0.0:8765 --timeout 120 app:app
"""

from __future__ import annotations

import os

from llmwiki.mcp_factory import create_mcp_server, get_cors_middleware

_mcp_server = None
_asgi_app = None


def _get_server():
    global _mcp_server
    if _mcp_server is None:
        _mcp_server = create_mcp_server()
    return _mcp_server


def _get_app():
    global _asgi_app
    if _asgi_app is None:
        _asgi_app = _get_server().http_app(middleware=get_cors_middleware())
    return _asgi_app


class _LazyASGIApp:
    async def __call__(self, scope, receive, send):
        await _get_app()(scope, receive, send)


app = _LazyASGIApp()

application = app


if __name__ == "__main__":
    host = os.environ.get("LLMWIKI_HOST", "127.0.0.1")
    port = int(os.environ.get("LLMWIKI_PORT", "8765"))
    stateless = os.environ.get("STATELESS_HTTP", "true").lower() in (
        "1",
        "true",
        "yes",
    )
    _get_server().run(
        transport="http",
        host=host,
        port=port,
        stateless_http=stateless,
    )
