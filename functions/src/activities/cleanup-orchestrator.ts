// CleanupOrchestrator — Timer-triggered Azure Function that prunes stale ingestion runs.
// Removes ExtractionRuns older than 24 hours in 'failed' or 'completed' status,
// and resets 'queued'/'in_progress' runs older than 6 hours to 'failed'.
// Cron expression: every 6 hours (0 0 */6 * * *)

import { app } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';

const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT ?? '';
const COSMOS_AUTH_KEY = process.env.COSMOS_AUTH_KEY ?? '';
const DB_NAME         = 'resumeBuilder';
const CONTAINER_NAME  = 'extractionRuns';

// Thresholds
const STALE_COMPLETED_MS  = 24 * 60 * 60 * 1000; // 24 hours
const STALE_INACTIVE_MS   = 6 * 60 * 60 * 1000;  // 6 hours

let _client: CosmosClient | null = null;

async function getClient(): Promise<CosmosClient> {
  if (!_client) {
    if (!COSMOS_ENDPOINT || !COSMOS_AUTH_KEY) throw new Error('COSMOS_ENDPOINT and COSMOS_AUTH_KEY required');
    _client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_AUTH_KEY });
  }
  return _client;
}

export async function cleanupStaleRuns(context: any): Promise<void> {
  const now = Date.now();
  context.log(`[CleanupOrchestrator] Starting stale-run cleanup at ${new Date().toISOString()}`);

  const client = await getClient();
  const container = client.database(DB_NAME).container(CONTAINER_NAME);

  try {
    // ── 1. Mark stuck runs (queued/in_progress > STALE_INACTIVE_MS) as failed ──
    const stuckQuery: any = {
      query: `SELECT c.id, c.status FROM c WHERE c.status IN ('queued','in_progress') AND (NOW() - CAST(UNIX_DATE(c.createdAt)/1000 AS INT)) > @threshold`,
      parameters: [{ name: '@threshold', value: STALE_INACTIVE_MS / 1000 }],
    };
    const stuckItems = await container.items.query(stuckQuery).fetchAll();

    let markedFailed = 0;
    for (const item of stuckItems.resources) {
      try {
        const result = await container.item(item.id, item.id).read();
        if (result.resource?.status === 'queued' || result.resource?.status === 'in_progress') {
          await container.item(item.id, item.id).replace({
            ...result.resource,
            status: 'failed',
            failedReason: 'Stale - exceeded 6-hour inactive timeout',
            updatedAt: new Date().toISOString(),
          });
          markedFailed++;
        }
      } catch (e) {
        context.warn(`[CleanupOrchestrator] Failed to mark run ${item.id} as failed:`, e);
      }
    }

    // ── 2. Delete completed runs older than STALE_COMPLETED_MS (archive to blob if needed later) ──
    const archivableQuery: any = {
      query: `SELECT c.id FROM c WHERE c.status = 'completed' AND (NOW() - CAST(UNIX_DATE(c.createdAt)/1000 AS INT)) > @threshold`,
      parameters: [{ name: '@threshold', value: STALE_COMPLETED_MS / 1000 }],
    };
    const archivableItems = await container.items.query(archivableQuery).fetchAll();

    let deletedCount = 0;
    for (const item of archivableItems.resources) {
      try {
        await container.item(item.id, item.id).delete();
        deletedCount++;
      } catch (e) {
        context.warn(`[CleanupOrchestrator] Failed to delete run ${item.id}:`, e);
      }
    }

    context.info(
      `[CleanupOrchestrator] Cleanup complete - marked failed: ${markedFailed}, deleted completed: ${deletedCount}`,
    );
  } catch (err: any) {
    context.error(`[CleanupOrchestrator] Error during cleanup:`, err);
  }
}

app.timer('CleanupStaleRunsTimer', {
  schedule: '0 0 */6 * * *',
  handler: (_myTimer: any, context: any) => cleanupStaleRuns(context),
});
