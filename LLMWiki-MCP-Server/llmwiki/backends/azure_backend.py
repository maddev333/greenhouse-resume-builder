"""Azure AI Search backend for LLMWiki.

Implements :class:`WikiStorage` using Azure AI Search per the architecture
plan §4:

 * ``wiki-sections``   -> primary search index (BM25 + vector hybrid)
 * ``wiki-documents``  -> metadata catalog / collection store
 * ``wiki-concepts``   -> concept store with name/definition searchable

Every public method returns the **same dataclass instances** as the SQLite
backend (see ``models.py``) so the tool layer -- which relies on
``dataclasses.asdict`` and attribute access -- works unchanged on either
backend ("zero tool changes").

Security contract (Phase 2): the backend is *tenant-scoped*. ``tenant_id``
must be configured (constructor arg or ``LLMWIKI_AZURE_SEARCH_TENANT_ID``);
every read and write asserts :meth:`_require_tenant` and ANDs a
``tenantId eq '...'`` filter into the query. Callers without a verified
tenant are blocked (fail-closed). All identifiers interpolated into OData
filters are escaped with :func:`_esc` to prevent filter injection.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Iterable

from ..models import (
    Collection,
    Concept,
    Document,
    IngestLogEntry,
    SearchHit,
    Section,
)
from .base import WikiStorage

# Azure SDK -- imported lazily so local/dev (SQLite mode) needs no install.
try:
    from azure.core.exceptions import HttpResponseError
    from azure.search.documents import SearchClient
    from azure.search.documents.indexes import SearchIndexClient
    from azure.search.documents.indexes.models import (
        HnswAlgorithmConfiguration,
        SearchField,
        SearchFieldDataType,
        SearchIndex,
        SemanticConfiguration,
        SemanticField,
        SemanticPrioritizedFields,
        SemanticSearch,
        SimpleField,
        VectorSearch,
        VectorSearchProfile,
    )
    from azure.search.documents.models import VectorizedQuery

    _azure_available = True
except ImportError:  # pragma: no cover - exercised only without the SDK
    HttpResponseError = Exception  # type: ignore[assignment,misc]
    _azure_available = False


_VECTOR_DIMENSIONS = 1536
_SECTIONS_INDEX = "wiki-sections"
_DOCUMENTS_INDEX = "wiki-documents"
_CONCEPTS_INDEX = "wiki-concepts"
_INDEX_PREFIX_DEFAULT = "wiki"


def _resolve_index_name(explicit: str | None, env_var: str, suffix: str) -> str:
    """Resolve an index name from (in order): explicit arg, a dedicated env
    var, or ``{LLMWIKI_AZURE_SEARCH_INDEX_PREFIX}-{suffix}`` (prefix defaults
    to ``wiki``). Lets one Azure AI Search service host many logical wikis.
    """
    if explicit and explicit.strip():
        return explicit.strip()
    dedicated = (os.environ.get(env_var) or "").strip()
    if dedicated:
        return dedicated
    prefix = (os.environ.get("LLMWIKI_AZURE_SEARCH_INDEX_PREFIX") or "").strip() or _INDEX_PREFIX_DEFAULT
    return f"{prefix}-{suffix}"


def _esc(s: Any) -> str:
    """Escape a value for safe inclusion in an OData ``'...'`` literal.

    Single quotes are doubled per the OData spec (the only metacharacter
    inside a string literal). Empty / falsy input returns the quoted empty
    literal ``''``; otherwise wrap the result in quotes at the call site
    (``f"id eq '{_esc(x)}'"``). Callers must therefore avoid passing empty
    values to a quote-wrapped site.
    """
    if not s:
        return "''"
    return str(s).replace("'", "''")


def _parse_json(raw: Any) -> dict[str, Any]:
    """Best-effort parse of a JSON object string into a dict."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw:
        try:
            val = json.loads(raw)
            return val if isinstance(val, dict) else {}
        except (json.JSONDecodeError, TypeError):
            return {}
    return {}


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_opt_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# ---- Index schema helpers ---------------------------------------------------

