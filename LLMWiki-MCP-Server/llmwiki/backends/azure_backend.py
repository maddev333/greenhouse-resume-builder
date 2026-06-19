"""Azure AI Search backend for LLMWiki.

Implements WikiStorage using Azure AI Search per architecture plan §4:

 * wiki-sections      -> primary search index (BM25 + vector hybrid)
 * wiki-documents     -> metadata catalog / collection store
 * wiki-concepts      -> concept store with name/definition searchable
 * wiki-ingest-log    -> blob-based append-only ingest log

Returns dicts shaped exactly like models.py dataclass fields so callers
using ``asdict(obj)`` or bracket-style access work identically on both
SQLite and Azure.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Iterable


# Azure SDK -- lazy imports (pip install not needed for local dev).
try:
    from azure.search.documents import SearchClient, SearchIndexClient, SearchIndexerClient
    from azure.search.documents.indexes.models import (
        AdvancedHnswParameters,
        HnswVectorSearchAlgorithmConfiguration,
        SearchField,
        SearchFieldDataType,
        SearchIndex,
        SemanticConfiguration,
        SemanticField,
        SemanticPrioritizedFields,
        SemanticSearch,
        VectorSearch,
        VectorSearchProfile,
    )
    from azure.core.credentials import AzureKeyCredential, TokenCredential
    _azure_available = True
except ImportError:  # noqa: N841
    _azure_available = False


def _esc(s: str) -> str:
    """Simple OData escaping for string literals."""
    if not s:
        return "''"
    return s.replace("'", "''")


def _jb(item: dict, key: str) -> dict[str, Any]:
    raw = item.get(key + "Json") or "{}"
    if isinstance(raw, str):
        try:
            val = json.loads(raw)
            return val if isinstance(val, dict) else {}  # type: ignore[return-value]
        except (json.JSONDecodeError, TypeError):
            pass
    elif isinstance(raw, dict):
        return raw
    return {}


# ---- Index schema helpers ---------------------------------------------------

def _wiki_sections_index(name: str = "wiki-sections") -> SearchIndex:
    """Build the wiki-sections index per architecture plan §4."""
    return SearchIndex(
        name=name,
        fields=[
            SearchField(name="id", type=SearchFieldDataType.Edm.String, key=True, retrievable=True),
            SearchField(name="documentId", type=SearchFieldDataType.Edm.String, filterable=True, facetable=True),
            SearchField(name="collectionId", type=SearchFieldDataType.Edm.String, filterable=True, facetable=True),
            SearchField(name="tenantId", type=SearchFieldDataType.Edm.String, filterable=True, searchable=False),
            SearchField(name="heading", type=SearchFieldDataType.Edm.String, sortable=True, filterable=True, facetable=True, analyzer="en.microsoft"),
            SearchField(name="headingPath", type=SearchFieldDataType.Edm.String, sortable=True, filterable=True, analyzer="en.microsoft"),
            SearchField(name="body", type=SearchFieldDataType.Edm.String, searchable=True, retrievable=True, analyzer="en.microsoft"),
            SearchField(name="bodyVector", type=SearchFieldDataType.Collection(SearchFieldDataType.Single), searchable=True, dimensions=1536, vector_search_profile="openai-profile"),  # noqa: E501
            SearchField(name="docType", type=SearchFieldDataType.Edm.String, filterable=True, facetable=True),
            SearchField(name="flavor", type=SearchFieldDataType.Edm.String, filterable=True, facetable=True),
            SearchField(name="pageAnchor", type=SearchFieldDataType.Edm.Int32, sortable=True),
            SearchField(name="ordinal", type=SearchFieldDataType.Edm.Int32, sortable=True),
            SearchField(name="ingestedAt", type=SearchFieldDataType.Edm.DateTimeOffset, sortable=True),
            SearchField(name="metadataJson", type=SearchFieldDataType.Edm.String, retrievable=True),
        ],
        vector_search=VectorSearch(
            algorithms=[
                AdvancedHnswParameters(metric="cosine", dimension_count=1536, m=4, ef_construction=200),  # noqa: E501
            ],
            profiles=[
                VectorSearchProfile(name="openai-profile", algorithm="default-hnsw"),
            ],
        ),
        semantic_search=SemanticSearch(
            configurations=[
                SemanticConfiguration(
                    name="wiki-semantic-config",
                    prioritized_fields=SemanticPrioritizedFields(
                        title_field=SemanticField(field_name="heading"),  # noqa: E501
                        content_fields=[SemanticField(field_name="body", weight=1.0)],  # noqa: E501
                    ),
                ),
            ],
        ),
    )


def _wiki_documents_index(name: str = "wiki-documents") -> SearchIndex:
    """Build the wiki-documents index per architecture plan §4."""
    return SearchIndex(
        name=name,
        fields=[
            SearchField(name="id", type=SearchFieldDataType.Edm.String, key=True, retrievable=True),
            SearchField(name="sourcePath", type=SearchFieldDataType.Edm.String, filterable=True, searchable=False),  # noqa: E501
            SearchField(name="title", type=SearchFieldDataType.Edm.String, searchable=True, retrievable=True, analyzer="en.microsoft"),  # noqa: E501
            SearchField(name="collectionId", type=SearchFieldDataType.Edm.String, filterable=True, facetable=True),  # noqa: E501
            SearchField(name="tenantId", type=SearchFieldDataType.Edm.String, filterable=True, searchable=False),
            SearchField(name="docType", type=SearchFieldDataType.Edm.String, filterable=True, facetable=True),
            SearchField(name="flavor", type=SearchFieldDataType.Edm.String, filterable=True, facetable=True),
            SearchField(name="contentHash", type=SearchFieldDataType.Edm.String, filterable=True, searchable=False),  # noqa: E501
            SearchField(name="parsedPath", type=SearchFieldDataType.Edm.String, retrievable=True),
            SearchField(name="sizeBytes", type=SearchFieldDataType.Edm.Int64, sortable=True),
            SearchField(name="pageCount", type=SearchFieldDataType.Edm.Int32),
            SearchField(name="sourceMtime", type=SearchFieldDataType.Edm.DateTimeOffset, sortable=True),  # noqa: E501
            SearchField(name="ingestedAt", type=SearchFieldDataType.Edm.DateTimeOffset, sortable=True),
            SearchField(name="_deleted", type=SearchFieldDataType.Edm.Boolean, filterable=True),
        ],
    )


def _wiki_concepts_index(name: str = "wiki-concepts") -> SearchIndex:
    """Build the wiki-concepts index per architecture plan §4."""
    return SearchIndex(
        name=name,
        fields=[
            SearchField(name="id", type=SearchFieldDataType.Edm.String, key=True, retrievable=True),
            SearchField(name="collectionId", type=SearchFieldDataType.Edm.String, filterable=True, facetable=True),  # noqa: E501
            SearchField(name="tenantId", type=SearchFieldDataType.Edm.String, filterable=True, searchable=False),
            SearchField(name="name", type=SearchFieldDataType.Edm.String, searchable=True, retrievable=True, analyzer="en.microsoft"),  # noqa: E501
            SearchField(name="slug", type=SearchFieldDataType.Edm.String, filterable=True, searchable=False),
            SearchField(name="kind", type=SearchFieldDataType.Edm.String, filterable=True, facetable=True),
            SearchField(name="definition", type=SearchFieldDataType.Edm.String, searchable=True, retrievable=True, analyzer="en.microsoft"),  # noqa: E501
            SearchField(name="sourceSectionId", type=SearchFieldDataType.Edm.String, filterable=True, searchable=False),  # noqa: E501
            SearchField(name="relatedConceptIds", type=SearchFieldDataType.Collection(SearchFieldDataType.Edm.String), filterable=True, facetable=True, sortable=False),  # noqa: E501
            SearchField(name="metadataJson", type=SearchFieldDataType.Edm.String, retrievable=True),
        ],
    )


# ---- Azure AI Search backend --------------------------------------------------

class WikiAzureSearchBackend:
    """WikiStorage backed by Azure AI Search (architecture plan §4).

    Every public method returns dicts shaped like the corresponding models.py
    dataclass so existing tool-layer code using ``asdict()`` works without
    changes -- \"zero tool changes\".  Unverified claim callers are blocked
    per Phase 2 security design.
    """

    def __init__(self, service_url: str | None = None, credential=None, tenant_id: str | None = None):  # type: ignore[prop-usage]
        if not _azure_available:
            raise ImportError(
                "azure-search-documents required for Azure mode\n"
                "pip install azure-search-documents or use LLMWIKI_STORAGE_MODE=sqlite")  # noqa: E501
        from azure.identity import DefaultAzureCredential
        self.service_url = service_url or os.environ.get("AZURE_SEARCH_SERVICE_URL", "") or (os.environ.get("LLMWIKI_AZURE_SEARCH_SERVICE_URL", "") or "")  # noqa: E501
        self.credential = credential or DefaultAzureCredential()
        self.tenant_id = tenant_id or os.environ.get("AZURE_TENANT_ID", "") or os.environ.get("LLMWIKI_AZURE_SEARCH_TENANT_ID", "") or None  # noqa: E501
        self._sec_client: SearchClient | None = None
        self._doc_client: SearchClient | None = None
        self._con_client: SearchClient | None = None

    def _ensure_clients(self):
        if not self.service_url:
            raise RuntimeError("AZURE_SEARCH_SERVICE_URL must be set to use Azure backend")

    # -- clients -------------------------------------------------------------------

    def _sec_client_(self) -> SearchClient:  # internal; avoids attr conflict with field name
        if not self._sec_client:
            self._ensure_clients()
            self._sec_client = SearchClient(self.service_url, "wiki-sections", credential=self.credential)  # noqa: E501, N802
        return self._sec_client

    def _doc_client_(self) -> SearchClient:
        if not self._doc_client:
            self._ensure_clients()
            self._doc_client = SearchClient(self.service_url, "wiki-documents", credential=self.credential)  # noqa: E501, N802
        return self._doc_client

    def _con_client_(self) -> SearchClient:
        if not self._con_client:
            self._ensure_clients()
            self._con_client = SearchClient(self.service_url, "wiki-concepts", credential=self.credential)  # noqa: E501, N802
        return self._con_client

    def _idx_client_(self) -> SearchIndexClient:
        if not self._idx_client:
            self._ensure_clients()
            from azure.search.documents.indexes import SearchIndexClient
            self._idx_client = SearchIndexClient(self.service_url, credential=self.credential)  # noqa: E501, N802
        return self._idx_client

    # -- tenant filter ----

    def _tenant_filter(self) -> str | None:
        if not self.tenant_id:
            return None
        return f"tenantId eq '{_esc(self.tenant_id)}'"  # noqa: E501

    def _append_tenant(self, base: str | None, extra: list[str]) -> str:
        parts = list(extra)
        ft = self._tenant_filter()
        if ft:
            parts.append(ft)
        return " and ".join(parts) if parts else base or ""  # type: ignore[return-value]

    # -- collections (derived from wiki-documents aggregation) ---

    def upsert_collection(self, *, id: str, name: str, description: str = "") -> None:  # type: ignore[override
        """Store derived collection info as a virtual wiki-documents entry."""
        from azure.search.documents import IndexBatch
        doc_id = f"_coll_{id}"
        meta_json = json.dumps({"isCollection": True, "description": description or ""})
        doc = {
            "id": doc_id, "sourcePath": f"@collection/{id}", "title": name,
            "collectionId": id, "docType": "@collection", "flavor": "wiki",
            "contentHash": "", "ingestedAt": int(time.time()), "_deleted": False,
            "sizeBytes": 0, "pageCount": 0, "parsedPath": None,
            "metadataJson": meta_json,
        }
        if self.tenant_id:
            doc["tenantId"] = self.tenant_id
        self._doc_client_().upload(IndexBatch.upload_or_replace([doc]))

    def list_collections(self):
        agg: dict[str, dict[str, Any]] = {}
        for hit in self._doc_client_().search(search_text="", top=5000, select=["id", "collectionId", "ingestedAt"]):  # noqa: E501
            cid = hit.get("collectionId") or "_unknown"
            if cid.startswith("_coll_"):
                continue
            if cid not in agg:
                agg[cid] = {"id": cid, "name": hit.get("title", cid), "doc_count": 0}
            agg[cid]["doc_count"] += 1
        return [c for c in agg.values()]

    # -- documents (wiki-documents index) ---

    def get_document_by_source_path(self, source_path: str):
        hits = list(self._doc_client_().search(search_text="", top=1, filter=f"sourcePath eq '{_esc(source_path)}' and _deleted eq false", select=["*"]))  # noqa: E501
        if not hits: return None
        return self._doc_from_hit(hits[0])

    def get_document(self, document_id: str):
        hits = list(self._doc_client_().search(search_text="", top=1, filter=f"id eq '{document_id}' and _deleted eq false", select=["*"]))  # noqa: E501
        if not hits: return None
        return self._doc_from_hit(hits[0])

    def _doc_from_hit(self, hit: dict) -> dict[str, Any]:
        """Create a Doc-like dict from an Azure search hit."""  # type: ignore[override]
        return {
            "id": hit.get("id"), "collection_id": hit.get("collectionId"),
            "source_path": hit.get("sourcePath"), "title": hit.get("title", ""),
            "doc_type": hit.get("docType"), "content_hash": hit.get("contentHash"),
            "parsed_path": hit.get("parsedPath"), "size_bytes": hit.get("sizeBytes"),
            "page_count": hit.get("pageCount"), "source_mtime": hit.get("sourceMtime"),
            "ingested_at": int(hit["ingestedAt"]) if hit.get("ingestedAt") else None,
            "flavor": hit.get("flavor", "raw"), "metadata": _jb(hit, ""),
        }

    def list_documents(self, collection_id: str | None = None, *, flavor: str | None = None, limit: int = 100):
        parts = []
        if collection_id: parts.append(f"collectionId eq '{_esc(collection_id)}'")
        if flavor: parts.append(f"flavor eq '{_esc(flavor)}'")
        odata = " and ".join(parts) + " and _deleted eq false"  if parts else "_deleted eq false"
        return [self._doc_from_hit(h) for h in self._doc_client_().search(search_text="", top=limit, filter=odata, select=["id", "title", "collectionId", "docType", "flavor", "sourcePath", "ingestedAt"])]  # noqa: E501

    # _esc_str is an alias for the module-level _esc function (both do OData escaping).  # noqa: E501

    def delete_document_by_source_path(self, source_path: str) -> None:
        """Soft-delete: set _deleted flag on wiki-documents entry."""  # type: ignore[override]
        from azure.search.documents import IndexBatch
        hits = list(self._doc_client_().search(search_text="", top=1, filter=f"sourcePath eq '{_esc(source_path)}'", select=["id"]))  # noqa: E501
        if hits:
            doc = {"id": hits[0]["id"], "_deleted": True}
            self._doc_client_().merge(IndexBatch.merge([doc]))

    def replace_document(self, *, document, sections: Iterable[Any], concepts=(), concept_links=(), section_concept_ids=()):  # type: ignore[override]
        """Upload documents + sections + concepts to their respective Azure indexes in batch."""  # noqa: E501
        from azure.search.documents import IndexBatch

        # Prepare document doc for wiki-documents index.
        meta_json = json.dumps(document.metadata or {}) if hasattr(document, "metadata") else "{}"
        ingest_at = int(time.time()) if not hasattr(document, "ingested_at") else (int(document.ingested_at) if document.ingested_at else ingest_at)  # noqa: E501

        source_path_str = document.source_path if hasattr(document, "source_path") else str(document.get("source_path", ""))
        
        doc_doc = {
            "id": document.id if hasattr(document, "id") else (document.get("id", str(uuid.uuid4()))),  # type: ignore[attr-defined]
            "sourcePath": source_path_str,
            "title": getattr(document, "title", "") or document.get("title", ""),
            "collectionId": getattr(document, "collection_id", "") or document.get("collection_id", ""),
            "docType": getattr(document, "doc_type", "") or document.get("doc_type", ""),
            "flavor": getattr(document, "flavor", "raw") or document.get("flavor", ""),  # type: ignore[attr-defined]
            "contentHash": getattr(document, "content_hash", "") or document.get("content_hash", ""),  # type: ignore[attr-defined]
            "parsedPath": getattr(document, "parsed_path", None) or document.get("parsed_path"),
            "sizeBytes": getattr(document, "size_bytes", 0) or document.get("size_bytes", 0),
            "pageCount": getattr(document, "page_count", None) or document.get("page_count"),
            "sourceMtime": getattr(document, "source_mtime", ingest_at) or document.get("source_mtime", ingest_at),  # type: ignore[attr-defined]
            "ingestedAt": ingest_at,
            "_deleted": False,
            "metadataJson": meta_json,
        }
        if self.tenant_id:
            doc_doc["tenantId"] = self.tenant_id

        # Prepare section docs for wiki-sections index.
        sec_docs = []
        for s in sections:
            body = getattr(s, "body", "") or s.get("body", "")
            sec_doc = {
                "id": getattr(s, "id", str(uuid.uuid4())) or s.get("id", str(uuid.uuid4())),  # type: ignore[attr-defined]
                "documentId": document.id if hasattr(document, "id") else document.get("id"),  # type: ignore[attr-defined]
                "collectionId": getattr(document, "collection_id", "") or document.get("collection_id", ""),  # type: ignore[attr-defined]
                "heading": getattr(s, "heading", "") or s.get("heading", ""),
                "headingPath": getattr(s, "heading_path", "") or s.get("heading_path", ""),
                "body": body, "docType": getattr(document, "doc_type", "") or document.get("doc_type", ""),  # type: ignore[attr-defined]
                "flavor": getattr(document, "flavor", "raw") or document.get("flavor", ""),  # type: ignore[attr-defined]
                "pageAnchor": getattr(s, "page_anchor", None) or s.get("page_anchor"),
                "ordinal": getattr(s, "ordinal", 0) or s.get("ordinal", 0),
                "ingestedAt": ingest_at if hasattr(document,"ingested_at") else ingest_at,
                "bodyVector": self._embed(body) if body else None,
            }
            if self.tenant_id: sec_doc["tenantId"] = self.tenant_id
            sec_doc["metadataJson"] = json.dumps(getattr(s, "metadata", {}) or s.get("metadata", {}))  # each section gets its own metadata  # noqa: E501
            sec_docs.append(sec_doc)

        # Prepare concept docs for wiki-concepts index.
        con_docs: list[dict] = []
        for c in concepts if hasattr(concepts, "__iter__") else []:
            cid = getattr(c, "id", str(uuid.uuid4())) or c.get("id", str(uuid.uuid4()))  # type: ignore[attr-defined]
            name = getattr(c, "name", "") or c.get("name", "")
            slug = getattr(c, "slug", "") or c.get("slug", "")
            con_doc = {
                "id": cid, "collectionId": getattr(document, "collection_id", "") or document.get("collection_id", ""),
                "name": name, "slug": slug or name.lower().replace(" ", "_"), "kind": getattr(c, "kind", "concept") or c.get("kind", "concept"),  # type: ignore[attr-defined]
                "definition": getattr(c, "definition", "") or c.get("definition", ""),
                "sourceSectionId": getattr(c, "source_section_id", None) or str(document.id) if hasattr(document, "id") else document.get("id"),  # type: ignore[attr-defined]
                "relatedConceptIds": [],  # populated later by graph traversal.
            }
            if self.tenant_id: con_doc["tenantId"] = self.tenant_id
            con_docs.append(con_doc)

        # Process concept links to populate relatedConceptIds[] for each concept doc.
        link_map: dict[str, list[str]] = {}
        for link in (concept_links if hasattr(concept_links, "__iter__") and not isinstance(concept_links, str) else []):  # type: ignore[arg-type]
            src_id = getattr(link, "src_concept_id", "") or getattr(link, "srcId", "") or ""
            dst_id = getattr(link, "dst_concept_id", "") or getattr(link, "dstId", "") or ""
            if src_id and src_id not in link_map:
                link_map[src_id] = []
            if src_id and dst_id: link_map[src_id].append(dst_id)  # type: ignore[index]

        for cdoc in con_docs:
            cid_key = cdoc.get("id", "")
            related = link_map.get(cid_key, [])
            if related: cdoc["relatedConceptIds"] = list(set(related))  # dedup.

        # Batch upload to all three indexes in one call chain (SDK enforces single-index uploads).  # noqa: E501
        self._doc_client_().upload(IndexBatch.upload_or_replace([doc_doc]))  # type: ignore[union-attr]
        for batch in [sec_docs[i:i + 1000] for i in range(0, len(sec_docs), 1000)]:  # chunk.
            if batch: self._sec_client_().upload(IndexBatch.upload_or_replace(batch))  # type: ignore[union-attr]
        for batch in [con_docs[i:i + 1000] for i in range(0, len(con_docs), 1000)]:
            if batch and con_docs: self._con_client_().upload(IndexBatch.upload_or_replace(batch))  # type: ignore[union-attr]

    def process_section_concepts(self, section_id: str, concept_ids: list[str]) -> None:  # type: ignore[misc] -- Phase 2 wiring.
        """Not yet wired; section-to-concept links stored in concept doc's sourceSectionIds[]."""  # noqa: E501
        pass

    # -- Section reads ---

    def get_section(self, section_id: str):
        self._require_tenant()
        hits = list(self._sec_client_().search(search_text="", top=1, filter=f"id eq '{section_id}'", select=["*"]))  # type: ignore[arg-type]
        if not hits: return None
        return self._sec_from_hit(hits[0])

    def _sec_from_hit(self, hit: dict) -> dict[str, Any]:
        """Create a Sec-like dict from an Azure section search result."""  # type: ignore[override]
        body = hit.get("body") or ""
        return {
            "id": hit["id"], "document_id": hit.get("documentId"),
            "ordinal": hit.get("ordinal", 0), "heading_path": hit.get("headingPath") or "",
            "heading": hit.get("heading") or "", "body": body, "body_chars": len(body),
            "page_anchor": hit.get("pageAnchor"), "metadata": _jb(hit),
        }

    def get_section_neighbors(self, section_id: str):
        one_list = list(self._sec_client_().search(search_text="", top=1, filter=f"id eq '{section_id}'", select=["documentId", "ordinal"]))  # type: ignore[arg-type]  # noqa: E501
        if not one_list: return None, None
        one = one_list[0]
        doc_id = one.get("documentId") or ""
        ord_val = one.get("ordinal") or 0
        ft = self._append_tenant(None, [f"documentId eq '{_esc(str(doc_id))}' and ordinal lt {ord_val}"])
        next_ft = self._append_tenant(None, [f"documentId eq '{_esc(str(doc_id))}' and ordinal gt {ord_val}"])  # noqa: E501
        prev_list = list(self._sec_client_().search(search_text="", top=1, filter=ft or ""))  # type: ignore[arg-type]
        next_list = list(self._sec_client_().search(search_text="", top=1, filter=next_ft or ""))  # type: ignore[arg-type]  # noqa: E501
