/**
 * Ingestion agent (agent-framework runtime).
 *
 * Self-hosted Azure OpenAI tool-calling loop that drives the Acquisition + Extraction
 * MCP servers to turn raw sources into evidence-grounded facts. IL5-compliant: app code
 * owns the loop; the managed Foundry Agent Service (IL2-only) is not used.
 *
 * Run: `npm run build` then `node dist/agent.js "<source url or text>"`.
 */
import { runAgentLoop, mcpToolCaller, type AgentTool } from '@greenhouse-resume-builder/mcp-core';

const ACQUISITION_URL = process.env.ACQUISITION_MCP_URL || 'http://localhost:7071/api/mcp/acquisition';
const EXTRACTION_URL = process.env.EXTRACTION_MCP_URL || 'http://localhost:7072/api/mcp/extraction';

const SYSTEM = [
  'You are the Ingestion agent for a recruiting knowledge base.',
  'Use the acquisition tools to fetch/normalize sources, then the extraction tools to pull',
  'employment, skills, and education STRICTLY from the acquired text. Never invent facts.',
  'Every extracted fact must trace back to acquired source text.',
].join(' ');

const tools: AgentTool[] = [
  {
    name: 'fetch_web_snapshot',
    description: 'Fetch and snapshot a public web source; returns a source-document reference.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'normalize_text',
    description: 'Normalize raw extracted text before extraction.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'extract_experience',
    description: 'Extract employment history strictly from supplied text.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'extract_skills',
    description: 'Extract skills strictly from supplied text.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

// Route each tool name to the MCP server that hosts it.
const acquisition = mcpToolCaller(ACQUISITION_URL);
const extraction = mcpToolCaller(EXTRACTION_URL);
const routes: Record<string, (name: string, args: any) => Promise<unknown>> = {
  fetch_web_snapshot: acquisition,
  normalize_text: acquisition,
  extract_experience: extraction,
  extract_skills: extraction,
};

export async function runIngestionAgent(input: string): Promise<void> {
  const result = await runAgentLoop({
    system: SYSTEM,
    user: `Ingest this source and extract grounded facts:\n${input}`,
    tools,
    callTool: (name, args) => (routes[name] ?? acquisition)(name, args),
    logger: console,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  const input = process.argv.slice(2).join(' ') || 'https://example.com/candidate';
  runIngestionAgent(input).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
