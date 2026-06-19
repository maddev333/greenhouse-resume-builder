"""Search and read helpers over the :class:`Storage` DAO.

Responsibilities:

* Build a safe FTS5 ``MATCH`` expression from a free-text query.
* Run the search and shape :class:`SearchHit` lists for tool output.
* Expand a single section by adding optional neighbour context.
"""

from __future__ import annotations

import re
from dataclasses import asdict
from typing import Any

from .models import SearchHit
from .storage import Storage

# FTS5 reserved punctuation that breaks the query parser. We strip these and
# fall back to a token-OR plus best-effort phrase match.
_FTS_STRIP = re.compile(r"[\"^*:()\-]+")
_TOKEN_SPLIT = re.compile(r"\s+")


def build_match_expression(query: str) -> str:
    cleaned = _FTS_STRIP.sub(" ", query or "").strip()
    if not cleaned:
        return '""'
    tokens = [t for t in _TOKEN_SPLIT.split(cleaned) if t]
    if not tokens:
        return '""'
    or_clause = " OR ".join(_safe_token(t) for t in tokens)
    if len(tokens) > 1:
        phrase = " ".join(tokens)
        return f'("{phrase}") OR {or_clause}'
    return or_clause


def _safe_token(token: str) -> str:
    token = token.strip()
    if not token:
        return '""'
    # Add a prefix wildcard so partial-typed terms still match. Quoting keeps
    # any remaining special chars (e.g. apostrophes) literal.
    return f'"{token}"*'


def search_wiki(
    storage: Storage,
    *,
    query: str,
    collection: str | None = None,
    doc_type: str | None = None,
    flavor: str | None = None,
    max_results: int = 8,
) -> dict[str, Any]:
    match = build_match_expression(query)
    hits = storage.search_sections(
        match_expr=match,
        collection_id=collection,
        doc_type=doc_type,
        flavor=flavor,
        limit=max(1, min(max_results, 25)),
    )
    return {
        "query": query,
        "match_expression": match,
        "flavor": flavor,
        "result_count": len(hits),
        "results": [_hit_to_payload(h) for h in hits],
    }


def _hit_to_payload(hit: SearchHit) -> dict[str, Any]:
    payload = asdict(hit)
    payload["score"] = round(hit.score, 4)
    return payload


def read_section(
    storage: Storage,
    *,
    section_id: str,
    include_neighbors: bool = False,
    max_chars: int = 20000,
) -> dict[str, Any] | None:
    section = storage.get_section(section_id)
    if not section:
        return None
    document = storage.get_document(section.document_id)
    payload = {
        "section": _section_payload(section, max_chars=max_chars),
        "document": _document_payload(document) if document else None,
    }
    if include_neighbors:
        prev, nxt = storage.get_section_neighbors(section_id)
        payload["previous_section_id"] = prev.id if prev else None
        payload["next_section_id"] = nxt.id if nxt else None
    return payload


def _section_payload(section, *, max_chars: int) -> dict[str, Any]:
    body = section.body
    truncated = False
    if max_chars and len(body) > max_chars:
        body = body[:max_chars]
        truncated = True
    return {
        "id": section.id,
        "document_id": section.document_id,
        "ordinal": section.ordinal,
        "heading": section.heading,
        "heading_path": section.heading_path,
        "page_anchor": section.page_anchor,
        "body_chars": section.body_chars,
        "body": body,
        "truncated": truncated,
        "metadata": section.metadata,
    }


def _document_payload(document) -> dict[str, Any]:
    return {
        "id": document.id,
        "title": document.title,
        "collection_id": document.collection_id,
        "doc_type": document.doc_type,
        "source_path": document.source_path,
        "page_count": document.page_count,
        "size_bytes": document.size_bytes,
    }
