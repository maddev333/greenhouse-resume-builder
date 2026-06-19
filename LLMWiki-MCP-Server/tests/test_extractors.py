"""Tests for the extractor registry and the Azure Document Intelligence
extractor's pure-Python helpers.

The DI tests don't talk to Azure: we drive the extractor with a fake
``DocumentIntelligenceClient`` that returns a hand-crafted result object.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from llmwiki import extractors  # noqa: E402
from llmwiki.extractors import (  # noqa: E402
    ExtractedDocument,
    ExtractionError,
    ExtractorRegistry,
    configure_registry,
)
from llmwiki.extractors_doc_intel import (  # noqa: E402
    AzureDocumentIntelligenceExtractor,
    _DocIntelClientBundle,
    _line_page_anchors,
)


class _FakePoller:
    def __init__(self, result: Any) -> None:
        self._result = result

    def result(self, timeout: int | None = None) -> Any:
        return self._result


class _FakeDIClient:
    """Stand-in for DocumentIntelligenceClient."""

    def __init__(self, response: Any) -> None:
        self._response = response
        self.calls: list[dict[str, Any]] = []

    def begin_analyze_document(self, **kwargs: Any) -> _FakePoller:
        self.calls.append(kwargs)
        return _FakePoller(self._response)


def _di_response(
    content: str, page_count: int | None = None
) -> SimpleNamespace:
    pages = (
        [SimpleNamespace(page_number=i + 1) for i in range(page_count)]
        if page_count
        else None
    )
    return SimpleNamespace(content=content, pages=pages)


def _di_extractor(response: Any) -> AzureDocumentIntelligenceExtractor:
    bundle = _DocIntelClientBundle(
        client=_FakeDIClient(response),
        model_id="prebuilt-layout",
        timeout_seconds=60,
    )
    return AzureDocumentIntelligenceExtractor(bundle)


class RegistryTests(unittest.TestCase):
    def tearDown(self) -> None:
        # Restore the builtin registry so later tests don't see DI / fakes.
        configure_registry(None)

    def test_builtin_registry_handles_md_txt_html(self) -> None:
        registry = configure_registry(None)
        self.assertIn(".md", registry.supported_suffixes)
        self.assertIn(".txt", registry.supported_suffixes)
        self.assertIn(".html", registry.supported_suffixes)
        self.assertEqual(registry.detect_doc_type(Path("foo.md")), "md")
        self.assertEqual(registry.detect_doc_type(Path("foo.HTML")), "html")
        self.assertIsNone(registry.detect_doc_type(Path("foo.docx")))

    def test_extract_routes_through_registry_for_markdown(self) -> None:
        configure_registry(None)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "note.md"
            path.write_text("# Hello\n\nBody.", encoding="utf-8")
            doc = extractors.extract(path)
        self.assertEqual(doc.doc_type, "md")
        self.assertEqual(doc.title, "Hello")
        self.assertEqual(doc.extractor, "builtin.text")

    def test_unsupported_suffix_raises(self) -> None:
        configure_registry(None)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "thing.zip"
            path.write_bytes(b"PK\x03\x04")
            with self.assertRaises(ExtractionError):
                extractors.extract(path)

    def test_doc_intel_config_registers_and_evicts_pypdf(self) -> None:
        doc_intel = SimpleNamespace(
            enabled=True,
            endpoint="https://example.cognitiveservices.azure.com/",
            api_key="sk-test",
            model="prebuilt-layout",
            for_doc_types=("pdf", "image"),
            fallback_to_pypdf=False,
            timeout_seconds=60,
        )
        config = SimpleNamespace(doc_intel=doc_intel)

        # Monkey-patch the extractor module so we don't need the real SDK.
        fake_response = _di_response("# Test\n\nBody", page_count=1)

        def _factory(_doc_intel):
            return _di_extractor(fake_response)

        from llmwiki import extractors_doc_intel as dim
        original = dim.AzureDocumentIntelligenceExtractor.from_config
        dim.AzureDocumentIntelligenceExtractor.from_config = staticmethod(_factory)
        try:
            registry = configure_registry(config)
        finally:
            dim.AzureDocumentIntelligenceExtractor.from_config = original

        pdf_extractors = registry.extractors_for("pdf")
        self.assertEqual(len(pdf_extractors), 1)
        self.assertEqual(pdf_extractors[0].name, "azure.documentintelligence")

        image_extractors = registry.extractors_for("image")
        self.assertEqual(len(image_extractors), 1)
        self.assertIn(".png", registry.supported_suffixes)
        self.assertIn(".pdf", registry.supported_suffixes)

    def test_doc_intel_with_fallback_keeps_pypdf_after_di(self) -> None:
        doc_intel = SimpleNamespace(
            enabled=True,
            endpoint="https://example.cognitiveservices.azure.com/",
            api_key="sk-test",
            model="prebuilt-layout",
            for_doc_types=("pdf",),
            fallback_to_pypdf=True,
            timeout_seconds=60,
        )
        config = SimpleNamespace(doc_intel=doc_intel)
        fake_response = _di_response("# Test\n\nBody", page_count=1)

        def _factory(_doc_intel):
            return _di_extractor(fake_response)

        from llmwiki import extractors_doc_intel as dim
        original = dim.AzureDocumentIntelligenceExtractor.from_config
        dim.AzureDocumentIntelligenceExtractor.from_config = staticmethod(_factory)
        try:
            registry = configure_registry(config)
        finally:
            dim.AzureDocumentIntelligenceExtractor.from_config = original

        pdf_extractors = registry.extractors_for("pdf")
        self.assertEqual(len(pdf_extractors), 2)
        # DI comes first (prepended), pypdf is the fallback.
        self.assertEqual(pdf_extractors[0].name, "azure.documentintelligence")
        self.assertEqual(pdf_extractors[1].name, "builtin.pypdf")


class DocIntelExtractorTests(unittest.TestCase):
    def tearDown(self) -> None:
        configure_registry(None)

    def test_extract_returns_markdown_title_and_pages(self) -> None:
        markdown = (
            "# Annual Report\n\n"
            "First page body.\n\n"
            "<!-- PageBreak -->\n"
            "<!-- PageNumber=\"2\" -->\n"
            "## Section Two\n\n"
            "Second page body.\n"
        )
        extractor = _di_extractor(_di_response(markdown, page_count=2))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "report.pdf"
            path.write_bytes(b"%PDF-fake")
            result = extractor.extract(path, doc_type="pdf")
        self.assertEqual(result.title, "Annual Report")
        self.assertEqual(result.doc_type, "pdf")
        self.assertEqual(result.page_count, 2)
        self.assertTrue(result.markdown.startswith("# Annual Report"))
        # Page anchor for some line should map to page 2.
        self.assertIn(2, set(result.line_page_anchors.values()))
        self.assertTrue(
            result.extractor and result.extractor.startswith(
                "azure.documentintelligence"
            )
        )

    def test_empty_response_raises_extraction_error(self) -> None:
        extractor = _di_extractor(_di_response("   \n  \n", page_count=1))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "empty.pdf"
            path.write_bytes(b"%PDF-fake")
            with self.assertRaises(ExtractionError):
                extractor.extract(path, doc_type="pdf")

    def test_image_doc_type_supported(self) -> None:
        extractor = _di_extractor(
            _di_response("# Sign\n\nNo loitering.\n", page_count=1)
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sign.png"
            path.write_bytes(b"\x89PNG\r\n\x1a\n")
            result = extractor.extract(path, doc_type="image")
        self.assertEqual(result.doc_type, "image")
        self.assertEqual(result.title, "Sign")


class PageAnchorTests(unittest.TestCase):
    def test_page_break_advances_counter(self) -> None:
        markdown = (
            "Intro line.\n"
            "<!-- PageBreak -->\n"
            "Second page line.\n"
            "<!-- PageBreak -->\n"
            "Third page line.\n"
        )
        anchors = _line_page_anchors(markdown)
        self.assertEqual(anchors.get(0), 1)
        self.assertEqual(anchors.get(2), 2)
        self.assertEqual(anchors.get(4), 3)

    def test_page_number_marker_sets_explicit_page(self) -> None:
        markdown = (
            "Cover.\n"
            "<!-- PageNumber=\"7\" -->\n"
            "Body of page seven.\n"
        )
        anchors = _line_page_anchors(markdown)
        self.assertEqual(anchors.get(2), 7)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
