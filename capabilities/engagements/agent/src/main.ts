/**
 * Entry point — two modes:
 *   CLI (default):   npm run ask -- "I'm planning a trip to AUSA, who should I meet on UAS/drone?" --persona EA_G8
 *   HTTP (--serve):  npm run serve   ->  POST /ask { question, persona?, leaderId?, topN? }
 *
 * The HTTP surface is the seam the chat UI (M6) calls. Requires the engagements MCP server
 * running (default http://localhost:3010/mcp; override with ENGAGEMENTS_MCP_URL).
 */
import './load-env.js';
import { buildAreaItinerary, planAreaOptions, planTrip } from './orchestrator.js';

interface CliArgs {
  question?: string;
  persona?: string;
  leader?: string;
  top?: number;
  options?: boolean;
  region?: string;
  window?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--persona') out.persona = argv[++i];
    else if (a === '--leader') out.leader = argv[++i];
    else if (a === '--top') out.top = Number(argv[++i]);
    else if (a === '--options') out.options = true;
    else if (a === '--region') out.region = argv[++i];
    else if (a === '--window') out.window = argv[++i];
    else rest.push(a);
  }
  out.question = rest.join(' ').trim() || undefined;
  return out;
}

/** Parse a "YYYY-MM-DD..YYYY-MM-DD" CLI window into the request shape. */
function parseWindow(w?: string): { start: string; end: string } | undefined {
  const m = w?.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  return m ? { start: m[1], end: m[2] } : undefined;
}

/** Interactive planner (STAGE 1) from the CLI: survey an area and print the ranked option menus. */
async function options(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const result = await planAreaOptions({
    question: args.question,
    persona: args.persona,
    region: args.region,
    leaderId: args.leader,
    window: parseWindow(args.window),
  });

  console.log(`\n[persona ${result.persona}] stage=${result.stage}${result.rejected ? '  ACCESS REJECTED' : ''}`);
  if (result.error) console.error(`\n! ${result.error}`);
  if (result.answer) console.log(`\n${result.answer}`);
  for (const q of result.questions) {
    console.log(`\n${q.prompt}`);
    for (const c of q.choices) {
      console.log(`  ${c.selected ? '●' : '○'} ${c.label}${c.detail ? `  — ${c.detail}` : ''}`);
    }
  }
  if (result.stage === 'options') {
    console.log(`\n— area ${result.area?.name ?? '?'}; ${result.areaSurvey.length} topic(s); redacted ${result.redactedCount ?? 0}`);
    console.log(`  to build: POST /build { leaderId, durationTier?, extensionContactIds?, region }`);
  }
  if (process.env.ENGAGEMENTS_AGENT_JSON) console.log(`\n${JSON.stringify(result, null, 2)}`);
}

async function ask(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args.question) {
    console.error('usage: npm run ask -- "<question>" [--persona EA_G8] [--leader L1] [--top 3]');
    console.error('   or: npm run ask -- --options "<ask>" [--region NCR] [--window 2025-10-06..2025-10-31] [--persona EA_G8]');
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

  // Interactive planner — STAGE 1: survey an area and return the ranked option menus (or ask
  // "which area?"). The UI renders `questions` as option groups; nothing is committed yet.
  app.post('/plan-options', async (req, res) => {
    const { question, persona, regionId, region, city, state, radiusKm, window, leaderId, topicIds, requireTopicMatch } = req.body ?? {};
    try {
      res.json(await planAreaOptions({ question, persona, regionId, region, city, state, radiusKm, window, leaderId, topicIds, requireTopicMatch }));
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Interactive planner — STAGE 2: build the final itinerary + ui://trip-map from the human's picks.
  app.post('/build', async (req, res) => {
    const { persona, regionId, region, city, state, radiusKm, window, leaderId, durationTier, extensionContactIds, acceptedContactIds, anchorEventId, topicIds } = req.body ?? {};
    if (!leaderId || typeof leaderId !== 'string') {
      res.status(400).json({ ok: false, error: 'body.leaderId (string) is required' });
      return;
    }
    try {
      res.json(
        await buildAreaItinerary({ persona, regionId, region, city, state, radiusKm, window, leaderId, durationTier, extensionContactIds, acceptedContactIds, anchorEventId, topicIds }),
      );
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  const port = Number(process.env.ENGAGEMENTS_AGENT_PORT || 3020);
  app.listen(port, () => {
    console.log(`Engagements orchestrator on http://localhost:${port}`);
    console.log(`  POST /ask           { question, persona?, leaderId?, topN? }            — one-shot plan`);
    console.log(`  POST /plan-options  { question?|region?|city?, persona?, window? }       — interactive: survey + option menus`);
    console.log(`  POST /build         { leaderId, durationTier?, extensionContactIds?, region? } — build itinerary + trip map`);
    console.log(`  -> engagements MCP: ${process.env.ENGAGEMENTS_MCP_URL || 'http://localhost:3010/mcp'}`);
    console.log(`  -> model: ${process.env.AZURE_OPENAI_DEPLOYMENT ? `Azure OpenAI (${process.env.AZURE_OPENAI_DEPLOYMENT})` : 'not configured — deterministic fallback'}`);
  });
}

const argv = process.argv.slice(2);
function dispatch(): Promise<void> {
  if (argv.includes('--serve')) return serve();
  const rest = argv.filter((a) => a !== '--serve');
  if (rest.includes('--options')) return options(rest);
  return ask(rest);
}
dispatch().catch((e) => {
  console.error(e);
  process.exit(1);
});
