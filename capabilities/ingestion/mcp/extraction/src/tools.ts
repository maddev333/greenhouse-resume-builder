import { defineTool, toolResult, type JsonSchema, type McpTool } from '@greenhouse-resume-builder/mcp-core';

/**
 * Extraction MCP server tools (skeleton).
 *
 * Tool input/output mirrors the strict-JSON contracts already used by
 * functions/src/services/agent-runtime.ts (e.g. {"experience":[...]}) so existing
 * validation/fallback behavior carries over unchanged when these handlers are wired
 * to the real model-backed extractors.
 */
const textInput: JsonSchema = {
  type: 'object',
  properties: { text: { type: 'string', description: 'Source text to extract from.' } },
  required: ['text'],
};

export const extractionTools: McpTool[] = [
  defineTool({
    name: 'extract_experience',
    description: 'Extract employment history STRICTLY from the supplied text (no invented employers/titles/dates).',
    inputSchema: textInput,
    handler: () => toolResult('Experience extraction stub.', { experience: [] }),
  }),
  defineTool({
    name: 'extract_skills',
    description: 'Extract technical/soft skills with optional proficiency and evidence from the supplied text.',
    inputSchema: textInput,
    handler: () => toolResult('Skills extraction stub.', { skills: [] }),
  }),
  defineTool({
    name: 'extract_education',
    description: 'Extract education entries (school, degree, field, dates) STRICTLY from the supplied text.',
    inputSchema: textInput,
    handler: () => toolResult('Education extraction stub.', { education: [] }),
  }),
  defineTool({
    name: 'generate_summary',
    description: 'Generate a grounded profile summary using ONLY the supplied extracted facts.',
    inputSchema: {
      type: 'object',
      properties: { facts: { type: 'array', items: { type: 'object' } } },
      required: ['facts'],
    },
    handler: () => toolResult('Summary generation stub.', { summary: '' }),
  }),
];