def _wiki_sections_index(name: str = _SECTIONS_INDEX, vector_dimensions: int = _VECTOR_DIMENSIONS) -> "SearchIndex":
    """Build the ``wiki-sections`` index (BM25 + vector hybrid)."""
    return SearchIndex(
        name=name,
        fields=[
            SimpleField(name="id", type=SearchFieldDataType.String, key=True),
            SimpleField(name="documentId", type=SearchFieldDataType.String, filterable=True),
            SimpleField(name="collectionId", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="tenantId", type=SearchFieldDataType.String, filterable=True),
            SearchField(name="heading", type=SearchFieldDataType.String, searchable=True, analyzer_name="en.microsoft"),
            SearchField(name="headingPath", type=SearchFieldDataType.String, searchable=True, analyzer_name="en.microsoft"),
            SearchField(name="body", type=SearchFieldDataType.String, searchable=True, analyzer_name="en.microsoft"),
            SearchField(
                name="bodyVector",
                type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
                searchable=True,
                vector_search_dimensions=vector_dimensions,
                vector_search_profile_name="openai-profile",
            ),
            SimpleField(name="docType", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="flavor", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="pageAnchor", type=SearchFieldDataType.Int32, sortable=True),
            SimpleField(name="ordinal", type=SearchFieldDataType.Int32, sortable=True),
            SimpleField(name="ingestedAt", type=SearchFieldDataType.Int64, sortable=True),
            # Denormalized so a search hit carries its citation without a join.
            SimpleField(name="sourcePath", type=SearchFieldDataType.String),
            SearchField(name="documentTitle", type=SearchFieldDataType.String, searchable=True, analyzer_name="en.microsoft"),
            SimpleField(name="metadataJson", type=SearchFieldDataType.String),
        ],
        vector_search=VectorSearch(
            algorithms=[HnswAlgorithmConfiguration(name="default-hnsw")],
            profiles=[
                VectorSearchProfile(name="openai-profile", algorithm_configuration_name="default-hnsw"),
            ],
        ),
        semantic_search=SemanticSearch(
            configurations=[
                SemanticConfiguration(
                    name="wiki-semantic-config",
                    prioritized_fields=SemanticPrioritizedFields(
                        title_field=SemanticField(field_name="heading"),
                        content_fields=[SemanticField(field_name="body")],
                    ),
                ),
            ],
        ),
    )


def _wiki_documents_index(name: str = _DOCUMENTS_INDEX) -> "SearchIndex":
    """Build the ``wiki-documents`` metadata/catalog index."""
    return SearchIndex(
        name=name,
        fields=[
            SimpleField(name="id", type=SearchFieldDataType.String, key=True),
            SimpleField(name="sourcePath", type=SearchFieldDataType.String, filterable=True),
            SearchField(name="title", type=SearchFieldDataType.String, searchable=True, analyzer_name="en.microsoft"),
            SimpleField(name="collectionId", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="tenantId", type=SearchFieldDataType.String, filterable=True),
            SimpleField(name="docType", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="flavor", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="contentHash", type=SearchFieldDataType.String, filterable=True),
            SimpleField(name="parsedPath", type=SearchFieldDataType.String),
            SimpleField(name="sizeBytes", type=SearchFieldDataType.Int64, sortable=True),
            SimpleField(name="pageCount", type=SearchFieldDataType.Int32),
            SimpleField(name="sourceMtime", type=SearchFieldDataType.Int64, sortable=True),
            SimpleField(name="ingestedAt", type=SearchFieldDataType.Int64, sortable=True),
            SimpleField(name="metadataJson", type=SearchFieldDataType.String),
            SimpleField(name="isDeleted", type=SearchFieldDataType.Boolean, filterable=True),
        ],
    )


