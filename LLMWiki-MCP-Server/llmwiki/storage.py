"""SQLite + FTS5 storage layer.

All persistence (documents, sections, concepts, ontology links, ingest log)
lives in a single sqlite database on disk. FTS5 virtual tables back keyword /
BM25 search.  One writer thread (ingest pipeline), many readers (MCP tools).
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

from .models import (
    Collection,
    Concept,
    ConceptLink,
    Document,
    IngestLogEntry,
    SearchHit,
    Section,
)


class Storage:
    """Thin DAO over the wiki sqlite database."""

    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path) if isinstance(db_path, str) else db_path
        self._write_lock = threading.Lock()
        self._initialize()

    # ------------------------------------------------------------------
    # Init / migration
    # ------------------------------------------------------------------

    def _initialize(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript(_SCHEMA)
            existing_cols = {row[1] for row in conn.execute(
                "PRAGMA table_info(documents)")}
            if "flavor" not in existing_cols:
                conn.execute(
                    "ALTER TABLE documents ADD COLUMN flavor TEXT NOT NULL DEFAULT 'raw'"
                )
            conn.executescript("""
INSERT OR IGNORE INTO meta(key,value) VALUES('schema_version','1');""")
            conn.commit()

    # ---- connection helpers ------------------------------------------------

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.db_path), isolation_level=None, timeout=30.0)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA synchronous=NORMAL")
            yield conn
        finally:
            conn.close()

    @contextmanager
    def write(self) -> Iterator[sqlite3.Connection]:
        with self._write_lock, self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise

    # ---- collections -------------------------------------------------------

    def upsert_collection(self, *, id: str, name: str, description: str = "") -> None:
        with self.write() as conn:
            conn.execute(
                "INSERT INTO collections(id,name,description,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description",
                (id, name, description or "", int(time.time())),
            )

    def list_collections(self) -> list[Collection]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT c.id, c.name, c.description, c.created_at,"
                "(SELECT COUNT(*) FROM documents d WHERE d.collection_id=c.id) AS cnt_doc,"
                "(SELECT COUNT(*) FROM sections s JOIN documents d ON d.id=s.document_id WHERE d.collection_id=c.id) AS cnt_sec,"
                "(SELECT COUNT(*) FROM concepts cn WHERE cn.collection_id=c.id) AS cnt_con,"
                "(SELECT MAX(ingested_at) FROM documents WHERE collection_id=c.id) AS last_ing"
                " FROM collections c ORDER BY c.name COLLATE NOCASE",
            ).fetchall()
        result = []
        for r in rows:
            result.append(Collection(
                id=r["id"], name=r["name"],
                description=r["description"] or "", created_at=r["created_at"],
                document_count=r["cnt_doc"] or 0, section_count=r["cnt_sec"] or 0,
                concept_count=r["cnt_con"] or 0, last_ingested_at=r["last_ing"]))
        return result

    # ---- documents ---------------------------------------------------------

    def get_document_by_source_path(self, source_path: str):  # -> Document | None
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM documents WHERE source_path=?", (source_path,)).fetchone()
        if not row: return None
        keys = row.keys() if hasattr(row, "keys") else []
        flvr = row["flavor"] if "flavor" in keys and row["flavor"] is not None else "raw"
        return Document(
            id=row["id"], collection_id=row["collection_id"], source_path=row["source_path"],
            title=row["title"], doc_type=row["doc_type"], content_hash=row["content_hash"],
            parsed_path=row["parsed_path"], size_bytes=row["size_bytes"], page_count=row["page_count"],
            source_mtime=row["source_mtime"], ingested_at=row["ingested_at"],
            flavor=flvr, metadata=_safe_json(row["metadata_json"]))

    def get_document(self, document_id: str):  # -> Document | None
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM documents WHERE id=?", (document_id,)).fetchone()
        if not row: return None
        keys = row.keys() if hasattr(row, "keys") else []
        flvr = row["flavor"] if "flavor" in keys and row["flavor"] is not None else "raw"
        return Document(
            id=row["id"], collection_id=row["collection_id"], source_path=row["source_path"],
            title=row["title"], doc_type=row["doc_type"], content_hash=row["content_hash"],
            parsed_path=row["parsed_path"], size_bytes=row["size_bytes"], page_count=row["page_count"],
            source_mtime=row["source_mtime"], ingested_at=row["ingested_at"],
            flavor=flvr, metadata=_safe_json(row["metadata_json"]))

    def list_documents(
        self, collection_id: str | None = None, *, flavor: str | None = None, limit: int = 100,
    ) -> list[Document]:
        sql = "SELECT * FROM documents WHERE 1=1"
        params: list[Any] = []
        if collection_id:
            sql += " AND collection_id=?"; params.append(collection_id)
        if flavor:
            sql += " AND flavor=?"; params.append(flavor)
        sql += " ORDER BY title COLLATE NOCASE ASC LIMIT ?"
        params.append(min(limit, 500))
        with self.connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        result = []
        for r in rows:
            keys = r.keys() if hasattr(r, "keys") else []
            flvr = r["flavor"] if "flavor" in keys and r["flavor"] is not None else "raw"
            result.append(Document(
                id=r["id"], collection_id=r["collection_id"], source_path=r["source_path"],
                title=r["title"], doc_type=r["doc_type"], content_hash=r["content_hash"],
                parsed_path=r["parsed_path"], size_bytes=r["size_bytes"], page_count=r["page_count"],
                source_mtime=r["source_mtime"], ingested_at=r["ingested_at"],
                flavor=flvr, metadata=_safe_json(r["metadata_json"])))
        return result

    def delete_document_by_source_path(self, source_path: str) -> None:
        with self.write() as conn:
            conn.execute("DELETE FROM documents WHERE source_path=?", (source_path,))

    def replace_document(
        self, *, document: Document, sections: Iterable[Section],
        concepts: Iterable[Concept] = (), concept_links: Iterable[ConceptLink] = (), section_concept_ids: Iterable[tuple[str, str]] = (),
    ) -> None:
        with self.write() as conn:
            conn.execute("DELETE FROM documents WHERE source_path=?", (document.source_path,))
            conn.execute(
                "INSERT INTO documents(id,collection_id,source_path,title,doc_type,content_hash,parsed_path,size_bytes,page_count,source_mtime,ingested_at,flavor,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (document.id, document.collection_id, document.source_path,
                    document.title, document.doc_type, document.content_hash,
                    document.parsed_path, document.size_bytes, document.page_count or 0,
                    document.source_mtime, document.ingested_at, document.flavor, json.dumps(document.metadata)))
            section_params = []
            for s in sections:
                section_params.append((s.id, s.document_id, s.ordinal, s.heading_path or "", s.heading or "",
                                       s.body, s.body_chars, s.page_anchor or 0, json.dumps(s.metadata)))
            if section_params:
                conn.executemany(
                    "INSERT INTO sections(id,document_id,ordinal,heading_path,heading,body,body_chars,page_anchor,metadata_json) VALUES (?,?,?,?,?,?,?,?,?)",
                    section_params)
            for c in concepts:
                conn.execute(
                    "INSERT INTO concepts(id,collection_id,name,slug,kind,definition,source_section_id,metadata_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(collection_id,slug,kind) DO UPDATE SET name=excluded.name,definition=excluded.definition",
                    (c.id, c.collection_id, c.name, c.slug, c.kind, c.definition or "", c.source_section_id, json.dumps(c.metadata)))
            if concept_links:
                conn.executemany(
                    "INSERT OR IGNORE INTO concept_links(src_concept_id,dst_concept_id,relation) VALUES (?,?,?)",
                    [(l.src_concept_id, l.dst_concept_id, l.relation) for l in concept_links])
            if section_concept_ids:
                conn.executemany(
                    "INSERT OR IGNORE INTO section_concepts(section_id,concept_id) VALUES (?,?)",
                    list(section_concept_ids))

    # ---- section reads -----------------------------------------------------

    def get_section(self, section_id: str):  # -> Section | None
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM sections WHERE id=?", (section_id,)).fetchone()
        if not row: return None
        return Section(
            id=row["id"], document_id=row["document_id"], ordinal=row["ordinal"],
            heading_path=row["heading_path"] or "", heading=row["heading"] or "", body=row["body"],
            body_chars=row["body_chars"], page_anchor=row["page_anchor"], metadata=_safe_json(row["metadata_json"]))

    def get_section_neighbors(self, section_id: str):  # -> (Section | None, Section | None)
        with self.connect() as conn:
            cur = conn.execute("SELECT document_id,ordinal FROM sections WHERE id=?", (section_id,)).fetchone()
            if not cur: return None, None
            prev_row = conn.execute(
                "SELECT * FROM sections WHERE document_id=? AND ordinal < ? ORDER BY ordinal DESC LIMIT 1",
                (cur["document_id"], cur["ordinal"])).fetchone()
            nxt_row = conn.execute(
                "SELECT * FROM sections WHERE document_id=? AND ordinal > ? ORDER BY ordinal ASC LIMIT 1",
                (cur["document_id"], cur["ordinal"])).fetchone()
        prev = None
        if prev_row:
            prev = Section(id=prev_row["id"], document_id=prev_row["document_id"], ordinal=prev_row["ordinal"],
                           heading_path=prev_row["heading_path"] or "", heading=prev_row["heading"] or "", body=prev_row["body"],
                           body_chars=prev_row["body_chars"], page_anchor=prev_row["page_anchor"], metadata=_safe_json(prev_row["metadata_json"]))
        nxt = None
        if nxt_row:
            nxt = Section(id=nxt_row["id"], document_id=nxt_row["document_id"], ordinal=nxt_row["ordinal"],
                          heading_path=nxt_row["heading_path"] or "", heading=nxt_row["heading"] or "", body=nxt_row["body"],
                          body_chars=nxt_row["body_chars"], page_anchor=nxt_row["page_anchor"], metadata=_safe_json(nxt_row["metadata_json"]))
        return prev, nxt

    def list_sections_for_document(self, document_id: str) -> list[Section]:
        result = []
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM sections WHERE document_id=? ORDER BY ordinal ASC", (document_id,)).fetchall()
        for r in rows:
            result.append(Section(
                id=r["id"], document_id=r["document_id"], ordinal=r["ordinal"],
                heading_path=r["heading_path"] or "", heading=r["heading"] or "", body=r["body"],
                body_chars=r["body_chars"], page_anchor=r["page_anchor"], metadata=_safe_json(r["metadata_json"])))
        return result

    # ---- search ------------------------------------------------------------

    def search_sections(
        self, *, match_expr: str, collection_id: str | None = None, doc_type: str | None = None,
        flavor: str | None = None, limit: int = 10,
    ) -> list[SearchHit]:
        params: list[Any] = [match_expr]
        filters = ""
        if collection_id:
            filters += " AND d.collection_id=?"; params.append(collection_id)
        if doc_type:
            filters += " AND d.doc_type=?"; params.append(doc_type)
        if flavor:
            filters += " AND d.flavor=?"; params.append(flavor)
        fql = ("SELECT s.id AS section_id, s.heading, s.heading_path, s.body, s.page_anchor," +
               " d.id AS document_id, d.title AS document_title," +
               " d.collection_id, d.source_path," +
               " bm25(sections_fts) AS score, " +
               " snippet(sections_fts, 2, '[', ']', '...', 24) AS snippet" +
               " FROM sections_fts JOIN sections s ON s.rowid=sections_fts.rowid" +
               " JOIN documents d ON d.id=s.document_id" +
               f" WHERE sections_fts MATCH ?{filters} ORDER BY score ASC LIMIT ?")
        hits = []
        with self.connect() as conn:
            rows = conn.execute(fql, params + [min(limit, 25)]).fetchall()
        for r in rows:
            snippet = (r["snippet"] or r["body"][:200] or "").strip()
            hits.append(SearchHit(
                section_id=r["section_id"], document_id=r["document_id"],
                document_title=r["document_title"], collection_id=r["collection_id"],
                heading_path=r["heading_path"] or "", heading=r["heading"] or "",
                snippet=snippet, score=float(r["score"]), source_path=r["source_path"], page_anchor=r["page_anchor"]))
        return hits

    # ---- concepts / ontology -----------------------------------------------

    def get_concept(self, concept_id: str):  # -> Concept | None
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM concepts WHERE id=?", (concept_id,)).fetchone()
        if not row: return None
        return Concept(
            id=row["id"], collection_id=row["collection_id"],
            name=row["name"] or "", slug=row["slug"], kind=row["kind"],
            definition=row["definition"] or "", source_section_id=row["source_section_id"],
                                metadata=_safe_json(row["metadata_json"]))

    def list_concepts(
        self, *, collection_id: str | None = None, kind: str | None = None, limit: int = 100,
    ) -> list[Concept]:
        sql = "SELECT * FROM concepts WHERE 1=1"
        params: list[Any] = []
        if collection_id:
            sql += " AND collection_id=?"; params.append(collection_id)
        if kind:
            sql += " AND kind=?"; params.append(kind)
        sql += " ORDER BY name COLLATE NOCASE ASC LIMIT ?"
        params.append(min(limit, 1000))
        result = []
        with self.connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        for r in rows:
            result.append(Concept(
                id=r["id"], collection_id=r["collection_id"], name=r["name"] or "", slug=r["slug"],
                kind=r["kind"], definition=r["definition"] or "", source_section_id=r["source_section_id"],
                    metadata=_safe_json(r["metadata_json"])))
        return result

    def related_concepts(self, concept_id: str, *, limit: int = 25):  # -> [(Concept, str), ...]
        result = []
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT c.*, l.relation AS _rel FROM concept_links l JOIN concepts c ON c.id=l.dst_concept_id" +
                " WHERE l.src_concept_id=? LIMIT ?", (concept_id, limit)).fetchall()
        for r in rows:
            result.append((Concept(
                id=r["id"], collection_id=r["collection_id"], name=r["name"] or "", slug=r["slug"],
                kind=r["kind"], definition=r["definition"] or "", source_section_id=r["source_section_id"],
                    metadata=_safe_json(r["metadata_json"])), r["_rel"]))
        return result

    # ---- ingest / audit log ---

    def record_ingest_event(self, *, source_path: str, status: str, message: str | None = None, started_at: int | None = None, finished_at: int | None = None) -> None:
        with self.write() as conn:
            conn.execute("INSERT INTO ingest_log(source_path,status,message,started_at,finished_at) VALUES (?,?,?,?,?)",
                         (source_path, status, message, started_at, finished_at))

    def recent_ingest_log(self, limit: int = 50) -> list[IngestLogEntry]:
        result = []
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM ingest_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        for r in rows:
            result.append(IngestLogEntry(
                id=r["id"], source_path=r["source_path"], status=r["status"], message=r["message"],
                    started_at=r["started_at"], finished_at=r["finished_at"]))
        return result

    # ---- maintenance helpers ---

    def get_document_count(self, collection_id: str | None = None) -> int:  # type: ignore[return-value]
        sql = "SELECT COUNT(*) AS cnt FROM documents WHERE 1=1"
        params: list[Any] = []
        if collection_id:
            sql += " AND collection_id=?"; params.append(collection_id)
        with self.connect() as conn:
            return conn.execute(sql, params).fetchone()["cnt"]

    def count_collections(self) -> int:  # type: ignore[return-value]
        with self.connect() as conn:
            return conn.execute("SELECT COUNT(*) AS cnt FROM collections").fetchone()["cnt"]


# ---- helpers -------------------------------------------------------------

def _safe_json(raw: str | None) -> dict[str, Any]:
    if not raw: return {}
    try: val = json.loads(raw); return val if isinstance(val, dict) else {}  # type: ignore[return-value]
    except (json.JSONDecodeError, TypeError): return {}


# ---- DDL -----------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL UNIQUE, title TEXT NOT NULL, doc_type TEXT NOT NULL,
  content_hash TEXT NOT NULL, parsed_path TEXT, size_bytes INTEGER NOT NULL, page_count INTEGER,
  source_mtime INTEGER NOT NULL, ingested_at INTEGER NOT NULL, flavor TEXT NOT NULL DEFAULT 'raw',
  metadata_json TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY, document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, heading_path TEXT NOT NULL DEFAULT '', heading TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL, body_chars INTEGER NOT NULL, page_anchor INTEGER, metadata_json TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS concepts (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, name TEXT NOT NULL,
  slug TEXT NOT NULL, kind TEXT NOT NULL, definition TEXT NOT NULL DEFAULT '', source_section_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}', UNIQUE(collection_id, slug, kind));

CREATE TABLE IF NOT EXISTS concept_links (src_concept_id TEXT NOT NULL, dst_concept_id TEXT NOT NULL, relation TEXT NOT NULL, PRIMARY KEY(src_concept_id, dst_concept_id, relation));

CREATE TABLE IF NOT EXISTS section_concepts (section_id TEXT NOT NULL, concept_id TEXT NOT NULL, PRIMARY KEY(section_id, concept_id));

CREATE TABLE IF NOT EXISTS ingest_log (id INTEGER PRIMARY KEY AUTOINCREMENT, source_path TEXT NOT NULL, status TEXT NOT NULL, message TEXT, started_at INTEGER, finished_at INTEGER);

CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection_id);
CREATE INDEX IF NOT EXISTS idx_documents_flavor ON documents(flavor);
CREATE INDEX IF NOT EXISTS idx_concepts_collection ON concepts(collection_id);

-- FTS5 keyword search (porter unicode61 tokenizer).
CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(heading, heading_path, body, content='sections', content_rowid='rowid', tokenize='porter unicode61');

-- Triggers keep FTS5 in sync with the 'sections' table.
DROP TRIGGER if exists _s_ai; CREATE TRIGGER _s_ai AFTER INSERT ON sections BEGIN INSERT INTO sections_fts(rowid,heading,heading_path,body) VALUES (new.rowid,new.heading,new.heading_path,new.body); END;
DROP TRIGGER if exists _s_ad; CREATE TRIGGER _s_ad AFTER DELETE ON sections BEGIN INSERT INTO sections_fts(sections_fts,rowid,heading,heading_path,body) VALUES('delete',old.rowid,old.heading,old.heading_path,old.body); END;
DROP TRIGGER if exists _s_au; CREATE TRIGGER _s_au AFTER UPDATE ON sections BEGIN DELETE FROM sections_fts WHERE rowid=old.rowid; INSERT INTO sections_fts(rowid,heading,heading_path,body) VALUES (new.rowid,new.heading,new.heading_path,new.body); END;
"""
