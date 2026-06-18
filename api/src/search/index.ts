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
  const raw = SEARCH_SERVICE_NAME.trim().replace(/\/+$/, '');
  // Accept any of: a full URL (https://svc.search.windows.net), a fully-qualified
  // host (svc.search.windows.net), or a bare service name (svc).
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.includes('.')) return `https://${raw}`;
  return `https://${raw}.${SEARCH_ENDPOINT_SUFFIX}`;
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
      semanticSearch: {
        configurations: [{
          name: 'semantic-config',
          // prioritizedFields must be a defined object (the SDK serializer reads
          // titleField/contentFields off it directly); fields referenced here must
          // be searchable string fields — only factValue & bulletText qualify.
          prioritizedFields: {
            titleField: { name: 'factValue' },
            contentFields: [{ name: 'bulletText' }],
          },
        }],
      } as any,
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
  const searchClient = new ((globalThis as any)?.SearchClient || (require('@azure/search-documents')?.SearchClient))(endpoint, INDEX_NAME, getSearchCredential());

  await searchClient.mergeOrUploadDocuments([doc]);
}

/** Bulk upsert a batch of documents into the index. */
export async function bulkUpsertSearchDocuments(docs: Record<string, unknown>[]): Promise<void> {
  if (!SEARCH_SERVICE_NAME) return;

  const endpoint = searchEndpoint();
  // @ts-ignore
  const searchClient = new ((globalThis as any)?.SearchClient || (require('@azure/search-documents')?.SearchClient))(endpoint, INDEX_NAME, getSearchCredential());

  for (const doc of docs) {
    if (!doc.id) continue;
    await searchClient.mergeOrUploadDocuments([doc]);
  }
}

/* ───────────── Query helpers ───────────── */

export interface SearchQueryOptions {
  query:       string;
  /** Verified Entra `tid` claim. Mandatory security trim — a query without it is rejected (fail closed). */
  tenantId?:   string;
  sectionId?:  string;
  personId?:   string;
  factKey?:    string;
  /** Verified Entra app roles (`roles` claim) — gate sensitive attributes. */
  roles?:      string[];
  /** Verified Entra delegated scopes (`scp` claim) — gate sensitive attributes. */
  scopes?:     string[];
  top?:         number;
  skip?:        number;
  userAssertionToken?: string;
}

/** Escape a string literal for an OData filter (single quotes are doubled per the OData grammar). */
function odataEscapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Entra roles/scopes permitted to read sensitive attributes. Cloud-configurable so the privileged
 * role/scope names match the app registration's appRoles / exposed API scopes.
 */
const SENSITIVE_READ_ROLES = (process.env.FACTS_SENSITIVE_READ_ROLES ?? 'ClearedReviewer,Admin')
  .split(',').map((s) => s.trim()).filter(Boolean);
const SENSITIVE_READ_SCOPES = (process.env.FACTS_SENSITIVE_READ_SCOPES ?? 'Facts.ReadSensitive')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** factKeys treated as sensitive/need-to-know: temporal `event.*` facts and any precise `*.location` fact. */
function isSensitiveFactKey(factKey: unknown): boolean {
  return typeof factKey === 'string' && (factKey.startsWith('event.') || factKey.endsWith('.location'));
}

/** A caller may read sensitive attributes only with a privileged Entra app role or delegated scope. */
function canReadSensitiveAttributes(roles?: string[], scopes?: string[]): boolean {
  return (roles ?? []).some((r) => SENSITIVE_READ_ROLES.includes(r))
    || (scopes ?? []).some((s) => SENSITIVE_READ_SCOPES.includes(s));
}

/**
 * Full-text search across bullets and facts, security-trimmed by the caller's verified Entra claims.
 *
 * Enforcement:
 *  - **Tenant isolation (row-level):** a mandatory `tenantId eq '<tid>'` OData filter; a query with no
 *    verified tenant claim is rejected (fail closed), so one tenant can never read another's facts.
 *  - **Attribute-level trim:** sensitive factKeys (temporal `event.*`, precise `*.location`) are redacted
 *    unless the caller's Entra `roles`/`scp` include a privileged value.
 *
 * Optional `personId`/`sectionId`/`factKey` narrow within the tenant. All literals are OData-escaped, and
 * `sectionId` is matched as a collection field (`Collection(Edm.String)` in the index schema).
 */
export async function searchResumeContents(options: SearchQueryOptions): Promise<Record<string, unknown>[]> {
  if (!SEARCH_SERVICE_NAME) return [];

  const { query, tenantId, sectionId, personId, factKey, roles, scopes, top = 20, skip = 0, userAssertionToken } = options;

  // Fail closed: the attribute layer is tenant-scoped, so a missing/empty tenant claim must never
  // widen to a cross-tenant query (the prior implementation applied no tenant filter at all).
  if (!tenantId) {
    console.warn('[Search] Rejected: no verified tenantId claim — attribute-layer queries must be tenant-trimmed.');
    return [];
  }

  // Mandatory tenant trim first, then optional exact-match narrowing within the tenant.
  const filterParts: string[] = [`tenantId eq '${odataEscapeLiteral(tenantId)}'`];
  if (personId) filterParts.push(`personId eq '${odataEscapeLiteral(personId)}'`);
  if (factKey) filterParts.push(`factKey eq '${odataEscapeLiteral(factKey)}'`);
  if (sectionId) filterParts.push(`sectionId/any(s: s eq '${odataEscapeLiteral(sectionId)}')`);
  const filter = filterParts.join(' and ');

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
      filter,
    } as any);
  } catch {
    return [];
  }

  const rawResults = results.results || results.value || [];
  // @ts-ignore -- SearchResultIterator vs array varies by SDK version
  const allItems: any[] = Array.isArray(rawResults) ? rawResults : [];

  // Attribute-level trim: drop sensitive factKeys unless the caller's Entra claims permit them.
  const allowSensitive = canReadSensitiveAttributes(roles, scopes);
  const visible = allowSensitive
    ? allItems
    : allItems.filter((r: any) => !isSensitiveFactKey(r.document?.factKey));

  return visible.map((r: any) => ({
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
