import { defineTool, toolResult, type McpTool } from '@greenhouse-resume-builder/mcp-core';

/**
 * Acquisition MCP server tools (skeleton).
 *
 * Backed today by FetchAndSnapshotWebSources / StoreUploadsAndExtract / Document
 * Intelligence in functions/src/activities. Handlers return typed placeholders; wire
 * them to the real activities/repositories (inside the durable boundary) to go live.
 */
export const acquisitionTools: McpTool[] = [
  defineTool({
    name: 'triage_sources',
    description: 'Classify incoming sources into web vs document routes and flag likely duplicates.',
    inputSchema: {
      type: 'object',
      properties: {
        sources: {
          type: 'array',
          items: { type: 'object' },
          description: 'Raw source descriptors (url or uploaded doc ref).',
        },
      },
      required: ['sources'],
    },
    handler: (args: any) => {
      const sources = Array.isArray(args?.sources) ? args.sources : [];
      const routes = sources.map((s: any, index: number) => ({
        index,
        route: typeof s?.url === 'string' ? 'web' : 'document',
        duplicate: false,
      }));
      return toolResult(`Triaged ${routes.length} source(s).`, { routes });
    },
  }),
  defineTool({
    name: 'fetch_web_snapshot',
    description: 'Fetch and snapshot a public web source into raw storage (returns a source-document reference).',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    handler: (args: any) =>
      toolResult(`Snapshot stub for ${args?.url ?? '(missing url)'}.`, {
        sourceDocumentId: null,
        blobPath: null,
        url: args?.url ?? null,
        status: 'stub',
      }),
  }),
  defineTool({
    name: 'extract_document',
    description: 'Run Azure AI Document Intelligence over an uploaded document and return extracted text spans.',
    inputSchema: {
      type: 'object',
      properties: { blobPath: { type: 'string' } },
      required: ['blobPath'],
    },
    handler: (args: any) =>
      toolResult(`Document Intelligence stub for ${args?.blobPath ?? '(missing blobPath)'}.`, {
        blobPath: args?.blobPath ?? null,
        pages: 0,
        text: '',
        status: 'stub',
      }),
  }),
  defineTool({
    name: 'normalize_text',
    description: 'Normalize raw extracted text (whitespace, encoding, section hints) before extraction.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    handler: (args: any) => {
      const text = typeof args?.text === 'string' ? args.text : '';
      return toolResult(`Normalized ${text.length} char(s).`, { text: text.replace(/\s+/g, ' ').trim() });
    },
  }),
];
