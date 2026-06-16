/**
 * Local cloud demo (geospatial) — exercises two real Azure services from one local app:
 *
 *   [1] Azure Maps geocoding via subscription key (AZURE_MAPS_KEY).
 *   [2] Azure OpenAI tool-calling via the identity SDK (DefaultAzureCredential / `az login`),
 *       driving the in-process geocode tool through the Agent Governance Toolkit gate.
 *
 * No Functions host required — the agent loop dispatches tools in-process.
 *
 *   npm run build --workspace=@greenhouse-resume-builder/cap-geospatial-mcp-geospatial
 *   npm run demo  --workspace=@greenhouse-resume-builder/cap-geospatial-mcp-geospatial -- "Space Needle, Seattle"
 */
import {
  runAgentLoop,
  governedToolCaller,
  getGovernance,
  isOboConfigured,
  type AgentTool,
} from '@greenhouse-resume-builder/mcp-core';
import { geospatialTools } from './tools';
import { geocodeLocation, isMapsConfigured } from './maps';

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(' ').trim() || 'Microsoft Building 92, Redmond, WA';

  // [1] Direct Azure Maps geocode (key auth) ────────────────────────────────
  console.log(`\n[1] Azure Maps geocode for: "${query}"`);
  if (!isMapsConfigured()) {
    console.log('    SKIP — set AZURE_MAPS_KEY (or AZURE_MAPS_CLIENT_ID for managed identity).');
  } else {
    try {
      const result = await geocodeLocation(query);
      console.log('    ->', JSON.stringify(result));
    } catch (err: any) {
      console.log('    ERROR —', err?.message || err);
    }
  }

  // [2] Azure OpenAI agent loop (identity SDK) → governed geocode tool ───────
  console.log('\n[2] Azure OpenAI agent loop → governed geocode tool');
  const agentTools: AgentTool[] = geospatialTools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));

  // In-process tool dispatch (no MCP host); wrapped with the governance gate.
  const dispatch = async (name: string, args: unknown): Promise<unknown> => {
    const tool = geospatialTools.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    const result = await tool.handler((args ?? {}) as Record<string, unknown>, {});
    return result.structuredContent ?? result;
  };
  const callTool = governedToolCaller(dispatch, getGovernance());

  // Auth: when a signed-in user's token is supplied (AOAI_USER_ASSERTION) and OBO is
  // configured, the model call runs On-Behalf-Of that user — no shared secret. Otherwise
  // the loop uses the app's / developer's own identity via DefaultAzureCredential.
  const userAssertionToken = process.env.AOAI_USER_ASSERTION || undefined;
  if (userAssertionToken && isOboConfigured()) {
    console.log('    auth: On-Behalf-Of — calls run as the signed-in user (no shared secret).');
  } else if (userAssertionToken) {
    console.log('    auth: user token supplied but OBO not configured (set AZURE_OBO_TENANT_ID + AZURE_OBO_CLIENT_ID); using app identity.');
  } else {
    console.log('    auth: app/developer identity via DefaultAzureCredential (`az login`).');
  }

  const result = await runAgentLoop({
    system:
      'You are the Geospatial agent. Geocode the user-provided location by calling the geocode tool, then report the coordinates. Never geocode sensitive personal/home addresses.',
    user: `Geocode this location: ${query}`,
    tools: agentTools,
    callTool,
    userAssertionToken,
    logger: console,
  });

  if (result.output === null) {
    console.log('    SKIP/fallback — Azure OpenAI not configured or unavailable.');
    console.log('    Set AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_DEPLOYMENT, then `az login` (or supply AOAI_USER_ASSERTION for OBO).');
  } else {
    console.log('    model output:', result.output);
  }
  console.log('    tool calls:', JSON.stringify(result.toolCalls));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
