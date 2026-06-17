/**
 * Azure AI Search service — initializes index, syncs docs, queries facts/bullets/annotations.
 */

import { getCredentialForUser } from '../services/entra-token';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyImport = any;

const SEARCH_SERVICE_NAME: string = process.env.AZURE_SEARCH_SERVICE ?? '';
const SEARCH_API_KEY: string   = process.env.AZURE_SEARCH_API_KEY   ?? '';
const INDEX_NAME: string        = 'resume-facts';

// Cloud-configurable endpoint suffix. Default Commercial; Gov/DoD: 'search.azure.us'.
const SEARCH_ENDPOINT_SUFFIX: string = process.env.AZURE_SEARCH_ENDPOINT_SUFFIX ?? 'search.windows.net';

function searchEndpoint(): string {
  return `https://${SEARCH_SERVICE_NAME}.${SEARCH_ENDPOINT_SUFFIX}`;
}

/**
 * Credential for Azure AI Search. Uses the admin API key when AZURE_SEARCH_API_KEY is set;
 * otherwise Microsoft Entra ID (managed identity) — required for DoD IL5.
 */
function getSearchCredential(userAssertionToken?: string): AnyImport {
  if (SEARCH_API_KEY) {
    const { AzureKeyCredential } = require('@azure/core-auth');
    return new AzureKeyCredential(SEARCH_API_KEY);
  }
  return getCredentialForUser(userAssertionToken);
}

let _indexClient: AnyImport | null = null;

function getIndexClient(): AnyImport {
  if (!_indexClient) {
    if (!SEARCH_SERVICE_NAME) {
      return getNoOpSearchClient();
    }
    const endpoint = searchEndpoint();
    // @ts-ignore-next-line -- Azure SDK type compatibility with dynamic require
    _indexClient = new ((globalThis as AnyImport).SearchIndexClient || (require('@azure/search-documents').SearchIndexClient))(endpoint, getSearchCredential());
  }
  return _indexClient;
}

/* ───────────── Index definition ───────────── */

/** Create or verify the resume-facts index during service startup. */
export async function ensureSearchIndex(): Promise<void> {
  if (!SEARCH_SERVICE_NAME) {
    console.log('[Search] Azure AI Search not configured — operations are no-op');
    return;
  }

  const client = getIndexClient();
  let exists = false;
  try {
    // @ts-ignore -- enumerateIndexes / listIndexes vary by SDK version
    const iter = client.listIndexes ? client.listIndexes({}) : {};
    for await (const idx of (iter as any)) {
      if (idx.name === INDEX_NAME) { exists = true; break; }
    }
  } catch { exists = false; }

  if (!exists) {
    // @ts-ignore -- field definitions vary by SDK version
    await client.createIndex({
      name: INDEX_NAME,
      fields: [
        { name: 'id',         type: 'Edm.String',  key: true } as any,
        { name: 'tenantId',   type: 'Edm.String' } as any,
        { name: 'personId',   type: 'Edm.String' } as any,
        { name: 'extractionRunId', type: 'Edm.String' } as any,
        { name: 'sectionId',  type: 'Collection(Edm.String)' } as any,
        { name: 'factKey',    type: 'Edm.String' } as any,
        { name: 'factValue',  type: 'Edm.String', searchable: true } as any,
        { name: 'bulletText', type: 'Edm.String', searchable: true } as any,
        { name: 'normalizedValue', type: 'Edm.String' } as any,
        { name: 'createdAt',  type: 'Edm.DateTimeOffset' } as any,
      ],
      semanticSearch: { configurations: [{ name: 'semantic-config' }] } as any,
    });
    console.log('[Search] Created index:', INDEX_NAME);
  } else {
    console.log('[Search] Index already exists:', INDEX_NAME);
  }
}

/* ───────────── Document upsert helpers ───────────── */

/**
 * Upsert a single document into the search index.
 */
// @ts-ignore-next-line 
export async function upsertSearchDocument(doc: Record<string, unknown>): Promise<void> {
  if (!SEARCH_SERVICE_NAME) return;

  const endpoint = searchEndpoint();
  // @ts-ignore -- constructor signatures vary by SDK version
  const searchClient = new ((globalThis as any)?.SearchClient || (require('@azure/search-documents')?.SearchClient))(endpoint, getSearchCredential());

  await searchClient.mergeOrUploadDocuments([doc]);
}

/** Bulk upsert a batch of documents into the index. */
export async function bulkUpsertSearchDocuments(docs: Record<string, unknown>[]): Promise<void> {
  if (!SEARCH_SERVICE_NAME) return;

  const endpoint = searchEndpoint();
  // @ts-ignore
  const searchClient = new ((globalThis as any)?.SearchClient || (require('@azure/search-documents')?.SearchClient))(endpoint, getSearchCredential());

  for (const doc of docs) {
    if (!doc.id) continue;
    await searchClient.mergeOrUploadDocuments([doc]);
  }
}

/* ───────────── Query helpers ───────────── */

export interface SearchQueryOptions {
  query:       string;
  sectionId?:  string;
  personId?:   string;
  factKey?:    string;
  top?:         number;
  skip?:        number;
  userAssertionToken?: string;
}

/** Full-text search across bullets and facts, with optional filters. */
export async function searchResumeContents(options: SearchQueryOptions): Promise<Record<string, unknown>[]> {
  if (!SEARCH_SERVICE_NAME) return [];

  const { query, top = 20, skip = 0, userAssertionToken, ...filters } = options;

  let filterParts: string[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === 'string' && value) {
      filterParts.push(`${key} eq '${value}'`);
    } else if (Array.isArray(value)) {
      const vals = (value as string[]).map((v: unknown) => `'${v}'`).join(', ');
      filterParts.push(`any(f: f in ${key}, search.equals_any(f, [${vals}]))`);
    }
  }
  const filter = filterParts.length ? ` and ${filterParts.join('\n')}` : '';

  const endpoint = searchEndpoint();
  // @ts-ignore -- SearchClient constructor/signature compatibility
  const searchClient = new ((globalThis as any)?.SearchClient || (require('@azure/search-documents')?.SearchClient))(endpoint, getSearchCredential(userAssertionToken));

  let results: any;
  try {
    results = await searchClient.search(query, {
      skip: skip,
      top: top,
      // @ts-ignore -- $count optional in some SDK versions
      count: true,
      filter: filter || undefined,
    } as any);
  } catch {
    return [];
  }

  const rawResults = results.results || results.value || [];
  // @ts-ignore -- SearchResultIterator vs array varies by SDK version
  const allItems: any[] = Array.isArray(rawResults) ? rawResults : [];

  return allItems.map((r: any) => ({
    ...r.document,
    score: r.score || 0,
    highlights: (r.highlights as any)?.bulletText ?? null,
  }));
}

/* ───────────── No-op fallback — for dev / missing env vars ───────────── */

function getNoOpSearchClient(): AnyImport {
  return new (class {
    mergeOrUploadDocuments(_docs: any[]) { return Promise.resolve(); }
  })();
}

export const noopUpser = async (_doc: Record<string, unknown>) => {};
