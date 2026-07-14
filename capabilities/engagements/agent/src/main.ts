/**
 * Entry point — two modes:
 *   CLI (default):   npm run ask -- "I'm planning a trip to AUSA, who should I meet on UAS/drone?" --persona EA_G8
 *   HTTP (--serve):  npm run serve   ->  POST /ask { question, persona?, leaderId?, topN? }
 *
 * The HTTP surface is the seam the chat UI (M6) calls. Requires the engagements MCP server
 * running (default http://localhost:3010/mcp; override with ENGAGEMENTS_MCP_URL).
 */
import './load-env.js';
import { buildAreaItinerary, buildAreaItineraryOptions, buildRadiusItinerary, hotTopics, planAreaOptions, planRadiusOptions, planTrip } from './orchestrator.js';

interface CliArgs {
  question?: string;
  persona?: string;
  leader?: string;
  top?: number;
  options?: boolean;
  topics?: boolean;
  radius?: boolean;
  region?: string;
  window?: string;
  days?: number;
  company?: string;
  anchor?: string;
  city?: string;
  radiusMi?: number;
  lat?: number;
  lng?: number;
  count?: number;
  maxDays?: number;
  perDay?: number;
  targetDays?: number[];
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
    else if (a === '--topics') out.topics = true;
    else if (a === '--radius') out.radius = true;
    else if (a === '--region') out.region = argv[++i];
    else if (a === '--window') out.window = argv[++i];
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--company') out.company = argv[++i];
    else if (a === '--anchor') out.anchor = argv[++i];
    else if (a === '--city') out.city = argv[++i];
    else if (a === '--radius-mi' || a === '--mi') out.radiusMi = Number(argv[++i]);
    else if (a === '--lat') out.lat = Number(argv[++i]);
    else if (a === '--lng') out.lng = Number(argv[++i]);
    else if (a === '--count') out.count = Number(argv[++i]);
    else if (a === '--max-days') out.maxDays = Number(argv[++i]);
    else if (a === '--per-day') out.perDay = Number(argv[++i]);
    else if (a === '--target-days') out.targetDays = argv[++i].split(',').map((d) => Number(d.trim())).filter((n) => Number.isFinite(n));
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
  if (result.stage === 'clarify' && result.clarify === 'leader') {
    console.log(`\n— pick a leader, then: POST /build-options { leaderId, region } — compare full itineraries of different lengths`);
  }
  if (process.env.ENGAGEMENTS_AGENT_JSON) console.log(`\n${JSON.stringify(result, null, 2)}`);
}

/**
 * Interactive planner (STAGE 2, options) from the CLI: for a chosen leader, build MULTIPLE complete
 * itineraries of DIFFERENT LENGTHS (a short visit → a full regional tour) so the EA can compare
 * finished trips and pick one to proceed. Tune with --count / --max-days / --per-day / --target-days.
 */
async function itineraries(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args.leader) {
    console.error('usage: npm run ask -- --itineraries --leader L1 [--region NCR | --city Reston] [--window 2025-10-06..2025-10-31] [--count 3] [--max-days 7] [--per-day 2] [--target-days 2,5,7] [--persona EA_G8]');
    process.exit(1);
  }
  const result = await buildAreaItineraryOptions({
    persona: args.persona,
    leaderId: args.leader,
    region: args.region,
    city: args.city,
    window: parseWindow(args.window),
    optionCount: args.count,
    maxDays: args.maxDays,
    meetingsPerDay: args.perDay,
    targetDays: args.targetDays,
  });

  console.log(`\n[persona ${result.persona}] itinerary options for ${result.leaderId}${result.leaderName ? ` (${result.leaderName})` : ''}${result.rejected ? '  ACCESS REJECTED' : ''}`);
  if (result.error) console.error(`\n! ${result.error}`);
  console.log(`— area ${result.area?.name ?? '?'}; ${result.options.length} different-length option(s); redacted ${result.redactedCount ?? 0}`);
  for (const o of result.options) {
    const roi = o.itinerary?.roi?.roiScore ?? o.roiScore;
    const nearby = o.itinerary?.nearbyLeaders?.length ?? 0;
    console.log(`\n${o.id === result.recommendedOptionId ? '★' : '·'} ${o.label} [${o.tier}] — ${o.summary}`);
    console.log(`    ${o.days} day(s), ${o.stopCount} stop(s), ROI ${roi}${o.overBudget ? ' (OVER BUDGET)' : ''}; nearby leaders ${nearby}; map ${o.tripMap ? 'YES' : 'no'}`);
  }
  console.log(`\n  each option above is already a complete itinerary (route + ROI + trip map) — pick one by its length id (e.g. ${result.recommendedOptionId ?? '5d'}).`);
  if (process.env.ENGAGEMENTS_AGENT_JSON) console.log(`\n${JSON.stringify(result, null, 2)}`);
}

