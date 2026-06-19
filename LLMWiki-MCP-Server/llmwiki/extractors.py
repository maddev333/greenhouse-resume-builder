"""Source-document extractors and the registry that selects between them.

Each extractor returns canonical markdown plus structural metadata
(page anchors, page count) so the downstream chunker can produce
well-cited sections.

The registry is the seam that lets us swap PDF / image / Office
backends without touching ``ingest.py``. The default registry is
pure-Python and uses only the standard library + ``pypdf`` for PDFs.
Calling :func:`configure_registry` at startup (done automatically by
``IngestService.__init__``) rewires the chain based on the runtime
config — most notably to register the Azure Document Intelligence
extractor for PDFs / images / Office docs when the operator opts in.

Extractor ordering is a fallback chain: the first extractor for a
doc_type that returns successfully wins; an :class:`ExtractionError`
lets the registry try the next one. That's how an Azure DI → pypdf
fallback is implemented when the operator sets
``LLMWIKI_DOC_INTEL_FALLBACK=true``.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable, Mapping, Protocol, Sequence

try:  # Optional. PDFs are skipped with a clear ingest_log message if missing.
    import pypdf  # type: ignore

    HAS_PYPDF = True
except Exception:  # pragma: no cover - optional dep
    HAS_PYPDF = False


@dataclass
class ExtractedDocument:
    """Result of running an extractor against a source file."""

    title: str
    doc_type: str  # 'pdf' | 'md' | 'txt' | 'html' | 'image' | 'docx' | 'xlsx' | 'pptx'
    markdown: str
    page_count: int | None = None
    # Optional page anchors: line index -> 1-based page number. Populated by
    # extractors that know about pages (pypdf, Azure DI). The chunker reads
    # them when present and falls back gracefully otherwise.
    line_page_anchors: dict[int, int] = field(default_factory=dict)
    # Free-form extractor metadata (extractor name, model id, etc.) so
    # operators can audit which backend produced which document.
    extractor: str | None = None


class ExtractionError(RuntimeError):
    """Raised when an extractor cannot produce usable text."""


# ---------------------------------------------------------------------------
# Extractor Protocol + Registry
# ---------------------------------------------------------------------------
class Extractor(Protocol):
    name: str

    def supports(self, doc_type: str) -> bool: ...

    def extract(self, path: Path, *, doc_type: str) -> ExtractedDocument: ...


class ExtractorRegistry:
    """Ordered registry of extractors keyed by canonical doc_type."""

    def __init__(self) -> None:
        # doc_type -> list of extractors, first one tried first.
        self._by_doc_type: dict[str, list[Extractor]] = {}
        # suffix -> doc_type. First suffix wins; later registrations only
        # add new suffixes, they never reassign existing ones.
        self._suffix_to_doc_type: dict[str, str] = {}

    def register(
        self,
        extractor: Extractor,
        *,
        doc_types: Sequence[str],
        suffixes: Mapping[str, str] | None = None,
        prepend: bool = False,
    ) -> None:
        for doc_type in doc_types:
            bucket = self._by_doc_type.setdefault(doc_type, [])
            if extractor in bucket:
                continue
            if prepend:
                bucket.insert(0, extractor)
            else:
                bucket.append(extractor)
        if suffixes:
            for suffix, doc_type in suffixes.items():
                self._suffix_to_doc_type.setdefault(suffix.lower(), doc_type)

    def clear(self) -> None:
        self._by_doc_type.clear()
        self._suffix_to_doc_type.clear()

    def detect_doc_type(self, path: Path) -> str | None:
        return self._suffix_to_doc_type.get(path.suffix.lower())

    @property
    def supported_suffixes(self) -> set[str]:
        return set(self._suffix_to_doc_type.keys())

    def extractors_for(self, doc_type: str) -> list[Extractor]:
        return list(self._by_doc_type.get(doc_type, ()))

    def extract(self, path: Path) -> ExtractedDocument:
        doc_type = self.detect_doc_type(path)
        if doc_type is None:
            raise ExtractionError(f"Unsupported file type: {path.suffix}")
        candidates = self._by_doc_type.get(doc_type, [])
        if not candidates:
            raise ExtractionError(
                f"No extractor registered for doc_type={doc_type!r}. "
                "If this is a PDF / image / Office file, enable Azure "
                "Document Intelligence via LLMWIKI_DOC_INTEL_ENDPOINT."
            )
        last_error: Exception | None = None
        for extractor in candidates:
            try:
                doc = extractor.extract(path, doc_type=doc_type)
                if doc.extractor is None:
                    doc.extractor = extractor.name
                return doc
            except ExtractionError as exc:
                last_error = exc
                continue
        raise last_error or ExtractionError(
            f"All extractors failed for {path.name}."
        )


_REGISTRY = ExtractorRegistry()


def get_registry() -> ExtractorRegistry:
    return _REGISTRY


# Module-level public API kept stable for callers that imported these
# names directly (ingest.py, scripts). ``SUPPORTED_SUFFIXES`` is mutated
# in place by :func:`configure_registry` so existing imports keep working.
SUPPORTED_SUFFIXES: set[str] = set()


def extract(path: Path) -> ExtractedDocument:
    return _REGISTRY.extract(path)


def detect_doc_type(path: Path) -> str | None:
    return _REGISTRY.detect_doc_type(path)


# ---------------------------------------------------------------------------
# Builtin extractors
# ---------------------------------------------------------------------------
class _TextExtractor:
    name = "builtin.text"

    def supports(self, doc_type: str) -> bool:
        return doc_type in {"md", "txt"}

    def extract(self, path: Path, *, doc_type: str) -> ExtractedDocument:
        raw = _read_text_file(path)
        title = _derive_title_from_text(raw, path.stem)
        return ExtractedDocument(title=title, doc_type=doc_type, markdown=raw)


class _HtmlExtractor:
    name = "builtin.html"

    def supports(self, doc_type: str) -> bool:
        return doc_type == "html"

    def extract(self, path: Path, *, doc_type: str) -> ExtractedDocument:
        raw = _read_text_file(path)
        parser = _MarkdownExtractor()
        parser.feed(raw)
        parser.close()
        title = parser.title or _derive_title_from_text(
            parser.markdown, path.stem
        )
        return ExtractedDocument(
            title=title, doc_type="html", markdown=parser.markdown
        )


class _PyPdfExtractor:
    name = "builtin.pypdf"

    def supports(self, doc_type: str) -> bool:
        return doc_type == "pdf"

    def extract(self, path: Path, *, doc_type: str) -> ExtractedDocument:
        if not HAS_PYPDF:
            raise ExtractionError(
                "PDF support requires pypdf. Install with "
                "`pip install pypdf>=4.0.0`, or enable Azure Document "
                "Intelligence via LLMWIKI_DOC_INTEL_ENDPOINT."
            )
        reader = pypdf.PdfReader(str(path))
        md_parts: list[str] = []
        line_page_anchors: dict[int, int] = {}
        title = path.stem
        meta_title = None
        try:
            meta = reader.metadata or {}
            meta_title = getattr(meta, "title", None) or meta.get("/Title")
        except Exception:
            meta_title = None
        if meta_title:
            title = str(meta_title).strip() or title

        current_line = 0
        for page_index, page in enumerate(reader.pages, start=1):
            try:
                text = page.extract_text() or ""
            except Exception:
                text = ""
            if text:
                line_page_anchors[current_line] = page_index
                md_parts.append(text.strip() + "\n\n")
                current_line += text.count("\n") + 2
        markdown = "".join(md_parts).strip()
        if not markdown:
            raise ExtractionError(
                "pypdf returned no extractable text — this PDF is likely "
                "an image scan. Enable Azure Document Intelligence "
                "(LLMWIKI_DOC_INTEL_ENDPOINT) or run OCR before placing "
                "it in data/corpus/."
            )
        return ExtractedDocument(
            title=title,
            doc_type="pdf",
            markdown=markdown,
            page_count=len(reader.pages),
            line_page_anchors=line_page_anchors,
        )


# ---------------------------------------------------------------------------
# Registry bootstrap
# ---------------------------------------------------------------------------
_BUILTIN_SUFFIXES = {
    ".md": "md",
    ".markdown": "md",
    ".txt": "txt",
    ".html": "html",
    ".htm": "html",
    ".pdf": "pdf",
}

# Suffix groups that DI can handle. Operators select which doc_types via
# ``LLMWIKI_DOC_INTEL_FOR``; suffixes are derived from that.
_DOC_INTEL_SUFFIXES: dict[str, tuple[str, ...]] = {
    "pdf": (".pdf",),
    "image": (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".heif"),
    "docx": (".docx",),
    "xlsx": (".xlsx",),
    "pptx": (".pptx",),
    "html": (".html", ".htm"),
}


def _install_builtins(registry: ExtractorRegistry) -> None:
    text = _TextExtractor()
    html_ext = _HtmlExtractor()
    pdf = _PyPdfExtractor()
    registry.register(
        text,
        doc_types=("md", "txt"),
        suffixes={k: v for k, v in _BUILTIN_SUFFIXES.items() if v in {"md", "txt"}},
    )
    registry.register(
        html_ext,
        doc_types=("html",),
        suffixes={k: v for k, v in _BUILTIN_SUFFIXES.items() if v == "html"},
    )
    registry.register(
        pdf,
        doc_types=("pdf",),
        suffixes={k: v for k, v in _BUILTIN_SUFFIXES.items() if v == "pdf"},
    )


def _sync_supported_suffixes(registry: ExtractorRegistry) -> None:
    SUPPORTED_SUFFIXES.clear()
    SUPPORTED_SUFFIXES.update(registry.supported_suffixes)


def configure_registry(config: "object | None" = None) -> ExtractorRegistry:
    """Rebuild the global registry from runtime config.

    Idempotent: safe to call multiple times. Pass ``None`` to install
    only the builtins (useful for tests).
    """
    _REGISTRY.clear()
    _install_builtins(_REGISTRY)
    if config is not None:
        _maybe_install_doc_intel(_REGISTRY, config)
    _sync_supported_suffixes(_REGISTRY)
    return _REGISTRY


def _maybe_install_doc_intel(
    registry: ExtractorRegistry, config: "object"
) -> None:
    doc_intel = getattr(config, "doc_intel", None)
    if doc_intel is None or not getattr(doc_intel, "enabled", False):
        return
    try:
        from .extractors_doc_intel import (
            AzureDocumentIntelligenceExtractor,
            DocIntelConfigError,
        )
    except ImportError as exc:  # pragma: no cover - optional dep
        raise ExtractionError(
            "Azure Document Intelligence support requires "
            "`pip install azure-ai-documentintelligence azure-identity`."
        ) from exc

    try:
        extractor = AzureDocumentIntelligenceExtractor.from_config(doc_intel)
    except DocIntelConfigError as exc:
        raise ExtractionError(str(exc)) from exc

    doc_types: Iterable[str] = doc_intel.for_doc_types
    suffix_map: dict[str, str] = {}
    for doc_type in doc_types:
        for suffix in _DOC_INTEL_SUFFIXES.get(doc_type, ()):
            suffix_map[suffix] = doc_type
    # If fallback is disabled, evict the pypdf extractor for 'pdf' so
    # silent quality regressions can't sneak in.
    if "pdf" in doc_types and not doc_intel.fallback_to_pypdf:
        registry._by_doc_type.pop("pdf", None)  # noqa: SLF001 (internal API)
    registry.register(
        extractor,
        doc_types=tuple(doc_types),
        suffixes=suffix_map,
        prepend=True,
    )


# ---------------------------------------------------------------------------
# Text / HTML helpers (shared by builtins)
# ---------------------------------------------------------------------------
def _read_text_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1", errors="replace")


def _derive_title_from_text(raw: str, fallback: str) -> str:
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip() or fallback
        return stripped[:200]
    return fallback


_BLOCK_TAGS = {
    "p", "div", "section", "article", "header", "footer", "main",
    "li", "blockquote", "pre", "table", "tr", "td", "th",
    "h1", "h2", "h3", "h4", "h5", "h6",
}
_HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
_SKIP_TAGS = {"script", "style", "noscript", "svg", "iframe", "object"}


class _MarkdownExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._chunks: list[str] = []
        self._skip_depth = 0
        self._heading_level = 0
        self._in_list = 0
        self._title: str | None = None
        self._in_title_tag = False

    def handle_starttag(self, tag: str, attrs):  # type: ignore[override]
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
            return
        if tag == "title":
            self._in_title_tag = True
            return
        if tag in _HEADING_TAGS:
            self._heading_level = int(tag[1])
            self._chunks.append("\n\n" + "#" * self._heading_level + " ")
            return
        if tag in {"ul", "ol"}:
            self._in_list += 1
            self._chunks.append("\n")
            return
        if tag == "li":
            self._chunks.append("\n- ")
            return
        if tag == "br":
            self._chunks.append("\n")
            return
        if tag in _BLOCK_TAGS:
            self._chunks.append("\n\n")

    def handle_endtag(self, tag: str) -> None:  # type: ignore[override]
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if tag == "title":
            self._in_title_tag = False
            return
        if tag in _HEADING_TAGS:
            self._heading_level = 0
            self._chunks.append("\n")
            return
        if tag in {"ul", "ol"}:
            self._in_list = max(0, self._in_list - 1)
            self._chunks.append("\n")
            return
        if tag in _BLOCK_TAGS:
            self._chunks.append("\n")

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if self._skip_depth > 0:
            return
        if self._in_title_tag:
            self._title = (self._title or "") + data
            return
        self._chunks.append(data)

    @property
    def title(self) -> str | None:
        return self._title.strip() if self._title else None

    @property
    def markdown(self) -> str:
        text = html.unescape("".join(self._chunks))
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


# Install builtins eagerly so callers that bypass configure_registry()
# (e.g. tests that import extract() directly) still see the default
# chain wired up.
_install_builtins(_REGISTRY)
_sync_supported_suffixes(_REGISTRY)
