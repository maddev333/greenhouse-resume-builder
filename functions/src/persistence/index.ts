/**
 * Persistence layer for the Azure Functions pipeline.
 *
 * Uses @azure/cosmos directly (already in functions/package.json) so it works
 * independently of the Express API in this repo. Each function can call these
 * helpers without needing to start an HTTP server.
 */

import { CosmosClient, type Container, type ItemResponse } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import type {
  Person,
  SourceDocument,
  ExtractionRun,
  FactVersion,
  BulletMapping,
  Annotation,
  Relationship,
} from '@greenhouse-resume-builder/shared';

// ── Singleton client (lazy-init from env) ───────────────────────────────────

let _client: CosmosClient | undefined;
const DB          = 'resumeBuilder';
const CONTAINERS  = [
  'persons',
  'sourceDocuments',
  'extractionRuns',
  'factVersions',
  'bulletMappings',
  'annotations',
  'relationships',
];

async function getClient(): Promise<CosmosClient> {
  if (_client) return _client;
  const endpoint = process.env.COSMOS_ENDPOINT ?? '';
  const key      = process.env.COSMOS_AUTH_KEY ?? '';
  if (!endpoint) throw new Error('COSMOS_ENDPOINT is required');
  // IL5 / production: Microsoft Entra ID (managed identity) when no account key is supplied.
  _client = key
    ? new CosmosClient({ endpoint, key })
    : new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
  return _client;
}

/** Ensure all containers exist on first access. */
export async function ensureContainers(): Promise<void> {
  const client = await getClient();
  await ensureAllContainers(client);
}

// Generic container provider — lazy-creates containers on first access.
const _containers: Partial<Record<string, Promise<Container>>> = {};
async function ensureAllContainers(client: CosmosClient): Promise<void> {
  const db = client.database(DB);
  for (const name_ of CONTAINERS) {
    if (!_containers[name_]) {
      _containers[name_] = db.containers.createIfNotExists({ id: name_ }).then(r => r.container);
    }
  }
}

async function getContainer(name: string): Promise<Container> {
  if (_containers[name]) return _containers[name];

  // Lazy init + ensure all registered containers exist
  const client = await getClient();
  if (!_containers[CONTAINERS[0]]) {
    await ensureAllContainers(client);
  }

  if (!Object.prototype.hasOwnProperty.call(_containers, name)) {
    throw new Error('Container not registered: ' + name);
  }
  return _containers[name];
}

/** ── Upsert helpers ─────────────────────────────────────────────────────── */

async function upsert<T extends { id: string }>(doc: T, containerName: string): Promise<ItemResponse<T>> {
  const c = await getContainer(containerName);
  return (await c.items.upsert(doc)) as unknown as ItemResponse<T>;
}

/** ── Query helper ───────────────────────────────────────────────────────── */

async function query<TOut>(sql: string, parameters: any[] | undefined, containerName: string): Promise<TOut[]> {
  const c = await getContainer(containerName);
  return (await c.items.query<TOut>({ query: sql, parameters }).fetchAll()).resources;
}

// ── Public persistence functions ────────────────────────────────────────────

/** ── FactVersions ────────────────────────────────────────────────────────── */

export const upsertFactVersion = async (doc: FactVersion): Promise<FactVersion> => {
  const r = await upsert(doc, 'factVersions');
  return r.resource as FactVersion;
};

export const bulkInsertFacts = async (facts: Partial<FactVersion>[]): Promise<void> => {
  // Use raw container batch upsert for performance.
  const c = await getContainer('factVersions');
  for (const f of facts) {
    if (!f.id) throw new Error('FactVersion must have id');
    await c.items.upsert({ ...f, partitionKey: f.id } as any);
  }
};

export const queryFactsByPersonAndRun = async (personId: string, runId: string): Promise<FactVersion[]> => {
  return query<FactVersion>(
    "SELECT * FROM c WHERE c.personId = @p AND c.extractionRunId = @r",
    [{ name: '@p', value: personId }, { name: '@r', value: runId }],
    'factVersions',
  );
};

export const queryFactsByPerson = async (personId: string): Promise<FactVersion[]> => {
  return query<FactVersion>(
    "SELECT * FROM c WHERE c.personId = @p ORDER BY c.extractedAt DESC",
    [{ name: '@p', value: personId }],
    'factVersions',
  );
};

export const queryAllFacts = async (limit = 500): Promise<FactVersion[]> => {
  return query<FactVersion>(`SELECT TOP ${limit} * FROM c ORDER BY c.extractedAt DESC`, undefined, 'factVersions');
};

