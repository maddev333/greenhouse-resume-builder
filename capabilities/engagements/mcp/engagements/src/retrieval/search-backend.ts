/**
 * Azure AI Search backend for the engagements read model — the CLOUD swap-in that satisfies the
 * SAME `SecurityDecision` / `TrimmedResult` contract as the in-memory {@link EngagementIndex}
 * (ARCHITECTURE §5.2–5.4). The security trim is enforced SERVER-SIDE as an OData `$filter`, so
 * unauthorized rows never leave the service — identical guarantee to the shim's predicate, only now
 * evaluated by Azure instead of in Node.
 *
 * Topology: ONE index (`engagements`) with a `kind` discriminator (`contact` | `event`) so the free
 * tier's 3-index cap is respected (`resume-facts` already occupies one). Each doc carries the
 * filterable governance envelope (`tenantId`, `aclGroups[]`, `sensitivity`, `topicIds[]`) the trim
 * evaluates, plus a retrievable `json` string holding the full {@link Labeled} record for lossless
 * reconstruction on read.
 *
 * Recall parity: `query`/`topicIds`/`status` are RECALL (they shape the base set); tenant + ACL +
 * sensitivity are the SECURITY trim. `redactedCount = |base| − |authorized|` is computed with two
 * count-only queries (server-side `$filter` never returns the trimmed rows, so the "watch a row
 * disappear" beat is reconstructed from the count delta).
 *
 * Auth: admin/query key when `AZURE_SEARCH_API_KEY` is set, else `DefaultAzureCredential`
 * (managed identity / `az login`) — matching `api/src/search/index.ts`.
 */
import { SearchClient, SearchIndexClient, AzureKeyCredential } from '@azure/search-documents';
import type { SearchField, SearchIndex } from '@azure/search-documents';
import { DefaultAzureCredential } from '@azure/identity';
import type { Contact, EngagementEvent, Preferences } from '@greenhouse-resume-builder/shared';
import { buildEngagementSecurityFilter, odataEscapeLiteral } from './security';
import type { ContactQuery, EventQuery } from './retrieval-index';
import type { Labeled, LabeledDataset, TrimmedResult } from './types';

const INDEX_NAME: string = process.env.ENGAGEMENTS_SEARCH_INDEX ?? 'engagements';
const ENDPOINT_SUFFIX: string = process.env.AZURE_SEARCH_ENDPOINT_SUFFIX ?? 'search.windows.net';

/** True when a search service is configured (else the capability falls back to the in-memory index). */
export function isSearchConfigured(): boolean {
  return Boolean((process.env.AZURE_SEARCH_SERVICE ?? '').trim());
}

