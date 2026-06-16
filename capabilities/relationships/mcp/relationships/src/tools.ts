import { defineTool, toolResult, type McpTool } from '@greenhouse-resume-builder/mcp-core';

/**
 * Graph/Relationships MCP server tools (skeleton).
 *
 * Backed by InferRelationshipsForMatchingPersons + relationship routes. Persistence of
 * canonical edges stays activity/API-bound; recruiter-authored edges are authoritative
 * over inference.
 */
export const relationshipsTools: McpTool[] = [
  defineTool({
    name: 'infer_relationships',
    description: 'Suggest evidence-backed relationships (shared_employer, worked_together, ...) for a person.',
    inputSchema: {
      type: 'object',
      properties: { personId: { type: 'string' } },
      required: ['personId'],
    },
    handler: (args: any) =>
      toolResult(`Inference stub for ${args?.personId ?? '(missing personId)'}.`, { suggestions: [] }),
  }),
  defineTool({
    name: 'confirm_relationship',
    description: 'Confirm or reject an inferred relationship suggestion (recruiter action).',
    inputSchema: {
      type: 'object',
      properties: {
        relationshipId: { type: 'string' },
        decision: { type: 'string', enum: ['confirm', 'reject'] },
      },
      required: ['relationshipId', 'decision'],
    },
    handler: (args: any) =>
      toolResult(`Recorded ${args?.decision ?? 'decision'} for ${args?.relationshipId ?? '(missing id)'}.`, {
        relationshipId: args?.relationshipId ?? null,
        status: args?.decision ?? 'pending',
      }),
  }),
  defineTool({
    name: 'upsert_explicit_relationship',
    description: 'Create or update an explicit, recruiter-authored relationship edge with evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        fromPersonId: { type: 'string' },
        toPersonId: { type: 'string' },
        type: { type: 'string' },
        evidence: { type: 'array', items: { type: 'object' } },
      },
      required: ['fromPersonId', 'toPersonId', 'type'],
    },
    handler: () => toolResult('Explicit relationship upsert stub.', { relationshipId: null, status: 'stub' }),
  }),
];
