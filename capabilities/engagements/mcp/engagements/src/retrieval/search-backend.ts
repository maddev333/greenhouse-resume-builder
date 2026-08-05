/**
 * Azure AI Search backend for the engagements read model — the CLOUD swap-in that satisfies the
 * SAME result contract as the in-memory {@link EngagementIndex} (ARCHITECTURE §5.2).
 *
 * Topology: whatever the schema REGISTRY declares. Every read and write resolves the declaration
 * that claims the record kind (`declarationForKind`) and uses THAT declaration's index name, key,
 * discriminator, topic/status fields, payload field and searchable fields. So contacts and events
 * may sit in one index with a `kind` discriminator (the demo `engagements` index), or in separate
 * customer indexes with entirely different field names — nothing here assumes one shared index.
 *
 * Auth: admin/query key when `AZURE_SEARCH_API_KEY` is set, else `DefaultAzureCredential`
 * (managed identity / `az login`).
 */
import {
  SearchClient,
  SearchIndexClient,
  AzureKeyCredential,
} from "@azure/search-documents";
import { DefaultAzureCredential } from "@azure/identity";
import type {
  Contact,
  EngagementEvent,
  Preferences,
} from "@greenhouse-resume-builder/shared";
import { odataEscapeLiteral } from "./odata";
import { runSearch, searchLog as log } from "./search-errors.js";
import {
  declarationForKind,
  entityTypeValue,
  filterableField,
  indexName,
  loadIndexRegistry,
  payloadField,
  searchableFields,
  toSearchIndex,
  type IndexEntityKind,
  type IndexSchema,
} from "./index-schema";
import type { ContactQuery, EventQuery } from "./retrieval-index";
import type { Labeled, LabeledDataset } from "./types";

const ENDPOINT_SUFFIX: string =
  process.env.AZURE_SEARCH_ENDPOINT_SUFFIX ?? "search.windows.net";

/** True when a search service is configured (else the capability falls back to the in-memory index). */
export function isSearchConfigured(): boolean {
  return Boolean((process.env.AZURE_SEARCH_SERVICE ?? "").trim());
}

function serviceEndpoint(): string {
  const raw = (process.env.AZURE_SEARCH_SERVICE ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!raw)
    throw new Error(
      "AZURE_SEARCH_SERVICE is not set (expected the service name or full https:// endpoint).",
    );
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.includes(".")) return `https://${raw}`;
  return `https://${raw}.${ENDPOINT_SUFFIX}`;
}

/** Admin/query key when present, otherwise Entra ID (managed identity / az login). */
function credential(): AzureKeyCredential | DefaultAzureCredential {
  const key = process.env.AZURE_SEARCH_API_KEY;
  if (!key) {
    log.debug(
      "no AZURE_SEARCH_API_KEY -- authenticating with DefaultAzureCredential (managed identity / az login)",
    );
  }
  return key ? new AzureKeyCredential(key) : new DefaultAzureCredential();
}

// ── Declaration resolution ─────────────────────────────────────────────────

/** The declaration that claims a record kind. Throws when no configured index holds it. */
function declarationFor(kind: IndexEntityKind): IndexSchema {
  const schema = declarationForKind(kind);
  if (!schema) {
    const message =
      `No index declaration carries the "${kind}" record kind, so it cannot be read or written. ` +
      `Add "${kind}" to \`mapping.entityType\` in one of:\n` +
      loadIndexRegistry()
        .map((d) => `  ${d.id}: ${d.sourcePath}`)
        .join("\n");
    log.error(message);
    throw new Error(message);
  }
  return schema;
}

/** A client bound to the index THIS declaration names — never one shared index. */
function clientFor(schema: IndexSchema): SearchClient<EngagementDoc> {
  return new SearchClient<EngagementDoc>(
    serviceEndpoint(),
    indexName(schema),
    credential(),
  );
}

// ── Index document shape ───────────────────────────────────────────────────