/** Fixed-radius planner (STAGE 1) from the CLI: fill a fixed-day trip around a company/coordinate/city. */
async function radius(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const days = args.days ?? 3;
  const result = await planRadiusOptions({
    question: args.question,
    persona: args.persona,
    anchorContactId: args.anchor,
    company: args.company,
    lat: args.lat,
    lng: args.lng,
    city: args.city,
    region: args.region,
    radiusMi: args.radiusMi,
    days,
    leaderId: args.leader,
    window: parseWindow(args.window),
  });

  console.log(`\n[persona ${result.persona}] radius${result.rejected ? '  ACCESS REJECTED' : ''}`);
  if (result.error) console.error(`\n! ${result.error}`);
  if (result.answer) console.log(`\n${result.answer}`);
  for (const q of result.questions) {
    console.log(`\n${q.prompt}`);
    for (const c of q.choices) {
      console.log(`  ${c.selected ? '●' : '○'} ${c.label}${c.detail ? `  — ${c.detail}` : ''}`);
    }
  }
  console.log(
    `\n— anchor ${result.anchor?.name ?? '(coord/area)'}; area ${result.area?.name ?? '?'} (${result.area?.radiusMi ?? '?'} mi); ` +
      `${result.days ?? '?'} day(s), capacity ${result.capacity ?? '?'}; stops ${result.stops.length}; redacted ${result.redactedCount ?? 0}`,
  );
  console.log(`  to build: POST /build-radius { leaderId, days, anchorContactId|company|lat+lng|city, acceptedContactIds?, extensionContactIds? }`);
  if (process.env.ENGAGEMENTS_AGENT_JSON) console.log(`\n${JSON.stringify(result, null, 2)}`);
}

/** Hot topics from the CLI: rank the seed taxonomy by the persona's live footprint. */
async function topics(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const result = await hotTopics({ persona: args.persona });
  console.log(`\n[persona ${result.persona}]${result.rejected ? '  ACCESS REJECTED' : ''}`);
  if (result.error) console.error(`\n! ${result.error}`);
  if (result.topics.length === 0 && !result.error) console.log('\n(no hot topics visible to this persona)');
  for (const t of result.topics) {
    console.log(`  🔥 ${t.topicId} ${t.name}  — ${t.reason} (score ${t.score})`);
  }
  if (process.env.ENGAGEMENTS_AGENT_JSON) console.log(`\n${JSON.stringify(result, null, 2)}`);
}