export const queryFactsLatestByPersonSection = async (personId: string, sectionId: string): Promise<FactVersion | null> => {
  const docs = await query<FactVersion>(
    "SELECT TOP 1 * FROM c WHERE c.personId = @p AND c.sectionId = @s ORDER BY c.extractedAt DESC",
    [{ name: '@p', value: personId }, { name: '@s', value: sectionId }],
    'factVersions',
  );
  return (docs[0] ?? null) as unknown as FactVersion | null;
};

/** ── BulletMappings ───────────────────────────────────────────────────────── */

export const bulkInsertBullets = async (bullets: Partial<BulletMapping>[]): Promise<void> => {
  const c = await getContainer('bulletMappings');
  for (const b of bullets) {
    if (!b.id) throw new Error('BulletMapping must have id');
    await c.items.upsert({ ...b, partitionKey: b.id } as any);
  }
};

export const queryBulletsByRun = async (runId: string): Promise<BulletMapping[]> => {
  return query<BulletMapping>(
    "SELECT * FROM c WHERE c.extractionRunId = @r",
    [{ name: '@r', value: runId }],
    'bulletMappings',
  );
};

export const queryBulletsByPerson = async (personId: string): Promise<BulletMapping[]> => {
  return query<BulletMapping>(
    "SELECT * FROM c WHERE c.personId = @p",
    [{ name: '@p', value: personId }],
    'bulletMappings',
  );
};

export const queryAllBulletsByPerson = async (personId: string): Promise<BulletMapping[]> => {
  return query<BulletMapping>(
    "SELECT * FROM c WHERE c.personId = @p ORDER BY c.createdAt DESC",
    [{ name: '@p', value: personId }],
    'bulletMappings',
  );
};

/** Latest bullet with a given signature for a specific person and section. */
export const latestBulletBySignature = async (personId: string, signature: string, sectionId?: string): Promise<BulletMapping | null> => {
  let sql = 'SELECT TOP 1 * FROM c WHERE c.personId = @p AND c.bulletSignature = @sig ORDER BY c.createdAt DESC';
  const params: any[] = [{ name: '@p', value: personId }, { name: '@sig', value: signature }];

  if (sectionId) {
    sql += " AND c.sectionId = @s";
    params.push({ name: '@s', value: sectionId });
  }
  const docs = await query<BulletMapping>(sql, params, 'bulletMappings');
  return (docs[0] ?? null) as unknown as BulletMapping | null;
};

/** All latest bullets for a person across all sections. */
export const latestBulletsByPerson = async (personId: string): Promise<BulletMapping[]> => {
  return query<BulletMapping>(
    "SELECT * FROM c WHERE c.personId = @p AND c.latestForBullet = true",
    [{ name: '@p', value: personId }],
    'bulletMappings',
  );
};

/** ── Person ──────────────────────────────────────────────────────────────── */

export const upsertPerson = async (doc: Partial<Person> & { id: string }): Promise<void> => {
  const c = await getContainer('persons');
  await c.items.upsert({ ...doc, partitionKey: doc.id } as any);
};

export const getPerson = async (personId: string): Promise<Person | null> => {
  const c = await getContainer('persons');
  try {
    const r = await c.item(personId, personId).read<Person>();
    return r.resource;
  } catch {
    return null;
  }
};

export const searchPersonsByName = async (nameSearch: string): Promise<Person[]> => {
  return query<Person>(
    "SELECT * FROM c WHERE ARRAY_CONTAINS(c.aliases, @n) OR CONTAINS(LOWER(c.canonicalName), LOWER(@n))",
    [{ name: '@n', value: nameSearch }],
    'persons',
  );
};

/** ── ExtractionRun ───────────────────────────────────────────────────────── */

export const upsertExtractionRun = async (doc: Partial<ExtractionRun> & { id: string }): Promise<void> => {
  const c = await getContainer('extractionRuns');
  await c.items.upsert({ ...doc, partitionKey: doc.id } as any);
};

export const queryExtractionRun = async (runId: string): Promise<ExtractionRun | null> => {
  const c = await getContainer('extractionRuns');
  try {
    const r = await c.item(runId, runId).read<ExtractionRun>();
    return r.resource;
  } catch {
    return null;
  }
};

export const updateExtractionRunStatus = async (runId: string, status: ExtractionRun['status'], extra?: Partial<ExtractionRun>): Promise<void> => {
  const r = await queryExtractionRun(runId);
  if (!r) throw new Error('ExtractionRun not found: ' + runId);
  await upsertExtractionRun({ ...r, status, updatedAt: new Date().toISOString(), ...extra } as any);
};

