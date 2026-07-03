/**
 * Persistence layer for the Azure Functions pipeline.
 *
 * Uses node-postgres (`pg`) directly so it works independently of the Express API
 * in this repo. Each function can call these helpers without needing to start an
 * HTTP server. Every entity is stored as a JSONB document keyed by its stable `id`,
 * mirroring the single-partition containers the MVP previously used in Cosmos DB.
 */

import { Pool, type PoolConfig } from 'pg';
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

// ── Logical container → physical table mapping ──────────────────────────────

const TABLES = {
  persons: 'persons',
  sourceDocuments: 'source_documents',
  extractionRuns: 'extraction_runs',
  factVersions: 'fact_versions',
  bulletMappings: 'bullet_mappings',
  annotations: 'annotations',
  relationships: 'relationships',
} as const;

// ── Singleton pool (lazy-init from env) ─────────────────────────────────────

let _poolPromise: Promise<Pool> | undefined;

/** AAD scope for Azure Database for PostgreSQL flexible server (managed-identity auth). */
const AAD_SCOPE = process.env.PG_AAD_SCOPE ?? 'https://ossrdbms-aad.database.windows.net/.default';

function isAzureHost(host: string): boolean {
  return /\.postgres\.database\.(azure\.com|usgovcloudapi\.net|chinacloudapi\.cn)$/i.test(host);
}

function buildPoolConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL;
  const host = process.env.PGHOST ?? '';
  const sslWanted =
    process.env.PGSSLMODE === 'require' ||
    process.env.DATABASE_SSL === 'true' ||
    (!!host && isAzureHost(host)) ||
    (!!connectionString && /\bsslmode=require\b/.test(connectionString));
  const rejectUnauthorized = process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false';
  const ssl = sslWanted ? { rejectUnauthorized } : undefined;

  if (connectionString) {
    return { connectionString, ssl, max: Number(process.env.PG_POOL_MAX ?? 10) };
  }

  const config: PoolConfig = {
    host,
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'resume_builder',
    user: process.env.PGUSER ?? 'postgres',
    ssl,
    max: Number(process.env.PG_POOL_MAX ?? 10),
  };

  // IL5 / production: when no password is supplied, authenticate with Microsoft Entra ID.
  // node-postgres evaluates a function password per new connection, so AAD tokens refresh
  // automatically as the pool opens new connections.
  const password = process.env.PGPASSWORD ?? '';
  if (password) {
    config.password = password;
  } else {
    const credential = new DefaultAzureCredential();
    config.password = async () => {
      const token = await credential.getToken(AAD_SCOPE);
      if (!token?.token) throw new Error('Failed to acquire AAD token for PostgreSQL');
      return token.token;
    };
  }

  return config;
}