async function ask(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args.question) {
    console.error('usage: npm run ask -- "<question>" [--persona EA_G8] [--leader L1] [--top 3]');
    console.error('   or: npm run ask -- --options "<ask>" [--region NCR] [--window 2025-10-06..2025-10-31] [--persona EA_G8]');
    console.error('   or: npm run ask -- --radius --company "Meridian Robotics" --days 3 [--radius-mi 40] [--lat --lng | --city] [--persona EA_G8]');
    console.error('   or: npm run ask -- --topics [--persona EA_G8]');
    process.exit(1);
  }
  const result = await planTrip({ question: args.question, persona: args.persona, leaderId: args.leader, topN: args.top });

  console.log(`\n[persona ${result.persona}] mode=${result.mode}${result.stage ? ` stage=${result.stage}` : ''}${result.rejected ? '  ACCESS REJECTED' : ''}`);
  if (result.error) console.error(`\n! ${result.error}`);
  if (result.answer) console.log(`\n${result.answer}`);

  // Leader-first: WHO to plan for (asked up front instead of defaulting a leader).
  if (result.stage === 'clarify' && result.questions?.length) {
    for (const c of result.questions[0].choices) {
      console.log(`   ${c.recommended ? '★' : '·'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    console.log(`\n— re-run with the chosen leader: --leader <id>`);
  }
  // Different-length itinerary options to compare.
  if (result.stage === 'options' && result.options?.length) {
    for (const o of result.options) {
      console.log(
        `   ${o.recommended ? '★ REC' : '     '} [${o.id}] ${o.label} — ${o.stopCount} stop(s), ROI ${o.roiScore ?? '—'}${o.overBudget ? ' (OVER BUDGET)' : ''}`,
      );
    }
  }

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

  // Hot topics — a topic-first entry point for the UI. Persona-trimmed; picking one just seeds a
  // free-form /ask, so it kicks off a search without locking the user into a flow.
  app.get('/topics', async (req, res) => {
    const persona = typeof req.query.persona === 'string' ? req.query.persona : undefined;
    try {
      res.json(await hotTopics({ persona }));
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
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
    const { question, persona, regionId, region, city, state, radiusMi, window, leaderId, topicIds, requireTopicMatch } = req.body ?? {};
    try {
      res.json(await planAreaOptions({ question, persona, regionId, region, city, state, radiusMi, window, leaderId, topicIds, requireTopicMatch }));
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Interactive planner — STAGE 2: build the final itinerary + ui://trip-map from the human's picks.
  app.post('/build', async (req, res) => {
    const { persona, regionId, region, city, state, radiusMi, window, leaderId, durationTier, extensionContactIds, acceptedContactIds, anchorEventId, topicIds } = req.body ?? {};
    if (!leaderId || typeof leaderId !== 'string') {
      res.status(400).json({ ok: false, error: 'body.leaderId (string) is required' });
      return;
    }
    try {
      res.json(
        await buildAreaItinerary({ persona, regionId, region, city, state, radiusMi, window, leaderId, durationTier, extensionContactIds, acceptedContactIds, anchorEventId, topicIds }),
      );
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Interactive planner — STAGE 2 (options): for the CHOSEN leader, build MULTIPLE complete
  // itineraries of DIFFERENT LENGTHS (short visit → full regional tour) so the EA compares finished
  // trips and proceeds with one. Optional knobs: optionCount / maxDays / targetDays / meetingsPerDay.
  app.post('/build-options', async (req, res) => {
    const { persona, regionId, region, city, state, radiusMi, window, leaderId, topicIds, optionCount, maxDays, targetDays, meetingsPerDay } = req.body ?? {};
    if (!leaderId || typeof leaderId !== 'string') {
      res.status(400).json({ ok: false, error: 'body.leaderId (string) is required' });
      return;
    }
    try {
      res.json(await buildAreaItineraryOptions({ persona, regionId, region, city, state, radiusMi, window, leaderId, topicIds, optionCount, maxDays, targetDays, meetingsPerDay }));
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Fixed-radius planner — STAGE 1: fill a fixed-day trip around a company/coordinate/city and return
  // the who/extend menus. Event-OPTIONAL: no anchor event is required or invented.
  app.post('/plan-radius', async (req, res) => {
    const { question, persona, anchorContactId, company, lat, lng, city, state, region, regionId, radiusMi, days, meetingsPerDay, window, leaderId, topicIds, requireTopicMatch } = req.body ?? {};
    if (typeof days !== 'number' || !(days > 0)) {
      res.status(400).json({ ok: false, error: 'body.days (positive number) is required' });
      return;
    }
    try {
      res.json(
        await planRadiusOptions({ question, persona, anchorContactId, company, lat, lng, city, state, region, regionId, radiusMi, days, meetingsPerDay, window, leaderId, topicIds, requireTopicMatch }),
      );
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Fixed-radius planner — STAGE 2: build the event-less itinerary + ui://trip-map from the picks.
  app.post('/build-radius', async (req, res) => {
    const { persona, anchorContactId, company, lat, lng, city, state, region, regionId, radiusMi, days, meetingsPerDay, window, leaderId, acceptedContactIds, extensionContactIds, topicIds } = req.body ?? {};
    if (!leaderId || typeof leaderId !== 'string') {
      res.status(400).json({ ok: false, error: 'body.leaderId (string) is required' });
      return;
    }
    if (typeof days !== 'number' || !(days > 0)) {
      res.status(400).json({ ok: false, error: 'body.days (positive number) is required' });
      return;
    }
    try {
      res.json(
        await buildRadiusItinerary({ persona, anchorContactId, company, lat, lng, city, state, region, regionId, radiusMi, days, meetingsPerDay, window, leaderId, acceptedContactIds, extensionContactIds, topicIds }),
      );
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  const port = Number(process.env.ENGAGEMENTS_AGENT_PORT || 3020);
  const server = app.listen(port, () => {
    console.log(`Engagements orchestrator on http://localhost:${port}`);
    console.log(`  POST /ask           { question, persona?, leaderId?, topN? }            — one-shot / free-form plan`);
    console.log(`  GET  /topics        ?persona=EA_G8                                       — hot topics (topic-first entry)`);
    console.log(`  POST /plan-options  { question?|region?|city?, persona?, window? }       — interactive: survey + option menus`);
    console.log(`  POST /build         { leaderId, durationTier?, extensionContactIds?, region? } — build itinerary + trip map`);
    console.log(`  POST /build-options { leaderId, region?|city?, window?, optionCount?, maxDays?, targetDays?[] } — compare full itineraries of DIFFERENT LENGTHS`);
    console.log(`  POST /plan-radius   { days, company?|anchorContactId?|lat+lng?|city?, radiusMi?, persona? } — fixed-radius: fill + menus`);
    console.log(`  POST /build-radius  { leaderId, days, company?|anchorContactId?|lat+lng?|city?, acceptedContactIds? } — event-less itinerary + map`);
    console.log(`  -> engagements MCP: ${process.env.ENGAGEMENTS_MCP_URL || 'http://localhost:3010/mcp'}`);
    console.log(`  -> model: ${process.env.AZURE_OPENAI_DEPLOYMENT ? `Azure OpenAI (${process.env.AZURE_OPENAI_DEPLOYMENT})` : 'not configured — deterministic fallback'}`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Engagements orchestrator: port ${port} is already in use — a previous orchestrator may still be running. Stop that process or set ENGAGEMENTS_AGENT_PORT to a free port, then retry.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}

const argv = process.argv.slice(2);
function dispatch(): Promise<void> {
  if (argv.includes('--serve')) return serve();
  const rest = argv.filter((a) => a !== '--serve');
  if (rest.includes('--topics')) return topics(rest);
  if (rest.includes('--radius')) return radius(rest);
  if (rest.includes('--itineraries')) return itineraries(rest);
  if (rest.includes('--options')) return options(rest);
  return ask(rest);
}
dispatch().catch((e) => {
  console.error(e);
  process.exit(1);
});
