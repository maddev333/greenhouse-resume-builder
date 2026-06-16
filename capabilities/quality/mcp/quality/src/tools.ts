import { defineTool, toolResult, type JsonSchema, type McpTool } from '@greenhouse-resume-builder/mcp-core';

/**
 * Quality/Citations MCP server tools (skeleton).
 *
 * Backed by CitationGuardAgent / ConflictQualityAgent / ReviewTaskAgent (target). These
 * are deterministic guardrails that run in IL5 compute and add evidence-grounding
 * independent of any model service.
 */
const factsInput: JsonSchema = {
  type: 'object',
  properties: {
    personId: { type: 'string' },
    facts: { type: 'array', items: { type: 'object' } },
  },
  required: ['facts'],
};

export const qualityTools: McpTool[] = [
  defineTool({
    name: 'check_citations',
    description: 'Verify each fact/bullet has supporting source-document evidence; flag unsupported claims.',
    inputSchema: factsInput,
    handler: (args: any) => {
      const facts = Array.isArray(args?.facts) ? args.facts : [];
      return toolResult(`Checked citations for ${facts.length} fact(s).`, { uncited: [], checked: facts.length });
    },
  }),
  defineTool({
    name: 'detect_conflicts',
    description: 'Compare current extraction against prior facts and flag contradictions.',
    inputSchema: factsInput,
    handler: () => toolResult('Conflict detection stub.', { conflicts: [] }),
  }),
  defineTool({
    name: 'create_review_tasks',
    description: 'Create review tasks for low-confidence or conflicting facts.',
    inputSchema: factsInput,
    handler: () => toolResult('Review-task creation stub.', { reviewTasks: [] }),
  }),
];
