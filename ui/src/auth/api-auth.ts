/**
 * Auth-aware API client — attaches Bearer tokens to every request.
 * Called by components to sync their auth token into the API client's request headers.
 */

import type { ExtractionRun, BulletDiff } from '../api';

let _token: string | null = null;
let _apiBaseUrl: string = import.meta.env.VITE_API_URL ?? '/api/v1';

export function initApiAuth(basePath: string, token: string | null): void {
  if (basePath) _apiBaseUrl = basePath;
  _token = token;
}

/** Attach Bearer token to all subsequent API calls. */
export function setAuthToken(token: string | null): void { _token = token; }

export function getApiAuthToken(): string | null {
  return _token;
}

/** Raw fetch wrapper — adds Authorization header if a token is available. */
async function jsonWithAuth<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (_token) headers.set('Authorization', `Bearer ${_token}`);

  const init: RequestInit = { method, headers, body: body ? JSON.stringify(body) : undefined };
  
  const res = await fetch(`${_apiBaseUrl}${path}`, init);
  if (res.status === 204 || res.status === 205) return null as T;

  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(detail.error ?? `API ${method} ${path}: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// ── Ingestion ───────────────────────────────────────────────

export const apiIngestion = {
  create: (body: { tenantId: string; sourceDocuments: Array<{ name: string; mimeType: string; blobPath?: string; uri?: string; sourceType: 'web' | 'upload'; capturedAt?: string }> }) =>
    jsonWithAuth<unknown>(`POST`, `/ingestion-requests`, body).then(r => ({ runId: (r as any).runId, status: (r as any).status })),

  getStatus: (runId: string) => jsonWithAuth<ExtractionRun>(`GET`, `/ingestion-requests/${runId}/status`),

  listAll: (tenantId?: string) => {
    const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
    return jsonWithAuth<ExtractionRun[]>(`GET`, `/ingestion-requests${qs}`);
  },
};

// ── Bullet Mappings & Facts ────────────────────────────────

export const apiInsights = {
  getBullets: (personId: string, section?: string) => 
    jsonWithAuth<any>(`GET`, `/insights/${personId}/bullet-mappings${section ? `?section=${encodeURIComponent(section)}` : ''}`),

  getFacts: (personId: string, section?: string) => 
    jsonWithAuth<any>(`GET`, `/insights/${personId}/facts${section ? `?section=${encodeURIComponent(section)}` : ''}`),

  getDiffs: (personId: string) => jsonWithAuth<BulletDiff[]>(`GET`, `/insights/${personId}/differences`),
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
  createdAt?: string;
}

export const apiSearch = {
  search: (query: string, options?: { sectionId?: string; personId?: string }) =>
    jsonWithAuth<{ results: SearchResult[] }>('POST', '/search', { query, ...options }).then(r => r.results ?? []),
};

// ── Stats ─────────────────────────────────────────────────────

export interface StatsResponse {
  factsTotal: number;
  bulletsTotal: number;
  runsPending: number;
  searchConfigured: boolean;
}
