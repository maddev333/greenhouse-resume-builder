"""Tests for the SQLite storage layer + FTS5 round-trip."""

from __future__ import annotations

import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from llmwiki.models import Concept, ConceptLink, Document, Section  # noqa: E402
from llmwiki.retrieval import build_match_expression, search_wiki  # noqa: E402
from llmwiki.storage import Storage  # noqa: E402


def _make_document(collection_id: str = "default") -> Document:
    return Document(
        id=str(uuid.uuid4()),
        collection_id=collection_id,
        source_path=f"/tmp/{uuid.uuid4()}.md",
        title="Style Guide",
        doc_type="md",
        content_hash="abc123",
        parsed_path=None,
        size_bytes=42,
        page_count=None,
        source_mtime=int(time.time()),
        ingested_at=int(time.time()),
        metadata={"author": "ops"},
    )


def _make_section(document_id: str, ordinal: int = 0) -> Section:
    body = (
        "Always use the Oxford comma when writing lists. "
        "Avoid jargon. Prefer plain English."
    )
    return Section(
        id=str(uuid.uuid4()),
        document_id=document_id,
        ordinal=ordinal,
        heading_path="Style Guide > Grammar",
        heading="Grammar",
        body=body,
        body_chars=len(body),
        page_anchor=None,
    )


def _make_rule(collection_id: str, section_id: str) -> Concept:
    return Concept(
        id=str(uuid.uuid4()),
        collection_id=collection_id,
        name="Always use the Oxford comma",
        slug="always-use-the-oxford-comma",
        kind="rule",
        definition="Always use the Oxford comma when writing lists.",
        source_section_id=section_id,
    )


class StorageTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = Path(self._tmp.name) / "wiki.sqlite3"
        self.storage = Storage(self.db_path)
        self.storage.upsert_collection(id="default", name="default")

    def test_round_trip_document_and_search(self) -> None:
        document = _make_document()
        section = _make_section(document.id)
        rule = _make_rule(document.collection_id, section.id)
        self.storage.replace_document(
            document=document,
            sections=[section],
            concepts=[rule],
            section_concept_ids=[(section.id, rule.id)],
        )

        fetched = self.storage.get_document(document.id)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.title, "Style Guide")

        hits = self.storage.search_sections(
            match_expr=build_match_expression("oxford comma"),
            limit=5,
        )
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].document_id, document.id)
        self.assertIn("oxford", hits[0].snippet.lower())

        concept = self.storage.get_concept(rule.id)
        self.assertIsNotNone(concept)
        self.assertEqual(concept.kind, "rule")

    def test_replace_document_removes_old_sections(self) -> None:
        document = _make_document()
        section = _make_section(document.id)
        self.storage.replace_document(
            document=document, sections=[section]
        )
        # Replace with a new section list.
        new_section = _make_section(document.id, ordinal=0)
        new_section.body = "Use the en-dash for ranges."
        new_section.body_chars = len(new_section.body)
        self.storage.replace_document(
            document=document, sections=[new_section]
        )
        all_sections = self.storage.list_sections_for_document(document.id)
        self.assertEqual(len(all_sections), 1)
        self.assertIn("en-dash", all_sections[0].body)

        # Old section should no longer be searchable.
        old_hits = self.storage.search_sections(
            match_expr=build_match_expression("oxford"), limit=5
        )
        self.assertEqual(len(old_hits), 0)

    def test_search_wiki_helper_returns_payload(self) -> None:
        document = _make_document()
        section = _make_section(document.id)
        self.storage.replace_document(
            document=document, sections=[section]
        )
        payload = search_wiki(
            self.storage, query="oxford comma", max_results=3
        )
        self.assertEqual(payload["result_count"], 1)
        self.assertEqual(
            payload["results"][0]["document_id"], document.id
        )

    def test_flavor_round_trip_and_filter(self) -> None:
        raw_doc = _make_document(collection_id="default")
        raw_section = _make_section(raw_doc.id)
        self.storage.replace_document(
            document=raw_doc, sections=[raw_section]
        )

        wiki_doc = _make_document(collection_id="wiki")
        wiki_doc.flavor = "wiki"
        wiki_doc.title = "Wiki Note"
        self.storage.upsert_collection(id="wiki", name="wiki")
        wiki_section = _make_section(wiki_doc.id)
        wiki_section.body = "Always cite the source. Avoid hallucinating."
        wiki_section.body_chars = len(wiki_section.body)
        self.storage.replace_document(
            document=wiki_doc, sections=[wiki_section]
        )

        # Flavor is stored and round-trips through get_document.
        fetched_wiki = self.storage.get_document(wiki_doc.id)
        self.assertIsNotNone(fetched_wiki)
        self.assertEqual(fetched_wiki.flavor, "wiki")
        fetched_raw = self.storage.get_document(raw_doc.id)
        self.assertEqual(fetched_raw.flavor, "raw")

        # list_documents filters by flavor.
        raw_only = self.storage.list_documents(flavor="raw")
        self.assertTrue(all(d.flavor == "raw" for d in raw_only))
        wiki_only = self.storage.list_documents(flavor="wiki")
        self.assertTrue(all(d.flavor == "wiki" for d in wiki_only))
        self.assertEqual(len(wiki_only), 1)
        self.assertEqual(wiki_only[0].id, wiki_doc.id)

        # search_sections honors the flavor filter.
        hits_all = self.storage.search_sections(
            match_expr=build_match_expression("always"), limit=10
        )
        self.assertGreaterEqual(len(hits_all), 2)
        hits_wiki = self.storage.search_sections(
            match_expr=build_match_expression("always"),
            limit=10,
            flavor="wiki",
        )
        self.assertEqual(len(hits_wiki), 1)
        self.assertEqual(hits_wiki[0].document_id, wiki_doc.id)

    def test_concept_links_round_trip(self) -> None:
        document = _make_document()
        section = _make_section(document.id)
        rule = _make_rule(document.collection_id, section.id)
        other = Concept(
            id=str(uuid.uuid4()),
            collection_id="default",
            name="Plain English",
            slug="plain-english",
            kind="concept",
            definition="Prefer plain English over jargon.",
            source_section_id=section.id,
        )
        link = ConceptLink(
            src_concept_id=rule.id,
            dst_concept_id=other.id,
            relation="related_to",
        )
        self.storage.replace_document(
            document=document,
            sections=[section],
            concepts=[rule, other],
            concept_links=[link],
            section_concept_ids=[
                (section.id, rule.id),
                (section.id, other.id),
            ],
        )
        related = self.storage.related_concepts(rule.id)
        self.assertEqual(len(related), 1)
        related_concept, relation = related[0]
        self.assertEqual(related_concept.id, other.id)
        self.assertEqual(relation, "related_to")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
