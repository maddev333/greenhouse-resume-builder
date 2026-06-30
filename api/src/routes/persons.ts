import { Router } from 'express';
import { getServiceAuthHeaders } from '../services/entra-token';
import { getFunctionsBaseUrl } from '../services/functions-host';

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
    const fnHost = getFunctionsBaseUrl();
    const url = `${fnHost}/api/deconflict`;
    // Trusted-subsystem auth: present the API's own managed identity (app-only token), NOT OBO.
    // The Functions endpoint validates only audience/issuer/tenant — it doesn't read the user
    // identity — and FUNCTIONS_AUTH_AUDIENCE reuses this API's app registration, so an OBO
    // exchange would target the same app ("OBO to self") and fail. Mirrors pg-client's MI path.
    const authHeaders = await getServiceAuthHeaders(process.env.FUNCTIONS_TOKEN_SCOPE);

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