async function ensureTables(pool: Pool): Promise<void> {
  for (const table of Object.values(TABLES)) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data JSONB NOT NULL)`);
  }
}

async function getPool(): Promise<Pool> {
  if (!_poolPromise) {
    _poolPromise = (async () => {
      const pool = new Pool(buildPoolConfig());
      pool.on('error', (err) => console.error('[pg] idle client error:', err.message));
      await ensureTables(pool);
      return pool;
    })();
  }
  return _poolPromise;
}

/** Ensure all document tables exist (idempotent; triggers pool init). */
export async function ensureContainers(): Promise<void> {
  await getPool();
}

// ── Generic JSONB document helpers ──────────────────────────────────────────

interface FindOptions {
  orderBy?: string; // top-level JSON field (ISO timestamps sort lexicographically)
  desc?: boolean;
  limit?: number;
}

async function upsertDoc<T extends { id: string }>(table: string, doc: T): Promise<T> {
  const pool = await getPool();
  const res = await pool.query(
    `INSERT INTO ${table} (id, data) VALUES ($1, $2::jsonb)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
     RETURNING data`,
    [doc.id, JSON.stringify(doc)],
  );
  return res.rows[0].data as T;
}

async function readDoc<T>(table: string, id: string): Promise<T | null> {
  const pool = await getPool();
  const res = await pool.query(`SELECT data FROM ${table} WHERE id = $1`, [id]);
  return res.rowCount ? (res.rows[0].data as T) : null;
}

async function findDocs<T>(table: string, where: string, params: any[] = [], opts?: FindOptions): Promise<T[]> {
  const pool = await getPool();
  let sql = `SELECT data FROM ${table}`;
  if (where) sql += ` WHERE ${where}`;
  if (opts?.orderBy) sql += ` ORDER BY data->>'${opts.orderBy}' ${opts.desc ? 'DESC' : 'ASC'}`;
  if (opts?.limit != null) sql += ` LIMIT ${Number(opts.limit)}`;
  const res = await pool.query(sql, params);
  return res.rows.map((r) => r.data as T);
}

async function deleteDoc(table: string, id: string): Promise<void> {
  const pool = await getPool();
  await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
}

// ── Public persistence functions ────────────────────────────────────────────

/** ── FactVersions ────────────────────────────────────────────────────────── */

export const upsertFactVersion = async (doc: FactVersion): Promise<FactVersion> =>
  upsertDoc(TABLES.factVersions, doc);

export const bulkInsertFacts = async (facts: Partial<FactVersion>[]): Promise<void> => {
  for (const f of facts) {
    if (!f.id) throw new Error('FactVersion must have id');
    await upsertDoc(TABLES.factVersions, f as FactVersion);
  }
};

export const queryFactsByPersonAndRun = async (personId: string, runId: string): Promise<FactVersion[]> =>
  findDocs<FactVersion>(
    TABLES.factVersions,
    "data->>'personId' = $1 AND data->>'extractionRunId' = $2",
    [personId, runId],
  );

export const queryFactsByPerson = async (personId: string): Promise<FactVersion[]> =>
  findDocs<FactVersion>(
    TABLES.factVersions,
    "data->>'personId' = $1",
    [personId],
    { orderBy: 'extractedAt', desc: true },
  );

export const queryAllFacts = async (limit = 500): Promise<FactVersion[]> =>
  findDocs<FactVersion>(TABLES.factVersions, '', [], { orderBy: 'extractedAt', desc: true, limit });

export const queryFactsLatestByPersonSection = async (personId: string, sectionId: string): Promise<FactVersion | null> => {
  const docs = await findDocs<FactVersion>(
    TABLES.factVersions,
    "data->>'personId' = $1 AND data->>'sectionId' = $2",
    [personId, sectionId],
    { orderBy: 'extractedAt', desc: true, limit: 1 },
  );
  return docs[0] ?? null;
};

/** ── BulletMappings ───────────────────────────────────────────────────────── */

export const bulkInsertBullets = async (bullets: Partial<BulletMapping>[]): Promise<void> => {
  for (const b of bullets) {
    if (!b.id) throw new Error('BulletMapping must have id');
    await upsertDoc(TABLES.bulletMappings, b as BulletMapping);
  }
};

export const queryBulletsByRun = async (runId: string): Promise<BulletMapping[]> =>
  findDocs<BulletMapping>(TABLES.bulletMappings, "data->>'extractionRunId' = $1", [runId]);

export const queryBulletsByPerson = async (personId: string): Promise<BulletMapping[]> =>
  findDocs<BulletMapping>(TABLES.bulletMappings, "data->>'personId' = $1", [personId]);

export const queryAllBulletsByPerson = async (personId: string): Promise<BulletMapping[]> =>
  findDocs<BulletMapping>(
    TABLES.bulletMappings,
    "data->>'personId' = $1",
    [personId],
    { orderBy: 'createdAt', desc: true },
  );

/** Latest bullet with a given signature for a specific person and section. */
export const latestBulletBySignature = async (personId: string, signature: string, sectionId?: string): Promise<BulletMapping | null> => {
  let where = "data->>'personId' = $1 AND data->>'bulletSignature' = $2";
  const params: any[] = [personId, signature];
  if (sectionId) {
    where += " AND data->>'sectionId' = $3";
    params.push(sectionId);
  }
  const docs = await findDocs<BulletMapping>(TABLES.bulletMappings, where, params, { orderBy: 'createdAt', desc: true, limit: 1 });
  return docs[0] ?? null;
};

/** All latest bullets for a person across all sections. */
export const latestBulletsByPerson = async (personId: string): Promise<BulletMapping[]> =>
  findDocs<BulletMapping>(
    TABLES.bulletMappings,
    "data->>'personId' = $1 AND (data->>'latestForBullet')::boolean = true",
    [personId],
  );

/** ── Person ──────────────────────────────────────────────────────────────── */

export const upsertPerson = async (doc: Partial<Person> & { id: string }): Promise<void> => {
  await upsertDoc(TABLES.persons, doc as Person);
};

export const getPerson = async (personId: string): Promise<Person | null> =>
  readDoc<Person>(TABLES.persons, personId);

export const searchPersonsByName = async (nameSearch: string): Promise<Person[]> =>
  findDocs<Person>(
    TABLES.persons,
    "data->'aliases' @> to_jsonb($1::text) OR LOWER(data->>'canonicalName') LIKE '%' || LOWER($1) || '%'",
    [nameSearch],
  );

/** All persons in a tenant (used for dedup candidate matching + deconfliction). */
export const listPersonsByTenant = async (tenantId: string): Promise<Person[]> =>
  findDocs<Person>(TABLES.persons, "data->>'tenantId' = $1", [tenantId]);

/** Delete a person document by id. */
export const deletePersonDoc = async (personId: string): Promise<void> => {
  await deleteDoc(TABLES.persons, personId);
};

/**
 * Re-point every reference to `fromId` so it points at `toId` across all entity tables.
 * Keyed purely on the personId fields (NOT tenant) so edges authored under a different
 * tenantId are still re-pointed. Used when merging duplicate persons (deconfliction).
 */
export const reassignPersonReferences = async (fromId: string, toId: string): Promise<void> => {
  if (fromId === toId) return;
  const pool = await getPool();
  // Tables with a scalar personId field.
  for (const table of [
    TABLES.factVersions,
    TABLES.bulletMappings,
    TABLES.sourceDocuments,
    TABLES.annotations,
    TABLES.extractionRuns,
  ]) {
    await pool.query(
      `UPDATE ${table} SET data = jsonb_set(data, '{personId}', to_jsonb($2::text)) WHERE data->>'personId' = $1`,
      [fromId, toId],
    );
  }
  // Relationships carry two endpoints.
  await pool.query(
    `UPDATE ${TABLES.relationships} SET data = jsonb_set(data, '{fromPersonId}', to_jsonb($2::text)) WHERE data->>'fromPersonId' = $1`,
    [fromId, toId],
  );
  await pool.query(
    `UPDATE ${TABLES.relationships} SET data = jsonb_set(data, '{toPersonId}', to_jsonb($2::text)) WHERE data->>'toPersonId' = $1`,
    [fromId, toId],
  );
};

/** ── ExtractionRun ───────────────────────────────────────────────────────── */

export const upsertExtractionRun = async (doc: Partial<ExtractionRun> & { id: string }): Promise<void> => {
  await upsertDoc(TABLES.extractionRuns, doc as ExtractionRun);
};

export const queryExtractionRun = async (runId: string): Promise<ExtractionRun | null> =>
  readDoc<ExtractionRun>(TABLES.extractionRuns, runId);

export const updateExtractionRunStatus = async (runId: string, status: ExtractionRun['status'], extra?: Partial<ExtractionRun>): Promise<void> => {
  const r = await queryExtractionRun(runId);
  if (!r) throw new Error('ExtractionRun not found: ' + runId);
  await upsertExtractionRun({ ...r, status, updatedAt: new Date().toISOString(), ...extra } as any);
};

/** Latest active run for a person. */
export const latestRunByPerson = async (personId: string): Promise<ExtractionRun | null> => {
  const docs = await findDocs<ExtractionRun>(
    TABLES.extractionRuns,
    "data->>'personId' = $1",
    [personId],
    { orderBy: 'createdAt', desc: true, limit: 1 },
  );
  return docs[0] ?? null;
};

/** Cleanup: mark stuck queued/in-progress runs created before `cutoffIso` as failed. Returns affected count. */
export const markStaleRunsFailed = async (cutoffIso: string, reason: string): Promise<number> => {
  const pool = await getPool();
  const res = await pool.query(
    `UPDATE ${TABLES.extractionRuns}
     SET data = data || jsonb_build_object('status', 'failed', 'failedReason', $1::text, 'updatedAt', $2::text)
     WHERE data->>'status' IN ('queued', 'in_progress') AND data->>'createdAt' < $3`,
    [reason, new Date().toISOString(), cutoffIso],
  );
  return res.rowCount ?? 0;
};

/** Cleanup: delete failed runs created before `cutoffIso`. Completed runs are retained so successful runs stay visible in the UI. Returns deleted count. */
export const deleteFailedRunsBefore = async (cutoffIso: string): Promise<number> => {
  const pool = await getPool();
  const res = await pool.query(
    `DELETE FROM ${TABLES.extractionRuns} WHERE data->>'status' = 'failed' AND data->>'createdAt' < $1`,
    [cutoffIso],
  );
  return res.rowCount ?? 0;
};

/** ── SourceDocument ──────────────────────────────────────────────────────── */

export const upsertSourceDoc = async (doc: Partial<SourceDocument> & { id: string }): Promise<void> => {
  await upsertDoc(TABLES.sourceDocuments, doc as SourceDocument);
};

export const querySourceDocsByRun = async (runId: string): Promise<SourceDocument[]> =>
  findDocs<SourceDocument>(TABLES.sourceDocuments, "data->>'extractionRunId' = $1", [runId]);

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
  await upsertDoc(TABLES.relationships, doc as Relationship);
};

export const queryRelationshipsForPerson = async (personId: string): Promise<Relationship[]> =>
  findDocs<Relationship>(
    TABLES.relationships,
    "data->>'fromPersonId' = $1 OR data->>'toPersonId' = $1",
    [personId],
    { orderBy: 'createdAt', desc: true },
  );

export const confirmRelationship = async (relationshipId: string, userId: string): Promise<void> => {
  const rel = await readDoc<Relationship>(TABLES.relationships, relationshipId);
  if (!rel) throw new Error('Relationship not found');
  await upsertDoc(TABLES.relationships, {
    ...rel,
    status: 'confirmed',
    confirmedByUserId: userId,
    confirmedAt: new Date().toISOString(),
  } as Relationship);
};

export const rejectRelationship = async (relationshipId: string, userId: string): Promise<void> => {
  const rel = await readDoc<Relationship>(TABLES.relationships, relationshipId);
  if (!rel) throw new Error('Relationship not found');
  await upsertDoc(TABLES.relationships, {
    ...rel,
    status: 'rejected',
    rejectedByUserId: userId,
    rejectedAt: new Date().toISOString(),
  } as Relationship);
};

export const edgeExists = async (personA: string, personB: string): Promise<boolean> => {
  const docs = await findDocs<Relationship>(
    TABLES.relationships,
    "(data->>'fromPersonId' = $1 AND data->>'toPersonId' = $2) OR (data->>'fromPersonId' = $2 AND data->>'toPersonId' = $1)",
    [personA, personB],
    { limit: 1 },
  );
  return docs.length > 0;
};

/**
 * After a merge, tidy the survivor's edges: drop self-loops (from === to) and collapse
 * duplicate edges (same unordered endpoint pair + relationshipType), keeping the most
 * authoritative status (confirmed > suggested > rejected, then lowest id). Returns the
 * number of relationship rows removed.
 */
export const cleanupRelationshipsForPerson = async (survivorId: string): Promise<number> => {
  const pool = await getPool();
  // 1) Self-loops created by collapsing two endpoints onto the survivor.
  const selfDel = await pool.query(
    `DELETE FROM ${TABLES.relationships} WHERE data->>'fromPersonId' = $1 AND data->>'toPersonId' = $1`,
    [survivorId],
  );

  // 2) Duplicate edges touching the survivor.
  const rels = await findDocs<Relationship>(
    TABLES.relationships,
    "data->>'fromPersonId' = $1 OR data->>'toPersonId' = $1",
    [survivorId],
  );
  const rank = (s: string) => (s === 'confirmed' ? 0 : s === 'suggested' ? 1 : 2);
  const best = new Map<string, Relationship>();
  const toDelete: string[] = [];
  for (const r of rels) {
    const a = r.fromPersonId < r.toPersonId ? r.fromPersonId : r.toPersonId;
    const b = r.fromPersonId < r.toPersonId ? r.toPersonId : r.fromPersonId;
    const key = `${a}|${b}|${r.relationshipType}`;
    const cur = best.get(key);
    if (!cur) {
      best.set(key, r);
      continue;
    }
    const keepNew = rank(r.status) < rank(cur.status) || (rank(r.status) === rank(cur.status) && r.id < cur.id);
    const winner = keepNew ? r : cur;
    const loser = keepNew ? cur : r;
    best.set(key, winner);
    toDelete.push(loser.id);
  }
  for (const id of toDelete) await deleteDoc(TABLES.relationships, id);
  return (selfDel.rowCount ?? 0) + toDelete.length;
};

/** ── Annotation ──────────────────────────────────────────────────────────── */

export const upsertAnnotation = async (doc: Partial<Annotation> & { id: string }): Promise<void> => {
  await upsertDoc(TABLES.annotations, doc as Annotation);
};

export const queryAnnotationsForFact = async (factVersionId: string): Promise<Annotation[]> =>
  findDocs<Annotation>(
    TABLES.annotations,
    "data->>'targetFactVersionId' = $1",
    [factVersionId],
    { orderBy: 'createdAt', desc: true },
  );

export const queryAnnotationsForPerson = async (personId: string): Promise<Annotation[]> =>
  findDocs<Annotation>(
    TABLES.annotations,
    "data->>'personId' = $1",
    [personId],
    { orderBy: 'createdAt', desc: true },
  );

export const updateAnnotationStatus = async (annotationId: string, status: Annotation['status']): Promise<void> => {
  const ann = await readDoc<Annotation>(TABLES.annotations, annotationId);
  if (!ann) throw new Error('Annotation not found');
  await upsertDoc(TABLES.annotations, { ...ann, status } as Annotation);
};

export const deleteAnnotation = async (annotationId: string): Promise<void> => {
  await deleteDoc(TABLES.annotations, annotationId);
};

/** ── Batch persistence for builder output ─────────────────────────────────── */

/**
 * Persist all builder output to PostgreSQL.
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
 * the search index in sync with PostgreSQL.
 */

let _searchKey = process.env.AZURE_SEARCH_API_KEY ?? '';
let _searchSvc = process.env.AZURE_SEARCH_SERVICE ?? '';

function shouldIndex(): boolean {
  if (process.env.NODE_ENV === 'test') return false;
  // Indexing only needs a configured service. Auth is admin-key when provided,
  // else Microsoft Entra (managed identity) — same model as the rest of the stack.
  return !!_searchSvc;
}

/**
 * Normalize AZURE_SEARCH_SERVICE into a full endpoint URL. Accepts a bare service
 * name (svc), a fully-qualified host (svc.search.windows.net), or a full URL.
 */
function searchEndpoint(): string {
  const suffix = process.env.AZURE_SEARCH_ENDPOINT_SUFFIX ?? 'search.windows.net';
  const raw = _searchSvc.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.includes('.')) return `https://${raw}`;
  return `https://${raw}.${suffix}`;
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
  // Admin key when provided, else Entra (managed identity) via DefaultAzureCredential.
  const credential = _searchKey ? new AzureKeyCredential(_searchKey) : new DefaultAzureCredential();
  const client = new SearchClient(searchEndpoint(), 'resume-facts', credential);

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
  // Admin key when provided, else Entra (managed identity) via DefaultAzureCredential.
  const credential = _searchKey ? new AzureKeyCredential(_searchKey) : new DefaultAzureCredential();
  const client = new SearchClient(searchEndpoint(), 'resume-facts', credential);

  for (const bullet of bullets) {
    // mergeOrUploadDocuments handles both first-write and existing-doc safely.
    await client.mergeOrUploadDocuments([toSearchDocBullet(bullet)]).catch(e =>
      console.warn('[Search] bullet upsert failed:', e.message));
  }
}
