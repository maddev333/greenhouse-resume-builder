import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';

// ━━━ Singleton client lifecycle (MVP: one global connection) ━━━━━━━━━━━

let _client: CosmosClient | undefined;

export async function initializeCosmosClient(): Promise<CosmosClient> {
  if (_client) return _client;

  const endpoint = process.env.COSMOS_ENDPOINT ?? '';
  const key      = process.env.COSMOS_AUTH_KEY     ?? '';

  if (!endpoint) {
    throw new Error('Cosmos DB required environment variable missing: COSMOS_ENDPOINT');
  }

  // IL5 / production: use Microsoft Entra ID (managed identity) when no account key is supplied.
  // Local dev against the Cosmos emulator keeps working by providing COSMOS_AUTH_KEY.
  _client = key
    ? new CosmosClient({ endpoint, key })
    : new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
  await ensureDatabaseExists();
  return _client;
}

export function getCosmosClient(): CosmosClient {
  if (!_client) throw new Error('initializeCosmosClient() not called');
  return _client;
}

// ━━━ Database + containers for MVP entities ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DATABASE_NAME = 'resumeBuilder';

export async function getDatabase() {
  const client = await initializeCosmosClient();
  return client.database(DATABASE_NAME);
}

/** List of partitioned container names created on startup (MVP: auto-provisioning). */
const MVP_CONTAINERS = [
  'persons',
  'sourceDocuments',
  'extractionRuns',
  'factVersions',
  'bulletMappings',
  'annotations',
  'relationships',
];

async function ensureDatabaseExists() {
  const client = await initializeCosmosClient();
  await client.databases.createIfNotExists({ id: DATABASE_NAME });
}

/** Ensure each MVP container exists; creates with default partition key (/id) for local dev. */
async function createCollectionIfMissing(name: string) {
  // NOTE: For production, use /tenantId as partition key + appropriate indexing policy.
  const db = await getDatabase();
  await db.containers.createIfNotExists({ id: name });
}

// Export startup guarantee — called once during app boot via server.ts
export async function ensureMVPContainersExist(): Promise<void> {
  for (const name of MVP_CONTAINERS) {
    await createCollectionIfMissing(name);
  }
}
