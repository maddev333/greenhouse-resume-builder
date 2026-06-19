"""Tests for the deterministic ontology extractor."""

from __future__ import annotations

import sys
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from llmwiki.models import Section  # noqa: E402
from llmwiki.ontology import extract_ontology  # noqa: E402


def _section(body: str, heading: str = "Section", heading_path: str = "Doc > Section") -> Section:
    return Section(
        id=str(uuid.uuid4()),
        document_id="doc",
        ordinal=0,
        heading_path=heading_path,
        heading=heading,
        body=body,
        body_chars=len(body),
        page_anchor=None,
    )


class OntologyTests(unittest.TestCase):
    def test_extracts_rule_concepts(self) -> None:
        sections = [
            _section("Always use the Oxford comma. Avoid double spaces.")
        ]
        concepts, _links, _pairs = extract_ontology(
            collection_id="default", sections=sections
        )
        rules = [c for c in concepts if c.kind == "rule"]
        self.assertGreaterEqual(len(rules), 1)
        self.assertTrue(any("Oxford comma" in c.definition for c in rules))

    def test_extracts_glossary_definitions(self) -> None:
        sections = [
            _section(
                "Brand Voice: how we sound to customers.\n"
                "Tone: the emotional register of a message.\n"
            )
        ]
        concepts, _, _ = extract_ontology(
            collection_id="default", sections=sections
        )
        glossary = [c for c in concepts if c.kind == "concept"]
        slugs = {c.slug for c in glossary}
        self.assertIn("brand-voice", slugs)
        self.assertIn("tone", slugs)

    def test_extracts_entity_from_capitalized_heading(self) -> None:
        sections = [
            _section(
                body="See guidance below.",
                heading="Quarterly Business Review",
                heading_path="Doc > Quarterly Business Review",
            )
        ]
        concepts, _, _ = extract_ontology(
            collection_id="default", sections=sections
        )
        entities = [c for c in concepts if c.kind == "entity"]
        self.assertTrue(
            any(c.name == "Quarterly Business Review" for c in entities)
        )

    def test_section_concept_pairs_are_linked(self) -> None:
        sections = [
            _section("Always use the Oxford comma.")
        ]
        _concepts, _links, pairs = extract_ontology(
            collection_id="default", sections=sections
        )
        self.assertGreaterEqual(len(pairs), 1)
        section_ids = {section_id for section_id, _ in pairs}
        self.assertIn(sections[0].id, section_ids)

    def test_dense_section_skips_cooccurrence_clique(self) -> None:
        # A glossary-heavy section yields many concepts. Beyond the
        # co-occurrence cap, the dense `related_to` clique is suppressed so
        # link counts stay linear, but the concepts themselves are kept.
        lines = [f"Term{i}: definition number {i}." for i in range(30)]
        sections = [_section("\n".join(lines))]
        concepts, links, _pairs = extract_ontology(
            collection_id="default", sections=sections
        )
        self.assertGreaterEqual(len(concepts), 20)
        self.assertEqual(links, [])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
