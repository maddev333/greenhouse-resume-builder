// CleanupOrchestrator — Timer-triggered Azure Function that prunes stale ingestion runs.
// Removes failed ExtractionRuns older than 24 hours (completed runs are retained so
// successful runs stay visible in the UI), and resets 'queued'/'in_progress' runs
// older than 6 hours to 'failed'.
// Cron expression: every 6 hours (0 0 */6 * * *)

import { app } from '@azure/functions';
import { markStaleRunsFailed, deleteFailedRunsBefore } from '../persistence/index';

// Thresholds
const STALE_FAILED_MS     = 24 * 60 * 60 * 1000; // 24 hours
const STALE_INACTIVE_MS   = 6 * 60 * 60 * 1000;  // 6 hours

export async function cleanupStaleRuns(context: any): Promise<void> {
  const now = Date.now();
  context.log(`[CleanupOrchestrator] Starting stale-run cleanup at ${new Date().toISOString()}`);

  try {
    // ── 1. Mark stuck runs (queued/in_progress older than STALE_INACTIVE_MS) as failed ──
    const inactiveCutoff = new Date(now - STALE_INACTIVE_MS).toISOString();
    const markedFailed = await markStaleRunsFailed(inactiveCutoff, 'Stale - exceeded 6-hour inactive timeout');

    // ── 2. Delete failed runs older than STALE_FAILED_MS (completed runs are retained so successful runs stay visible in the UI) ──
    const failedCutoff = new Date(now - STALE_FAILED_MS).toISOString();
    const deletedCount = await deleteFailedRunsBefore(failedCutoff);

    context.info(
      `[CleanupOrchestrator] Cleanup complete - marked failed: ${markedFailed}, deleted failed: ${deletedCount}`,
    );
  } catch (err: any) {
    context.error(`[CleanupOrchestrator] Error during cleanup:`, err);
  }
}

app.timer('CleanupStaleRunsTimer', {
  schedule: '0 0 */6 * * *',
  handler: (_myTimer: any, context: any) => cleanupStaleRuns(context),
});
