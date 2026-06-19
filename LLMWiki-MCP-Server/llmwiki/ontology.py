"""Deterministic ontology extraction.

Concept / rule / entity extraction is intentionally rule-based — no LLM,
no external services. This trades coverage for **provenance**: every
concept points back to the section that defined it, and rules always
carry the original wording so policy text is never paraphrased.

Three extractors run per section:

- :func:`_extract_rule_concepts` — sentences that look like normative
  guidance ("must", "must not", "should", "always", "never", "do not").
- :func:`_extract_glossary_concepts` — "Term: definition" lines and
  "Term — definition" lines, common in style guides.
- :func:`_extract_entity_concepts` — capitalised multi-word phrases
  that appear in section headings (entities / templates by convention).

Concepts are de-duped per collection by (kind, slug). When the same
rule is restated in multiple sections, all defining sections are linked
through `section_concepts`.
"""

from __future__ import annotations

import re
import uuid
from collections import defaultdict
from typing import Iterable

from .models import Concept, ConceptLink, Section

_RULE_TRIGGERS = re.compile(
    r"\b(must not|must|should not|should|shall not|shall|"
    r"do not|don't|never|always|avoid|prefer|require[sd]?)\b",
    re.IGNORECASE,
)
_GLOSSARY_LINE = re.compile(
    r"^\s*(?P<term>[A-Z][\w\s\-/]{1,80})\s*[:\u2014\u2013-]\s+(?P<def>.+?)\s*$"
)
_CAPITALIZED_PHRASE = re.compile(
    r"\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\b"
)
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z(\"'\[])")
_SLUG_NON_WORD = re.compile(r"[^a-z0-9]+")

_STOPWORD_PHRASES = {
    "table of contents",
    "executive summary",
}

# A section's concepts are linked pairwise into a `related_to` clique. That
# is O(n^2) in the number of concepts in the section, so a dense policy
# section (many "must"/"should" sentences) can emit tens of thousands of
# links. Skip clique-building for sections above this many concepts; the
# concepts and their section provenance are still recorded, only the dense
# co-occurrence edges are dropped.
_MAX_COOCCURRENCE_CONCEPTS = 12


def _slugify(value: str) -> str:
    lowered = value.strip().lower()
    slug = _SLUG_NON_WORD.sub("-", lowered).strip("-")
    return slug or "untitled"


def extract_ontology(
    *,
    collection_id: str,
    sections: Iterable[Section],
) -> tuple[list[Concept], list[ConceptLink], list[tuple[str, str]]]:
    """Return (concepts, links, section_concept_pairs).

    Concepts are de-duplicated by (kind, slug) within the collection.
    The first section that introduces a concept is kept as
    ``source_section_id``; later sections that restate it are linked via
    ``section_concepts`` so retrieval can surface every defining
    location.
    """
    by_key: dict[tuple[str, str], Concept] = {}
    section_links: set[tuple[str, str]] = set()
    related: set[tuple[str, str, str]] = set()

    for section in sections:
        for concept in _extract_rule_concepts(collection_id, section):
            _merge(by_key, concept, section, section_links)
        for concept in _extract_glossary_concepts(collection_id, section):
            _merge(by_key, concept, section, section_links)
        for concept in _extract_entity_concepts(collection_id, section):
            _merge(by_key, concept, section, section_links)

    # Build a small co-occurrence graph: concepts that share a section are
    # marked `related_to`. Cheap, fully deterministic, and good enough for the
    # agent's `find_related_concepts` call.
    by_section: dict[str, list[str]] = defaultdict(list)
    for section_id, concept_id in section_links:
        by_section[section_id].append(concept_id)
    for ids in by_section.values():
        # Bound the clique to avoid a quadratic explosion of `related_to`
        # edges on dense sections. Oversized sections keep their concepts
        # but contribute no co-occurrence links.
        if len(ids) > _MAX_COOCCURRENCE_CONCEPTS:
            continue
        for i, src in enumerate(ids):
            for dst in ids[i + 1 :]:
                if src == dst:
                    continue
                related.add((src, dst, "related_to"))
                related.add((dst, src, "related_to"))

    links = [
        ConceptLink(src_concept_id=src, dst_concept_id=dst, relation=rel)
        for src, dst, rel in related
    ]
    return (
        list(by_key.values()),
        links,
        sorted(section_links),
    )


def _merge(
    by_key: dict[tuple[str, str], Concept],
    concept: Concept,
    section: Section,
    section_links: set[tuple[str, str]],
) -> None:
    key = (concept.kind, concept.slug)
    existing = by_key.get(key)
    if existing is None:
        by_key[key] = concept
        section_links.add((section.id, concept.id))
        return
    # Keep the first concept; link the additional defining section.
    section_links.add((section.id, existing.id))
    # If the existing concept has no definition but the new one does, fill it.
    if not existing.definition and concept.definition:
        existing.definition = concept.definition


# ---------------------------------------------------------------------------
# Extractors
# ---------------------------------------------------------------------------
def _extract_rule_concepts(
    collection_id: str, section: Section
) -> list[Concept]:
    sentences = _SENTENCE_SPLIT.split(section.body)
    concepts: list[Concept] = []
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence or len(sentence) > 400:
            continue
        if not _RULE_TRIGGERS.search(sentence):
            continue
        # Use the first 80 chars (truncated to a word boundary) as the name.
        name = _short_name(sentence)
        slug = _slugify(name)
        concept = Concept(
            id=str(uuid.uuid4()),
            collection_id=collection_id,
            name=name,
            slug=slug,
            kind="rule",
            definition=sentence,
            source_section_id=section.id,
            metadata={
                "heading_path": section.heading_path,
                "trigger": (_RULE_TRIGGERS.search(sentence) or [""])[0],
            },
        )
        concepts.append(concept)
    return concepts


def _extract_glossary_concepts(
    collection_id: str, section: Section
) -> list[Concept]:
    concepts: list[Concept] = []
    for line in section.body.splitlines():
        if len(line) > 300:
            continue
        match = _GLOSSARY_LINE.match(line)
        if not match:
            continue
        term = match.group("term").strip()
        definition = match.group("def").strip()
        if not term or len(term.split()) > 8:
            continue
        if term.lower() in _STOPWORD_PHRASES:
            continue
        slug = _slugify(term)
        concepts.append(
            Concept(
                id=str(uuid.uuid4()),
                collection_id=collection_id,
                name=term,
                slug=slug,
                kind="concept",
                definition=definition,
                source_section_id=section.id,
                metadata={"heading_path": section.heading_path},
            )
        )
    return concepts


def _extract_entity_concepts(
    collection_id: str, section: Section
) -> list[Concept]:
    if not section.heading:
        return []
    if len(section.heading) > 80:
        return []
    if section.heading.lower() in _STOPWORD_PHRASES:
        return []
    matches = _CAPITALIZED_PHRASE.findall(section.heading)
    concepts: list[Concept] = []
    seen: set[str] = set()
    for phrase in matches:
        slug = _slugify(phrase)
        if slug in seen:
            continue
        seen.add(slug)
        concepts.append(
            Concept(
                id=str(uuid.uuid4()),
                collection_id=collection_id,
                name=phrase,
                slug=slug,
                kind="entity",
                definition="",
                source_section_id=section.id,
                metadata={"heading_path": section.heading_path},
            )
        )
    return concepts


def _short_name(sentence: str, *, max_chars: int = 80) -> str:
    if len(sentence) <= max_chars:
        return sentence
    cut = sentence[: max_chars].rsplit(" ", 1)[0]
    return cut + "..."
