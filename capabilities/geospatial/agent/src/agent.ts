/**
 * Geospatial agent (agent-framework runtime).
 *
 * Self-hosted Azure OpenAI tool-calling loop that normalizes/geocodes approved locations
 * and projects map pins for a person via the Geospatial MCP server. Avoids sensitive
 * personal addresses. IL5-compliant (no Foundry Agent Service).
 */
import { runAgentLoop, mcpToolCaller, type AgentTool } from '@greenhouse-resume-builder/mcp-core';

const GEOSPATIAL_MCP_URL = process.env.GEOSPATIAL_MCP_URL || 'http://localhost:7076/api/mcp/geospatial';

const SYSTEM = [
  'You are the Geospatial agent. Use the tools to normalize and geocode only approved',
  'public/professional locations and project map pins. Never geocode sensitive personal',
  'or home addresses; prefer coarse city/region precision for sensitive data.',
].join(' ');

const tools: AgentTool[] = [
  {
    name: 'normalize_location',
    description: 'Normalize a raw location string into structured fields.',
    parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
  },
  {
    name: 'project_map_pins',
    description: 'Project location-bearing records for a person into map pins.',
    parameters: { type: 'object', properties: { personId: { type: 'string' } }, required: ['personId'] },
  },
];

const callTool = mcpToolCaller(GEOSPATIAL_MCP_URL);

export async function runGeospatialAgent(personId: string): Promise<void> {
  const result = await runAgentLoop({
    system: SYSTEM,
    user: `Project approved map pins for personId=${personId}.`,
    tools,
    callTool,
    logger: console,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  const personId = process.argv[2] || 'person-123';
  runGeospatialAgent(personId).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
