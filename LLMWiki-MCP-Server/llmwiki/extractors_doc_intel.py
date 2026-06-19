"""Azure Document Intelligence extractor.

A pluggable, opt-in extractor that delegates PDF / image / Office
parsing to Azure Document Intelligence (the service formerly known as
Form Recognizer). Activated via :func:`extractors.configure_registry`
when the operator sets ``LLMWIKI_DOC_INTEL_ENDPOINT``.

Why this exists
---------------
* ``pypdf`` is a faithful but quality-limited extractor for plain PDFs;
  it loses tables, multi-column layouts, and reading order on complex
  documents, and silently returns empty text on scanned PDFs.
* Document Intelligence's ``prebuilt-layout`` model returns
  *markdown directly* with headings, tables, and explicit page
  markers (``<!-- PageBreak -->``), which is exactly the shape our
  heading-aware chunker expects.
* The same model handles scanned PDFs (real OCR), images, and Office
  documents, so a single extractor covers the long tail.

Trust boundary
--------------
This extractor sends document bytes to Azure. It is **off by default**.
Enable only when:

* The operator is comfortable transmitting the corpus to their Azure
  tenant.
* The cost / latency tradeoff is acceptable (DI is a per-page priced
  API and takes several seconds per document).

Auth
----
* If ``api_key`` is configured, key-based auth is used.
* Otherwise ``azure.identity.DefaultAzureCredential`` is used, which
  picks up Managed Identity / Azure CLI / VS Code / env vars in that
  order.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .extractors import ExtractedDocument, ExtractionError


class DocIntelConfigError(RuntimeError):
    """Raised when the Doc Intelligence config is incomplete or invalid."""


@dataclass(frozen=True)
class _DocIntelClientBundle:
    client: Any
    model_id: str
    timeout_seconds: int


class AzureDocumentIntelligenceExtractor:
    """Extractor backed by ``azure-ai-documentintelligence``.

    Uses the layout model with ``output_content_format="markdown"`` so
    the response is already shaped for our chunker. Page anchors are
    parsed from the ``<!-- PageBreak -->`` and ``<!-- PageNumber=... -->``
    comments the service emits between pages.
    """

    name = "azure.documentintelligence"

    def __init__(self, bundle: _DocIntelClientBundle) -> None:
        self._bundle = bundle

    # -- construction ---------------------------------------------------
    @classmethod
    def from_config(cls, doc_intel) -> "AzureDocumentIntelligenceExtractor":
        endpoint = (doc_intel.endpoint or "").strip()
        if not endpoint:
            raise DocIntelConfigError(
                "LLMWIKI_DOC_INTEL_ENDPOINT must be set when Document "
                "Intelligence is enabled."
            )
        try:
            from azure.ai.documentintelligence import (  # type: ignore
                DocumentIntelligenceClient,
            )
            from azure.core.credentials import AzureKeyCredential  # type: ignore
        except ImportError as exc:
            raise DocIntelConfigError(
                "Install `azure-ai-documentintelligence>=1.0.0` to enable "
                "the Document Intelligence extractor."
            ) from exc

        if doc_intel.api_key:
            credential: Any = AzureKeyCredential(doc_intel.api_key)
        else:
            try:
                from azure.identity import DefaultAzureCredential  # type: ignore
            except ImportError as exc:
                raise DocIntelConfigError(
                    "Install `azure-identity` to use Entra-based auth, or "
                    "set LLMWIKI_DOC_INTEL_API_KEY."
                ) from exc
            credential = DefaultAzureCredential()

        client = DocumentIntelligenceClient(
            endpoint=endpoint, credential=credential
        )
        return cls(
            _DocIntelClientBundle(
                client=client,
                model_id=doc_intel.model or "prebuilt-layout",
                timeout_seconds=doc_intel.timeout_seconds or 300,
            )
        )

    # -- Extractor protocol --------------------------------------------
    def supports(self, doc_type: str) -> bool:
        return doc_type in {"pdf", "image", "docx", "xlsx", "pptx", "html"}

    def extract(self, path: Path, *, doc_type: str) -> ExtractedDocument:
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise ExtractionError(f"Could not read {path}: {exc}") from exc

        try:
            poller = self._begin_analyze(data)
            result = poller.result(timeout=self._bundle.timeout_seconds)
        except Exception as exc:  # SDK raises HttpResponseError / ServiceRequestError
            raise ExtractionError(
                f"Azure Document Intelligence failed for {path.name}: "
                f"{exc.__class__.__name__}: {exc}"
            ) from exc

        markdown = _extract_content(result)
        if not markdown.strip():
            raise ExtractionError(
                f"Document Intelligence returned no content for {path.name}."
            )

        page_count = _page_count(result)
        line_page_anchors = _line_page_anchors(markdown)
        title = _derive_title(markdown, path.stem)

        return ExtractedDocument(
            title=title,
            doc_type=doc_type,
            markdown=markdown,
            page_count=page_count,
            line_page_anchors=line_page_anchors,
            extractor=f"{self.name}:{self._bundle.model_id}",
        )

    # -- internals ------------------------------------------------------
    def _begin_analyze(self, data: bytes):
        """Begin analysis using a dict body so the SDK's typed models are
        only required at client-construction time, not on every call."""
        kwargs: dict[str, Any] = {
            "model_id": self._bundle.model_id,
            "output_content_format": "markdown",
        }
        try:
            return self._bundle.client.begin_analyze_document(
                analyze_request={"base64Source": _b64(data)}, **kwargs
            )
        except TypeError:
            return self._bundle.client.begin_analyze_document(
                body=data,
                content_type="application/octet-stream",
                **kwargs,
            )


# ---------------------------------------------------------------------------
# Result helpers (pulled out so they're unit-testable without the SDK)
# ---------------------------------------------------------------------------
_PAGE_MARKER_RE = re.compile(
    r"<!--\s*PageBreak\s*-->|<!--\s*PageNumber\s*=\s*\"?(\d+)\"?\s*-->",
    re.IGNORECASE,
)


def _extract_content(result: Any) -> str:
    content = getattr(result, "content", None)
    if isinstance(content, str):
        return content
    # Some SDK versions wrap content under .analyze_result.content.
    analyze_result = getattr(result, "analyze_result", None)
    if analyze_result is not None:
        nested = getattr(analyze_result, "content", None)
        if isinstance(nested, str):
            return nested
    return ""


def _page_count(result: Any) -> int | None:
    pages = getattr(result, "pages", None)
    if pages is None:
        analyze_result = getattr(result, "analyze_result", None)
        if analyze_result is not None:
            pages = getattr(analyze_result, "pages", None)
    if pages is None:
        return None
    try:
        return len(pages)
    except TypeError:
        return None


def _line_page_anchors(markdown: str) -> dict[int, int]:
    """Parse DI's inline page markers into line_index -> page_number.

    DI emits ``<!-- PageBreak -->`` and ``<!-- PageNumber="N" -->``
    comments between pages when ``output_content_format=markdown``. We
    record the first content line that follows each marker.
    """
    anchors: dict[int, int] = {}
    current_page = 1
    saw_first_page = False
    for idx, line in enumerate(markdown.splitlines()):
        for match in _PAGE_MARKER_RE.finditer(line):
            number = match.group(1)
            if number:
                try:
                    current_page = int(number)
                except ValueError:
                    current_page += 1
            else:
                current_page += 1
            # Anchor the *next* content line, not the marker line itself.
            anchors[idx + 1] = current_page
        if line.strip() and not saw_first_page:
            anchors.setdefault(idx, 1)
            saw_first_page = True
    if not anchors:
        anchors[0] = 1
    return anchors


def _derive_title(markdown: str, fallback: str) -> str:
    for line in markdown.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("<!--"):
            continue
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip() or fallback
        return stripped[:200]
    return fallback


def _b64(data: bytes) -> str:
    import base64

    return base64.b64encode(data).decode("ascii")
