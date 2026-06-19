"""Unit tests for the read-only ``resume-facts`` adapter backend.

These exercise the *client-side* mapping/trimming logic of
:class:`WikiResumeFactsBackend` with a fake ``SearchClient`` -- no network.

The live ``resume-facts`` index has **no filterable fields**, so the backend
never issues an OData ``$filter``; it fetches by relevance / key and trims
tenant, section, person and sensitive predicates in Python. The fake client
mirrors that: a ``search_text="*"`` call returns the "scan" corpus (used by the
aggregation + name-resolution scans), any other ``search_text`` returns the
"relevance" corpus, and ``get_document(key=...)`` looks a doc up by ``id``.
"""

from __future__ import annotations

import unittest


def _sdk_available() -> bool:
    try:
        import azure.search.documents  # noqa: F401
        import azure.core.exceptions  # noqa: F401

        return True
    except ImportError:
        return False


# Module-level helpers import cleanly even without the SDK (lazy azure import).
from llmwiki.backends.resume_facts_backend import (  # noqa: E402
    _epoch,
    _is_sensitive_fact_key,
    _query_text_from_match,
    _section_ids,
)

TENANT = "tenant-dev"


def _doc(
    id: str,
    *,
    person: str = "p1",
    tenant: str = TENANT,
    section: str | list[str] | None = "experience",
    fact_key: str | None = None,
    fact_value: str | None = None,
    bullet: str | None = None,
    created_at: str | None = None,
    score: float = 1.0,
) -> dict:
    """Build a fake ``resume-facts`` search document."""
    return {
        "id": id,
        "personId": person,
        "tenantId": tenant,
        "sectionId": section,
        "factKey": fact_key,
        "factValue": fact_value,
        "bulletText": bullet,
        "normalizedValue": None,
        "extractionRunId": "run-1",
        "createdAt": created_at,
        "@search.score": score,
    }


class FakeSearchClient:
    """Minimal stand-in for ``azure.search.documents.SearchClient``.

    * ``search(search_text="*")`` -> the *scan* corpus (aggregation/name scans).
    * ``search(search_text=<query>)`` -> the *relevance* corpus.
    * ``get_document(key=...)`` -> doc whose ``id`` matches, else raises
      ``ResourceNotFoundError``.
    """

    def __init__(self, scan_docs: list[dict], search_docs: list[dict] | None = None):
        self.scan_docs = list(scan_docs)
        self.search_docs = list(search_docs) if search_docs is not None else list(scan_docs)
        self.calls: list[dict] = []

    def search(self, search_text=None, *, filter=None, top=None, select=None, **kw):
        self.calls.append(
            {"search_text": search_text, "filter": filter, "top": top, "select": select, **kw}
        )
        if search_text == "*":
            return list(self.scan_docs)
        return list(self.search_docs)

    def get_document(self, key=None, selected_fields=None, **kw):
        from azure.core.exceptions import ResourceNotFoundError

        for d in self.scan_docs:
            if d.get("id") == key:
                return dict(d)
        raise ResourceNotFoundError(f"document '{key}' not found")


def _make_backend(
    *,
    tenant_id: str | None = TENANT,
    allow_sensitive: bool = False,
    scan_docs: list[dict] | None = None,
    search_docs: list[dict] | None = None,
):
    """Construct a backend wired to a :class:`FakeSearchClient` (no network)."""
    from llmwiki.backends.resume_facts_backend import WikiResumeFactsBackend

    backend = WikiResumeFactsBackend(
        service_url="https://example.search.windows.net",
        tenant_id=tenant_id,
        allow_sensitive=allow_sensitive,
    )
    # Force deterministic state regardless of ambient env vars.
    backend.tenant_id = tenant_id
    backend.allow_sensitive = allow_sensitive
    backend._client = FakeSearchClient(scan_docs or [], search_docs)
    backend._name_cache = {}
    backend._names_loaded = False
    return backend


