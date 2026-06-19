"""LLMWiki FastMCP server entrypoint.

``fastmcp run server.py --transport http --port 8765`` discovers the
module-level ``mcp`` instance below. ASGI hosts should import
``app:app`` instead so they do not create this CLI-oriented instance as
a side effect.
"""

from __future__ import annotations

import os

from fastmcp import FastMCP
from llmwiki.mcp_factory import create_mcp_server, install_cors_on


# Module-level instance — required so `fastmcp run server.py` works.
mcp: FastMCP = create_mcp_server()
install_cors_on(mcp)


def main() -> None:
    host = os.environ.get("LLMWIKI_HOST", "127.0.0.1")
    port = int(os.environ.get("LLMWIKI_PORT", "8765"))
    stateless = os.environ.get("STATELESS_HTTP", "true").lower() in (
        "1",
        "true",
        "yes",
    )
    mcp.run(
        transport="http",
        host=host,
        port=port,
        stateless_http=stateless,
    )


if __name__ == "__main__":
    main()
