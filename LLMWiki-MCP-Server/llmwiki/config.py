"""Runtime configuration loaded from environment variables.

All paths are resolved against the project root (the parent of this
package) so the server runs the same whether invoked via `python
server.py`, `fastmcp run server.py`, or a custom ASGI host.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


def _resolve(path_str: str, default_rel: str) -> Path:
    raw = (path_str or default_rel).strip()
    p = Path(raw)
    if not p.is_absolute():
        p = PROJECT_ROOT / p
    return p


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _csv_env(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    parts = [p.strip().lower() for p in raw.split(",") if p.strip()]
    return tuple(parts) if parts else default


_DOC_INTEL_VALID_DOC_TYPES = {"pdf", "image", "docx", "xlsx", "pptx", "html"}


PROJECT_ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class DocIntelConfig:
    """Azure Document Intelligence extractor settings.

    Disabled unless ``LLMWIKI_DOC_INTEL_ENDPOINT`` is set. Auth is by
    API key if ``LLMWIKI_DOC_INTEL_API_KEY`` is present, otherwise by
    ``azure.identity.DefaultAzureCredential`` (Managed Identity / CLI /
    env vars). See README for details.
    """

    enabled: bool = False
    endpoint: str | None = None
    api_key: str | None = None
    model: str = "prebuilt-layout"
    for_doc_types: tuple[str, ...] = ("pdf", "image")
    fallback_to_pypdf: bool = False
    timeout_seconds: int = 300


@dataclass(frozen=True)
class LLMWikiConfig:
    host: str
    port: int
    corpus_dir: Path
    wiki_dir: Path
    parsed_dir: Path
    index_dir: Path
    watch_interval_seconds: int
    default_collection: str
    wiki_collection: str
    max_read_chars: int
    max_section_chars: int
    doc_intel: DocIntelConfig = field(default_factory=DocIntelConfig)

    # Phase 1 — storage mode / Azure AI Search (new).
    # 'azure-facts' = read-only adapter over the greenhouse `resume-facts` index.
    storage_mode: Literal["auto", "sqlite", "azure", "azure-facts"] = "auto"
    azure_search_service_url: str | None = None
    azure_tenant_id: str | None = None
    # Operator-configurable Azure AI Search index names + schema knobs.
    azure_sections_index: str = "wiki-sections"
    azure_documents_index: str = "wiki-documents"
    azure_concepts_index: str = "wiki-concepts"
    azure_vector_dimensions: int = 1536
    azure_auto_provision: bool = True
    # 'azure-facts' mode: read the greenhouse `resume-facts` index directly.
    azure_facts_index: str = "resume-facts"
    azure_facts_semantic_config: str = "semantic-config"
    facts_allow_sensitive: bool = False

    @property
    def db_path(self) -> Path:
        return self.index_dir / "wiki.sqlite3"

    @property
    def wiki_schema_path(self) -> Path:
        return self.wiki_dir / "AGENTS.md"

    @property
    def wiki_index_path(self) -> Path:
        return self.wiki_dir / "index.md"

    @property
    def wiki_log_path(self) -> Path:
        return self.wiki_dir / "log.md"


def _load_doc_intel_config() -> DocIntelConfig:
    endpoint = (os.environ.get("LLMWIKI_DOC_INTEL_ENDPOINT", "") or "").strip()
    if not endpoint:
        return DocIntelConfig()
    api_key = (os.environ.get("LLMWIKI_DOC_INTEL_API_KEY", "") or "").strip()
    model = (
        os.environ.get("LLMWIKI_DOC_INTEL_MODEL", "prebuilt-layout").strip()
        or "prebuilt-layout"
    )
    raw_doc_types = _csv_env("LLMWIKI_DOC_INTEL_FOR", ("pdf", "image"))
    doc_types = tuple(
        dt for dt in raw_doc_types if dt in _DOC_INTEL_VALID_DOC_TYPES
    )
    if not doc_types:
        doc_types = ("pdf", "image")
    return DocIntelConfig(
        enabled=True,
        endpoint=endpoint,
        api_key=api_key or None,
        model=model,
        for_doc_types=doc_types,
        fallback_to_pypdf=_bool_env("LLMWIKI_DOC_INTEL_FALLBACK", False),
        timeout_seconds=max(
            10, _int_env("LLMWIKI_DOC_INTEL_TIMEOUT_SECONDS", 300)
        ),
    )


def load_config() -> LLMWikiConfig:
    # Phase 1 — Azure AI Search settings.
    azure_url = (os.environ.get("LLMWIKI_AZURE_SEARCH_SERVICE_URL", "") or "").strip() or None
    azure_tenant = (os.environ.get("LLMWIKI_AZURE_SEARCH_TENANT_ID", "") or "").strip() or None
    # storage_mode: 'auto' (default) → Azure if a Search URL is present, else SQLite.
    # 'azure-facts' (alias 'resume-facts') → read-only adapter over the
    # greenhouse `resume-facts` index (no new indexes are created).
    raw_mode = (os.environ.get("LLMWIKI_STORAGE_MODE", "auto") or "auto").strip().lower()
    if raw_mode in ("azure-facts", "resume-facts", "facts"):
        mode = "azure-facts"
    elif raw_mode in ("auto", "sqlite", "azure"):
        mode = raw_mode
    else:
        mode = "auto"
    # Index names resolve from a dedicated env var, then an index prefix
    # (default 'wiki'); shared with the backend so they never diverge.
    from .backends.azure_backend import _resolve_index_name
    sections_index = _resolve_index_name(None, "LLMWIKI_AZURE_SEARCH_SECTIONS_INDEX", "sections")
    documents_index = _resolve_index_name(None, "LLMWIKI_AZURE_SEARCH_DOCUMENTS_INDEX", "documents")
    concepts_index = _resolve_index_name(None, "LLMWIKI_AZURE_SEARCH_CONCEPTS_INDEX", "concepts")
    vector_dimensions = max(1, _int_env("LLMWIKI_AZURE_SEARCH_VECTOR_DIMENSIONS", 1536))
    auto_provision = _bool_env("LLMWIKI_AZURE_SEARCH_AUTO_PROVISION", True)
    # 'azure-facts' mode: the greenhouse-owned index + its semantic config.
    facts_index = (os.environ.get("LLMWIKI_AZURE_SEARCH_FACTS_INDEX", "") or "").strip() or "resume-facts"
    facts_semantic_config = (
        (os.environ.get("LLMWIKI_AZURE_SEARCH_FACTS_SEMANTIC_CONFIG", "") or "").strip()
        or "semantic-config"
    )
    facts_allow_sensitive = _bool_env("LLMWIKI_FACTS_ALLOW_SENSITIVE", False)

    cfg = LLMWikiConfig(
        host=os.environ.get("LLMWIKI_HOST", "127.0.0.1").strip() or "127.0.0.1",
        port=_int_env("LLMWIKI_PORT", 8765),
        corpus_dir=_resolve(os.environ.get("LLMWIKI_CORPUS_DIR", ""), "data/corpus"),
        wiki_dir=_resolve(os.environ.get("LLMWIKI_WIKI_DIR", ""), "data/wiki"),
        parsed_dir=_resolve(os.environ.get("LLMWIKI_PARSED_DIR", ""), "data/parsed"),
        index_dir=_resolve(os.environ.get("LLMWIKI_INDEX_DIR", ""), "data/index"),
        watch_interval_seconds=max(0, _int_env("LLMWIKI_WATCH_INTERVAL_SECONDS", 30)),
        default_collection=(os.environ.get("LLMWIKI_DEFAULT_COLLECTION", "default").strip() or "default"),
        wiki_collection=(os.environ.get("LLMWIKI_WIKI_COLLECTION", "wiki").strip() or "wiki"),
        max_read_chars=max(1024, _int_env("LLMWIKI_MAX_READ_CHARS", 20000)),
        max_section_chars=max(512, _int_env("LLMWIKI_MAX_SECTION_CHARS", 4000)),
        doc_intel=_load_doc_intel_config(),
        storage_mode=mode,
        azure_search_service_url=azure_url,
        azure_tenant_id=azure_tenant,
        azure_sections_index=sections_index,
        azure_documents_index=documents_index,
        azure_concepts_index=concepts_index,
        azure_vector_dimensions=vector_dimensions,
        azure_auto_provision=auto_provision,
        azure_facts_index=facts_index,
        azure_facts_semantic_config=facts_semantic_config,
        facts_allow_sensitive=facts_allow_sensitive,
    )
    cfg.corpus_dir.mkdir(parents=True, exist_ok=True)
    cfg.wiki_dir.mkdir(parents=True, exist_ok=True)
    cfg.parsed_dir.mkdir(parents=True, exist_ok=True)
    cfg.index_dir.mkdir(parents=True, exist_ok=True)
    return cfg
