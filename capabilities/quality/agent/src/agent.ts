/**
 * Quality agent (agent-framework runtime).
 *
 * Self-hosted Azure OpenAI tool-calling loop that runs citation + conflict guardrails
 * over a person's facts via the Quality MCP server. IL5-compliant (no Foundry Agent Service).
 */
import { runAgentLoop, mcpToolCaller, type AgentTool } from '@greenhouse-resume-builder/mcp-core';

const QUALITY_MCP_URL = process.env.QUALITY_MCP_URL || 'http://localhost:7073/api/mcp/quality';

const SYSTEM = [
  'You are the Quality agent. Use the tools to verify every fact has supporting evidence,',
  'detect contradictions against prior facts, and create review tasks for low-confidence or',
  'conflicting data. Never approve an unsupported claim.',
].join(' ');

const facts = { type: 'object', properties: { facts: { type: 'array', items: { type: 'object' } } }, required: ['facts'] };

const tools: AgentTool[] = [
  { name: 'check_citations', description: 'Verify facts have supporting evidence; flag unsupported claims.', parameters: facts },
  { name: 'detect_conflicts', description: 'Flag contradictions against prior facts.', parameters: facts },
  { name: 'create_review_tasks', description: 'Create review tasks for low-confidence/conflicting facts.', parameters: facts },
];

const callTool = mcpToolCaller(QUALITY_MCP_URL);

export async function runQualityAgent(personId: string): Promise<void> {
  const result = await runAgentLoop({
    system: SYSTEM,
    user: `Run quality guardrails for personId=${personId} over the facts already extracted for this person.`,
    tools,
    callTool,
    logger: console,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  const personId = process.argv[2] || 'person-123';
  runQualityAgent(personId).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
