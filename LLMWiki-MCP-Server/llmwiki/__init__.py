"""LLMWiki MCP server core package.

This package is intentionally dependency-light: all storage and search is
done with the Python standard library (sqlite3 + FTS5). PDF support is the
only optional add-on (pypdf); markdown / text / html are parsed with
stdlib.

Public surface lives in `llmwiki.tools` (MCP registrations) and is wired
into the server factory in `server.py`.
"""

from .config import LLMWikiConfig, load_config

__all__ = ["LLMWikiConfig", "load_config"]
