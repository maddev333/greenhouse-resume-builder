/**
 * Auth-aware API client — attaches Bearer tokens to every request.
 * Called by components to sync their auth token into the API client's request headers.
 */

import { getAccessToken as msalGetAccessToken } from './useAuth';

let _token: string | null = null;
let _apiBaseUrl: string = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';
let _tokenProvider: (() => Promise<string | null>) | null = null;

export interface ExtractionRun {
  id: string;
  status: string;
  createdAt: string;
  completedAt?: string | null;
  personId?: string;
}

export type BulletDiff = {
  type: 'added' | 'removed' | 'changed';
  previousBulletText?: string;
  currentBulletText: string;
  currentCitations?: string[];
};

export function initApiAuth(basePath: string, token: string | null): void {
  if (basePath) _apiBaseUrl = basePath;
  _token = token;
}

/** Attach Bearer token to all subsequent API calls. */
export function setAuthToken(token: string | null): void { _token = token; }

/** Attach a live token provider so each request can silently refresh before sending. */
export function setAuthTokenProvider(provider: (() => Promise<string | null>) | null): void {
  _tokenProvider = provider;
}

export function getApiAuthToken(): string | null {
  return _token;
}

export async function getApiAuthTokenAsync(): Promise<string | null> {
  // Prefer the explicitly-registered provider, but fall back to MSAL directly. The provider is
  // wired in a root-level effect; child components' first data-fetch effects run before that effect
  // (React flushes effects child-before-parent), so without this fallback the very first authenticated
  // request would go out with no Bearer token and 401 under enforced auth.
  const provider = _tokenProvider ?? msalGetAccessToken;
  const token = await provider();
  _token = token;
  return token;
}

export async function buildAuthHeaders(headers?: HeadersInit): Promise<Headers> {
  const merged = new Headers(headers);
  const token = await getApiAuthTokenAsync();
  if (token) merged.set('Authorization', `Bearer ${token}`);
  return merged;
}

export async function fetchWithAuth(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = await buildAuthHeaders(init.headers);
  const url = /^https?:\/\//i.test(path) ? path : `${_apiBaseUrl}${path}`;
  return fetch(url, { ...init, headers });
}

/** Raw fetch wrapper — adds Authorization header if a token is available. */
export async function jsonWithAuth<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) headers.set('Content-Type', 'application/json');

  const init: RequestInit = { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined };
  const res = await fetchWithAuth(path, init);
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
