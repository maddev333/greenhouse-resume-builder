import { Pool, type PoolConfig } from 'pg';
import { getEntraAccessToken } from '../services/entra-token';

// ━━━ Singleton pool lifecycle (MVP: one global connection pool) ━━━━━━━━

let _poolPromise: Promise<Pool> | undefined;

/**
 * AAD scope for Azure Database for PostgreSQL flexible server.
 * Used when no password is supplied (managed-identity / Entra auth — IL5 posture).
 */
const AAD_SCOPE = process.env.PG_AAD_SCOPE ?? 'https://ossrdbms-aad.database.windows.net/.default';

/** Detect Azure-hosted PostgreSQL endpoints so we can require TLS by default. */
function isAzureHost(host: string): boolean {
  return /\.postgres\.database\.(azure\.com|usgovcloudapi\.net|chinacloudapi\.cn)$/i.test(host);
}

function buildPoolConfig(): PoolConfig {
  // Connection-string form takes precedence (e.g. local dev / DATABASE_URL).
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

  // IL5 / production: when no password is supplied, authenticate with Microsoft Entra ID using the
  // shared MSAL-backed credential helper (services/entra-token.ts) — the same auth model the API
  // uses for Azure AI Search and other downstream services (On-Behalf-Of when a user assertion is
  // available, otherwise managed identity). node-postgres evaluates this function per new connection
  // and @azure/identity caches/refreshes the token, so every connection gets a valid AAD token.
  const password = process.env.PGPASSWORD ?? '';
  if (password) {
    config.password = password;
  } else {
    // The pool is a process-wide singleton with no per-request user context, so it authenticates as
    // the app/managed identity (getEntraAccessToken with no user assertion), mirroring the shared
    // singleton Azure AI Search client.
    if ((config.user ?? 'postgres') === 'postgres') {
      // Azure PostgreSQL validates an Entra token only for a username that is a provisioned Entra
      // principal; the built-in "postgres" role is password-only and will return 28P01. Make that
      // misconfiguration obvious instead of surfacing a bare "password authentication failed".
      console.warn(
        '[pg] PGPASSWORD is empty, so connecting with a Microsoft Entra (MSAL) token — but PGUSER is ' +
          '"postgres". Azure Database for PostgreSQL rejects Entra tokens for the built-in "postgres" role. ' +
          'Set PGUSER to your Entra principal (your az-login UPN/email, or the managed-identity/group name) ' +
          'that is provisioned on the server, or set PGPASSWORD to use password auth.',
      );
    }
    config.password = () => getEntraAccessToken(AAD_SCOPE);
  }

  return config;
}

export async function getPool(): Promise<Pool> {
  if (!_poolPromise) {
    _poolPromise = (async () => {
      const pool = new Pool(buildPoolConfig());
      pool.on('error', (err) => console.error('[pg] idle client error:', err.message));
      await ensureTablesOn(pool);
      return pool;
    })();
  }
  return _poolPromise;
}

// ━━━ Logical container → physical table mapping (MVP entities) ━━━━━━━━━

/**
 * Maps the legacy Cosmos container names to PostgreSQL table names.
 * Doubles as an allow-list so table identifiers can never be attacker-controlled.
 */
export const CONTAINER_TABLES: Record<string, string> = {
  persons: 'persons',
  sourceDocuments: 'source_documents',
  extractionRuns: 'extraction_runs',
  factVersions: 'fact_versions',
  bulletMappings: 'bullet_mappings',
  annotations: 'annotations',
  relationships: 'relationships',
};

export function physicalTable(container: string): string {
  const table = CONTAINER_TABLES[container];
  if (!table) throw new Error(`Unknown container/table: ${container}`);
  return table;
}

// ━━━ Schema provisioning (MVP: auto-create document tables + indexes) ━━

/**
 * Each entity is stored as a JSONB document keyed by its stable `id`, mirroring the
 * single-partition Cosmos containers. Expression indexes cover the hot filter paths.
 */
const TABLE_DDL: Array<{ table: string; indexes: string[] }> = [
  { table: 'persons', indexes: [
    "CREATE INDEX IF NOT EXISTS persons_tenant_idx ON persons ((data->>'tenantId'))",
    "CREATE INDEX IF NOT EXISTS persons_aliases_idx ON persons USING gin ((data->'aliases'))",
  ] },
  { table: 'source_documents', indexes: [
    "CREATE INDEX IF NOT EXISTS source_documents_run_idx ON source_documents ((data->>'extractionRunId'))",
    "CREATE INDEX IF NOT EXISTS source_documents_person_idx ON source_documents ((data->>'personId'))",
  ] },
  { table: 'extraction_runs', indexes: [
    "CREATE INDEX IF NOT EXISTS extraction_runs_tenant_idx ON extraction_runs ((data->>'tenantId'))",
    "CREATE INDEX IF NOT EXISTS extraction_runs_person_idx ON extraction_runs ((data->>'personId'))",
    "CREATE INDEX IF NOT EXISTS extraction_runs_status_idx ON extraction_runs ((data->>'status'))",
  ] },
  { table: 'fact_versions', indexes: [
    "CREATE INDEX IF NOT EXISTS fact_versions_person_idx ON fact_versions ((data->>'personId'))",
    "CREATE INDEX IF NOT EXISTS fact_versions_run_idx ON fact_versions ((data->>'extractionRunId'))",
    "CREATE INDEX IF NOT EXISTS fact_versions_section_idx ON fact_versions ((data->>'sectionId'))",
  ] },
  { table: 'bullet_mappings', indexes: [
    "CREATE INDEX IF NOT EXISTS bullet_mappings_person_idx ON bullet_mappings ((data->>'personId'))",
    "CREATE INDEX IF NOT EXISTS bullet_mappings_run_idx ON bullet_mappings ((data->>'extractionRunId'))",
  ] },
  { table: 'annotations', indexes: [
    "CREATE INDEX IF NOT EXISTS annotations_person_idx ON annotations ((data->>'personId'))",
    "CREATE INDEX IF NOT EXISTS annotations_fact_idx ON annotations ((data->>'targetFactVersionId'))",
  ] },
  { table: 'relationships', indexes: [
    "CREATE INDEX IF NOT EXISTS relationships_from_idx ON relationships ((data->>'fromPersonId'))",
    "CREATE INDEX IF NOT EXISTS relationships_to_idx ON relationships ((data->>'toPersonId'))",
  ] },
];

// Export startup guarantee — called once during app boot via server.ts
async function ensureTablesOn(pool: Pool): Promise<void> {
  for (const { table, indexes } of TABLE_DDL) {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data JSONB NOT NULL)`,
    );
    for (const idx of indexes) {
      await pool.query(idx);
    }
  }
}

/** Provision all MVP tables (idempotent). Triggers pool init + table creation. */
export async function ensureMVPTablesExist(): Promise<void> {
  await getPool();
}
