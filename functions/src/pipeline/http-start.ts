/**
 * HTTP starter (durable client) for the ingestion orchestrator.
 *
 * The Express API kicks off ingestion with:
 *   POST {FUNCTIONS_HOST}/api/orchestrators/IngestCandidateOrchestrator  body: { runId }
 *
 * Durable Functions orchestrators cannot be triggered directly over HTTP, so
 * this client function receives the request and calls client.startNew(...).
 */

// Load environment variables
import '../env';

import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import * as df from 'durable-functions';
import { isCallerAuthConfigured, validateCallerToken } from './validate-caller';

const ORCHESTRATOR_NAME = 'IngestCandidateOrchestrator';

let _warnedNoCallerAuth = false;

app.http('IngestCandidateOrchestratorHttpStart', {
  route: 'orchestrators/IngestCandidateOrchestrator',
  methods: ['POST'],
  authLevel: 'anonymous',
  extraInputs: [df.input.durableClient()],
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const client = df.getClient(context);

    // ── Authenticate the calling service before trusting any caller-supplied identity. ──
    // The orchestrator writes records under the tenant/user provided below, so that metadata is only
    // trustworthy once we know the caller holds a valid token for this endpoint (trusted-subsystem).
    if (isCallerAuthConfigured()) {
      try {
        await validateCallerToken(request.headers.get('authorization'));
      } catch (err: any) {
        context.warn(`[HttpStart] Caller authentication failed: ${err?.message ?? err}`);
        return { status: 401, jsonBody: { error: 'Unauthorized' } };
      }
    } else if (!_warnedNoCallerAuth) {
      _warnedNoCallerAuth = true;
      context.warn(
        '[HttpStart] Caller authentication is NOT enforced (FUNCTIONS_AUTH_AUDIENCE unset). The ' +
        'orchestrator trusts caller-supplied tenant/user identity — protect this endpoint with ' +
        'platform auth (EasyAuth/APIM) or network isolation, and set FUNCTIONS_AUTH_AUDIENCE to ' +
        'enforce token validation.',
      );
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    if (!body?.runId || typeof body.runId !== 'string') {
      return { status: 400, jsonBody: { error: 'runId (string) is required' } };
    }

    const input = {
      runId: body.runId,
      // Caller-forwarded identity — trusted only because the caller was authenticated above (when
      // enforcement is configured). The API derives these from the verified end-user token.
      tenantId: body.tenantId ?? request.headers.get('x-tenant-id') ?? undefined,
      requestedByUserId: body.requestedByUserId ?? request.headers.get('x-authenticated-user-id') ?? undefined,
      personOverride: body.personOverride,
      webUrls: Array.isArray(body.webUrls) ? body.webUrls : undefined,
    };

    // Use the runId as the orchestration instanceId for idempotent re-starts.
    const instanceId = await client.startNew(ORCHESTRATOR_NAME, { input, instanceId: body.runId });
    context.log(`[HttpStart] Started ${ORCHESTRATOR_NAME} instanceId=${instanceId} runId=${body.runId}`);

    return client.createCheckStatusResponse(request, instanceId);
  },
});
