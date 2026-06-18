import { Router } from 'express';
import { getServiceAuthHeaders } from '../services/entra-token';

/**
 * Persons routes.
 *
 * `POST /deconflict` triggers same-name person deconfliction (merge duplicates) for the
 * caller's tenant. The merge itself lives in the Durable Functions app (which owns the
 * persistence layer), so the API proxies to it — mirroring how ingestion is dispatched.
 */
const router = Router();

router.post('/deconflict', async (req: any, res: any) => {
  const tenantId = req.body?.tenantId || req.user?.tenantId || req.tenantId || 'tenant-default';

  try {
    const fnHost = process.env.FUNCTIONS_HOST || 'http://localhost:7071';
    const url = `${fnHost}/api/deconflict`;
    const authHeaders = await getServiceAuthHeaders(process.env.FUNCTIONS_TOKEN_SCOPE, req.accessToken);

    console.log(`[Persons] Deconflict requested: tenant=${tenantId} → ${fnHost}`);
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': tenantId,
        ...authHeaders,
      },
      body: JSON.stringify({ tenantId }),
    });

    const text = await resp.text();
    if (!resp.ok) {
      console.error(`[Persons] Deconflict via functions failed: ${resp.status} ${text.slice(0, 300)}`);
      return res.status(502).json({ error: 'Deconfliction service error', status: resp.status });
    }

    const summary = text ? JSON.parse(text) : {};
    console.log(`[Persons] Deconflict done: groups=${summary.groupsFound ?? 0} merged=${summary.personsMerged ?? 0}`);
    res.json(summary);
  } catch (err: any) {
    console.error('[Persons] Deconflict error:', err?.message ?? err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