/** Latest active run for a person. */
export const latestRunByPerson = async (personId: string): Promise<ExtractionRun | null> => {
  const docs = await query<ExtractionRun>(
    "SELECT TOP 1 * FROM c WHERE c.personId = @p ORDER BY c.createdAt DESC",
    [{ name: '@p', value: personId }],
    'extractionRuns',
  );
  return (docs[0] ?? null) as unknown as ExtractionRun | null;
};

/** ── SourceDocument ──────────────────────────────────────────────────────── */

export const upsertSourceDoc = async (doc: Partial<SourceDocument> & { id: string }): Promise<void> => {
  const c = await getContainer('sourceDocuments');
  await c.items.upsert({ ...doc, partitionKey: doc.id } as any);
};

export const querySourceDocsByRun = async (runId: string): Promise<SourceDocument[]> => {
  return query<SourceDocument>(
    "SELECT * FROM c WHERE c.extractionRunId = @r",
    [{ name: '@r', value: runId }],
    'sourceDocuments',
  );
};

export const upsertPersonSourceDoc = async (personId: string, runId: string, sourceDocs: SourceDocument[]): Promise<SourceDocument[]> => {
  for (const doc of sourceDocs) {
    if ((doc as any).personId === personId || !doc.personId) {
      await upsertSourceDoc({ ...doc, personId } as any);
    }
  }
  return sourceDocs;
};

/** ── Relationship ─────────────────────────────────────────────────────────── */

export const upsertRelationship = async (doc: Partial<Relationship> & { id: string }): Promise<void> => {
  await upsert(doc, 'relationships');
};

export const queryRelationshipsForPerson = async (personId: string): Promise<Relationship[]> => {
  return query<Relationship>(
    "SELECT * FROM c WHERE c.fromPersonId = @p OR c.toPersonId = @p ORDER BY c.createdAt DESC",
    [{ name: '@p', value: personId }],
    'relationships',
  );
};

export const confirmRelationship = async (relationshipId: string, userId: string): Promise<void> => {
  const r = await query<Relationship>(
    "SELECT TOP 1 * FROM c WHERE c.id = @r",
    [{ name: '@r', value: relationshipId }],
    'relationships',
  );
  if (!r.length) throw new Error('Relationship not found');
  const rel = r[0] as Relationship;
  await upsert({ ...rel, status: 'confirmed', confirmedByUserId: userId, confirmedAt: new Date().toISOString() } as any, 'relationships');
};

export const rejectRelationship = async (relationshipId: string, userId: string): Promise<void> => {
  const r = await query<Relationship>(
    "SELECT TOP 1 * FROM c WHERE c.id = @r",
    [{ name: '@r', value: relationshipId }],
    'relationships',
  );
  if (!r.length) throw new Error('Relationship not found');
  const rel = r[0] as Relationship;
  await upsert({ ...rel, status: 'rejected', rejectedByUserId: userId, rejectedAt: new Date().toISOString() } as any, 'relationships');
};

export const edgeExists = async (personA: string, personB: string): Promise<boolean> => {
  const docs = await query(
    "SELECT TOP 1 c.id FROM c WHERE (c.fromPersonId = @a AND c.toPersonId = @b) OR (c.fromPersonId = @b AND c.toPersonId = @a)",
    [{ name: '@a', value: personA }, { name: '@b', value: personB }],
    'relationships',
  );
  return !!docs.length;
};

/** ── Annotation ──────────────────────────────────────────────────────────── */

export const upsertAnnotation = async (doc: Partial<Annotation> & { id: string }): Promise<void> => {
  await upsert(doc, 'annotations');
};

export const queryAnnotationsForFact = async (factVersionId: string): Promise<Annotation[]> => {
  return query<Annotation>(
    "SELECT * FROM c WHERE c.targetFactVersionId = @f ORDER BY c.createdAt DESC",
    [{ name: '@f', value: factVersionId }],
    'annotations',
  );
};

export const queryAnnotationsForPerson = async (personId: string): Promise<Annotation[]> => {
  return query<Annotation>(
    "SELECT * FROM c WHERE c.personId = @p ORDER BY c.createdAt DESC",
    [{ name: '@p', value: personId }],
    'annotations',
  );
};

export const updateAnnotationStatus = async (annotationId: string, status: Annotation['status']): Promise<void> => {
  const r = await query<Annotation>(
    "SELECT TOP 1 * FROM c WHERE c.id = @a",
    [{ name: '@a', value: annotationId }],
    'annotations',
  );
  if (!r.length) throw new Error('Annotation not found');
  const ann = r[0] as Annotation;
  await upsert({ ...ann, status } as any, 'annotations');
};

export const deleteAnnotation = async (annotationId: string): Promise<void> => {
  const c = await getContainer('annotations');
  await c.item(annotationId, annotationId).delete();
};