/**
 * A document keyed by PHYSICAL field name. The mapped roles (key, discriminator, topicIds, status,
 * payload) are written under whatever names the target declaration gives them; the free-text
 * projection columns (`name`/`org`/`smeText`/`city`/`state`) have no mapping entry and so are
 * written literally, matching the demo `engagements` index.
 *
 * Writes are a DEMO facility — `ensure`/`sync` must never be aimed at a customer index.
 */
export type EngagementDoc = Record<string, unknown>;

/** Azure Search keys allow only letters, digits, `_`, `-`, `=`; namespace by kind + sanitize the id. */
const KEY_UNSAFE = /[^A-Za-z0-9_\-=]/g;
const docKey = (kind: string, id: string): string =>
  `${kind}-${id.replace(KEY_UNSAFE, "_")}`;

/** The mapped columns every document carries, named as the target declaration names them. */
function mappedDoc(
  schema: IndexSchema,
  kind: IndexEntityKind,
  record: { id: string },
  topicIds: string[],
  status?: string,
): EngagementDoc {
  const kindField = schema.mapping.entityType?.field;
  const kindValue = entityTypeValue(kind, schema);
  if (!kindField || !kindValue) {
    throw new Error(
      `Index declaration "${schema.id}" does not carry the "${kind}" record kind.\n  (${schema.sourcePath})`,
    );
  }

  const doc: EngagementDoc = {
    [schema.mapping.key]: docKey(kind, record.id),
    [kindField]: kindValue,
  };
  if (schema.mapping.topicIds) doc[schema.mapping.topicIds] = topicIds;
  if (schema.mapping.status && status) doc[schema.mapping.status] = status;
  if (schema.mapping.payload) {
    doc[schema.mapping.payload] = JSON.stringify(record);
  }
  return doc;
}

function contactToDoc(c: Labeled<Contact>, schema: IndexSchema): EngagementDoc {
  return {
    ...mappedDoc(schema, "contact", c, c.topicIds ?? [], c.status),
    name: c.name,
    org: c.org ?? "",
    smeText: (c.smeAreas ?? []).join(" "),
    city: c.location.city,
    state: c.location.state ?? "",
  };
}

function eventToDoc(
  e: Labeled<EngagementEvent>,
  schema: IndexSchema,
): EngagementDoc {
  return {
    ...mappedDoc(schema, "event", e, e.topicIds ?? []),
    name: e.name,
    city: e.location.city,
    state: e.location.state ?? "",
  };
}

// ── Index provisioning ─────────────────────────────────────────────────────

/** Project a reference record (leader/topic/message/region) into its declaration's document shape. */
function referenceDoc(
  kind: IndexEntityKind,
  record: { id: string; name?: string },
  schema: IndexSchema,
): EngagementDoc {
  return {
    ...mappedDoc(schema, kind, record, []),
    name: record.name ?? record.id,
  };
}

/**
 * Create or update EVERY index the registry declares (idempotent). Requires index-management rights
 * (admin key). Returns the index names, comma-joined; declarations sharing an index name are
 * applied once.
 */
export async function ensureEngagementIndex(): Promise<string> {
  const client = new SearchIndexClient(serviceEndpoint(), credential());
  const names: string[] = [];
  for (const schema of loadIndexRegistry()) {
    if (names.includes(indexName(schema))) continue;
    const res = await client.createOrUpdateIndex(toSearchIndex(schema));
    names.push(res.name);
  }
  return names.join(", ");
}

/**
 * Upsert every contact + event from a labeled dataset (the "reindex per data source" demo beat).
 * Documents are batched PER DECLARATION, so a registry that splits records across indexes issues
 * one upload per index.
 */
