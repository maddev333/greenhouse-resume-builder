import { Router } from 'express';
import type { CreateIngestionRequestInput, ExtractionRun, IngestionRunResponse } from '@greenhouse-resume-builder/shared';
import { extractionRunRepo, sourceDocRepo } from '../db/repo';
import { getServiceAuthHeaders } from '../services/entra-token';

import crypto from 'crypto';

const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10-minute dedup window

/** Generate a stable content hash of the source documents for idempotency keys. */
function computeContentHash(sourceDocs: CreateIngestionRequestInput['sourceDocuments']): string {
  const payload = sourceDocs
    .sort((a, b) => (a.blobPath ?? a.uri ?? '').localeCompare(b.blobPath ?? b.uri ?? ''))
    .map(d => `${d.name}|${d.mimeType}|${d.blobPath || d.uri || ''}`)
    .join(';');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

const router = Router();

router.post('/', async (req: any, res: any) => {
  const input: CreateIngestionRequestInput = req.body;

  if (!input?.tenantId || !Array.isArray(input.sourceDocuments) || input.sourceDocuments.length === 0) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const tenantId = input.tenantId || req.user?.tenantId || req.tenantId || 'tenant-default';
  const requestedByUserId = req.user?.id || req.userId || 'system';

  const webCount = input.sourceDocuments.filter((d) => d.sourceType === 'web').length;
  const uploadCount = input.sourceDocuments.length - webCount;
  console.log(
    `[Ingestion] Request received: tenant=${tenantId} user=${requestedByUserId} ` +
      `sources=${input.sourceDocuments.length} (web=${webCount}, upload=${uploadCount})`,
  );

  // ── Idempotency check ────────────────────────────────────────────────
  const contentHash = computeContentHash(input.sourceDocuments);
  const recentRuns = await extractionRunRepo.activeByTenant(tenantId);
  for (const r of recentRuns as unknown as ExtractionRun[]) {
    if ((Date.now() - new Date(r.createdAt).getTime()) > DEDUP_WINDOW_MS) continue;
    // Quick content hash match on the run's source doc IDs to avoid false positives
    const sourceDocs = await sourceDocRepo.getByRun(r.id);
    const runHash = computeContentHash(sourceDocs.map((sd: any) => ({
      name: sd.mimeType || 'unknown', mimeType: sd.mimeType, blobPath: sd.blobPath, uri: sd.uri,
    })) as CreateIngestionRequestInput['sourceDocuments']);
    if (runHash === contentHash) {
      console.log(`[Ingestion] Deduplicated → returning existing run ${r.id} (within ${DEDUP_WINDOW_MS / 60000}min window)`);
      return res.status(200).json({
        runId: r.id,
        status: 'queued' as const,
        createdAt: r.createdAt,
        sourceDocumentIds: [],
        deduplicated: true,
      } as unknown as IngestionRunResponse);
    }
  }

  try {
    const now = new Date().toISOString();
    const run = await extractionRunRepo.create({
      id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      tenantId,
      requestedByUserId,
      sourceDocumentIds: [],
    } as any);

    // Store content hash on the run for dedup debugging.
    (run as any).contentHash = contentHash;
    await extractionRunRepo.updateStatus(run.id, 'in_progress', { updatedAt: now });

    const sourceDocIds: string[] = [];
    for (const sd of input.sourceDocuments) {
      const sdId = `sd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await sourceDocRepo.create({
        id: sdId, tenantId, personId: input.personId,
        extractionRunId: run.id, sourceType: (sd.sourceType || 'upload'),
        uri: sd.uri, blobPath: sd.blobPath, mimeType: sd.mimeType,
      } as any);
      sourceDocIds.push(sdId);
    }

    // Update run with content hash and source doc IDs.
    await extractionRunRepo.replace(run.id, {
      ...run, sourceDocumentIds: sourceDocIds, updatedAt: now,
    });

    res.status(201).json({
      runId: run.id,
      status: 'in_progress' as const,
      createdAt: run.createdAt,
      sourceDocumentIds: sourceDocIds,
    } satisfies IngestionRunResponse);

    const fnHost = process.env.FUNCTIONS_HOST || 'http://localhost:7071';
    const orchestratorUrl = `${fnHost}/api/orchestrators/IngestCandidateOrchestrator`;
    // Forward web source URLs to the orchestrator. The pipeline fetches/normalizes these from the
    // input payload; they are NOT otherwise recoverable inside the pipeline (storeUploadsAndExtract
    // only handles uploaded blobs), so omitting them yields a run with 0 fetched content / 0 facts.
    const webUrls = input.sourceDocuments
      .filter((d) => d.sourceType === 'web' && d.uri)
      .map((d) => d.uri as string);
    console.log(`[Ingestion] Run ${run.id} created with ${sourceDocIds.length} source doc(s) (${webUrls.length} web URL(s)) → triggering orchestrator at ${fnHost}`);
    void (async () => {
      const authHeaders = await getServiceAuthHeaders(process.env.FUNCTIONS_TOKEN_SCOPE, req.accessToken);
      const resp = await fetch(orchestratorUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-authenticated-user-id': requestedByUserId,
          'x-tenant-id': tenantId,
          ...authHeaders,
        },
        body: JSON.stringify({ runId: run.id, tenantId, requestedByUserId, webUrls }),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(
          `Orchestrator start returned ${resp.status} ${resp.statusText} from ${orchestratorUrl}: ${detail.slice(0, 500)}`,
        );
      }
      console.log(`[Ingestion] Orchestrator started for run ${run.id} (HTTP ${resp.status})`);
    })().catch(async (e) => {
      console.error(`[Ingestion] Failed to start orchestrator for run ${run.id}:`, e?.message ?? e);
      // Surface the failure to the UI instead of leaving the run stuck "in_progress" forever.
      try {
        await extractionRunRepo.updateStatus(run.id, 'failed', {
          failedReason: `Failed to start ingestion pipeline: ${e?.message ?? e}`,
        } as Partial<ExtractionRun>);
      } catch (markErr) {
        console.error(`[Ingestion] Could not mark run ${run.id} as failed:`, markErr);
      }
    });

  } catch (err) {
    console.error('[Ingestion] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:runId/status', async (req: any, res: any) => {
  try {
    const run = await extractionRunRepo.getById(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json({ runId: run.id, status: run.status, createdAt: run.createdAt,
      completedAt: run.completedAt ?? null, failedReason: run.failedReason ?? null,
      personId: (run as any).personId || null });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', async (_req: any, res: any) => {
  try {
    const tenantId = _req.query.tenantId as string | undefined;
    let docs: ExtractionRun[];
    if (tenantId) {
      docs = await extractionRunRepo.allByTenant(tenantId);
    } else {
      docs = await extractionRunRepo.recentAll(50);
    }

    const result = docs.map(r => ({
      id: r.id, status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt,
      personId: (r as any).personId || null,
      sourceDocumentCount: (r.sourceDocumentIds?.length ?? 0),
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
