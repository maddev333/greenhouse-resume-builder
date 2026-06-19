"""Content checking against indexed ``rule`` concepts.

Given a piece of drafted content (paragraph, email, slide, cell text),
match it against every indexed rule whose key trigger phrase or noun
keyword appears in the content. The result is a list of
:class:`Finding` objects, each citing the originating section so the
agent can quote the rule verbatim.

This is intentionally lexical / deterministic; no LLM judgement is made
here. The agent layer can refine these candidates upstream.
"""

from __future__ import annotations

import re
from dataclasses import asdict
from typing import Any

from .models import Finding
from .storage import Storage

_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z\-]{2,}")
_GENERIC_KEYWORDS = {
    "must", "should", "shall", "always", "never", "avoid", "prefer",
    "the", "and", "for", "with", "from", "this", "that", "have",
    "use", "are", "was", "were", "they", "you", "your", "our",
    "not", "but", "any", "all", "can", "may", "than", "then",
}


def check_content_against_wiki(
    storage: Storage,
    *,
    content: str,
    collection: str | None = None,
    max_findings: int = 25,
) -> dict[str, Any]:
    rules = storage.list_concepts(
        collection_id=collection, kind="rule", limit=1000
    )
    content_tokens = _tokenize(content)
    findings: list[Finding] = []
    for rule in rules:
        rule_tokens = _meaningful_tokens(rule.name + " " + rule.definition)
        if not rule_tokens:
            continue
        overlap = rule_tokens & content_tokens
        if not overlap:
            continue
        severity = _severity_for(rule.definition)
        section = (
            storage.get_section(rule.source_section_id)
            if rule.source_section_id
            else None
        )
        document = (
            storage.get_document(section.document_id) if section else None
        )
        citation: dict[str, Any] = {
            "section_id": rule.source_section_id,
        }
        if section:
            citation["heading_path"] = section.heading_path
            citation["page_anchor"] = section.page_anchor
        if document:
            citation["document_id"] = document.id
            citation["document_title"] = document.title
            citation["source_path"] = document.source_path
        findings.append(
            Finding(
                rule_concept_id=rule.id,
                rule_name=rule.name,
                severity=severity,
                evidence=", ".join(sorted(overlap)[:6]),
                suggestion=rule.definition,
                citation=citation,
            )
        )
        if len(findings) >= max_findings:
            break
    return {
        "checked_chars": len(content or ""),
        "rule_pool_size": len(rules),
        "finding_count": len(findings),
        "findings": [asdict(f) for f in findings],
    }


def _tokenize(text: str) -> set[str]:
    return {m.group(0).lower() for m in _TOKEN_RE.finditer(text or "")}


def _meaningful_tokens(text: str) -> set[str]:
    return {tok for tok in _tokenize(text) if tok not in _GENERIC_KEYWORDS}


def _severity_for(definition: str) -> str:
    lowered = (definition or "").lower()
    if any(
        kw in lowered
        for kw in ("must not", "never", "do not", "don't", "shall not")
    ):
        return "error"
    if any(kw in lowered for kw in ("must", "shall", "required")):
        return "error"
    if any(kw in lowered for kw in ("should", "should not", "avoid")):
        return "warn"
    return "info"
