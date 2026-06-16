/**
 * Temporal agent (agent-framework runtime).
 *
 * Self-hosted Azure OpenAI tool-calling loop that detects temporal patterns and predicts
 * likely future events for a person via the Temporal MCP server. Predictions are never
 * facts. IL5-compliant (no Foundry Agent Service).
 */
import { runAgentLoop, mcpToolCaller, type AgentTool } from '@greenhouse-resume-builder/mcp-core';

const TEMPORAL_MCP_URL = process.env.TEMPORAL_MCP_URL || 'http://localhost:7075/api/mcp/temporal';

const SYSTEM = [
  'You are the Temporal agent. Use the tools to detect recurrence patterns and predict',
  'likely future events with explicit confidence and rationale. Never present a prediction',
  'as an observed fact; always include evidence and an expiration.',
].join(' ');

const personParam = { type: 'object', properties: { personId: { type: 'string' } }, required: ['personId'] };

const tools: AgentTool[] = [
  { name: 'detect_patterns', description: 'Detect recurrence/seasonality/sequences/gaps for a person.', parameters: personParam },
  { name: 'predict_events', description: 'Predict likely future events with confidence and rationale.', parameters: personParam },
  { name: 'create_alerts', description: 'Create recruiter alerts for actionable predictions.', parameters: personParam },
];

const callTool = mcpToolCaller(TEMPORAL_MCP_URL);

export async function runTemporalAgent(personId: string): Promise<void> {
  const result = await runAgentLoop({
    system: SYSTEM,
    user: `Detect patterns and predict future events for personId=${personId}.`,
    tools,
    callTool,
    logger: console,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  const personId = process.argv[2] || 'person-123';
  runTemporalAgent(personId).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
