import {
  defineTool,
  toolResult,
  buildFactSecurityFilter,
  isSensitiveFactKey,
  odataEscapeLiteral,
  type McpTool,
  type ToolCallContext,
  type ToolResult,
} from '@greenhouse-resume-builder/mcp-core';

/**
 * Discovery (search) MCP server tools.
 *
 * Backed by Azure AI Search indexes over facts and relationships (the backing query is a skeleton
 * here). Every read is **security-trimmed by the caller's verified Entra claims** on
 * {@link ToolCallContext}: a mandatory tenant filter (fail closed without a tenant claim) plus
 * role/scope-gated redaction of sensitive attributes. The index stores only IL5-authorized fields.
 */

/** MCP-idiomatic error result (surface failures via `isError`, not by throwing across JSON-RPC). */
function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export const searchTools: McpTool[] = [
  defineTool({
    name: 'search_facts',
    description: 'Search the facts index (keyword + vector) with optional filters; tenant/role security-trimmed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        filters: { type: 'object' },
        top: { type: 'number' },
      },
      required: ['query'],
    },
    handler: (args: any, ctx: ToolCallContext): ToolResult => {
      const f = args?.filters ?? {};
      const decision = buildFactSecurityFilter(ctx, {
        personId: typeof f.personId === 'string' ? f.personId : undefined,
        sectionId: typeof f.sectionId === 'string' ? f.sectionId : undefined,
        factKey: typeof f.factKey === 'string' ? f.factKey : undefined,
      });
      // Fail closed: never run an attribute-layer query without a verified tenant claim.
      if (!decision.allowed) {
        return errorResult(`search_facts denied: ${decision.reason}.`);
      }

      // Skeleton backing store. Apply the same attribute-level redaction the real index query must use,
      // so the security contract holds regardless of which backing the handler is wired to.
      const rawResults: any[] = [];
      const results = decision.allowSensitive
        ? rawResults
        : rawResults.filter((r) => !isSensitiveFactKey(r?.factKey));

      return toolResult(`Searched facts for "${args?.query ?? ''}" (tenant-trimmed).`, {
        results,
        total: results.length,
        appliedFilter: decision.filter,
        sensitiveAttributesIncluded: decision.allowSensitive,
      });
    },
  }),
  defineTool({
    name: 'search_relationships',
    description: 'Search the relationships index, optionally scoped to a person; tenant security-trimmed.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, personId: { type: 'string' } },
      required: ['query'],
    },
    handler: (args: any, ctx: ToolCallContext): ToolResult => {
      // Relationships are tenant-scoped; reuse the fail-closed tenant trim.
      const decision = buildFactSecurityFilter(ctx);
      if (!decision.allowed) {
        return errorResult(`search_relationships denied: ${decision.reason}.`);
      }
      const personId = typeof args?.personId === 'string' && args.personId ? args.personId : undefined;
      const filter = personId
        ? `${decision.filter} and (fromPersonId eq '${odataEscapeLiteral(personId)}' or toPersonId eq '${odataEscapeLiteral(personId)}')`
        : decision.filter;
      return toolResult('Relationship search (tenant-trimmed).', { results: [], appliedFilter: filter });
    },
  }),
  defineTool({
    name: 'index_upsert',
    description: 'Upsert documents into the search index (control-plane projection of facts).',
    inputSchema: {
      type: 'object',
      properties: { documents: { type: 'array', items: { type: 'object' } } },
      required: ['documents'],
    },
    handler: (args: any, ctx: ToolCallContext): ToolResult => {
      // Writes must be tenant-stamped from the verified claim — never trust a caller-supplied tenantId.
      if (!ctx.tenantId) {
        return errorResult('index_upsert denied: missing verified tenant claim (x-tenant-id).');
      }
      const docs = Array.isArray(args?.documents) ? args.documents : [];
      const stamped = docs.map((d: Record<string, unknown>) => ({ ...d, tenantId: ctx.tenantId }));
      return toolResult('Index upsert stub (tenant-stamped).', { upserted: stamped.length });
    },
  }),
];
