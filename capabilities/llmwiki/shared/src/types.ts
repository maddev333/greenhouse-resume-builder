/**
 * @greenhouse-resume-builder/llmwiki-shared
 *
 * Domain types ported from the LLMWiki MCP Server's llmwiki/models.py dataclasses.
 * These are kept minimal — plain interfaces with no logic — so they serialize cleanly
 * as JSON through any MCP transport (JSON-RPC over Streamable HTTP).
 */

/* ------------------------------------------------------------------ */
/*  Collection                                                         */
/* ------------------------------------------------------------------ */

export interface CollectionInfo {
  id: string;
  name: string;
  description: string;
  created_at: number;
  document_count?: number;
  section_count?: number;
  concept_count?: number;
  last_ingested_at?: number | null;
}

/* ------------------------------------------------------------------ */
/*  Document                                                           */
/* ------------------------------------------------------------------ */

export interface DocumentInfo {
  id: string;
  collection_id: string;
  source_path: string;
  title: string;
  doc_type: 'txt' | 'md' | 'pdf' | 'html' | 'docx' | 'xlsx' | 'pptx' | 'png' | 'jpg' | 'heif';
  content_hash: string;
  parsed_path: string | null;
  size_bytes: number;
  page_count: number | null;
  source_mtime: number;
  ingested_at: number;
  flavor: 'raw' | 'wiki';
  metadata: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Section                                                            */
/* ------------------------------------------------------------------ */

export interface SectionInfo {
  id: string;
  document_id: string;
  ordinal: number;
  heading_path: string;
  heading: string;
  body: string;
  body_chars: number;
  page_anchor: number | null;
  metadata: Record<string, unknown>;
}

export interface SectionResult extends SectionInfo {
  document?: DocumentInfo | null;
  previous_section_id: string | null;
  next_section_id: string | null;
  truncated?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Concept                                                            */
/* ------------------------------------------------------------------ */

export type ConceptKind = 'concept' | 'rule' | 'entity' | 'template';

export interface ConceptInfo {
  id: string;
  collection_id: string;
  name: string;
  slug: string;
  kind: ConceptKind;
  definition: string;
  source_section_id: string | null;
  metadata: Record<string, unknown>;
}

export interface ConceptLink {
  src_concept_id: string;
  dst_concept_id: string;
  relation: string;
}

/* ------------------------------------------------------------------ */
/*  Search                                                             */
/* ------------------------------------------------------------------ */

export interface SearchHit {
  section_id: string;
  document_id: string;
  document_title: string;
  collection_id: string;
  heading_path: string;
  heading: string;
  snippet: string;
  score: number;
  source_path: string;
  page_anchor: number | null;
  /** Vector similarity component (only present when hybrid search is active). */
  vector_score?: number;
}

export interface SearchOptions {
  collectionId?: string;
  docType?: string;
  flavor?: 'raw' | 'wiki';
  limit?: number;
}

/* ------------------------------------------------------------------ */
/*  Validation                                                         */
/* ------------------------------------------------------------------ */

export interface Finding {
  rule_concept_id: string;
  rule_name: string;
  severity: 'info' | 'warn' | 'error';
  evidence: string;
  suggestion: string;
  citation: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Ingest                                                             */
/* ------------------------------------------------------------------ */

export type IngestStatusValue = 'queued' | 'parsing' | 'indexed' | 'error' | 'skipped';

export interface IngestLogEntry {
  id: number;
  source_path: string;
  status: IngestStatusValue;
  message: string | null;
  started_at: number | null;
  finished_at: number | null;
}

/** Status shape returned by ingest_status tool. */
export interface IngestStatus {
  polling_interval: number;
  last_poll_time: number | null;
  watched_dirs: { corpus: string; wiki: string };
  recent_log?: IngestLogEntry[];
}

/* ------------------------------------------------------------------ */
/*  Wiki Health                                                        */
/* ------------------------------------------------------------------ */

export type FindingKind = 'orphan' | 'broken_link' | 'index_gap' | 'missing_canonical';
export type FindingSeverity = 'info' | 'warn' | 'error';

export interface WikiHealthFinding {
  kind: FindingKind;
  severity: FindingSeverity;
  page: string;
  detail: string;
  target?: string | null;
}