def _wiki_concepts_index(name: str = _CONCEPTS_INDEX) -> "SearchIndex":
    """Build the ``wiki-concepts`` index."""
    return SearchIndex(
        name=name,
        fields=[
            SimpleField(name="id", type=SearchFieldDataType.String, key=True),
            SimpleField(name="collectionId", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="tenantId", type=SearchFieldDataType.String, filterable=True),
            SearchField(name="name", type=SearchFieldDataType.String, searchable=True, analyzer_name="en.microsoft"),
            SimpleField(name="slug", type=SearchFieldDataType.String, filterable=True),
            SimpleField(name="kind", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SearchField(name="definition", type=SearchFieldDataType.String, searchable=True, analyzer_name="en.microsoft"),
            SimpleField(name="sourceSectionId", type=SearchFieldDataType.String, filterable=True),
            SearchField(
                name="relatedConceptIds",
                type=SearchFieldDataType.Collection(SearchFieldDataType.String),
                filterable=True,
            ),
            SimpleField(name="metadataJson", type=SearchFieldDataType.String),
        ],
    )


# ---- Azure AI Search backend ------------------------------------------------

class WikiAzureSearchBackend(WikiStorage):
    """:class:`WikiStorage` backed by Azure AI Search.

    Returns the same dataclasses as the SQLite backend. Every query is
    tenant-scoped and fail-closed when no tenant identity is configured.
    """

    def __init__(
        self,
        service_url: str | None = None,
        credential: Any = None,
        tenant_id: str | None = None,
        *,
        sections_index: str | None = None,
        documents_index: str | None = None,
        concepts_index: str | None = None,
        vector_dimensions: int | None = None,
    ) -> None:
        if not _azure_available:
            raise ImportError(
                "azure-search-documents is required for Azure mode.\n"
                "pip install azure-search-documents azure-identity "
                "or set LLMWIKI_STORAGE_MODE=sqlite."
            )
        self.service_url = (
            (service_url or "").strip()
            or (os.environ.get("AZURE_SEARCH_SERVICE_URL") or "").strip()
            or (os.environ.get("LLMWIKI_AZURE_SEARCH_SERVICE_URL") or "").strip()
        )
        # Data-isolation tenant -- intentionally NOT AZURE_TENANT_ID (that is
        # the Entra auth tenant, a different concept).
        self.tenant_id = (
            (tenant_id or os.environ.get("LLMWIKI_AZURE_SEARCH_TENANT_ID", "")).strip() or None
        )
        # Operator-configurable index names (constructor arg / env / prefix)
        # so one Search service can host multiple logical wikis.
        self.sections_index = _resolve_index_name(sections_index, "LLMWIKI_AZURE_SEARCH_SECTIONS_INDEX", "sections")
        self.documents_index = _resolve_index_name(documents_index, "LLMWIKI_AZURE_SEARCH_DOCUMENTS_INDEX", "documents")
        self.concepts_index = _resolve_index_name(concepts_index, "LLMWIKI_AZURE_SEARCH_CONCEPTS_INDEX", "concepts")
        self.vector_dimensions = int(
            vector_dimensions
            or (os.environ.get("LLMWIKI_AZURE_SEARCH_VECTOR_DIMENSIONS") or "").strip()
            or _VECTOR_DIMENSIONS
        )
        # Credential is resolved lazily so the backend constructs even when
        # azure-identity is absent (e.g. unit tests of the tenant guard).
        self._credential = credential
        self._sec_client: "SearchClient | None" = None
        self._doc_client: "SearchClient | None" = None
        self._con_client: "SearchClient | None" = None
        self._idx_client: "SearchIndexClient | None" = None

    # -- credential / clients -------------------------------------------------

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
        else:
            from azure.identity import DefaultAzureCredential

            self._credential = DefaultAzureCredential()
        return self._credential

    def _require_service_url(self) -> str:
        if not self.service_url:
            raise RuntimeError(
                "AZURE_SEARCH_SERVICE_URL (or LLMWIKI_AZURE_SEARCH_SERVICE_URL) "
                "must be set to use the Azure backend."
            )
        return self.service_url

    def _sec_client_(self) -> "SearchClient":
        if self._sec_client is None:
            self._sec_client = SearchClient(self._require_service_url(), self.sections_index, credential=self._resolve_credential())
        return self._sec_client

    def _doc_client_(self) -> "SearchClient":
        if self._doc_client is None:
            self._doc_client = SearchClient(self._require_service_url(), self.documents_index, credential=self._resolve_credential())
        return self._doc_client

    def _con_client_(self) -> "SearchClient":
        if self._con_client is None:
            self._con_client = SearchClient(self._require_service_url(), self.concepts_index, credential=self._resolve_credential())
        return self._con_client

    def _idx_client_(self) -> "SearchIndexClient":
        if self._idx_client is None:
            self._idx_client = SearchIndexClient(self._require_service_url(), credential=self._resolve_credential())
        return self._idx_client

    # -- tenant guard ---------------------------------------------------------

    @property
    def _tenant_verified(self) -> bool:
        """True only when a tenant identity is configured."""
        return bool(self.tenant_id)

    def _require_tenant(self) -> None:
        """Fail closed when the caller has no verified tenant identity."""
        if not self._tenant_verified:
            raise RuntimeError(
                "LLMWIKI_AZURE_SEARCH_TENANT_ID (or the tenant_id argument) is "
                "required. Unverified callers cannot query without tenant isolation."
            )

    def _tenant_filter(self) -> str:
        return f"tenantId eq '{_esc(self.tenant_id)}'"

    def _scoped_filter(self, extra: Iterable[str] = ()) -> str:
        """Combine caller filters with the mandatory tenant constraint (AND)."""
        parts = [p for p in extra if p]
        parts.append(self._tenant_filter())
        return " and ".join(parts)

    # -- collections (derived from wiki-documents) ----------------------------

    def upsert_collection(self, *, id: str, name: str, description: str = "") -> None:
        self._require_tenant()
        doc = {
            "id": f"_coll_{id}",
            "sourcePath": f"@collection/{id}",
            "title": name,
            "collectionId": id,
            "tenantId": self.tenant_id,
            "docType": "@collection",
            "flavor": "wiki",
            "contentHash": "",
            "parsedPath": None,
            "sizeBytes": 0,
            "pageCount": 0,
            "sourceMtime": int(time.time()),
            "ingestedAt": int(time.time()),
            "metadataJson": json.dumps({"isCollection": True, "description": description or ""}),
            "isDeleted": False,
        }
        self._doc_client_().merge_or_upload_documents(documents=[doc])

    def list_collections(self) -> list[Collection]:
        self._require_tenant()
        names: dict[str, dict[str, Any]] = {}
        counts: dict[str, int] = {}
        last_ing: dict[str, int] = {}
        for hit in self._doc_client_().search(
            search_text="*",
            filter=self._scoped_filter(["isDeleted eq false"]),
            top=5000,
            select=["id", "collectionId", "title", "ingestedAt", "docType", "metadataJson"],
        ):
            cid = hit.get("collectionId") or "_unknown"
            if str(hit.get("id", "")).startswith("_coll_") or hit.get("docType") == "@collection":
                meta = _parse_json(hit.get("metadataJson"))
                names[cid] = {"name": hit.get("title") or cid, "description": meta.get("description", "")}
                continue
            counts[cid] = counts.get(cid, 0) + 1
            ing = _as_int(hit.get("ingestedAt"))
            if ing and ing > last_ing.get(cid, 0):
                last_ing[cid] = ing
        collection_ids = set(counts) | set(names)
        result: list[Collection] = []
        for cid in sorted(collection_ids):
            meta = names.get(cid, {})
            result.append(
                Collection(
                    id=cid,
                    name=meta.get("name", cid),
                    description=meta.get("description", ""),
                    created_at=last_ing.get(cid, 0),
                    document_count=counts.get(cid, 0),
                    section_count=0,
                    concept_count=0,
                    last_ingested_at=last_ing.get(cid) or None,
                )
            )
        return result

    # -- documents (wiki-documents index) -------------------------------------

    def _doc_from_hit(self, hit: dict) -> Document:
        return Document(
            id=hit.get("id", ""),
            collection_id=hit.get("collectionId", "") or "",
            source_path=hit.get("sourcePath", "") or "",
            title=hit.get("title", "") or "",
            doc_type=hit.get("docType", "") or "",
            content_hash=hit.get("contentHash", "") or "",
            parsed_path=hit.get("parsedPath"),
            size_bytes=_as_int(hit.get("sizeBytes")),
            page_count=_as_opt_int(hit.get("pageCount")),
            source_mtime=_as_int(hit.get("sourceMtime")),
            ingested_at=_as_int(hit.get("ingestedAt")),
            flavor=hit.get("flavor", "raw") or "raw",
            metadata=_parse_json(hit.get("metadataJson")),
        )

    def get_document_by_source_path(self, source_path: str) -> Document | None:
        self._require_tenant()
        flt = self._scoped_filter([f"sourcePath eq '{_esc(source_path)}'", "isDeleted eq false"])
        hits = list(self._doc_client_().search(search_text="*", top=1, filter=flt, select=["*"]))
        return self._doc_from_hit(hits[0]) if hits else None

    def get_document(self, document_id: str) -> Document | None:
        self._require_tenant()
        flt = self._scoped_filter([f"id eq '{_esc(document_id)}'", "isDeleted eq false"])
        hits = list(self._doc_client_().search(search_text="*", top=1, filter=flt, select=["*"]))
        return self._doc_from_hit(hits[0]) if hits else None

    def list_documents(self, collection_id: str | None = None, *, flavor: str | None = None, limit: int = 100) -> list[Document]:
        self._require_tenant()
        extra = ["isDeleted eq false"]
        if collection_id:
            extra.append(f"collectionId eq '{_esc(collection_id)}'")
        if flavor:
            extra.append(f"flavor eq '{_esc(flavor)}'")
        hits = self._doc_client_().search(
            search_text="*",
            top=min(limit, 500),
            filter=self._scoped_filter(extra),
            select=["*"],
        )
        return [self._doc_from_hit(h) for h in hits if not str(h.get("id", "")).startswith("_coll_")]

    def delete_document_by_source_path(self, source_path: str) -> None:
        """Soft-delete: set the ``isDeleted`` flag on the document entry."""
        self._require_tenant()
        flt = self._scoped_filter([f"sourcePath eq '{_esc(source_path)}'"])
        hits = list(self._doc_client_().search(search_text="*", top=1, filter=flt, select=["id"]))
        if hits:
            self._doc_client_().merge_documents(documents=[{"id": hits[0]["id"], "isDeleted": True}])

    def replace_document(self, *, document: Any, sections: Iterable[Any], concepts: Iterable[Any] = (), concept_links: Iterable[Any] = (), section_concept_ids: Iterable[Any] = ()) -> None:
        self._require_tenant()
        ingest_at = _as_int(getattr(document, "ingested_at", None), int(time.time())) or int(time.time())
        doc_id = getattr(document, "id", None) or str(uuid.uuid4())
        doc_title = getattr(document, "title", "") or ""
        source_path = getattr(document, "source_path", "") or ""
        collection_id = getattr(document, "collection_id", "") or ""
        flavor = getattr(document, "flavor", "raw") or "raw"
        doc_type = getattr(document, "doc_type", "") or ""

        doc_doc = {
            "id": doc_id,
            "sourcePath": source_path,
            "title": doc_title,
            "collectionId": collection_id,
            "tenantId": self.tenant_id,
            "docType": doc_type,
            "flavor": flavor,
            "contentHash": getattr(document, "content_hash", "") or "",
            "parsedPath": getattr(document, "parsed_path", None),
            "sizeBytes": _as_int(getattr(document, "size_bytes", 0)),
            "pageCount": _as_opt_int(getattr(document, "page_count", None)),
            "sourceMtime": _as_int(getattr(document, "source_mtime", ingest_at), ingest_at),
            "ingestedAt": ingest_at,
            "metadataJson": json.dumps(getattr(document, "metadata", {}) or {}),
            "isDeleted": False,
        }

        sec_docs: list[dict] = []
        for s in sections:
            body = getattr(s, "body", "") or ""
            sec_doc = {
                "id": getattr(s, "id", None) or str(uuid.uuid4()),
                "documentId": doc_id,
                "collectionId": collection_id,
                "tenantId": self.tenant_id,
                "heading": getattr(s, "heading", "") or "",
                "headingPath": getattr(s, "heading_path", "") or "",
                "body": body,
                "docType": doc_type,
                "flavor": flavor,
                "pageAnchor": _as_opt_int(getattr(s, "page_anchor", None)),
                "ordinal": _as_int(getattr(s, "ordinal", 0)),
                "ingestedAt": ingest_at,
                "sourcePath": source_path,
                "documentTitle": doc_title,
                "metadataJson": json.dumps(getattr(s, "metadata", {}) or {}),
            }
            vector = self._embed(body)
            if vector is not None:
                sec_doc["bodyVector"] = vector
            sec_docs.append(sec_doc)

        # Map concept links so each concept doc carries its related ids.
        link_map: dict[str, list[str]] = {}
        for link in concept_links or []:
            src_id = getattr(link, "src_concept_id", "") or ""
            dst_id = getattr(link, "dst_concept_id", "") or ""
            if src_id and dst_id:
                link_map.setdefault(src_id, []).append(dst_id)

        con_docs: list[dict] = []
        for c in concepts or []:
            cid = getattr(c, "id", None) or str(uuid.uuid4())
            name = getattr(c, "name", "") or ""
            con_docs.append(
                {
                    "id": cid,
                    "collectionId": collection_id,
                    "tenantId": self.tenant_id,
                    "name": name,
                    "slug": getattr(c, "slug", "") or name.lower().replace(" ", "_"),
                    "kind": getattr(c, "kind", "concept") or "concept",
                    "definition": getattr(c, "definition", "") or "",
                    "sourceSectionId": getattr(c, "source_section_id", None),
                    "relatedConceptIds": sorted(set(link_map.get(cid, []))),
                    "metadataJson": json.dumps(getattr(c, "metadata", {}) or {}),
                }
            )

        # Remove any prior sections for this document (avoids orphans on
        # re-ingest with fewer sections), then upsert the new state.
        self._delete_sections_for_document(doc_id)
        self._doc_client_().merge_or_upload_documents(documents=[doc_doc])
        for batch in _chunk(sec_docs, 1000):
            self._sec_client_().merge_or_upload_documents(documents=batch)
        for batch in _chunk(con_docs, 1000):
            self._con_client_().merge_or_upload_documents(documents=batch)

    def _delete_sections_for_document(self, document_id: str) -> None:
        flt = self._scoped_filter([f"documentId eq '{_esc(document_id)}'"])
        ids = [{"id": h["id"]} for h in self._sec_client_().search(search_text="*", top=1000, filter=flt, select=["id"])]
        for batch in _chunk(ids, 1000):
            if batch:
                self._sec_client_().delete_documents(documents=batch)

    # -- section reads --------------------------------------------------------

    def _sec_from_hit(self, hit: dict) -> Section:
        body = hit.get("body") or ""
        return Section(
            id=hit.get("id", ""),
            document_id=hit.get("documentId", "") or "",
            ordinal=_as_int(hit.get("ordinal")),
            heading_path=hit.get("headingPath", "") or "",
            heading=hit.get("heading", "") or "",
            body=body,
            body_chars=len(body),
            page_anchor=_as_opt_int(hit.get("pageAnchor")),
            metadata=_parse_json(hit.get("metadataJson")),
        )

    def get_section(self, section_id: str) -> Section | None:
        self._require_tenant()
        flt = self._scoped_filter([f"id eq '{_esc(section_id)}'"])
        hits = list(self._sec_client_().search(search_text="*", top=1, filter=flt, select=["*"]))
        return self._sec_from_hit(hits[0]) if hits else None

    def get_section_neighbors(self, section_id: str):
        self._require_tenant()
        flt = self._scoped_filter([f"id eq '{_esc(section_id)}'"])
        anchor = list(self._sec_client_().search(search_text="*", top=1, filter=flt, select=["documentId", "ordinal"]))
        if not anchor:
            return None, None
        doc_id_raw = anchor[0].get("documentId")
        if not doc_id_raw:
            return None, None
        doc_id = _esc(doc_id_raw)
        ordinal = _as_int(anchor[0].get("ordinal"))
        prev_flt = self._scoped_filter([f"documentId eq '{doc_id}'", f"ordinal lt {ordinal}"])
        next_flt = self._scoped_filter([f"documentId eq '{doc_id}'", f"ordinal gt {ordinal}"])
        prev_hits = list(self._sec_client_().search(search_text="*", top=1, filter=prev_flt, order_by=["ordinal desc"], select=["*"]))
        next_hits = list(self._sec_client_().search(search_text="*", top=1, filter=next_flt, order_by=["ordinal asc"], select=["*"]))
        prev = self._sec_from_hit(prev_hits[0]) if prev_hits else None
        nxt = self._sec_from_hit(next_hits[0]) if next_hits else None
        return prev, nxt

    def list_sections_for_document(self, document_id: str) -> list[Section]:
        self._require_tenant()
        flt = self._scoped_filter([f"documentId eq '{_esc(document_id)}'"])
        hits = self._sec_client_().search(search_text="*", top=1000, filter=flt, order_by=["ordinal asc"], select=["*"])
        return [self._sec_from_hit(h) for h in hits]

    # -- search (hybrid BM25 + vector) ----------------------------------------

    def search_sections(self, *, match_expr: str, collection_id: str | None = None, doc_type: str | None = None, flavor: str | None = None, limit: int = 10) -> list[SearchHit]:
        self._require_tenant()
        extra: list[str] = []
        if collection_id:
            extra.append(f"collectionId eq '{_esc(collection_id)}'")
        if doc_type:
            extra.append(f"docType eq '{_esc(doc_type)}'")
        if flavor:
            extra.append(f"flavor eq '{_esc(flavor)}'")
        odata = self._scoped_filter(extra)
        top = max(1, min(limit, 25))

        vector_queries = None
        embedding = self._embed(match_expr)
        if embedding is not None:
            vector_queries = [VectorizedQuery(vector=embedding, k_nearest_neighbors=top, fields="bodyVector")]

        client = self._sec_client_()
        try:
            results = client.search(
                search_text=match_expr,
                filter=odata,
                top=top,
                vector_queries=vector_queries,
                query_type="semantic",
                semantic_configuration_name="wiki-semantic-config",
            )
            return [self._hit_from(r) for r in results]
        except HttpResponseError:
            # Semantic tier may be unavailable; degrade to keyword (+vector).
            results = client.search(
                search_text=match_expr,
                filter=odata,
                top=top,
                vector_queries=vector_queries,
            )
            return [self._hit_from(r) for r in results]

    def _hit_from(self, hit: dict) -> SearchHit:
        score = hit.get("@search.score")
        if score is None:
            score = hit.get("@search.reranker_score") or hit.get("@search.rerankerScore") or 0.0
        body = hit.get("body") or ""
        return SearchHit(
            section_id=hit.get("id", ""),
            document_id=hit.get("documentId", "") or "",
            document_title=hit.get("documentTitle", "") or "",
            collection_id=hit.get("collectionId", "") or "",
            heading_path=hit.get("headingPath", "") or "",
            heading=hit.get("heading", "") or "",
            snippet=body[:200].strip(),
            score=float(score),
            source_path=hit.get("sourcePath", "") or "",
            page_anchor=_as_opt_int(hit.get("pageAnchor")),
        )

    # -- concepts (wiki-concepts index) ---------------------------------------

    def _con_from_hit(self, hit: dict) -> Concept:
        return Concept(
            id=hit.get("id", ""),
            collection_id=hit.get("collectionId", "") or "",
            name=hit.get("name", "") or "",
            slug=hit.get("slug", "") or "",
            kind=hit.get("kind", "") or "",
            definition=hit.get("definition", "") or "",
            source_section_id=hit.get("sourceSectionId"),
            metadata=_parse_json(hit.get("metadataJson")),
        )

    def get_concept(self, concept_id: str) -> Concept | None:
        self._require_tenant()
        flt = self._scoped_filter([f"id eq '{_esc(concept_id)}'"])
        hits = list(self._con_client_().search(search_text="*", top=1, filter=flt, select=["*"]))
        return self._con_from_hit(hits[0]) if hits else None

    def list_concepts(self, *, collection_id: str | None = None, kind: str | None = None, limit: int = 100) -> list[Concept]:
        self._require_tenant()
        extra: list[str] = []
        if collection_id:
            extra.append(f"collectionId eq '{_esc(collection_id)}'")
        if kind:
            extra.append(f"kind eq '{_esc(kind)}'")
        hits = self._con_client_().search(search_text="*", top=min(limit, 1000), filter=self._scoped_filter(extra), select=["*"])
        return [self._con_from_hit(h) for h in hits]

    def related_concepts(self, concept_id: str, *, limit: int = 25) -> list[tuple[Concept, str]]:
        self._require_tenant()
        con = self.get_concept(concept_id)
        if con is None:
            return []
        related_ids = (con.metadata.get("related_concept_ids") if isinstance(con.metadata, dict) else None) or []
        if not related_ids:
            # relatedConceptIds lives on the index doc, not in metadata; fetch it.
            flt = self._scoped_filter([f"id eq '{_esc(concept_id)}'"])
            hits = list(self._con_client_().search(search_text="*", top=1, filter=flt, select=["relatedConceptIds"]))
            if hits:
                related_ids = hits[0].get("relatedConceptIds") or []
        results: list[tuple[Concept, str]] = []
        for rid in list(related_ids)[:limit]:
            other = self.get_concept(rid)
            if other is not None:
                results.append((other, "related_to"))
        return results

    # -- ingest / audit log (blob-based, best-effort) -------------------------

    def _blob_service(self):
        """Return a BlobServiceClient via connection string or managed identity, or None."""
        try:
            from azure.storage.blob import BlobServiceClient
        except ImportError:
            return None
        conn_str = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "")
        if conn_str:
            return BlobServiceClient.from_connection_string(conn_str)
        account_url = os.environ.get("AZURE_STORAGE_ACCOUNT_URL", "")
        if account_url:
            return BlobServiceClient(account_url, credential=self._resolve_credential())
        return None

    def record_ingest_event(self, *, source_path: str, status: str, message: str | None = None, started_at: int | None = None, finished_at: int | None = None) -> None:
        try:
            bs = self._blob_service()
            if bs is None:
                return
            blob = bs.get_blob_client(container="ingest-log", blob=f"{int(time.time())}_{uuid.uuid4().hex[:6]}.json")
            entry = {
                "sourcePath": source_path,
                "status": status,
                "message": message,
                "startedAt": started_at,
                "finishedAt": finished_at,
            }
            blob.upload_blob(json.dumps(entry), overwrite=True)
        except Exception:
            # Audit logging must never break ingestion itself.
            pass

    def recent_ingest_log(self, limit: int = 50) -> list[IngestLogEntry]:
        results: list[IngestLogEntry] = []
        try:
            bs = self._blob_service()
            if bs is None:
                return []
            container = bs.get_container_client("ingest-log")
            blobs = sorted((b.name for b in container.list_blobs()), reverse=True)[:limit]
            for idx, name in enumerate(blobs):
                try:
                    raw = container.download_blob(name).readall()
                    if isinstance(raw, bytes):
                        raw = raw.decode("utf-8")
                    entry = json.loads(raw)
                    results.append(
                        IngestLogEntry(
                            id=idx,
                            source_path=entry.get("sourcePath", ""),
                            status=entry.get("status", ""),
                            message=entry.get("message"),
                            started_at=entry.get("startedAt"),
                            finished_at=entry.get("finishedAt"),
                        )
                    )
                except Exception:
                    continue
        except Exception:
            return results
        return results

    # -- maintenance helpers --------------------------------------------------

    def get_document_count(self, collection_id: str | None = None) -> int:
        self._require_tenant()
        extra = ["isDeleted eq false"]
        if collection_id:
            extra.append(f"collectionId eq '{_esc(collection_id)}'")
        res = self._doc_client_().search(
            search_text="*",
            filter=self._scoped_filter(extra),
            top=0,
            include_total_count=True,
        )
        return res.get_count() or 0

    def count_collections(self) -> int:
        self._require_tenant()
        seen: set[str] = set()
        for hit in self._doc_client_().search(
            search_text="*",
            filter=self._scoped_filter(["isDeleted eq false"]),
            top=10000,
            select=["collectionId", "id"],
        ):
            cid = hit.get("collectionId")
            if cid and not str(hit.get("id", "")).startswith("_coll_"):
                seen.add(cid)
        return len(seen)

    # -- embeddings -----------------------------------------------------------

    def _embed(self, text: str) -> list[float] | None:
        """Return an embedding for *text*, or ``None`` when unavailable.

        Returning ``None`` (rather than a zero vector) keeps unembeddable
        content out of vector search instead of polluting it with a
        degenerate vector.
        """
        if not text:
            return None
        from ..embeddings import generate_embedding

        return generate_embedding(text)

    # -- provisioning ---------------------------------------------------------

    def provision_indexes(self, *, force_create: bool = False) -> list[str]:
        """Create the three indexes if missing (or recreate when forced).

        Returns the list of index names that were created/updated. Uses the
        configured index names + vector dimensions so the provisioned schema
        always matches what this backend reads and writes.
        """
        idx_client = self._idx_client_()
        existing = {i.name for i in idx_client.list_indexes()}
        schemas = [
            _wiki_sections_index(self.sections_index, self.vector_dimensions),
            _wiki_documents_index(self.documents_index),
            _wiki_concepts_index(self.concepts_index),
        ]
        provisioned: list[str] = []
        for index in schemas:
            if force_create or index.name not in existing:
                idx_client.create_or_update_index(index)
                provisioned.append(index.name)
        return provisioned


def _chunk(items: list, size: int):
    """Yield ``items`` in lists of at most ``size`` (skips empties)."""
    for i in range(0, len(items), size):
        batch = items[i:i + size]
        if batch:
            yield batch