export async function syncEngagementDocs(
  ds: LabeledDataset,
): Promise<{ contacts: number; events: number; reference: number }> {
  const batches = new Map<
    string,
    { schema: IndexSchema; docs: EngagementDoc[] }
  >();
  const stage = (schema: IndexSchema, doc: EngagementDoc): void => {
    const batch = batches.get(schema.id) ?? { schema, docs: [] };
    batch.docs.push(doc);
    batches.set(schema.id, batch);
  };

  const contactSchema = declarationFor("contact");
  for (const c of ds.contacts) {
    stage(contactSchema, contactToDoc(c, contactSchema));
  }
  const eventSchema = declarationFor("event");
  for (const e of ds.events) stage(eventSchema, eventToDoc(e, eventSchema));

  // Reference sets are pushed too: the read model sources leaders/topics/messages/regions from the
  // INDEX (never the seed), so an index missing them would leave the planner with no roster.
  // A kind no declaration carries is skipped rather than guessed at.
  const referenceSets: [
    IndexEntityKind,
    ReadonlyArray<{ id: string; name?: string }>,
  ][] = [
    ["leader", ds.leaders],
    ["topic", ds.topics],
    ["message", ds.messages],
    ["region", ds.regions],
  ];
  let reference = 0;
  for (const [kind, records] of referenceSets) {
    const schema = declarationForKind(kind);
    if (!schema) continue;
    for (const r of records) {
      stage(schema, referenceDoc(kind, r, schema));
      reference += 1;
    }
  }

  for (const batch of batches.values()) {
    if (batch.docs.length) {
      await clientFor(batch.schema).mergeOrUploadDocuments(batch.docs);
    }
  }
  return {
    contacts: ds.contacts.length,
    events: ds.events.length,
    reference,
  };
}

/** Upsert a single contact/event (demo add/update). */
export async function upsertEngagementContact(
  c: Labeled<Contact>,
): Promise<void> {
  const schema = declarationFor("contact");
  await clientFor(schema).mergeOrUploadDocuments([contactToDoc(c, schema)]);
}
export async function upsertEngagementEvent(
  e: Labeled<EngagementEvent>,
): Promise<void> {
  const schema = declarationFor("event");
  await clientFor(schema).mergeOrUploadDocuments([eventToDoc(e, schema)]);
}

/** Delete a single record by kind + domain id (demo delete, then reindex, and the row disappears). */
export async function deleteEngagementDoc(
  kind: "contact" | "event",
  id: string,
): Promise<void> {
  const schema = declarationFor(kind);
  await clientFor(schema).deleteDocuments(schema.mapping.key, [
    docKey(kind, id),
  ]);
}

// ── Retrieval (the swap target) ───────────────────────────────────

/** `<entityType> eq '<value>'` for one kind, resolved through THAT declaration's mapping. */
function kindClause(kind: IndexEntityKind, schema: IndexSchema): string {
  const f = filterableField("entityType", schema)!;
  return `${f} eq '${odataEscapeLiteral(entityTypeValue(kind, schema)!)}'`;
}

/** `search.in` membership over the mapped topic collection; omitted when the index has no such field. */
function topicClause(
  topicIds: string[],
  schema: IndexSchema,
): string | undefined {
  const f = filterableField("topicIds", schema);
  if (!f) return undefined;
  const list = topicIds.map(odataEscapeLiteral).join(",");
  return `${f}/any(x: search.in(x, '${list}'))`;
}

/**
 * Reconstruct a domain record from a result document via the mapped payload field.
 * Without a payload field the index cannot round-trip domain objects, so say so plainly.
 */
function fromPayload<T>(doc: unknown, schema: IndexSchema): T {
  const f = payloadField(schema);
  if (!f) {
    throw new Error(
      `Index declaration "${schema.id}" declares no \`mapping.payload\` field, so domain records ` +
        "cannot be reconstructed. Add a payload field to the declaration, or use a grounding query " +
        `that returns text instead.\n  (${schema.sourcePath})`,
    );
  }
  return JSON.parse(String((doc as Record<string, unknown>)[f])) as T;
}

/** Preference narrowing - drops out-of-policy candidates (mirrors the shim). */
function narrowByPreferences<T extends { id: string; strategicValue: number }>(
  items: T[],
  prefs: Preferences,
): T[] {
  let out = items;
  if (prefs.doNotMeet?.length)
    out = out.filter((c) => !prefs.doNotMeet!.includes(c.id));
  if (typeof prefs.seniorityFloor === "number")
    out = out.filter((c) => c.strategicValue >= prefs.seniorityFloor!);
  return out;
}

