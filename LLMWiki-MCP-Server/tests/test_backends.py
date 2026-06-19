"""Tests for the storage abstraction layer (SQLite vs Azure backends).

Verifies:
1. WikiStorage ABC interface consistency
2. SQLite backend round-trip through the factory
3. Embeddings module API contract
4. Tenant guard enforcement on Azure backend
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


class TestWikiStorageProtocol(unittest.TestCase):
    """Verify the WikiStorage ABC defines all required methods."""

    def test_abc_has_all_required_methods(self) -> None:
        from llmwiki.backends.base import WikiStorage
        
        abstract_methods = {m for m, v in vars(WikiStorage).items() 
                          if getattr(v, '__isabstractmethod__', False)}
        
        expected = {
            'upsert_collection', 'list_collections', 
            'get_document_by_source_path', 'get_document', 
            'list_documents', 'delete_document_by_source_path',
            'replace_document', 'get_section', 'get_section_neighbors',
            'list_sections_for_document', 'search_sections',
            'get_concept', 'list_concepts', 'related_concepts',
            'record_ingest_event', 'recent_ingest_log',
            'get_document_count', 'count_collections',
        }
        
        for method in expected:
            self.assertIn(method, abstract_methods, f"Missing abstract method: {method}")


class TestSQLiteBackendFactory(unittest.TestCase):
    """Test the SQLite backend can be created via factory."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        from llmwiki.backends.base import create_sqlite_backend
        self.storage = create_sqlite_backend(Path(self._tmp.name) / 'wiki.sqlite3')

    def test_factory_creates_storage(self) -> None:
        """Basic sanity: can we store and retrieve a collection?"""
        self.storage.upsert_collection(id="test", name="Test Collection")
        collections = self.storage.list_collections()
        self.assertEqual(len(collections), 1)
        self.assertEqual(collections[0].id, "test")


class TestEmbeddingsModule(unittest.TestCase):
    """Test the embeddings module API contract."""

    def test_generate_embedding_api_exists(self) -> None:
        from llmwiki.embeddings import generate_embedding
        # No credentials → returns None (graceful degradation)
        result = generate_embedding("")
        self.assertIsNone(result)
    
    def test_batch_generate_texts_api_exists(self) -> None:
        from llmwiki.embeddings import batch_generate_texts
        results = batch_generate_texts([])
        self.assertEqual(results, [])

    def test_missing_openai_key_returns_none(self) -> None:
        """When no OpenAI key or Azure endpoint is configured, 
        generate_embedding should not raise—just return None."""
        from llmwiki.embeddings import generate_embedding
        # Unset all credential env vars first
        import os
        keys_to_save = ['LLMWIKI_EMBEDDING_ENDPOINT', 'LLMWIKI_EMBEDDING_API_KEY', 
                        'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT']
        saved = {k: os.environ.get(k) for k in keys_to_save}
        try:
            for k in keys_to_save:
                os.environ.pop(k, None)
            # Should not raise
            result = generate_embedding("test query")
            self.assertIsNone(result)
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v


class TestTenantGuard(unittest.TestCase):
    """Verify Phase 2 tenant guard behavior."""

    def test_tenant_guard_methods_exist(self) -> None:
        from llmwiki.backends.azure_backend import WikiAzureSearchBackend
        
        self.assertTrue(hasattr(WikiAzureSearchBackend, '_tenant_verified'))
        self.assertTrue(hasattr(WikiAzureSearchBackend, '_require_tenant'))

    def test_require_tenant_without_creds_raises(self) -> None:
        """When tenant_id is empty and no env config, _require_tenant raises."""
        # Only test if Azure SDK is available (skip in dev without it installed).
        try:
            from llmwiki.backends.azure_backend import WikiAzureSearchBackend, _azure_available
        except ImportError:
            self.skipTest("azure-search-documents not installed")
        
        if not sys.modules.get('azure.search.documents'):
            self.skipTest("Azure SDK not available in this environment")
        
        backend = WikiAzureSearchBackend()  # no tenant_id arg
        try:
            backend._require_tenant()
            self.fail("Expected RuntimeError")
        except RuntimeError as e:
            msg = str(e)
            self.assertIn("required", msg.lower())
            self.assertIn("tenant", msg.lower())


class TestIndexSchemaHelpers(unittest.TestCase):
    """Test that index schema helpers produce valid structures."""

    def test_search_index_has_required_fields(self) -> None:
        """Verify the index schemas expose the fields the backend reads/writes
        and that every field name is a valid Azure AI Search field name."""
        import re

        from llmwiki.backends import azure_backend as ab

        if not ab._azure_available:  # pragma: no cover - SDK present in CI
            self.skipTest("azure-search-documents not installed")

        sec = ab._wiki_sections_index()
        doc = ab._wiki_documents_index()
        con = ab._wiki_concepts_index()

        sec_fields = {f.name for f in sec.fields}
        doc_fields = {f.name for f in doc.fields}
        con_fields = {f.name for f in con.fields}

        self.assertTrue({'id', 'bodyVector', 'heading', 'body', 'tenantId', 'collectionId'} <= sec_fields)
        self.assertTrue({'id', 'title', 'docType', 'flavor', 'isDeleted', 'tenantId'} <= doc_fields)
        self.assertTrue({'id', 'name', 'slug', 'kind', 'definition'} <= con_fields)

        # Azure AI Search: field names must begin with a letter and contain
        # only letters, digits, or underscore. Guards the '_deleted' regression.
        name_re = re.compile(r'^[A-Za-z][A-Za-z0-9_]*$')
        for index in (sec, doc, con):
            for f in index.fields:
                self.assertRegex(f.name, name_re, f"invalid field name {f.name!r} in {index.name}")


class TestEscapingHelper(unittest.TestCase):
    """Verify OData string escaping."""

    def test_esc_escapes_apostrophes(self) -> None:
        from llmwiki.backends.azure_backend import _esc
        self.assertEqual(_esc("it's"), "it''s")
        self.assertEqual(_esc("o'brien"), "o''brien")

    def test_esc_handles_empty_string(self) -> None:
        from llmwiki.backends.azure_backend import _esc
        self.assertEqual(_esc(""), "''")

    def test_esc_passes_through_normal_strings(self) -> None:
        from llmwiki.backends.azure_backend import _esc
        result = _esc("hello world")
        self.assertEqual(result, "hello world")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