function serviceEndpoint(): string {
  const raw = (process.env.AZURE_SEARCH_SERVICE ?? '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('AZURE_SEARCH_SERVICE is not set (expected the service name or full https:// endpoint).');
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.includes('.')) return `https://${raw}`;
  return `https://${raw}.${ENDPOINT_SUFFIX}`;
}

/** Admin/query key when present, otherwise Entra ID (managed identity / az login). */
function credential(): AzureKeyCredential | DefaultAzureCredential {
  const key = process.env.AZURE_SEARCH_API_KEY;
  return key ? new AzureKeyCredential(key) : new DefaultAzureCredential();
}

// ── Index document shape ───────────────────────────────────────────────────

/** The flattened, filterable projection stored per record; `json` reconstructs the domain object. */
export interface EngagementDoc {
  id: string;
  kind: 'contact' | 'event';
  tenantId: string;
  aclGroups: string[];
  sensitivity: string;
  topicIds: string[];
  status?: string;
  name: string;
  org?: string;
  smeText?: string;
  city?: string;
  state?: string;
  json: string;
}

/** Azure Search keys allow only letters, digits, `_`, `-`, `=`; namespace by kind + sanitize the id. */
const KEY_UNSAFE = /[^A-Za-z0-9_\-=]/g;
const docKey = (kind: string, id: string): string => `${kind}-${id.replace(KEY_UNSAFE, '_')}`;

function contactToDoc(c: Labeled<Contact>): EngagementDoc {
  return {
    id: docKey('contact', c.id),
    kind: 'contact',
    tenantId: c.tenantId,
    aclGroups: c.aclGroups,
    sensitivity: c.sensitivity,
    topicIds: c.topicIds ?? [],
    status: c.status,
    name: c.name,
    org: c.org ?? '',
    smeText: (c.smeAreas ?? []).join(' '),
    city: c.location.city,
    state: c.location.state ?? '',
    json: JSON.stringify(c),
  };
}

function eventToDoc(e: Labeled<EngagementEvent>): EngagementDoc {
  return {
    id: docKey('event', e.id),
    kind: 'event',
    tenantId: e.tenantId,
    aclGroups: e.aclGroups,
    sensitivity: e.sensitivity,
    topicIds: e.topicIds ?? [],
    name: e.name,
    city: e.location.city,
    state: e.location.state ?? '',
    json: JSON.stringify(e),
  };
}

// ── Index provisioning ─────────────────────────────────────────────────────

/** The single `engagements` index: filterable trim fields + searchable recall + retrievable `json`. */
function indexDefinition(): SearchIndex {
  // Runtime shape is proven against v13 `createOrUpdateIndex`; the literal → union cast avoids the
  // SDK's discriminated-field friction (same pragmatism as api/src/search/index.ts).
  const fields = [
    { name: 'id', type: 'Edm.String', key: true, filterable: true, sortable: true },
    { name: 'kind', type: 'Edm.String', filterable: true },
    { name: 'tenantId', type: 'Edm.String', filterable: true },
    { name: 'aclGroups', type: 'Collection(Edm.String)', filterable: true },
    { name: 'sensitivity', type: 'Edm.String', filterable: true },
    { name: 'topicIds', type: 'Collection(Edm.String)', filterable: true },
    { name: 'status', type: 'Edm.String', filterable: true },
    { name: 'name', type: 'Edm.String', searchable: true },
    { name: 'org', type: 'Edm.String', searchable: true },
    { name: 'smeText', type: 'Edm.String', searchable: true },
    { name: 'city', type: 'Edm.String', searchable: true, filterable: true },
    { name: 'state', type: 'Edm.String', searchable: true, filterable: true },
    { name: 'json', type: 'Edm.String' },
  ] as unknown as SearchField[];
  return { name: INDEX_NAME, fields };
}

/** Create or update the `engagements` index (idempotent). Requires index-management rights (admin key). */
export async function ensureEngagementIndex(): Promise<string> {
  const client = new SearchIndexClient(serviceEndpoint(), credential());
  const res = await client.createOrUpdateIndex(indexDefinition());
  return res.name;
}

/** Upsert every contact + event from a labeled dataset (the "reindex per data source" demo beat). */
export async function syncEngagementDocs(ds: LabeledDataset): Promise<{ contacts: number; events: number }> {
  const client = new SearchClient<EngagementDoc>(serviceEndpoint(), INDEX_NAME, credential());
  const docs: EngagementDoc[] = [...ds.contacts.map(contactToDoc), ...ds.events.map(eventToDoc)];
  if (docs.length) await client.mergeOrUploadDocuments(docs);
  return { contacts: ds.contacts.length, events: ds.events.length };
}

/** Upsert a single contact/event (demo add/update). */
export async function upsertEngagementContact(c: Labeled<Contact>): Promise<void> {
  const client = new SearchClient<EngagementDoc>(serviceEndpoint(), INDEX_NAME, credential());
  await client.mergeOrUploadDocuments([contactToDoc(c)]);
}
export async function upsertEngagementEvent(e: Labeled<EngagementEvent>): Promise<void> {
  const client = new SearchClient<EngagementDoc>(serviceEndpoint(), INDEX_NAME, credential());
  await client.mergeOrUploadDocuments([eventToDoc(e)]);
}

/** Delete a single record by kind + domain id (demo delete → reindex → row disappears). */
export async function deleteEngagementDoc(kind: 'contact' | 'event', id: string): Promise<void> {
  const client = new SearchClient<EngagementDoc>(serviceEndpoint(), INDEX_NAME, credential());
  await client.deleteDocuments('id', [docKey(kind, id)]);
}

// ── Security-trimmed retrieval (the swap target) ───────────────────────────

const KIND_CONTACT = "kind eq 'contact'";
const KIND_EVENT = "kind eq 'event'";

/** `search.in` membership over a collection field — mirrors `security.ts` exactly (recall convenience). */
function topicClause(topicIds: string[]): string {
  const list = topicIds.map(odataEscapeLiteral).join(',');
  return `topicIds/any(x: search.in(x, '${list}'))`;
}

const REJECTED = <T>(reason: string): TrimmedResult<T> => ({
  items: [],
  filter: `(rejected: ${reason})`,
  redactedCount: 0,
});

/** Preference narrowing — drops out-of-policy candidates. NEVER widens the trim (mirrors the shim). */
function narrowByPreferences<T extends { id: string; strategicValue: number }>(items: T[], prefs: Preferences): T[] {
  let out = items;
  if (prefs.doNotMeet?.length) out = out.filter((c) => !prefs.doNotMeet!.includes(c.id));
  if (typeof prefs.seniorityFloor === 'number') out = out.filter((c) => c.strategicValue >= prefs.seniorityFloor!);
  return out;
}

async function countMatching(client: SearchClient<EngagementDoc>, text: string, filter: string): Promise<number> {
  const res = await client.search(text, { filter, top: 0, includeTotalCount: true });
  return res.count ?? 0;
}

/**
 * Return contacts the caller is authorized to see — recall (kind + status + topic + query) is trimmed
 * SERVER-SIDE by the tenant + ACL + sensitivity `$filter`, then narrowed by caller preferences.
 * `redactedCount` = matches to the recall base that the security trim removed.
 */
export async function searchEngagementContacts(q: ContactQuery): Promise<TrimmedResult<Labeled<Contact>>> {
  const decision = buildEngagementSecurityFilter(q.ctx);
  if (!decision.allowed || !decision.filter) return REJECTED(decision.reason ?? 'unauthorized');

  const recallParts: string[] = [KIND_CONTACT];
  if (q.status) recallParts.push(`status eq '${odataEscapeLiteral(q.status)}'`);
  if (q.topicIds?.length) recallParts.push(topicClause(q.topicIds));
  const recallFilter = recallParts.join(' and ');
  const authorizedFilter = `${recallFilter} and ${decision.filter}`;
  const text = q.query?.trim() ? q.query : '*';

  const client = new SearchClient<EngagementDoc>(serviceEndpoint(), INDEX_NAME, credential());
  const resp = await client.search(text, { filter: authorizedFilter, top: 1000, includeTotalCount: true });
  const items: Labeled<Contact>[] = [];
  for await (const r of resp.results) items.push(JSON.parse(r.document.json) as Labeled<Contact>);

  const authorizedCount = resp.count ?? items.length;
  const baseCount = await countMatching(client, text, recallFilter);
  const redactedCount = Math.max(0, baseCount - authorizedCount);

  const narrowed = q.preferences ? narrowByPreferences(items, q.preferences) : items;
  return { items: narrowed, filter: decision.filter, redactedCount };
}

/** Return authorized anchor events, optionally matched by text/topic (same server-side trim). */
export async function searchEngagementEvents(q: EventQuery): Promise<TrimmedResult<Labeled<EngagementEvent>>> {
  const decision = buildEngagementSecurityFilter(q.ctx);
  if (!decision.allowed || !decision.filter) return REJECTED(decision.reason ?? 'unauthorized');

  const recallParts: string[] = [KIND_EVENT];
  if (q.topicIds?.length) recallParts.push(topicClause(q.topicIds));
  const recallFilter = recallParts.join(' and ');
  const authorizedFilter = `${recallFilter} and ${decision.filter}`;
  const text = q.query?.trim() ? q.query : '*';

  const client = new SearchClient<EngagementDoc>(serviceEndpoint(), INDEX_NAME, credential());
  const resp = await client.search(text, { filter: authorizedFilter, top: 1000, includeTotalCount: true });
  const items: Labeled<EngagementEvent>[] = [];
  for await (const r of resp.results) items.push(JSON.parse(r.document.json) as Labeled<EngagementEvent>);

  const authorizedCount = resp.count ?? items.length;
  const baseCount = await countMatching(client, text, recallFilter);
  return { items, filter: decision.filter, redactedCount: Math.max(0, baseCount - authorizedCount) };
}