/** ── Batch persistence for builder output ─────────────────────────────────── */

/**
 * Persist all builder output to Cosmos DB.
 * Wraps writes in try/catch per phase so a single failure doesn't lose partial data silently.
 */
export async function persistBuildResults(facts: FactVersion[], bullets: BulletMapping[]): Promise<void> {
  // Phase 1: Bulk upsert facts
  if (facts.length > 0) {
    const errors: string[] = [];
    for (const f of facts) {
      try {
        await bulkInsertFacts([f]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[persist] fact upsert failed:', JSON.stringify(f.id), '-', msg);
        errors.push(msg);
      }
    }
    if (errors.length > 0) {
      console.error(`[persist] ${errors.length}/${facts.length} facts failed`);
    }
  }

  // Phase 2: Bulk upsert bullets
  if (bullets.length > 0) {
    const errors: string[] = [];
    for (const b of bullets) {
      try {
        await bulkInsertBullets([b]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[persist] bullet upsert failed:', JSON.stringify(b.id), '-', msg);
        errors.push(msg);
      }
    }
    if (errors.length > 0) {
      console.error(`[persist] ${errors.length}/${bullets.length} bullets failed`);
    }
  }
}

/** ── Azure AI Search indexing hooks ─────────────────────────────
 *
 * These are called by the orchestrator after persistence to keep
 * the search index in sync with Cosmos DB.
 */

let _searchKey = process.env.AZURE_SEARCH_API_KEY ?? '';
let _searchSvc = process.env.AZURE_SEARCH_SERVICE ?? '';

function shouldIndex(): boolean {
  if (process.env.NODE_ENV === 'test') return false;
  if (!_searchSvc || !_searchKey) return false;
  return true;
}

/** Convert a FactVersion into an Azure AI Search document. */
export function toSearchDocFact(fact: FactVersion): Record<string, any> {
  const valueStr = typeof fact.factValue === 'string'
    ? fact.factValue
    : JSON.stringify(fact.factValue);

  return {
    '@search.action':   'upload', // 'upload' is upsert — works for first-write and replace. (Was 'merge' which fails on first-write per AGENT_TASKS.md Task 4.1)
    id:                  `fact_${fact.id}`,
    tenantId:            fact.tenantId,
    personId:            fact.personId,
    extractionRunId:     fact.extractionRunId,
    sectionId:           [fact.sectionId],
    factKey:             fact.factKey,
    factValue:           valueStr,
    normalizedValue:     fact.normalizedValue,
    createdAt:           fact.extractedAt,
  };
}

/** Convert a BulletMapping into an Azure AI Search document. */
export function toSearchDocBullet(bullet: BulletMapping): Record<string, any> {
  return {
    '@search.action':   'upload', // 'upload' is upsert — works for first-write and replace.
    id:                  `b_${bullet.id}`,
    tenantId:            bullet.tenantId,
    personId:            bullet.personId,
    extractionRunId:     bullet.extractionRunId,
    sectionId:           [bullet.sectionId],
    bulletText:          bullet.bulletText,
    normalizedValue:     bullet.bulletSignature,
    createdAt:           bullet.createdAt,
  };
}

/** Upsert a collection of FactVersions to Azure AI Search. */
export async function indexFactsToSearch(facts: FactVersion[]): Promise<void> {
  if (!shouldIndex() || !facts.length) return;

  const { SearchClient, AzureKeyCredential } = await import('@azure/search-documents');
  const endpoint = `https://${_searchSvc}.search.windows.net`;
  const client   = new SearchClient('resume-facts', endpoint, new AzureKeyCredential(_searchKey), {});

  const docs = facts.map(toSearchDocFact);
  // Use mergeOrUploadDocuments for safe first-write + existing-doc handling.
  for (const doc of docs) {
    await client.mergeOrUploadDocuments([doc]).catch(e =>
      console.warn('[Search] fact upsert failed:', e.message));
  }
}

/** Upsert a collection of BulletMappings to Azure AI Search. */
export async function indexBulletsToSearch(bullets: BulletMapping[]): Promise<void> {
  if (!shouldIndex() || !bullets.length) return;

  const { SearchClient, AzureKeyCredential } = await import('@azure/search-documents');
  const endpoint = `https://${_searchSvc}.search.windows.net`;
  const client   = new SearchClient('resume-facts', endpoint, new AzureKeyCredential(_searchKey), {});

  for (const bullet of bullets) {
    // mergeOrUploadDocuments handles both first-write and existing-doc safely.
    await client.mergeOrUploadDocuments([toSearchDocBullet(bullet)]).catch(e =>
      console.warn('[Search] bullet upsert failed:', e.message));
  }
}
