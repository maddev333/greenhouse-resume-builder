/**
 * Discovery agent (agent-framework runtime).
 *
 * Self-hosted Azure OpenAI tool-calling loop that answers natural-language talent queries
 * by searching the facts/relationships indexes via the Discovery MCP server. Returns only
 * security-trimmed, cited results. IL5-compliant (no Foundry Agent Service).
 */
import { runAgentLoop, mcpToolCaller, type AgentTool } from '@greenhouse-resume-builder/mcp-core';

const SEARCH_MCP_URL = process.env.SEARCH_MCP_URL || 'http://localhost:7077/api/mcp/search';

const SYSTEM = [
  'You are the Discovery agent. Use the search tools to answer talent-discovery questions.',
  'Only surface results returned by the tools, always cite the underlying facts, and never',
  'invent candidates or attributes that are not in the search results.',
].join(' ');

const tools: AgentTool[] = [
  {
    name: 'search_facts',
    description: 'Search the facts index with optional filters.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, filters: { type: 'object' }, top: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'search_relationships',
    description: 'Search the relationships index, optionally scoped to a person.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, personId: { type: 'string' } },
      required: ['query'],
    },
  },
];

const callTool = mcpToolCaller(SEARCH_MCP_URL);

export async function runDiscoveryAgent(query: string): Promise<void> {
  const result = await runAgentLoop({
    system: SYSTEM,
    user: query,
    tools,
    callTool,
    logger: console,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  const query = process.argv.slice(2).join(' ') || 'Find candidates with Kubernetes and TS SCI clearance';
  runDiscoveryAgent(query).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
