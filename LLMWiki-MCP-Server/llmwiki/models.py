"""Domain dataclasses returned by the storage / retrieval layer.

These are plain dataclasses (no Pydantic) so they serialize cleanly via
``dataclasses.asdict`` for MCP tool responses with zero extra deps.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Collection:
    id: str
    name: str
    description: str
    created_at: int
    document_count: int = 0
    section_count: int = 0
    concept_count: int = 0
    last_ingested_at: int | None = None


@dataclass
class Document:
    id: str
    collection_id: str
    source_path: str
    title: str
    doc_type: str  # 'pdf' | 'md' | 'txt' | 'html'
    content_hash: str
    parsed_path: str | None
    size_bytes: int
    page_count: int | None
    source_mtime: int
    ingested_at: int
    flavor: str = "raw"  # 'raw' (immutable source) | 'wiki' (LLM-authored notes)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class Section:
    id: str
    document_id: str
    ordinal: int
    heading_path: str
    heading: str
    body: str
    body_chars: int
    page_anchor: int | None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class Concept:
    id: str
    collection_id: str
    name: str
    slug: str
    kind: str  # 'concept' | 'rule' | 'entity' | 'template'
    definition: str
    source_section_id: str | None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ConceptLink:
    src_concept_id: str
    dst_concept_id: str
    relation: str  # 'related_to' | 'applies_to' | 'supersedes' | 'cites' | ...


@dataclass
class SearchHit:
    section_id: str
    document_id: str
    document_title: str
    collection_id: str
    heading_path: str
    heading: str
    snippet: str
    score: float
    source_path: str
    page_anchor: int | None


@dataclass
class Finding:
    """A single violation surfaced by ``check_content_against_wiki``."""

    rule_concept_id: str
    rule_name: str
    severity: str  # 'info' | 'warn' | 'error'
    evidence: str
    suggestion: str
    citation: dict[str, Any]


@dataclass
class IngestLogEntry:
    id: int
    source_path: str
    status: str  # 'queued' | 'parsing' | 'indexed' | 'error' | 'skipped'
    message: str | None
    started_at: int | None
    finished_at: int | None


@dataclass
class WikiHealthFinding:
    """A single read-only diagnostic surfaced by ``lint_wiki``."""

    kind: str  # 'orphan' | 'broken_link' | 'index_gap' | 'missing_canonical'
    severity: str  # 'info' | 'warn' | 'error'
    page: str  # wiki-relative path of the page the finding is about
    detail: str
    target: str | None = None  # link target / referenced page, when applicable