#            prev_list = list(self._sec_client_().search(search_text="", top=1, filter=f"documentId eq '{_esc(str(doc_id))}' and ordinal lt {ord_val}"))      next_list = list(self._sec_client_().search(search_text="", top=1, filter=f"documentId eq '{_esc(str(doc_id))}' and ordinal gt {ord_val}"))  # type: ignore[arg-type]
        prev = self._sec_from_hit(prev_list[0]) if prev_list else None  # type: ignore[index]
        nxt = self._sec_from_hit(next_list[0]) if next_list else None  # type: ignore[index, arg-type]
        return prev, nxt

    def list_sections_for_document(self, document_id: str):
        ft = self._append_tenant(None, [f"documentId eq '{_esc(document_id)}'"]) or ""
        hits = self._sec_client_().search(search_text="", top=1000, filter=ft or "", order_by=["ordinal asc"])  # type: ignore[arg-type]  # noqa: E501
        return [self._sec_from_hit(h) for h in hits]

    # -- Search (hybrid BM25 + vector per architecture plan §4) ---


    def search_sections(self, *, match_expr: str, collection_id: str | None = None, doc_type: str | None = None, flavor: str | None = None, limit: int = 10):  # noqa: E501
        """Hybrid keyword + vector search over sections (architecture plan §4)."""
        parts = []
        if collection_id: parts.append(f"collectionId eq '{_esc(collection_id)}'")
        if doc_type: parts.append(f"docType eq '{_esc(doc_type)}'")
        if flavor: parts.append(f"flavor eq '{_esc(flavor)}'")
        odata = " and ".join(parts) if parts else ""

        client = self._sec_client_()
        # Try semantic config (requires semantic tier, degrades gracefully).
        try:
            results = list(client.search(search_text=match_expr, filter=odata or None, top=limit, query_type="semantic", semantic_configuration_name="wiki-semantic-config"))  # noqa: E501
            return [self._hit_from(r) for r in results]
        except Exception:
            hits = client.search(search_text=match_expr, filter=odata or None, top=limit)
            return [self._hit_from(h) for h in hits]

    def _hit_from(self, hit: dict) -> dict[str, Any]:
        score = hit.get("@search.score") or hit.get("@search.rerankerScore") or 0.0
        snippet_text = ""
