/**
 * Entry point — two modes:
 *   CLI (default):   npm run ask -- "I'm planning a trip to AUSA, who should I meet on UAS/drone?" --persona EA_G8
 *   HTTP (--serve):  npm run serve   ->  POST /ask { question, persona?, leaderId?, topN? }
 *
 * The HTTP surface is the seam the chat UI (M6) calls. Requires the engagements MCP server
 * running (default http://localhost:3010/mcp; override with ENGAGEMENTS_MCP_URL).
 */
import './load-env.js';
import { planTrip } from './orchestrator.js';

interface CliArgs {
  question?: string;
  persona?: string;
  leader?: string;
  top?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--persona') out.persona = argv[++i];
    else if (a === '--leader') out.leader = argv[++i];
    else if (a === '--top') out.top = Number(argv[++i]);
    else rest.push(a);
  }
  out.question = rest.join(' ').trim() || undefined;
  return out;
}

async function ask(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args.question) {
    console.error('usage: npm run ask -- "<question>" [--persona EA_G8] [--leader L1] [--top 3]');
    process.exit(1);
  }
  const result = await planTrip({ question: args.question, persona: args.persona, leaderId: args.leader, topN: args.top });

  console.log(`\n[persona ${result.persona}] mode=${result.mode}${result.rejected ? '  ACCESS REJECTED' : ''}`);
  if (result.error) console.error(`\n! ${result.error}`);
  if (result.answer) console.log(`\n${result.answer}`);
  console.log(`\n— tools: ${result.toolCalls.map((t) => t.name).join(' → ') || '(none)'}`);
  console.log(
    `— menu: ${result.menu?.length ?? 0} option(s); redacted ${result.redactedCount ?? 0}; trip-map ${result.tripMap ? 'YES' : 'no'}`,
  );
  if (process.env.ENGAGEMENTS_AGENT_JSON) console.log(`\n${JSON.stringify(result, null, 2)}`);
}

async function serve(): Promise<void> {
  const express = (await import('express')).default;
  const cors = (await import('cors')).default;
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'engagements-orchestrator', mcp: process.env.ENGAGEMENTS_MCP_URL || 'http://localhost:3010/mcp' });
  });

  app.post('/ask', async (req, res) => {
    const { question, persona, leaderId, topN } = req.body ?? {};
    if (!question || typeof question !== 'string') {
      res.status(400).json({ ok: false, error: 'body.question (string) is required' });
      return;
    }
    try {
      res.json(await planTrip({ question, persona, leaderId, topN }));
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  const port = Number(process.env.ENGAGEMENTS_AGENT_PORT || 3020);
  app.listen(port, () => {
    console.log(`Engagements orchestrator on http://localhost:${port}  (POST /ask { question, persona?, leaderId?, topN? })`);
    console.log(`  -> engagements MCP: ${process.env.ENGAGEMENTS_MCP_URL || 'http://localhost:3010/mcp'}`);
    console.log(`  -> model: ${process.env.AZURE_OPENAI_DEPLOYMENT ? `Azure OpenAI (${process.env.AZURE_OPENAI_DEPLOYMENT})` : 'not configured — deterministic fallback'}`);
  });
}

const argv = process.argv.slice(2);
(argv.includes('--serve') ? serve() : ask(argv.filter((a) => a !== '--serve'))).catch((e) => {
  console.error(e);
  process.exit(1);
});
