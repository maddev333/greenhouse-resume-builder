import { defineTool, toolResult, type JsonSchema, type McpTool } from '@greenhouse-resume-builder/mcp-core';

/**
 * Temporal Intelligence MCP server tools (skeleton).
 *
 * Backed by ExtractTemporalEvents / DetectTemporalPatterns / PredictFutureEvents /
 * CreateRecruiterAlerts (target). Predictions are NEVER persisted as observed facts;
 * every prediction carries evidence links, rationale, confidence, status, and expiration.
 */
const personInput: JsonSchema = {
  type: 'object',
  properties: { personId: { type: 'string' } },
  required: ['personId'],
};

export const temporalTools: McpTool[] = [
  defineTool({
    name: 'extract_events',
    description: 'Extract dated events (talks, publications, certs, role changes) from facts/sources.',
    inputSchema: {
      type: 'object',
      properties: { personId: { type: 'string' }, facts: { type: 'array', items: { type: 'object' } } },
      required: ['facts'],
    },
    handler: () => toolResult('Event extraction stub.', { events: [] }),
  }),
  defineTool({
    name: 'detect_patterns',
    description: 'Detect recurrence/seasonality/sequences/gaps by grouping events by normalized recurrence key.',
    inputSchema: personInput,
    handler: () => toolResult('Pattern detection stub.', { patterns: [] }),
  }),
  defineTool({
    name: 'predict_events',
    description: 'Predict likely future events with confidence and rationale (as predictions, not facts).',
    inputSchema: personInput,
    handler: () => toolResult('Prediction stub.', { predictions: [] }),
  }),
  defineTool({
    name: 'create_alerts',
    description: 'Create recruiter alerts for actionable medium/high-confidence predictions.',
    inputSchema: personInput,
    handler: () => toolResult('Alert creation stub.', { alerts: [] }),
  }),
];
