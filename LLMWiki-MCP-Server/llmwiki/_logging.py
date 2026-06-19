"""Stderr-only logging for the LLMWiki server.

stdout is reserved for the MCP (JSON-RPC) protocol when the server runs over
stdio, so all diagnostics go to **stderr**. The verbosity is controlled by the
``LLMWIKI_LOG_LEVEL`` environment variable (default ``INFO``); set it to
``DEBUG`` to see per-hit query/trim detail, or ``WARNING`` to quieten it.

Usage::

    from ._logging import get_logger          # within the llmwiki package
    logger = get_logger("llmwiki.resume_facts")
    logger.info("connecting to %s", endpoint)
"""

from __future__ import annotations

import logging
import os
import sys

_CONFIGURED = False


def configure_logging() -> None:
    """Attach a single stderr handler to the ``llmwiki`` logger (idempotent)."""
    global _CONFIGURED
    if _CONFIGURED:
        return
    level_name = (os.environ.get("LLMWIKI_LOG_LEVEL") or "INFO").strip().upper()
    level = getattr(logging, level_name, logging.INFO)

    logger = logging.getLogger("llmwiki")
    logger.setLevel(level)
    # Never propagate to the root logger (it may stream to stdout and corrupt
    # the MCP protocol). We own a dedicated stderr handler instead.
    logger.propagate = False
    if not any(getattr(h, "_llmwiki_handler", False) for h in logger.handlers):
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(
            logging.Formatter("[llmwiki] %(levelname)s %(name)s: %(message)s")
        )
        handler._llmwiki_handler = True  # type: ignore[attr-defined]
        logger.addHandler(handler)
    _CONFIGURED = True


def get_logger(name: str = "llmwiki") -> logging.Logger:
    """Return a configured logger (configures the stderr handler on first call)."""
    configure_logging()
    return logging.getLogger(name)
