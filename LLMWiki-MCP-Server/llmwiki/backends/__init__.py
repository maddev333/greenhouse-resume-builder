"""Backend factory for LLMWiki.

Back to storage mode selection, Azure AI Search backend (Phase 1).
"""

from __future__ import annotations

from .base import (
    WikiStorage,
    create_sqlite_backend,
    create_azure_backend,
    create_resume_facts_backend,
)

__all__ = [
    "WikiStorage",
    "create_backend",
    "create_sqlite_backend",
    "create_azure_backend",
    "create_resume_facts_backend",
]


def create_backend(storage_mode: str | None = None) -> WikiStorage:
    """Select and return the appropriate backend implementation."""
    _env = (storage_mode or "auto").strip().lower()
    if _env in ("azure-facts", "resume-facts", "facts"):
        return create_resume_facts_backend()
    if _env == "azure":
        return create_azure_backend()
    return create_sqlite_backend()