class TestPureHelpers(unittest.TestCase):
    """Helpers that need no Azure SDK."""

    def test_is_sensitive_fact_key(self):
        self.assertTrue(_is_sensitive_fact_key("event.start_date"))
        self.assertTrue(_is_sensitive_fact_key("event.end_date"))
        self.assertTrue(_is_sensitive_fact_key("profile.location"))
        self.assertTrue(_is_sensitive_fact_key("employment.location"))
        self.assertFalse(_is_sensitive_fact_key("employment.job_title"))
        self.assertFalse(_is_sensitive_fact_key("profile.name"))
        self.assertFalse(_is_sensitive_fact_key(None))
        self.assertFalse(_is_sensitive_fact_key(""))

    def test_query_text_from_match_strips_fts5(self):
        # build_match_expression-style FTS5 input -> clean token query.
        out = _query_text_from_match('"python" OR "azure"* OR (data)')
        self.assertEqual(out, "python azure data")

    def test_query_text_preserves_skill_tokens(self):
        out = _query_text_from_match('"c++" OR "c#"')
        self.assertEqual(out, "c++ c#")

    def test_query_text_dedupes_case_insensitively(self):
        out = _query_text_from_match("Python OR python OR PYTHON")
        self.assertEqual(out, "Python")

    def test_epoch_parses_iso_z(self):
        self.assertEqual(_epoch("1970-01-01T00:00:00Z"), 0)
        self.assertEqual(_epoch("1970-01-01T00:01:00Z"), 60)

    def test_epoch_handles_garbage(self):
        self.assertEqual(_epoch(None), 0)
        self.assertEqual(_epoch(""), 0)
        self.assertEqual(_epoch("not-a-date"), 0)

    def test_section_ids_normalizes(self):
        self.assertEqual(_section_ids({"sectionId": "experience"}), ["experience"])
        self.assertEqual(_section_ids({"sectionId": ["a", "b"]}), ["a", "b"])
        self.assertEqual(_section_ids({"sectionId": None}), [])
        self.assertEqual(_section_ids({"sectionId": ""}), [])


@unittest.skipUnless(_sdk_available(), "azure-search-documents not installed")
class TestTenantFailClosed(unittest.TestCase):
    """No tenant configured -> every query method fails closed."""

    def _backend(self):
        return _make_backend(tenant_id=None, scan_docs=[])

    def test_list_collections_requires_tenant(self):
        with self.assertRaises(RuntimeError):
            self._backend().list_collections()

    def test_list_documents_requires_tenant(self):
        with self.assertRaises(RuntimeError):
            self._backend().list_documents()

    def test_search_requires_tenant(self):
        with self.assertRaises(RuntimeError):
            self._backend().search_sections(match_expr="python")

    def test_get_section_requires_tenant(self):
        with self.assertRaises(RuntimeError):
            self._backend().get_section("s1")

    def test_get_document_requires_tenant(self):
        with self.assertRaises(RuntimeError):
            self._backend().get_document("p1")


@unittest.skipUnless(_sdk_available(), "azure-search-documents not installed")
class TestTenantTrim(unittest.TestCase):
    """Client-side tenant trim drops other tenants' docs (no leakage)."""

    def test_scan_excludes_other_tenants(self):
        scan = [
            _doc("a1", person="p1", fact_key="employment.job_title", fact_value="Eng"),
            _doc("b1", person="p2", tenant="other-tenant",
                 fact_key="employment.job_title", fact_value="Mgr"),
        ]
        backend = _make_backend(scan_docs=scan)
        ids = backend.get_document_count()
        self.assertEqual(ids, 1)  # only p1 (tenant-dev); p2 (other-tenant) dropped

    def test_get_section_other_tenant_returns_none(self):
        scan = [_doc("x1", person="p9", tenant="other-tenant",
                     fact_key="employment.job_title", fact_value="Eng")]
        backend = _make_backend(scan_docs=scan)
        self.assertIsNone(backend.get_section("x1"))


