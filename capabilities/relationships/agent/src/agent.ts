/**
 * Relationships agent (agent-framework runtime).
 *
 * Self-hosted Azure OpenAI tool-calling loop that proposes evidence-backed relationships
 * for a person via the Relationships MCP server. Recruiter-authored edges remain
 * authoritative over inference. IL5-compliant (no Foundry Agent Service).
 */
import { runAgentLoop, mcpToolCaller, type AgentTool } from '@greenhouse-resume-builder/mcp-core';

const RELATIONSHIPS_MCP_URL = process.env.RELATIONSHIPS_MCP_URL || 'http://localhost:7074/api/mcp/relationships';

const SYSTEM = [
  'You are the Relationships agent. Use the tools to infer evidence-backed relationships',
  'between people. Only suggest edges that have supporting evidence; never overwrite',
  'recruiter-authored edges.',
].join(' ');

const personParam = { type: 'object', properties: { personId: { type: 'string' } }, required: ['personId'] };

const tools: AgentTool[] = [
  { name: 'infer_relationships', description: 'Suggest evidence-backed relationships for a person.', parameters: personParam },
];

const callTool = mcpToolCaller(RELATIONSHIPS_MCP_URL);

export async function runRelationshipsAgent(personId: string): Promise<void> {
  const result = await runAgentLoop({
    system: SYSTEM,
    user: `Infer evidence-backed relationships for personId=${personId}.`,
    tools,
    callTool,
    logger: console,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  const personId = process.argv[2] || 'person-123';
  runRelationshipsAgent(personId).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
