/**
 * HTTP trigger for on-demand person deconfliction.
 *
 * The Express API proxies recruiter-initiated deconfliction here:
 *   POST {FUNCTIONS_HOST}/api/deconflict   body: { tenantId }
 *
 * Unlike ingestion this is a plain (non-durable) request: it merges same-name duplicate
 * persons across the tenant synchronously and returns a summary. The heavy lifting lives in
 * the shared `deconflictDuplicatePersons` routine, which the orchestrator also calls per-run.
 */

// Load environment variables (DATABASE_URL etc.) before persistence is touched.
import '../env';

import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { deconflictDuplicatePersons } from '../activities/deconflict';
import { isCallerAuthConfigured, validateCallerToken } from './validate-caller';

let _warnedNoCallerAuth = false;

app.http('DeconflictPersonsHttp', {
  route: 'deconflict',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    // Authenticate the calling service (trusted-subsystem) before mutating any records.
    if (isCallerAuthConfigured()) {
      try {
        await validateCallerToken(request.headers.get('authorization'));
      } catch (err: any) {
        context.warn(`[Deconflict] Caller authentication failed: ${err?.message ?? err}`);
        return { status: 401, jsonBody: { error: 'Unauthorized' } };
      }
    } else if (!_warnedNoCallerAuth) {
      _warnedNoCallerAuth = true;
      context.warn(
        '[Deconflict] Caller authentication is NOT enforced (FUNCTIONS_AUTH_AUDIENCE unset). This ' +
          'endpoint merges person records for the caller-supplied tenant — protect it with platform ' +
          'auth (EasyAuth/APIM) or network isolation, and set FUNCTIONS_AUTH_AUDIENCE to enforce.',
      );
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const tenantId = body?.tenantId ?? request.headers.get('x-tenant-id') ?? undefined;
    if (!tenantId || typeof tenantId !== 'string') {
      return { status: 400, jsonBody: { error: 'tenantId (string) is required' } };
    }

    try {
      const summary = await deconflictDuplicatePersons({ tenantId });
      context.log(
        `[Deconflict] tenant=${tenantId} groups=${summary.groupsFound} merged=${summary.personsMerged} edgesRemoved=${summary.edgesRemoved}`,
      );
      return { status: 200, jsonBody: summary };
    } catch (err: any) {
      context.error(`[Deconflict] failed for tenant=${tenantId}: ${err?.message ?? err}`);
      return { status: 500, jsonBody: { error: 'Deconfliction failed' } };
    }
  },
});