@unittest.skipUnless(_sdk_available(), "azure-search-documents not installed")
class TestSensitiveRedaction(unittest.TestCase):
    """event.* / *.location facts are redacted unless allow_sensitive."""

    def setUp(self):
        self.relevance = [
            _doc("s1", section="experience", fact_key="employment.job_title",
                 fact_value="Engineer"),
            _doc("s2", section="experience", fact_key="event.start_date",
                 fact_value="2020-01-01"),
            _doc("s3", section="profile", fact_key="profile.location",
                 fact_value="London"),
        ]
        # Scan corpus adds the profile.name fact so display-name resolves.
        self.scan = self.relevance + [
            _doc("n1", section="profile", fact_key="profile.name",
                 fact_value="Ada Lovelace"),
        ]

    def test_search_redacts_sensitive_by_default(self):
        backend = _make_backend(scan_docs=self.scan, search_docs=self.relevance)
        hits = backend.search_sections(match_expr="engineer", limit=10)
        headings = {h.heading for h in hits}
        self.assertEqual(headings, {"employment.job_title"})
        self.assertEqual(hits[0].document_title, "Ada Lovelace")
        self.assertEqual(hits[0].snippet, "Engineer")

    def test_search_allow_sensitive_includes_all(self):
        backend = _make_backend(
            scan_docs=self.scan, search_docs=self.relevance, allow_sensitive=True
        )
        hits = backend.search_sections(match_expr="engineer", limit=10)
        headings = {h.heading for h in hits}
        self.assertEqual(
            headings,
            {"employment.job_title", "event.start_date", "profile.location"},
        )

    def test_get_section_redacted_returns_none(self):
        backend = _make_backend(scan_docs=self.scan, search_docs=self.relevance)
        self.assertIsNone(backend.get_section("s2"))  # event.start_date
        self.assertIsNone(backend.get_section("s3"))  # profile.location

    def test_get_section_visible_returns_section(self):
        backend = _make_backend(scan_docs=self.scan, search_docs=self.relevance)
        sec = backend.get_section("s1")
        self.assertIsNotNone(sec)
        self.assertEqual(sec.heading, "employment.job_title")
        self.assertEqual(sec.body, "Engineer")
        self.assertEqual(sec.metadata["kind"], "fact")

    def test_get_section_allow_sensitive_returns_section(self):
        backend = _make_backend(
            scan_docs=self.scan, search_docs=self.relevance, allow_sensitive=True
        )
        sec = backend.get_section("s2")
        self.assertIsNotNone(sec)
        self.assertEqual(sec.heading, "event.start_date")

    def test_list_sections_for_document_redacts(self):
        backend = _make_backend(scan_docs=self.scan, search_docs=self.relevance)
        sections = backend.list_sections_for_document("p1")
        headings = {s.heading for s in sections}
        self.assertIn("employment.job_title", headings)
        self.assertIn("profile.name", headings)
        self.assertNotIn("event.start_date", headings)
        self.assertNotIn("profile.location", headings)


@unittest.skipUnless(_sdk_available(), "azure-search-documents not installed")
class TestSectionMapping(unittest.TestCase):
    """Fact/bullet -> Section mapping, ordering and kind metadata."""

    def test_sections_ordering_and_kind(self):
        scan = [
            _doc("a1", person="p1", section="experience",
                 fact_key="employment.job_title", fact_value="Engineer"),
            _doc("b1", person="p1", section="experience", bullet="Built the thing"),
            _doc("s1", person="p1", section="skills",
                 fact_key="skills.item", fact_value="Python"),
        ]
        backend = _make_backend(scan_docs=scan)
        sections = backend.list_sections_for_document("p1")
        self.assertEqual(len(sections), 3)
        # Ordered by (section, factKey, id): experience-bullet ('' key) first.
        self.assertEqual([s.id for s in sections], ["b1", "a1", "s1"])
        kinds = {s.heading: s.metadata["kind"] for s in sections}
        self.assertEqual(kinds["skills.item"], "fact")
        self.assertEqual(kinds["experience bullet"], "bullet")
        # ordinals are sequential
        self.assertEqual([s.ordinal for s in sections], [0, 1, 2])

    def test_bullet_heading_and_body(self):
        scan = [_doc("b1", person="p1", section="experience", bullet="Did stuff")]
        backend = _make_backend(scan_docs=scan)
        sections = backend.list_sections_for_document("p1")
        self.assertEqual(len(sections), 1)
        self.assertEqual(sections[0].heading, "experience bullet")
        self.assertEqual(sections[0].body, "Did stuff")
        self.assertEqual(sections[0].metadata["kind"], "bullet")


@unittest.skipUnless(_sdk_available(), "azure-search-documents not installed")
class TestDocumentsAndCollections(unittest.TestCase):
    """Person -> Document and resume sectionId -> Collection aggregation."""

    def _corpus(self):
        return [
            _doc("n1", person="p1", section="profile",
                 fact_key="profile.name", fact_value="Grace Hopper"),
            _doc("j1", person="p1", section="experience",
                 fact_key="employment.job_title", fact_value="Engineer"),
            _doc("n2", person="p2", section="profile",
                 fact_key="profile.name", fact_value="Alan Turing"),
        ]

    def test_list_documents_maps_persons(self):
        backend = _make_backend(scan_docs=self._corpus())
        docs = backend.list_documents()
        by_id = {d.id: d for d in docs}
        self.assertEqual(set(by_id), {"p1", "p2"})
        self.assertEqual(by_id["p1"].title, "Grace Hopper")
        self.assertEqual(by_id["p2"].title, "Alan Turing")
        self.assertEqual(by_id["p1"].doc_type, "resume")
        self.assertEqual(by_id["p1"].flavor, "raw")
        self.assertEqual(by_id["p1"].source_path, "person/p1")
        self.assertIn("experience", by_id["p1"].metadata["resume_sections"])
        self.assertIn("profile", by_id["p1"].metadata["resume_sections"])

    def test_get_document_single_person(self):
        backend = _make_backend(scan_docs=self._corpus())
        doc = backend.get_document("p2")
        self.assertIsNotNone(doc)
        self.assertEqual(doc.title, "Alan Turing")

    def test_get_document_unknown_returns_none(self):
        backend = _make_backend(scan_docs=self._corpus())
        self.assertIsNone(backend.get_document("nobody"))

    def test_get_document_by_source_path(self):
        backend = _make_backend(scan_docs=self._corpus())
        doc = backend.get_document_by_source_path("person/p1")
        self.assertIsNotNone(doc)
        self.assertEqual(doc.id, "p1")

    def test_list_collections_maps_sections(self):
        backend = _make_backend(scan_docs=self._corpus())
        collections = backend.list_collections()
        by_id = {c.id: c for c in collections}
        self.assertIn("profile", by_id)
        self.assertIn("experience", by_id)
        # profile has p1 + p2; experience has only p1.
        self.assertEqual(by_id["profile"].document_count, 2)
        self.assertEqual(by_id["experience"].document_count, 1)

    def test_count_helpers(self):
        backend = _make_backend(scan_docs=self._corpus())
        self.assertEqual(backend.get_document_count(), 2)
        self.assertEqual(backend.count_collections(), 2)

    def test_list_documents_filtered_by_collection(self):
        backend = _make_backend(scan_docs=self._corpus())
        docs = backend.list_documents(collection_id="experience")
        self.assertEqual({d.id for d in docs}, {"p1"})  # only p1 has experience


