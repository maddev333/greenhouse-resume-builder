"""Abstract protocol + factory for LLMWiki storage backends.

The ``WikiStorage`` ABC mirrors every public method on the original
``storage.Storage`` class so that upper-layer callers see zero interface
change when swapping SQLite -> Azure AI Search.  Each method returns real
dataclass instances (from models.py, or compatible types) so existing code
using ``asdict()`` works unchanged.
"""

from __future__ import annotations

import abc
from pathlib import Path
from typing import Any, Iterable


class WikiStorage(abc.ABC):
    """Protocol every LLMWiki backend must implement."""

    @abc.abstractmethod
    def upsert_collection(self, *, id: str, name: str, description: str = "") -> None: ...

    @abc.abstractmethod
    def list_collections(self) -> list[Any]:
        ...

    @abc.abstractmethod
    def get_document_by_source_path(self, source_path: str) -> Any | None:
        ...

    @abc.abstractmethod
    def get_document(self, document_id: str) -> Any | None:
        ...

    @abc.abstractmethod
    def list_documents(
        self, collection_id: str | None = None, *, flavor: str | None = None, limit: int = 100,
    ) -> list[Any]:
        ...

    @abc.abstractmethod
    def delete_document_by_source_path(self, source_path: str) -> None: ...

    @abc.abstractmethod
    def replace_document(
        self, *, document: Any, sections: Iterable[Any], concepts=(), concept_links=(), section_concept_ids=(),
    ) -> None: ...

    @abc.abstractmethod
    def get_section(self, section_id: str) -> Any | None: ...

    @abc.abstractmethod
    def get_section_neighbors(self, section_id: str):  # (Sec|None, Sec|None)
        ...

    @abc.abstractmethod
    def list_sections_for_document(self, document_id: str) -> list[Any]:
        ...

    @abc.abstractmethod
    def search_sections(
        self, *, match_expr: str, collection_id: str | None = None, doc_type: str | None = None, flavor: str | None = None, limit: int = 10,
    ) -> list[Any]:
        ...

    @abc.abstractmethod
    def get_concept(self, concept_id: str) -> Any | None: ...

    @abc.abstractmethod
    def list_concepts(
        self, *, collection_id: str | None = None, kind: str | None = None, limit: int = 100,
    ) -> list[Any]:
        ...

    @abc.abstractmethod
    def related_concepts(self, concept_id: str, *, limit: int = 25) -> list[tuple[Any, str]]:
        ...

    @abc.abstractmethod
    def record_ingest_event(
        self, *, source_path: str, status: str, message: str | None = None, started_at: int | None = None, finished_at: int | None = None,
    ) -> None: ...

    @abc.abstractmethod
    def recent_ingest_log(self, limit: int = 50) -> list[Any]:
        ...

    @abc.abstractmethod
    def get_document_count(self, collection_id: str | None = None) -> int: ...

    @abc.abstractmethod
    def count_collections(self) -> int: ...


# ---- concrete factory helpers (lazily imported to avoid circular deps) -----

def create_sqlite_backend(db_path: Path | str | None = None) -> WikiStorage:
    """Return a backend backed by local SQLite (original Storage class)."""
    from .. import storage as _storage
    db = db_path or Path("data/index/wiki.sqlite3")
    return _storage.Storage(db_path=Path(db) if isinstance(db, str) else db)


def create_azure_backend(service_url: str | None = None) -> WikiStorage:
    """Return a backend backed by Azure AI Search."""
    from . import azure_backend
    return azure_backend.WikiAzureSearchBackend(service_url=service_url)