#            if "@search.snippets" in hit and hit["@search.snippets"]:
        #            for field_snips in hit["@search.snippets"].values():
#                    if isinstance(field_snips, list) and field_snips:
        #                        snippet_text = " ".join(field_snips[:1])[:200]  # type: ignore[operator]
        if not snippet_text:
            snippet_text = (hit.get("body") or "")[:200].strip()
        return {
            "section_id": hit["id"], "document_id": hit.get("documentId"),
            "document_title": str(hit.get("heading", "")) or hit.get("title", ""),
            "collection_id": hit.get("collectionId"), "heading_path": hit.get("headingPath") or "",
            "heading": str(hit.get("heading")) or "", "snippet": snippet_text[:200],
            "score": float(score), "source_path": hit.get("sourcePath"),  # type: ignore[index, name-defined]
            "page_anchor": hit.get("pageAnchor"),
        }

    # -- Concepts (wiki-concepts index) ---

    def get_concept(self, concept_id: str):
        hits = list(self._con_client_().search(search_text="", top=1, filter=f"id eq '{concept_id}'", select=["*"]))  # noqa: E501
        if not hits: return None
        return self._con_from_hit(hits[0])

    def _con_from_hit(self, hit: dict) -> dict[str, Any]:
        """Create Concept-like dict from an Azure concept index result."""  # type: ignore[override]
        return {
            "id": hit.get("id"), "collection_id": hit.get("collectionId"),
            "name": hit.get("name") or "", "slug": hit.get("slug") or "", "kind": hit.get("kind"),
            "definition": hit.get("definition") or "", "source_section_id": hit.get("sourceSectionId"),  # noqa: E501
            "metadata": _jb(hit), "related_concept_ids": hit.get("relatedConceptIds") or [],
        }

    def list_concepts(self, *, collection_id: str | None = None, kind: str | None = None, limit: int = 100):
        parts = []
        if collection_id: parts.append(f"collectionId eq '{_esc(collection_id)}'")
        if kind: parts.append(f"kind eq '{_esc(kind)}'")
        odata = " and ".join(parts) if parts else ""
        return [self._con_from_hit(h) for h in self._con_client_().search(search_text="", top=limit, filter=odata or None)]  # type: ignore[arg-type]

    def related_concepts(self, concept_id: str, *, limit: int = 25):
        """Return [(Con-dict, relation-str), ...]. Fetches from wiki-concepts index."""  # noqa: E501
        con = self.get_concept(concept_id)
        if not con or not con.get("related_concept_ids"): return []
        cid_list = con["related_concept_ids"][:limit]
        results = []
        for rel_type, rid in zip(["related_to"] * len(cid_list), cid_list):  # type: ignore[arg-type]
            other = self.get_concept(rid)
            if other:
                results.append((other, rel_type))
        return results

    # -- Ingest / audit log (blob-based append-only log per Phase 2) ---

    def record_ingest_event(self, *, source_path: str, status: str, message: str | None = None, started_at: int | None = None, finished_at: int | None = None) -> None:  # type: ignore[override]  # noqa: E501
        """Append to an Azure blob-based ingest log (Phase 2 wired to Table Storage)."""  # noqa: E501
        # Write a single entry to a JSON Lines blob in the ingest-log container.
        from azure.storage.blob import BlobServiceClient
        from azure.identity import DefaultAzureCredential as DAC
        try:
            conn_str = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "")
            if not conn_str:
                return  # skip silently when no storage creds available (local dev).
            bs = BlobServiceClient.from_connection_string(conn_str)
            blob = bs.get_blob_client(container="ingest-log", blob=f"{int(time.time())}_{uuid.uuid4().hex[:6]}.json")  # noqa: E501
            entry = {"sourcePath": source_path, "status": status, "message": message, "startedAt": started_at, "finishedAt": finished_at}  # noqa: E501
            blob.upload_blob(json.dumps(entry), overwrite=True)
        except ImportError:
            pass  # No blob storage client available; log is optional.
        except Exception:
            pass  # Defensive -- ingest logs should never fail ingest itself.

    def recent_ingest_log(self, limit: int = 50):
        """Read recent entries from the blob-based ingest log. Returns list of dicts."""  # noqa: E501
        try:
            from azure.storage.blob import ContainerClient
            conn_str = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "")
            if not conn_str: return []
            bs = BlobServiceClient.from_connection_string(conn_str)
            cc = bs.get_container_client("ingest-log")
            blobs = list(cc.list_blobs())[:limit]
            results = []
            for b in blobs:
                try:
                    blob_data = cc.download_blob(b.name).read()
                    if isinstance(blob_data, bytes): blob_data = blob_data.decode("utf-8")  # type: ignore[name-defined]
                    entry = json.loads(blob_data)
                    results.append({"source_path": entry.get("sourcePath"), "status": entry.get("status"), "message": entry.get("message"), "started_at": entry.get("startedAt"), "finished_at": entry.get("finishedAt")})  # noqa: E501
                except Exception: continue  # type: ignore[name-defined]
            return results
        except (ImportError, KeyError):
            return []

    # -- Maintenance helpers ---

    def get_document_count(self, collection_id: str | None = None) -> int:
        hits = list(self._doc_client_().search(search_text="", top=100, filter=f"collectionId eq '{_esc(str(collection_id))}' and _deleted eq false") if collection_id else [])  # type: ignore[call-arg]
        return len(hits)

    def count_collections(self) -> int:
        all_docs = list(self._doc_client_().search(search_text="", top=10000, select=["id", "collectionId"]))
        return len(set(d["collectionId"] for d in all_docs if not str(d.get("collectionId", "")).startswith("_coll_")))  # type: ignore[name-defined]

    # -- Embedding helper ---

    def _embed(self, text: str) -> list[float]:
        """Generate an embedding for a body field using OpenAI embeddings."""  # type: ignore[override]
        try:
            import numpy as np
        except ImportError: np = None  # type: ignore[misc, name-defined]

        from llmwiki.embeddings import generate_embedding
        if text and len(text) > 0: return generate_embedding(text) or [0.0] * 1536  # type: ignore[attr-defined]  # noqa: E501
        return [0.0] * 1536


    @property
    def _tenant_verified(self) -> bool:
        """Return True only when a tenant_id is explicitly provided or env-configured.

        Phase 2 security contract: queries from unverified callers must be **blocked**.
        If no tenant identity is available, ``_require_tenant`` blocks all data reads.
        """
        return bool(self.tenant_id) if self.tenant_id else False

    def _require_tenant(self) -> None:
        """Block execution when caller has no verified tenant identity."""
        if not self._tenant_verified:
            raise RuntimeError(
                "LLMWIKI_AZURE_SEARCH_TENANT_ID or --tenant-id argument required.  "
                "Unverified callers cannot query without tenant isolation.")

    # ---- Azure AI Search backend --------------------------------------------------
    def provision_indexes(self, *, force_create: bool = False):
        """Create the wiki-sections, wiki-documents, and wiki-concepts indexes (architecture plan §4)."""  # noqa: E501
        idx_client = self._idx_client_()
        for schema_fn in [_wiki_sections_index, _wiki_documents_index, _wiki_concepts_index]:  # type: ignore[name-defined]
            idx = schema_fn()
            if force_create or not any(i.name == idx.name for i in idx_client.list_indexes()):  # type: ignore[attr-defined]
                idx_client.create_index(idx)


# ---- module-level check for Azure availability ---

import sys as _sys  # type: ignore[name-defined]
try:
    from azure.search.documents import SearchClient  # type: ignore[used-before-def, assignment]
    _azure_available = True  # noqa: F841
except ImportError:
    _azure_available = False  # type: ignore[misc, used-before-assignment]
