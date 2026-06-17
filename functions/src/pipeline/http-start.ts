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

const ORCHESTRATOR_NAME = 'IngestCandidateOrchestrator';

app.http('IngestCandidateOrchestratorHttpStart', {
  route: 'orchestrators/IngestCandidateOrchestrator',
  methods: ['POST'],
  authLevel: 'anonymous',
  extraInputs: [df.input.durableClient()],
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const client = df.getClient(context);

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
      personOverride: body.personOverride,
      webUrls: Array.isArray(body.webUrls) ? body.webUrls : undefined,
    };

    // Use the runId as the orchestration instanceId for idempotent re-starts.
    const instanceId = await client.startNew(ORCHESTRATOR_NAME, { input, instanceId: body.runId });
    context.log(`[HttpStart] Started ${ORCHESTRATOR_NAME} instanceId=${instanceId} runId=${body.runId}`);

    return client.createCheckStatusResponse(request, instanceId);
  },
});
