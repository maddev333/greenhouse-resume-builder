import { defineTool, toolResult, type McpTool } from '@greenhouse-resume-builder/mcp-core';

/**
 * Discovery (search) MCP server tools (skeleton).
 *
 * Backed by Azure AI Search indexes over facts and relationships (target). Queries must
 * respect per-document security trimming; the index stores only IL5-authorized fields.
 */
export const searchTools: McpTool[] = [
  defineTool({
    name: 'search_facts',
    description: 'Search the facts index (keyword + vector) with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        filters: { type: 'object' },
        top: { type: 'number' },
      },
      required: ['query'],
    },
    handler: (args: any) =>
      toolResult(`Searched facts for "${args?.query ?? ''}".`, { results: [], total: 0 }),
  }),
  defineTool({
    name: 'search_relationships',
    description: 'Search the relationships index, optionally scoped to a person.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, personId: { type: 'string' } },
      required: ['query'],
    },
    handler: () => toolResult('Relationship search stub.', { results: [] }),
  }),
  defineTool({
    name: 'index_upsert',
    description: 'Upsert documents into the search index (control-plane projection of facts).',
    inputSchema: {
      type: 'object',
      properties: { documents: { type: 'array', items: { type: 'object' } } },
      required: ['documents'],
    },
    handler: (args: any) =>
      toolResult('Index upsert stub.', { upserted: Array.isArray(args?.documents) ? args.documents.length : 0 }),
  }),
];
