"""End-to-end ingestion orchestration.

Pipeline per source file:

1. Detect doc type. Skip unknown suffixes.
2. Hash source bytes; if the document already exists and the hash is
   unchanged, no-op (idempotent re-runs).
3. Run the extractor → canonical markdown (persisted to ``data/parsed``).
4. Split the markdown into sections.
5. Run rule-based ontology extraction.
6. Replace the document and all derived rows atomically.
7. Append an entry to ``ingest_log`` (success or error).

The collection a document belongs to is inferred from the first
sub-directory under ``data/corpus/`` (e.g.
``data/corpus/style-guide/...`` -> ``style-guide``). Files dropped
directly into ``data/corpus/`` belong to ``default_collection``.
"""

from __future__ import annotations

import hashlib
import time
import traceback
import uuid
from dataclasses import dataclass
from pathlib import Path

from .chunking import split_into_sections
from .config import LLMWikiConfig
from .extractors import (
    SUPPORTED_SUFFIXES,
    ExtractedDocument,
    ExtractionError,
    configure_registry,
    detect_doc_type,
    extract,
)
from .models import Document, IngestLogEntry
from .ontology import extract_ontology
from .storage import Storage


@dataclass
class IngestResult:
    source_path: str
    status: str
    message: str | None = None


class IngestService:
    def __init__(
        self, config: LLMWikiConfig, storage: Storage
    ) -> None:
        self._config = config
        self._storage = storage
        # Re-bind the extractor registry to whatever the operator opted into
        # (Azure Document Intelligence, fallbacks, image / Office support).
        # This must run before any scan so SUPPORTED_SUFFIXES reflects the
        # current configuration.
        configure_registry(config)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    # Files in data/wiki/ that the agent uses for navigation rather than
    # content. They're exposed through `wiki://schema|index|log` resources
    # instead so search results stay focused on substantive pages.
    _WIKI_CANONICAL_NAMES = {
        "AGENTS.md",
        "CLAUDE.md",
        "index.md",
        "log.md",
        "README.md",
    }

    def scan_all(self) -> list[IngestResult]:
        """Scan both the raw-corpus and LLM-wiki roots."""
        results: list[IngestResult] = []
        results.extend(self._scan_root(self._config.corpus_dir, flavor="raw"))
        results.extend(self._scan_root(self._config.wiki_dir, flavor="wiki"))
        self._prune_deleted(results)
        return results

    # Back-compat alias for callers / tests that still know the old name.
    def scan_corpus(self) -> list[IngestResult]:
        return self.scan_all()

    def _scan_root(self, root: Path, *, flavor: str) -> list[IngestResult]:
        results: list[IngestResult] = []
        if not root.exists():
            return results
        for path in sorted(root.rglob("*")):
            if path.is_dir():
                continue
            if path.suffix.lower() not in SUPPORTED_SUFFIXES:
                continue
            if flavor == "wiki" and path.name in self._WIKI_CANONICAL_NAMES:
                continue
            results.append(self.ingest_file(path, flavor=flavor))
        return results

    def ingest_file(
        self, path: Path, *, flavor: str | None = None
    ) -> IngestResult:
        if flavor is None:
            flavor = self._infer_flavor(path)
        source_path_str = str(path.resolve())
        started_at = int(time.time())
        try:
            doc_type = detect_doc_type(path)
            if doc_type is None:
                msg = f"Unsupported file type: {path.suffix}"
                self._storage.record_ingest_event(
                    source_path=source_path_str,
                    status="skipped",
                    message=msg,
                    started_at=started_at,
                    finished_at=int(time.time()),
                )
                return IngestResult(source_path_str, "skipped", msg)

            content_hash = _sha256_file(path)
            existing = self._storage.get_document_by_source_path(
                source_path_str
            )
            if existing and existing.content_hash == content_hash:
                return IngestResult(source_path_str, "unchanged")

            self._storage.record_ingest_event(
                source_path=source_path_str,
                status="parsing",
                started_at=started_at,
            )

            try:
                extracted = extract(path)
            except ExtractionError as exc:
                msg = str(exc)
                self._storage.record_ingest_event(
                    source_path=source_path_str,
                    status="skipped",
                    message=msg,
                    started_at=started_at,
                    finished_at=int(time.time()),
                )
                return IngestResult(source_path_str, "skipped", msg)

            collection_id = self._infer_collection(path, flavor=flavor)
            self._storage.upsert_collection(
                id=collection_id, name=collection_id
            )

            parsed_path = self._persist_parsed_markdown(
                source_path=path,
                extracted=extracted,
                content_hash=content_hash,
                flavor=flavor,
            )

            document = Document(
                id=str(uuid.uuid4()),
                collection_id=collection_id,
                source_path=source_path_str,
                title=extracted.title or path.stem,
                doc_type=extracted.doc_type,
                content_hash=content_hash,
                parsed_path=str(parsed_path),
                size_bytes=path.stat().st_size,
                page_count=extracted.page_count,
                source_mtime=int(path.stat().st_mtime),
                ingested_at=int(time.time()),
                flavor=flavor,
                metadata={
                    "filename": path.name,
                    "relative_path": self._relative_to_root(path, flavor),
                    "extractor": extracted.extractor or "unknown",
                },
            )

            sections = split_into_sections(
                document_id=document.id,
                markdown=extracted.markdown,
                line_page_anchors=extracted.line_page_anchors,
                max_section_chars=self._config.max_section_chars,
            )
            concepts, links, section_pairs = extract_ontology(
                collection_id=collection_id, sections=sections
            )

            self._storage.replace_document(
                document=document,
                sections=sections,
                concepts=concepts,
                concept_links=links,
                section_concept_ids=section_pairs,
            )

            finished_at = int(time.time())
            self._storage.record_ingest_event(
                source_path=source_path_str,
                status="indexed",
                message=(
                    f"{len(sections)} sections, "
                    f"{len(concepts)} concepts"
                ),
                started_at=started_at,
                finished_at=finished_at,
            )
            return IngestResult(source_path_str, "indexed")

        except Exception as exc:  # pragma: no cover - defensive
            self._storage.record_ingest_event(
                source_path=source_path_str,
                status="error",
                message=f"{exc.__class__.__name__}: {exc}",
                started_at=started_at,
                finished_at=int(time.time()),
            )
            traceback.print_exc()
            return IngestResult(source_path_str, "error", str(exc))

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _infer_flavor(self, path: Path) -> str:
        resolved = path.resolve()
        try:
            resolved.relative_to(self._config.wiki_dir.resolve())
            return "wiki"
        except ValueError:
            return "raw"

    def _infer_collection(self, path: Path, *, flavor: str) -> str:
        if flavor == "wiki":
            return self._config.wiki_collection
        try:
            relative = path.resolve().relative_to(
                self._config.corpus_dir.resolve()
            )
        except ValueError:
            return self._config.default_collection
        if len(relative.parts) <= 1:
            return self._config.default_collection
        slug = relative.parts[0].strip().lower().replace(" ", "-")
        return slug or self._config.default_collection

    def _relative_to_root(self, path: Path, flavor: str) -> str:
        root = (
            self._config.wiki_dir if flavor == "wiki" else self._config.corpus_dir
        )
        try:
            return str(path.resolve().relative_to(root.resolve()))
        except ValueError:
            return path.name

    def _persist_parsed_markdown(
        self,
        *,
        source_path: Path,
        extracted: ExtractedDocument,
        content_hash: str,
        flavor: str = "raw",
    ) -> Path:
        root = (
            self._config.wiki_dir if flavor == "wiki" else self._config.corpus_dir
        )
        flavor_subdir = self._config.parsed_dir / flavor
        try:
            relative = source_path.resolve().relative_to(root.resolve())
            target = flavor_subdir / relative.with_suffix(".md")
        except ValueError:
            target = flavor_subdir / f"{source_path.stem}-{content_hash[:8]}.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(extracted.markdown, encoding="utf-8")
        return target

    def _prune_deleted(
        self, scan_results: list[IngestResult]
    ) -> None:
        scanned_paths = {r.source_path for r in scan_results}
        for document in self._storage.list_documents(limit=10000):
            if document.source_path not in scanned_paths and not Path(
                document.source_path
            ).exists():
                self._delete_parsed_artifact(document.parsed_path)
                self._storage.delete_document_by_source_path(
                    document.source_path
                )
                self._storage.record_ingest_event(
                    source_path=document.source_path,
                    status="deleted",
                    message="Source file no longer present in corpus.",
                    started_at=int(time.time()),
                    finished_at=int(time.time()),
                )

    def _delete_parsed_artifact(self, parsed_path: str | None) -> None:
        if not parsed_path:
            return
        path = Path(parsed_path)
        try:
            resolved = path.resolve()
            resolved.relative_to(self._config.parsed_dir.resolve())
        except (OSError, ValueError):
            return
        if resolved.is_file():
            try:
                resolved.unlink()
            except OSError:
                return

    # ------------------------------------------------------------------
    # Status helpers (used by tools)
    # ------------------------------------------------------------------
    def recent_log(self, limit: int = 50) -> list[IngestLogEntry]:
        return self._storage.recent_ingest_log(limit=limit)


def _sha256_file(path: Path, *, chunk_size: int = 65536) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()
