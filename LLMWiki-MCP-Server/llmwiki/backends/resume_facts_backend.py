"""Read-only LLMWiki backend over the greenhouse ``resume-facts`` index.

This adapter lets MCP clients browse and search the ``resume-facts`` Azure AI
Search index -- populated by the *greenhouse-resume-builder* pipeline -- through
the **standard LLMWiki tool surface**, WITHOUT creating any new indexes. It is a
thin abstraction layer: every public method returns the same dataclasses as the
SQLite/wiki backends (see ``models.py``) so the tool layer (``dataclasses.asdict``
+ attribute access) works unchanged.

Mapping (``resume-facts`` -> LLMWiki wiki model)::

    Person (personId)          -> Document   (title = profile.name fact)
    resume sectionId           -> Collection (profile/experience/skills/...)
    each fact OR bullet doc     -> Section    (heading=factKey|"bullet",
                                               body=factValue|bulletText)

Security parity with greenhouse ``api/src/search/index.ts``:

* **Tenant-scoped, fail-closed.** ``tenant_id`` must be configured; callers
  without a verified tenant are blocked. Every returned record is trimmed to the
  configured tenant, so one tenant can never read another's facts.
* **Sensitive-attribute redaction.** Facts whose ``factKey`` is temporal
  (``event.*``) or precise-location (``*.location``) are REDACTED by default,
  mirroring greenhouse's privileged ``FACTS_SENSITIVE_READ_ROLES`` /
  ``Facts.ReadSensitive`` gate. Opt in with ``allow_sensitive=True``.

**Why trimming is client-side.** The live ``resume-facts`` index marks *no*
fields ``filterable`` (greenhouse's index definition only sets ``searchable`` on
``factValue``/``bulletText``), so server-side OData ``$filter`` is rejected by the
service. This adapter therefore fetches by relevance / key and applies tenant,
section, person and sensitivity predicates in Python. This is *secure* (no
cross-tenant leakage -- non-matching docs are dropped) but, for very large
multi-tenant corpora, recall would improve if greenhouse marked ``tenantId`` /
``personId`` / ``sectionId`` / ``factKey`` ``filterable: true`` so the filters can
be pushed down. See README ("Limits & scaling").

Read-only: the greenhouse pipeline owns all writes, so the write methods raise
:class:`NotImplementedError` (and the factory does not start the corpus watcher
for this backend).
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any, Iterable

from .._logging import get_logger
from ..models import (
    Collection,
    Concept,
    Document,
    IngestLogEntry,
    SearchHit,
    Section,
)
from .base import WikiStorage

logger = get_logger("llmwiki.resume_facts")

# Azure SDK -- imported lazily so local/dev (SQLite mode) needs no install.
try:
    from azure.core.exceptions import HttpResponseError, ResourceNotFoundError
    from azure.search.documents import SearchClient

    _azure_available = True
except ImportError:  # pragma: no cover - exercised only without the SDK
    HttpResponseError = Exception  # type: ignore[assignment,misc]
    ResourceNotFoundError = Exception  # type: ignore[assignment,misc]
    _azure_available = False


_RESUME_FACTS_INDEX_DEFAULT = "resume-facts"
_SEMANTIC_CONFIG_DEFAULT = "semantic-config"
# Cap for the "*" overview scans that aggregate persons/sections in-memory. The
# live index holds a few hundred docs; raise this (or mark fields filterable in
# greenhouse for server-side pushdown) if the corpus grows much larger.
_SCAN_CAP = 2000
# Logical document/section model constants.
_DOC_TYPE = "resume"
_FLAVOR = "raw"  # resume facts are immutable source content
_WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+#/-]*")


def _is_sensitive_fact_key(fact_key: str | None) -> bool:
    """Mirror greenhouse ``isSensitiveFactKey``: temporal or precise-location.

    Sensitive = ``factKey`` begins with ``event.`` (temporal) or ends with
    ``.location`` (precise geo). Bullets (no ``factKey``) are never sensitive.
    """
    if not fact_key:
        return False
    key = fact_key.strip().lower()
    return key.startswith("event.") or key.endswith(".location")


def _query_text_from_match(match_expr: str) -> str:
    """Reduce an FTS5 ``MATCH`` expression to a plain Azure-Search query.

    ``retrieval.build_match_expression`` emits SQLite FTS5 syntax (quotes,
    ``*`` prefixes, ``OR``, parentheses) that is not valid Azure Search query
    syntax. We extract the distinct word tokens (order-preserving, dropping the
    ``OR`` connector) and join them with spaces so the simple/semantic query
    parser receives clean terms.
    """
    tokens: list[str] = []
    seen: set[str] = set()
    for match in _WORD_RE.finditer(match_expr or ""):
        tok = match.group(0)
        low = tok.lower()
        if low == "or":  # FTS connector, not a search term
            continue
        if low in seen:
            continue
        seen.add(low)
        tokens.append(tok)
    return " ".join(tokens)


def _epoch(value: Any) -> int:
    """Best-effort convert an Azure ``DateTimeOffset`` to epoch seconds."""
    if value is None or value == "":
        return 0
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        raw = value.strip()
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(raw)
        except ValueError:
            return 0
    else:
        return 0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    try:
        return int(dt.timestamp())
    except (OverflowError, OSError, ValueError):
        return 0


def _section_ids(hit: dict) -> list[str]:
    """Normalize the ``sectionId`` collection field into a list of strings."""
    raw = hit.get("sectionId")
    if raw is None:
        return []
    if isinstance(raw, str):
        return [raw] if raw else []
    if isinstance(raw, (list, tuple)):
        return [str(s) for s in raw if s]
    return [str(raw)]


class WikiResumeFactsBackend(WikiStorage):
    """Read-only :class:`WikiStorage` over the greenhouse ``resume-facts`` index.

    Tenant-scoped and fail-closed when no tenant identity is configured; redacts
    sensitive facts by default. Never writes.
    """

    #: Tells the factory to skip ingest/provisioning (greenhouse owns writes).
    read_only = True

    def __init__(
        self,
        service_url: str | None = None,
        credential: Any = None,
        tenant_id: str | None = None,
        *,
        facts_index: str | None = None,
        semantic_config: str | None = None,
        allow_sensitive: bool | None = None,
    ) -> None:
        if not _azure_available:
            raise ImportError(
                "azure-search-documents is required for the resume-facts backend.\n"
                "pip install azure-search-documents azure-identity "
                "or set LLMWIKI_STORAGE_MODE=sqlite."
            )
        self.service_url = (
            (service_url or "").strip()
            or (os.environ.get("AZURE_SEARCH_SERVICE_URL") or "").strip()
            or (os.environ.get("LLMWIKI_AZURE_SEARCH_SERVICE_URL") or "").strip()
        )
        # Data-isolation tenant -- NOT the Entra auth tenant (AZURE_TENANT_ID).
        self.tenant_id = (
            (tenant_id or os.environ.get("LLMWIKI_AZURE_SEARCH_TENANT_ID", "")).strip()
            or None
        )
        self.facts_index = (
            (facts_index or "").strip()
            or (os.environ.get("LLMWIKI_AZURE_SEARCH_FACTS_INDEX") or "").strip()
            or _RESUME_FACTS_INDEX_DEFAULT
        )
        self.semantic_config = (
            (semantic_config or "").strip()
            or (os.environ.get("LLMWIKI_AZURE_SEARCH_FACTS_SEMANTIC_CONFIG") or "").strip()
            or _SEMANTIC_CONFIG_DEFAULT
        )
        if allow_sensitive is None:
            allow_sensitive = (
                (os.environ.get("LLMWIKI_FACTS_ALLOW_SENSITIVE", "") or "")
                .strip()
                .lower()
                in {"1", "true", "yes", "on"}
            )
        self.allow_sensitive = bool(allow_sensitive)

        self._credential = credential
        self._client: "SearchClient | None" = None
        self._name_cache: dict[str, str] = {}
        self._names_loaded = False

        logger.info(
            "resume-facts backend configured: service_url=%s index=%s semantic_config=%s "
            "tenant_id=%r allow_sensitive=%s",
            self.service_url or "(unset)",
            self.facts_index,
            self.semantic_config,
            self.tenant_id,
            self.allow_sensitive,
        )
        if not self.tenant_id:
            logger.warning(
                "no tenant configured (LLMWIKI_AZURE_SEARCH_TENANT_ID / tenant_id) -- "
                "all queries will FAIL CLOSED until a tenant is set."
            )

    # -- credential / client --------------------------------------------------

    def _resolve_credential(self) -> Any:
        if self._credential is not None:
            return self._credential
        api_key = (
            os.environ.get("AZURE_SEARCH_API_KEY")
            or os.environ.get("LLMWIKI_AZURE_SEARCH_API_KEY")
        )
        if api_key:
            from azure.core.credentials import AzureKeyCredential

            self._credential = AzureKeyCredential(api_key)
            logger.info("auth: using AzureKeyCredential (API key from env)")
        else:
            from azure.identity import DefaultAzureCredential

            self._credential = DefaultAzureCredential()
            logger.info(
                "auth: using DefaultAzureCredential (Managed Identity / az login / env)"
            )
        return self._credential

    def _require_service_url(self) -> str:
        if not self.service_url:
            raise RuntimeError(
                "AZURE_SEARCH_SERVICE_URL (or LLMWIKI_AZURE_SEARCH_SERVICE_URL) "
                "must be set to use the resume-facts backend."
            )
        return self.service_url

    def _client_(self) -> "SearchClient":
        if self._client is None:
            endpoint = self._require_service_url()
            credential = self._resolve_credential()
            logger.info(
                "connecting to Azure AI Search: endpoint=%s index=%s credential=%s",
                endpoint,
                self.facts_index,
                type(credential).__name__,
            )
            self._client = SearchClient(
                endpoint,
                self.facts_index,
                credential=credential,
            )
        return self._client

    # -- tenant guard ---------------------------------------------------------

    @property
    def _tenant_verified(self) -> bool:
        return bool(self.tenant_id)

    def _require_tenant(self) -> None:
        if not self._tenant_verified:
            raise RuntimeError(
                "LLMWIKI_AZURE_SEARCH_TENANT_ID (or the tenant_id argument) is "
                "required. Unverified callers cannot query without tenant isolation."
            )

    def _matches_tenant(self, hit: dict) -> bool:
        """Client-side tenant trim (the index has no filterable ``tenantId``)."""
        return (hit.get("tenantId") or "") == self.tenant_id

    # -- query plumbing (no server-side $filter: index has none filterable) ---

    def _scan(self, *, select: list[str], top: int = _SCAN_CAP):
        """Yield tenant-matching hits for an aggregation scan.

        Selectors must include ``tenantId`` (or use ``["*"]``) so the client
        tenant trim can run. ``"*"`` returns every retrievable field.
        """
        logger.debug(
            "scan: index=%s search_text='*' top=%d select=%s", self.facts_index, top, select
        )
        raw = 0
        matched = 0
        seen_tenants: set[str] = set()
        try:
            for hit in self._client_().search(search_text="*", top=top, select=select):
                raw += 1
                tval = hit.get("tenantId")
                if tval is not None and len(seen_tenants) < 8:
                    seen_tenants.add(str(tval))
                if self._matches_tenant(hit):
                    matched += 1
                    yield hit
        finally:
            logger.debug(
                "scan done: index=%s raw=%d matched_tenant=%d (tenant=%r)",
                self.facts_index, raw, matched, self.tenant_id,
            )
            if raw > 0 and matched == 0:
                logger.warning(
                    "scan matched 0/%d docs for tenant=%r on index=%s. Data carries "
                    "tenantId(s)=%s. Set LLMWIKI_AZURE_SEARCH_TENANT_ID to one of those "
                    "(resume-facts uses 'tenant-dev').",
                    raw, self.tenant_id, self.facts_index, sorted(seen_tenants) or "<none>",
                )

    def _search(self, text: str, *, top: int) -> list[dict]:
        """Relevance search (semantic, degrading to keyword) with all fields."""
        client = self._client_()
        query = text or "*"
        try:
            results = list(
                client.search(
                    search_text=query, top=top,
                    query_type="semantic", semantic_configuration_name=self.semantic_config,
                )
            )
            logger.debug(
                "search(semantic): index=%s config=%s query=%r top=%d -> %d raw hits",
                self.facts_index, self.semantic_config, query, top, len(results),
            )
            return results
        except HttpResponseError as exc:
            logger.warning(
                "semantic search failed on index=%s (config=%s): %s -- falling back to keyword.",
                self.facts_index, self.semantic_config, exc,
            )
            results = list(client.search(search_text=query, top=top))
            logger.debug(
                "search(keyword): index=%s query=%r top=%d -> %d raw hits",
                self.facts_index, query, top, len(results),
            )
            return results

    # -- record helpers -------------------------------------------------------

    def _is_redacted(self, hit: dict) -> bool:
        """True when the hit must be hidden under the current sensitivity gate."""
        if self.allow_sensitive:
            return False
        return _is_sensitive_fact_key(hit.get("factKey"))

    @staticmethod
    def _kind(hit: dict) -> str:
        return "bullet" if hit.get("bulletText") else "fact"

    @staticmethod
    def _body(hit: dict) -> str:
        return (hit.get("factValue") or hit.get("bulletText") or "").strip()

    @staticmethod
    def _heading(hit: dict) -> str:
        fact_key = hit.get("factKey")
        if fact_key:
            return str(fact_key)
        sections = _section_ids(hit)
        return f"{sections[0]} bullet" if sections else "bullet"

    def _heading_path(self, hit: dict) -> str:
        sections = _section_ids(hit)
        sec = sections[0] if sections else ""
        fact_key = hit.get("factKey")
        if sec and fact_key:
            return f"{sec} / {fact_key}"
        return sec or (str(fact_key) if fact_key else "")

    def _sec_from_hit(self, hit: dict, ordinal: int = 0) -> Section:
        sections = _section_ids(hit)
        body = self._body(hit)
        return Section(
            id=hit.get("id", "") or "",
            document_id=hit.get("personId", "") or "",
            ordinal=ordinal,
            heading_path=self._heading_path(hit),
            heading=self._heading(hit),
            body=body,
            body_chars=len(body),
            page_anchor=None,
            metadata={
                "kind": self._kind(hit),
                "fact_key": hit.get("factKey") or None,
                "normalized_value": hit.get("normalizedValue") or None,
                "resume_sections": sections,
                "extraction_run_id": hit.get("extractionRunId") or None,
                "created_at": hit.get("createdAt") or None,
            },
        )

    # -- person-name resolution ----------------------------------------------

    def _ensure_names(self) -> None:
        """Populate the personId -> display-name cache (one tenant-scoped scan).

        Names come from the ``profile.name`` fact. Cached for the process
        lifetime; resume names are effectively immutable per ingestion.
        """
        if self._names_loaded:
            return
        try:
            for hit in self._scan(select=["personId", "factKey", "factValue", "tenantId"]):
                if hit.get("factKey") == "profile.name" and hit.get("personId"):
                    pid = hit["personId"]
                    self._name_cache.setdefault(
                        pid, (hit.get("factValue") or pid).strip() or pid
                    )
        except HttpResponseError:
            pass
        self._names_loaded = True

    def _name_of(self, person_id: str) -> str:
        if not person_id:
            return ""
        if person_id in self._name_cache:
            return self._name_cache[person_id]
        self._ensure_names()
        return self._name_cache.get(person_id, person_id)

    # -- collections (resume sectionId) --------------------------------------

    def list_collections(self) -> list[Collection]:
        self._require_tenant()
        logger.info("list_collections: tenant=%r index=%s", self.tenant_id, self.facts_index)
        persons: dict[str, set[str]] = {}
        sec_counts: dict[str, int] = {}
        for hit in self._scan(select=["personId", "sectionId", "factKey", "tenantId"]):
            if self._is_redacted(hit):
                continue
            pid = hit.get("personId") or ""
            for sec in _section_ids(hit):
                sec_counts[sec] = sec_counts.get(sec, 0) + 1
                persons.setdefault(sec, set())
                if pid:
                    persons[sec].add(pid)
        result: list[Collection] = []
        for sec in sorted(sec_counts):
            result.append(
                Collection(
                    id=sec,
                    name=sec,
                    description=f"Resume '{sec}' facts and bullets",
                    created_at=0,
                    document_count=len(persons.get(sec, set())),
                    section_count=sec_counts[sec],
                    concept_count=0,
                    last_ingested_at=None,
                )
            )
        return result

    def count_collections(self) -> int:
        self._require_tenant()
        seen: set[str] = set()
        for hit in self._scan(select=["sectionId", "tenantId"]):
            seen.update(_section_ids(hit))
        return len(seen)

    # -- documents (persons) --------------------------------------------------

    def _aggregate_persons(
        self, *, section: str | None = None,
    ) -> dict[str, dict[str, Any]]:
        """One tenant-scoped scan -> per-person rollup (name, sections, counts)."""
        persons: dict[str, dict[str, Any]] = {}
        for hit in self._scan(
            select=["personId", "sectionId", "factKey", "factValue", "createdAt", "tenantId"],
        ):
            pid = hit.get("personId") or ""
            if not pid:
                continue
            sections = _section_ids(hit)
            if section and section not in sections:
                continue
            rec = persons.setdefault(
                pid, {"sections": set(), "name": pid, "latest": 0, "count": 0}
            )
            rec["sections"].update(sections)
            if hit.get("factKey") == "profile.name" and hit.get("factValue"):
                rec["name"] = str(hit["factValue"]).strip() or pid
            rec["latest"] = max(rec["latest"], _epoch(hit.get("createdAt")))
            if not self._is_redacted(hit):
                rec["count"] += 1
        return persons

    def _document_from_rec(
        self, person_id: str, rec: dict[str, Any], *, collection_id: str,
    ) -> Document:
        self._name_cache.setdefault(person_id, rec["name"])
        primary = collection_id or (sorted(rec["sections"])[0] if rec["sections"] else "")
        return Document(
            id=person_id,
            collection_id=primary,
            source_path=f"person/{person_id}",
            title=rec["name"],
            doc_type=_DOC_TYPE,
            content_hash="",
            parsed_path=None,
            size_bytes=0,
            page_count=None,
            source_mtime=rec["latest"],
            ingested_at=rec["latest"],
            flavor=_FLAVOR,
            metadata={
                "person_id": person_id,
                "resume_sections": sorted(rec["sections"]),
                "fact_count": rec["count"],
            },
        )

    def get_document(self, document_id: str) -> Document | None:
        self._require_tenant()
        if not document_id:
            return None
        persons = self._aggregate_persons()
        rec = persons.get(document_id)
        if rec is None:
            return None
        return self._document_from_rec(document_id, rec, collection_id="")

    def get_document_by_source_path(self, source_path: str) -> Document | None:
        self._require_tenant()
        person_id = (source_path or "").split("/", 1)[-1] if source_path else ""
        if not person_id:
            return None
        return self.get_document(person_id)

    def list_documents(
        self, collection_id: str | None = None, *, flavor: str | None = None, limit: int = 100,
    ) -> list[Document]:
        self._require_tenant()
        logger.info(
            "list_documents: tenant=%r index=%s collection=%r flavor=%r",
            self.tenant_id, self.facts_index, collection_id, flavor,
        )
        if flavor and flavor.strip().lower() not in {_FLAVOR, "facts", _DOC_TYPE}:
            return []
        persons = self._aggregate_persons(section=collection_id)
        documents: list[Document] = []
        for pid in sorted(persons)[: max(1, min(limit, 500))]:
            documents.append(
                self._document_from_rec(pid, persons[pid], collection_id=collection_id or "")
            )
        logger.info("list_documents: returning %d person document(s)", len(documents))
        return documents

    def get_document_count(self, collection_id: str | None = None) -> int:
        self._require_tenant()
        seen: set[str] = set()
        for hit in self._scan(select=["personId", "sectionId", "tenantId"]):
            if collection_id and collection_id not in _section_ids(hit):
                continue
            pid = hit.get("personId")
            if pid:
                seen.add(pid)
        return len(seen)

    # -- sections (facts / bullets) ------------------------------------------

    def list_sections_for_document(self, document_id: str) -> list[Section]:
        self._require_tenant()
        hits = [
            h for h in self._scan(select=["*"])
            if (h.get("personId") or "") == document_id
        ]
        # Stable, deterministic ordering: by resume section then factKey/id.
        hits.sort(key=lambda h: (
            (_section_ids(h)[0] if _section_ids(h) else ""),
            h.get("factKey") or "",
            h.get("id") or "",
        ))
        sections: list[Section] = []
        ordinal = 0
        for hit in hits:
            if self._is_redacted(hit):
                continue
            sections.append(self._sec_from_hit(hit, ordinal=ordinal))
            ordinal += 1
        return sections

    def get_section(self, section_id: str) -> Section | None:
        self._require_tenant()
        if not section_id:
            return None
        try:
            hit = self._client_().get_document(key=section_id)
        except ResourceNotFoundError:
            logger.info("get_section: key=%r not found in index=%s", section_id, self.facts_index)
            return None
        except HttpResponseError as exc:
            logger.warning("get_section: key=%r lookup failed: %s", section_id, exc)
            return None
        if not self._matches_tenant(hit):
            logger.info(
                "get_section: key=%r belongs to tenant=%r (configured=%r) -> hidden",
                section_id, hit.get("tenantId"), self.tenant_id,
            )
            return None
        if self._is_redacted(hit):
            logger.info(
                "get_section: key=%r factKey=%r is sensitive -> redacted",
                section_id, hit.get("factKey"),
            )
            return None
        return self._sec_from_hit(hit)

    def get_section_neighbors(self, section_id: str):
        self._require_tenant()
        try:
            anchor = self._client_().get_document(key=section_id)
        except (ResourceNotFoundError, HttpResponseError):
            return (None, None)
        if not self._matches_tenant(anchor):
            return (None, None)
        person_id = anchor.get("personId") or ""
        if not person_id:
            return (None, None)
        siblings = self.list_sections_for_document(person_id)
        idx = next((i for i, s in enumerate(siblings) if s.id == section_id), None)
        if idx is None:
            return (None, None)
        prev_sec = siblings[idx - 1] if idx > 0 else None
        next_sec = siblings[idx + 1] if idx + 1 < len(siblings) else None
        return (prev_sec, next_sec)

    # -- search (semantic + keyword, tenant/section trimmed client-side) ------

    def search_sections(
        self, *, match_expr: str, collection_id: str | None = None,
        doc_type: str | None = None, flavor: str | None = None, limit: int = 10,
    ) -> list[SearchHit]:
        self._require_tenant()
        if flavor and flavor.strip().lower() not in {_FLAVOR, "facts", _DOC_TYPE}:
            return []
        top = max(1, min(limit, 25))
        # Over-fetch so post-query tenant/section trim + redaction still yield ~top.
        fetch = min(max(top * 4, top), 50)
        query = _query_text_from_match(match_expr)
        logger.info(
            "search_sections: tenant=%r index=%s match_expr=%r -> query=%r top=%d fetch=%d collection=%r",
            self.tenant_id, self.facts_index, match_expr, query, top, fetch, collection_id,
        )

        visible: list[dict] = []
        raw = 0
        dropped_tenant = dropped_collection = dropped_sensitive = 0
        for hit in self._search(query, top=fetch):
            raw += 1
            if not self._matches_tenant(hit):
                dropped_tenant += 1
                continue
            if collection_id and collection_id not in _section_ids(hit):
                dropped_collection += 1
                continue
            if self._is_redacted(hit):
                dropped_sensitive += 1
                continue
            visible.append(hit)
            if len(visible) >= top:
                break

        logger.info(
            "search_sections: raw=%d visible=%d (dropped tenant=%d collection=%d sensitive=%d)",
            raw, len(visible), dropped_tenant, dropped_collection, dropped_sensitive,
        )
        if raw > 0 and not visible and dropped_tenant == raw:
            logger.warning(
                "search_sections dropped ALL %d hits on tenant mismatch (configured tenant=%r). "
                "resume-facts data uses tenantId='tenant-dev'; check LLMWIKI_AZURE_SEARCH_TENANT_ID.",
                raw, self.tenant_id,
            )

        if visible:
            self._ensure_names()
        return [self._hit_from(r) for r in visible]

    def _hit_from(self, hit: dict) -> SearchHit:
        score = hit.get("@search.score")
        if score is None:
            score = hit.get("@search.reranker_score") or hit.get("@search.rerankerScore") or 0.0
        person_id = hit.get("personId", "") or ""
        sections = _section_ids(hit)
        body = self._body(hit)
        return SearchHit(
            section_id=hit.get("id", "") or "",
            document_id=person_id,
            document_title=self._name_cache.get(person_id, person_id),
            collection_id=sections[0] if sections else "",
            heading_path=self._heading_path(hit),
            heading=self._heading(hit),
            snippet=body[:200].strip(),
            score=float(score),
            source_path=f"person/{person_id}" if person_id else "",
            page_anchor=None,
        )

    # -- concepts (resume-facts has no concept store) ------------------------

    def get_concept(self, concept_id: str) -> Concept | None:
        self._require_tenant()
        return None

    def list_concepts(
        self, *, collection_id: str | None = None, kind: str | None = None, limit: int = 100,
    ) -> list[Concept]:
        self._require_tenant()
        return []

    def related_concepts(self, concept_id: str, *, limit: int = 25) -> list[tuple[Concept, str]]:
        self._require_tenant()
        return []

    # -- ingest log (read-only: nothing to report) ---------------------------

    def record_ingest_event(
        self, *, source_path: str, status: str, message: str | None = None,
        started_at: int | None = None, finished_at: int | None = None,
    ) -> None:
        # No-op: greenhouse owns ingestion; this backend records nothing.
        return None

    def recent_ingest_log(self, limit: int = 50) -> list[IngestLogEntry]:
        return []

    # -- writes (forbidden: greenhouse owns the index) -----------------------

    def upsert_collection(self, *, id: str, name: str, description: str = "") -> None:
        raise NotImplementedError(self._READ_ONLY_MSG)

    def delete_document_by_source_path(self, source_path: str) -> None:
        raise NotImplementedError(self._READ_ONLY_MSG)

    def replace_document(
        self, *, document: Any, sections: Iterable[Any], concepts: Iterable[Any] = (),
        concept_links: Iterable[Any] = (), section_concept_ids: Iterable[Any] = (),
    ) -> None:
        raise NotImplementedError(self._READ_ONLY_MSG)

    _READ_ONLY_MSG = (
        "The resume-facts backend is read-only; the greenhouse-resume-builder "
        "pipeline owns writes to this index."
    )
