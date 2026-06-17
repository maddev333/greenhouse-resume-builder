/**
 * Ingestion agent (agent-framework runtime).
 *
 * Self-hosted Azure OpenAI tool-calling loop that drives the Acquisition + Extraction
 * MCP servers to turn raw sources into evidence-grounded facts. IL5-compliant: app code
 * owns the loop; the managed Foundry Agent Service (IL2-only) is not used.
 *
 * Identity for the Azure OpenAI deployment:
 *  - On-Behalf-Of the signed-in UI user when a user access token is supplied — programmatically
 *    via `runIngestionAgent(input, userToken)` (e.g. an HTTP host forwarding the MSAL token), or
 *    for the CLI via the AOAI_USER_ASSERTION env var — AND OBO is configured
 *    (AZURE_OBO_TENANT_ID / AZURE_OBO_CLIENT_ID). The deployment is then accessed as that user.
 *  - Otherwise DefaultAzureCredential (managed identity in cloud; the az-login user locally).
 *
 * Run: `npm run build` then `node dist/agent.js "<source url or text>"`.
 */
import { loadAgentEnv } from './env';
loadAgentEnv(); // pick up repo-root .env (Azure OpenAI + OBO settings) before reading config

import { runAgentLoop, mcpToolCaller, isOboConfigured, type AgentTool } from '@greenhouse-resume-builder/mcp-core';

const SYSTEM = [
  'You are the Ingestion agent for a recruiting knowledge base.',
  'Use the acquisition tools to fetch/normalize sources, then the extraction tools to pull',
  'employment, skills, and education STRICTLY from the acquired text. Never invent facts.',
  'Every extracted fact must trace back to acquired source text.',
].join(' ');

const tools: AgentTool[] = [
  {
    name: 'fetch_web_snapshot',
    description: 'Fetch and snapshot a public web source; returns a source-document reference.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'normalize_text',
    description: 'Normalize raw extracted text before extraction.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'extract_experience',
    description: 'Extract employment history strictly from supplied text.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'extract_skills',
    description: 'Extract skills strictly from supplied text.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

/**
 * Run the ingestion agent.
 *
 * @param input  Source URL or raw text to ingest.
 * @param userAssertionToken  The signed-in UI user's access token (audience = AZURE_OBO_CLIENT_ID).
 *   When supplied and OBO is configured, the Azure OpenAI deployment and the MCP servers are
 *   accessed On-Behalf-Of that user. Falls back to the AOAI_USER_ASSERTION env var for CLI use.
 */
export async function runIngestionAgent(input: string, userAssertionToken?: string): Promise<void> {
  const acquisitionUrl = process.env.ACQUISITION_MCP_URL || 'http://localhost:7071/api/mcp/acquisition';
  const extractionUrl = process.env.EXTRACTION_MCP_URL || 'http://localhost:7072/api/mcp/extraction';

  // The signed-in user's token (from the UI/MSAL). When present and OBO is configured, every
  // downstream call — Azure OpenAI and the MCP servers — runs On-Behalf-Of that user.
  const userToken = userAssertionToken || process.env.AOAI_USER_ASSERTION || undefined;
  const callerOpts = userToken ? { userAssertionToken: userToken } : {};

  // Route each tool name to the MCP server that hosts it (user-scoped when a token is present).
  const acquisition = mcpToolCaller(acquisitionUrl, callerOpts);
  const extraction = mcpToolCaller(extractionUrl, callerOpts);
  const routes: Record<string, (name: string, args: any) => Promise<unknown>> = {
    fetch_web_snapshot: acquisition,
    normalize_text: acquisition,
    extract_experience: extraction,
    extract_skills: extraction,
  };

  if (userToken) {
    console.log(
      isOboConfigured()
        ? '[agent] Accessing the model On-Behalf-Of the signed-in user (OBO).'
        : '[agent] User token supplied but OBO is NOT configured (set AZURE_OBO_TENANT_ID/AZURE_OBO_CLIENT_ID); falling back to app identity.',
    );
  } else {
    console.log('[agent] No user token supplied; using app/managed identity (DefaultAzureCredential) for the model.');
  }

  const result = await runAgentLoop({
    system: SYSTEM,
    user: `Ingest this source and extract grounded facts:\n${input}`,
    tools,
    callTool: (name, args) => (routes[name] ?? acquisition)(name, args),
    userAssertionToken: userToken,
    logger: console,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  const input = process.argv.slice(2).join(' ') || 'https://example.com/candidate';
  // CLI: the user assertion (if any) comes from AOAI_USER_ASSERTION, resolved inside runIngestionAgent.
  runIngestionAgent(input).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
