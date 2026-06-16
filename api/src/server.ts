/** Greenhouse Resume Builder MVP — Express API Server Entry Point */
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ── Initialization (runs before routes are mounted) ────────────────

import { ensureMVPContainersExist } from './db/cosmos-client';
import { ensureSearchIndex } from './search/index';
import { authMiddleware } from './middleware/auth.middleware';

async function bootstrap() {
  console.log('[Server] Initializing data layers...');

  // Cosmos DB — auto-provision all containers
  await ensureMVPContainersExist();
  console.log('[Server] Cosmos DB containers verified');

  // Azure AI Search — create the resume-facts index if it doesn't exist
  await ensureSearchIndex();
  console.log('[Server] Azure AI Search index ensured');
}

// Start the server (don't block on init)
bootstrap().catch(err => {
  console.warn('[Server] Warning during initialization:', err);
});

// ── Authentication middleware (applied to all API routes) ─────────

app.use('/api/', authMiddleware as any);

// ── Public health check (no auth required) ────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ready' as string, timestamp: new Date().toISOString() });
});

// ── Route modules ─────────────────────────────────────────────────

// Ingestion (returns early if auth fails via middleware)
(async () => {
  const ingestionRoutes   = await import('./routes/ingestion').then(m => m.default);
  app.use('/api/v1/ingestion-requests', ingestionRoutes);
})();

(async () => {
  const annotationRoutes  = await import('./routes/annotations').then(m => m.default);
  app.use('/api/v1/annotations',        annotationRoutes);
})();

(async () => {
  const resumeBulletRoutes = await import('./routes/resume-bullets').then(m => m.default);
  app.use('/api/v1/insights',           resumeBulletRoutes);
})();

(async () => {
  const relationshipRoutes = await import('./routes/relationships').then(m => m.default);
  app.use('/api/v1/inferences',         relationshipRoutes);
})();

// ── Search endpoint (real-time full-text across facts + bullets) ──

(async () => {
  const search = await import('./search/index');
  app.post('/api/v1/search', async (req: any, res: any) => {
    try {
      const { query, sectionId, personId } = req.body;
      if (!query || typeof query !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid "query" field' });
      }
      const results = await search.searchResumeContents({
        query: query.trim(),
        sectionId,
        personId,
        top: parseInt(req.body.top as string) || 20,
        skip: parseInt(req.body.skip as string) || 0,
      });
      res.json({ results, total: results.length });
    } catch (err: any) {
      console.error('[Server] Search error:', err);
      res.status(500).json({ error: 'Search failed', details: err.message });
    }
  });
})();

// ── Stats endpoint (runtime counts from Cosmos) ──────────────────

(async () => {
  const repos = await import('./db/repo');
  app.get('/api/v1/stats', async (_req: any, res: any) => {
    try {
      // Use COUNT queries instead of full container scans.
      const factsCount = await repos.factVersionRepo.query<number>({
        sql: 'SELECT VALUE COUNT(1) FROM c WHERE isObject(c)',
      });
      const bulletsCount = await repos.bulletMappingRepo.query<number>({
        sql: 'SELECT VALUE COUNT(1) FROM c WHERE isObject(c)',
      });
      const pendingRuns = await repos.extractionRunRepo.query<number>({
        sql: 'SELECT VALUE COUNT(1) FROM c WHERE c.status IN ("pending", "started", "queued")',
      });

      // Each query returns a single-element array with a scalar count.
      const toNum = (vals: number[]) => {
        if (!Array.isArray(vals) || vals.length === 0) return 0;
        return vals[0] ?? 0;
      };

      res.json({
        factsTotal: toNum(factsCount),
        bulletsTotal: toNum(bulletsCount),
        runsPending: toNum(pendingRuns),
        searchConfigured: !!process.env.AZURE_SEARCH_SERVICE,
      });
    } catch (err: any) {
      res.status(500).json({ error: 'Stats fetch failed', details: err.message });
    }
  });
})();

// ── Health + Listen ───────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`[Server] MVP Express API ready on port ${PORT}, NODE_ENV=${process.env.NODE_ENV ?? 'not set'}`);
});