@unittest.skipUnless(_sdk_available(), "azure-search-documents not installed")
class TestSearchMapping(unittest.TestCase):
    """search_sections -> SearchHit mapping + section filter."""

    def _fixtures(self):
        relevance = [
            _doc("s1", person="p1", section="experience",
                 fact_key="employment.job_title", fact_value="Senior Engineer", score=2.5),
            _doc("s2", person="p1", section="skills",
                 fact_key="skills.item", fact_value="Python", score=1.0),
        ]
        scan = relevance + [
            _doc("n1", person="p1", section="profile",
                 fact_key="profile.name", fact_value="Ada Lovelace"),
        ]
        return scan, relevance

    def test_search_returns_hits_with_titles(self):
        scan, relevance = self._fixtures()
        backend = _make_backend(scan_docs=scan, search_docs=relevance)
        hits = backend.search_sections(match_expr="engineer", limit=10)
        self.assertEqual(len(hits), 2)
        top = hits[0]
        self.assertEqual(top.section_id, "s1")
        self.assertEqual(top.document_id, "p1")
        self.assertEqual(top.document_title, "Ada Lovelace")
        self.assertEqual(top.collection_id, "experience")
        self.assertEqual(top.score, 2.5)
        self.assertEqual(top.source_path, "person/p1")

    def test_search_filters_by_collection(self):
        scan, relevance = self._fixtures()
        backend = _make_backend(scan_docs=scan, search_docs=relevance)
        hits = backend.search_sections(match_expr="python", collection_id="skills", limit=10)
        self.assertEqual({h.section_id for h in hits}, {"s2"})

    def test_search_rejects_wiki_flavor(self):
        scan, relevance = self._fixtures()
        backend = _make_backend(scan_docs=scan, search_docs=relevance)
        hits = backend.search_sections(match_expr="engineer", flavor="wiki")
        self.assertEqual(hits, [])


@unittest.skipUnless(_sdk_available(), "azure-search-documents not installed")
class TestReadOnlyContract(unittest.TestCase):
    """Writes are forbidden; ingest log + concepts are empty/no-op."""

    def test_read_only_flag(self):
        backend = _make_backend(scan_docs=[])
        self.assertTrue(backend.read_only)

    def test_writes_raise(self):
        backend = _make_backend(scan_docs=[])
        with self.assertRaises(NotImplementedError):
            backend.upsert_collection(id="x", name="x")
        with self.assertRaises(NotImplementedError):
            backend.delete_document_by_source_path("person/p1")
        with self.assertRaises(NotImplementedError):
            backend.replace_document(document=object(), sections=[])

    def test_record_ingest_event_is_noop(self):
        backend = _make_backend(scan_docs=[])
        self.assertIsNone(
            backend.record_ingest_event(source_path="person/p1", status="indexed")
        )

    def test_recent_ingest_log_empty(self):
        backend = _make_backend(scan_docs=[])
        self.assertEqual(backend.recent_ingest_log(), [])

    def test_concepts_empty(self):
        backend = _make_backend(scan_docs=[])
        self.assertIsNone(backend.get_concept("c1"))
        self.assertEqual(backend.list_concepts(), [])
        self.assertEqual(backend.related_concepts("c1"), [])


if __name__ == "__main__":
    unittest.main()
