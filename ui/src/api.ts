/**
 * API client — typed fetch wrapper for the Greenhouse Resume Builder.
 */

import { fetchWithAuth, jsonWithAuth } from './auth/api-auth';

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  return jsonWithAuth<T>(method, path, body);
}

export type ExtractionRun = { id: string; status: string; createdAt: string; completedAt?: string | null; personId?: string };
export type BulletMapping = { bulletId: string; bulletText: string; sectionId: string; citationFactVersionIds: string[]; citationSourceDocumentIds: string[]; createdAt: string };
export type FactVersion = { factVersionId: string; sectionId: string; factKey: string; factValue: any; extractedAt: string; confidence?: number; status: string };
export type AnnotationItem = { id: string; commentText: string; targetFactVersionId: string; status: 'open' | 'resolved'; createdAt: string; createdByUserId: string; personId?: string };
export type RelationshipEdge = { relationshipId: string; fromPersonId: string; toPersonId: string; fromPersonName?: string | null; toPersonName?: string | null; relationshipType: string; status: string; confidence?: number };
export type BulletDiff = { type: 'added' | 'removed' | 'changed'; previousBulletText?: string; currentBulletText: string; currentCitations?: string[] }

// ── Ingestion ───────────────────────────────────────────────

export const apiIngestion = {
  /** Submit a new extraction ingestion request. */
  create: (body: { tenantId: string; sourceDocuments: Array<{ name: string; mimeType: string; blobPath?: string; uri?: string; sourceType: 'web' | 'upload'; capturedAt?: string }> }) =>
    json<unknown>(`POST`, `/ingestion-requests`, body).then(r => ({ runId: (r as any).runId, status: (r as any).status })),

  /** Get the current status of an extraction run. */
  getStatus: (runId: string) => json<ExtractionRun>(`GET`, `/ingestion-requests/${runId}/status`),

  /** List recent ingestion runs for a tenant. */
  listAll: (tenantId?: string) => {
    const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
    return json<ExtractionRun[]>(`GET`, `/ingestion-requests${qs}`);
  },
};

// ── Bullet Mappings & Facts ────────────────────────────────

export const apiInsights = {
  /** Get all bullets and citations for a person. */
  getBullets: (personId: string, section?: string) => 
    json<any>(`GET`, `/insights/${personId}/bullet-mappings${section ? `?section=${encodeURIComponent(section)}` : ''}`),

  /** Get facts (raw extracted values) for a person. */
  getFacts: (personId: string, section?: string) => 
    json<any>(`GET`, `/insights/${personId}/facts${section ? `?section=${encodeURIComponent(section)}` : ''}`),

  /** Bullet-level diffs between the latest extraction run and the previous one. */
  getDiffs: (personId: string) => json<BulletDiff[]>(`GET`, `/insights/${personId}/differences`),
};

// ── Annotations ─────────────────────────────────────────────

export const apiAnnotations = {
  /** Create or update an annotation on a FactVersion. */
  upsert: (id: string, body: { commentText: string; targetFactVersionId?: string }) =>
    json<AnnotationItem>(`PUT`, `/annotations/${id}`, body),

  /** List annotations — optionally scoped to a factVersion or person. */
  list: (params?: { factVersionId?: string; personId?: string; limit?: number }) => {
    const parts: string[] = [];
    if (params?.factVersionId) parts.push(`factVersionId=${encodeURIComponent(params.factVersionId)}`);
    if (params?.personId)     parts.push(`personId=${encodeURIComponent(params.personId!)}`);
    if (params?.limit)        parts.push(`limit=${params.limit}`);
    const qs = parts.length ? `?${parts.join('&')}` : '';
    return json<AnnotationItem[]>(`GET`, `/annotations${qs}`);
  },

  /** Update annotation status. */
  updateStatus: (id: string, status: 'open' | 'resolved') =>
    json<any>(`PATCH`, `/annotations/${id}`, { status }),

  /** Delete an annotation. */
  remove: (id: string) => fetchWithAuth(`/annotations/${id}`, { method: 'DELETE' }).then(r => r.status),
};

// ── Relationships ───────────────────────────────────────────

export const apiRelationships = {
  /** Get suggested relationships for a person. */
  getSuggested: (personId: string) => json<{ candidates: RelationshipEdge[] }>(`GET`, `/inferences/${personId}/suggested`),

  /** Update relationship status (confirm / reject). */
  updateStatus: (relId: string, body: { status: 'confirmed' | 'rejected'; fromPersonId?: string; toPersonId?: string }) =>
    json<{ updated: boolean }>(`PATCH`, `/inferences/${relId}`, body),
};

// ── Search ────────────────────────────────────────────────────

export interface SearchResult {
  id: string;
  score?: number;
  highlights: string | null;
  tenantId: string;
  personId: string;
  extractionRunId?: string;
  sectionId?: string[];
  factKey?: string;
  factValue?: string;
  bulletText?: string;
  normalizedValue?: string;
  createdAt?: string;
}

export const apiSearch = {
  /** Search across all facts + bullets by full-text query. */
  search: (query: string, options?: { sectionId?: string; personId?: string }) =>
    json<{ results: SearchResult[] }>('POST', '/search', { query, ...options }).then(r => r.results ?? []),
};

export interface StatsResponse {
  factsTotal: number;
  bulletsTotal: number;
  runsPending: number;
  searchConfigured: boolean;
}