/** Return contacts matching recall (kind + status + topic + query), narrowed by caller preferences. */
export async function searchEngagementContacts(
  q: ContactQuery,
): Promise<Labeled<Contact>[]> {
  const schema = declarationFor("contact");
  const recallParts: string[] = [kindClause("contact", schema)];
  if (q.status) {
    const statusField = filterableField("status", schema);
    if (statusField) {
      recallParts.push(`${statusField} eq '${odataEscapeLiteral(q.status)}'`);
    }
  }
  if (q.topicIds?.length) {
    const clause = topicClause(q.topicIds, schema);
    if (clause) recallParts.push(clause);
  }
  const recallFilter = recallParts.join(" and ");
  const text = q.query?.trim() ? q.query : "*";

  const index = indexName(schema);
  log.debug(
    () =>
      `search_contacts: index "${index}" search="${text}" $filter=${recallFilter}`,
  );
  const resp = await runSearch(
    log,
    { operation: "search_contacts", index, sourcePath: schema.sourcePath },
    () =>
      clientFor(schema).search(text, {
        filter: recallFilter,
        searchFields: searchableFields(schema),
        top: 1000,
      }),
  );
  const items: Labeled<Contact>[] = [];
  for await (const r of resp.results)
    items.push(fromPayload<Labeled<Contact>>(r.document, schema));

  const out = q.preferences ? narrowByPreferences(items, q.preferences) : items;
  log.info(
    `search_contacts: ${items.length} from index "${index}", ${out.length} after preference narrowing`,
  );
  return out;
}

/** Return anchor events, optionally matched by text/topic. */
export async function searchEngagementEvents(
  q: EventQuery,
): Promise<Labeled<EngagementEvent>[]> {
  const schema = declarationFor("event");
  const recallParts: string[] = [kindClause("event", schema)];
  if (q.topicIds?.length) {
    const clause = topicClause(q.topicIds, schema);
    if (clause) recallParts.push(clause);
  }
  const query = q.query?.trim();
  const exactId = query && /^E-[A-Za-z0-9-]+$/i.test(query) ? query : undefined;
  if (exactId) {
    recallParts.push(
      `${filterableField("key", schema)!} eq '${odataEscapeLiteral(exactId)}'`,
    );
  }
  const recallFilter = recallParts.join(" and ");
  const text = exactId ? "*" : query || "*";

  const index = indexName(schema);
  log.debug(
    () =>
      `search_events: index "${index}" search="${text}" $filter=${recallFilter}`,
  );
  const resp = await runSearch(
    log,
    { operation: "search_events", index, sourcePath: schema.sourcePath },
    () =>
      clientFor(schema).search(text, {
        filter: recallFilter,
        searchFields: searchableFields(schema),
        top: 1000,
      }),
  );
  const items: Labeled<EngagementEvent>[] = [];
  for await (const r of resp.results)
    items.push(fromPayload<Labeled<EngagementEvent>>(r.document, schema));

  log.info(`search_events: ${items.length} from index "${index}"`);
  return items;
}

/**
 * Read EVERY record of one kind straight from the index that declares it — the reference sets
 * (leaders, topics, messages, regions) the planner needs alongside contacts/events.
 *
 * Returns `[]` when NO declaration in the registry carries that kind, i.e. no configured index
 * holds it. That is deliberate: an empty reference set is the honest answer, and is strictly better
 * than silently substituting demo seed records.
 */
export async function searchEngagementRecords<T>(
  kind: IndexEntityKind,
): Promise<T[]> {
  const schema = declarationForKind(kind);
  if (!schema) {
    log.warn(
      `no index declaration carries the "${kind}" record kind -- reading back EMPTY rather than substituting demo seed records`,
    );
    return [];
  }

  const index = indexName(schema);
  const resp = await runSearch(
    log,
    { operation: `read ${kind}`, index, sourcePath: schema.sourcePath },
    () =>
      clientFor(schema).search("*", {
        filter: kindClause(kind, schema),
        top: 1000,
      }),
  );
  const items: T[] = [];
  for await (const r of resp.results)
    items.push(fromPayload<T>(r.document, schema));
  log.info(`read ${kind}: ${items.length} record(s) from index "${index}"`);
  return items;
}
