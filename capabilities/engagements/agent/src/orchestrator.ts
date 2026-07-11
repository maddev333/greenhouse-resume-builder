/**
 * The orchestrator — the "chat brain" (MVP-PLAN M5).
 *
 * Turns a natural-language trip question into a security-trimmed engagement plan by composing
 * the engagements capability's MCP tools. Primary path is an Azure OpenAI tool-calling loop
 * (mcp-core `runAgentLoop`); when the model is not configured/reachable it falls back to a
 * deterministic router so the demo always works offline. Either way it returns the ranked
 * option menu, the itinerary, and the `ui://trip-map` payload for the chat host to render.
 *
 * Auth boundary: the caller's persona is passed to the capability as `x-demo-persona`, which
 * stands in for verified Keycloak claims. The capability enforces the trim server-side; the
 * orchestrator only ever sees authorized rows.
 */
import mcpCore from '@greenhouse-resume-builder/mcp-core';
import { AGENT_TOOLS, makeToolClient, type CapturedCall, type ToolClient } from './tools.js';
import { resolveDefaultLeaderId, rosterForPrompt, topicIdsFromText, topicsForPrompt } from './catalog.js';

// mcp-core ships as CJS; default-import + destructure is immune to the `export *` named-export
// interop issue under NodeNext ESM.
const { runAgentLoop, isModelConfigured } = mcpCore;

export interface PlanRequest {
  question: string;
  /** Demo persona → security trim. EA_BASIC | EA_G8 | ADMIN | CROSS_TENANT | NO_TENANT. */
  persona?: string;
  /** Leader whose time is planned; defaults to ENGAGEMENTS_DEFAULT_LEADER or the first leader. */
  leaderId?: string;
  /** How many top candidates to route into the itinerary. */
  topN?: number;
  /** Engagements MCP endpoint; defaults to ENGAGEMENTS_MCP_URL or http://localhost:3010/mcp. */
  serverUrl?: string;
}

export interface PlanResult {
  ok: boolean;
  mode: 'llm' | 'deterministic';
  persona: string;
  question: string;
  /** Final narrative for the chat surface (model composed, or rendered from tool text). */
  answer: string | null;
  toolCalls: { name: string; args: unknown }[];
  /** suggest_candidates candidates — the option cards. */
  menu: any[] | null;
  /** build_itinerary summary (leader/event/route/roi/conflicts). */
  itinerary: any | null;
  /** The ui://trip-map App payload for the host to render. */
  tripMap: any | null;
  redactedCount: number | null;
  rejected: boolean;
  error?: string;
}

const DEFAULT_URL = (): string => process.env.ENGAGEMENTS_MCP_URL || 'http://localhost:3010/mcp';
const DEFAULT_TOPN = (): number => {
  const n = Number(process.env.ENGAGEMENTS_TOP_N);
  return Number.isFinite(n) && n > 0 ? n : 3;
};
const DEFAULT_PERSONA = (): string => process.env.ENGAGEMENTS_DEMO_PERSONA || 'EA_BASIC';

export function buildSystemPrompt(defaultLeaderId: string, topN: number): string {
  return [
    'You are the Strategic Engagements Orchestrator, the planning brain for a U.S. Army senior-leader',
    'executive assistant (EA). Turn the EA\'s natural-language trip question into a concrete,',
    'security-trimmed engagement plan using ONLY the provided tools.',
    '',
    'The "you\'re already going there" nudge: when a leader is already attending an anchor event,',
    'batch the highest-value people they should meet — on-site attendees/prospects (~0 extra travel)',
    'and nearby stale relationships worth re-engaging.',
    '',
    'Leaders (use the id):',
    rosterForPrompt(),
    '',
    'Topics (map the user\'s phrasing to these ids — e.g. "UAS/drone" or "autonomy" -> T3):',
    topicsForPrompt(),
    '',
    'Rules:',
    `1. Leader: use "${defaultLeaderId}" unless the user names another leader from the roster.`,
    '2. Anchor event: if the user names one (e.g. "AUSA"), pass it as eventQuery to suggest_candidates.',
    '3. Topic: map the ask to topicIds from the catalog and pass them to suggest_candidates.',
    '4. Call suggest_candidates to get the ranked menu of who to meet.',
    `5. ALWAYS follow with build_itinerary using the top ${topN} candidate ids from that menu, so the`,
    '   route and ui://trip-map are produced.',
    '6. Never invent contacts, events, or attributes — surface only what the tools return. Some records',
    '   are hidden by the security trim; report the redactedCount the tools give you.',
    '7. Finish with a concise, EA-ready answer: a short numbered menu (id — name, org, city, why) and a',
    '   one-line itinerary summary (route + ROI + any conflicts).',
  ].join('\n');
}

/** Extract a likely anchor token from the question for the deterministic path. */
export function anchorGuess(question: string): string {
  const acronym = question.match(/\b[A-Z]{3,}\b/)?.[0];
  if (acronym) return acronym;
  // Proper-case place/event name after a preposition ("visit to Fort Bragg next week" -> "Fort Bragg").
  const proper = question.match(/\b(?:to|at|for|attending|visiting|visit)\s+([A-Z][\w&]*(?:\s+[A-Z][\w&]*)*)/);
  if (proper?.[1]) return proper[1].trim();
  return question.trim();
}

function lastCapture(captured: CapturedCall[], name: string): CapturedCall | undefined {
  for (let i = captured.length - 1; i >= 0; i--) if (captured[i].name === name) return captured[i];
  return undefined;
}

function isRejected(result: any): boolean {
  return !!result?.rejected;
}

/**
 * No-LLM fallback: anchor -> suggest -> build, mirroring what the model would compose.
 * Drives the shared client; results are read from `client.captured` by the caller.
 */
async function deterministicPlan(client: ToolClient, opts: { question: string; leaderId: string; topN: number }): Promise<void> {
  const { question, leaderId, topN } = opts;
  const topicIds = topicIdsFromText(question);
  const anchor = anchorGuess(question);

  let suggest: any = await client.callTool('suggest_candidates', {
    leaderId,
    eventQuery: anchor,
    ...(topicIds.length ? { topicIds } : {}),
  });
  if (isRejected(suggest)) return;

  // Widen if the topic filter zeroed the menu.
  if ((suggest?.candidates?.length ?? 0) === 0 && topicIds.length) {
    suggest = await client.callTool('suggest_candidates', { leaderId, eventQuery: anchor, topicIds, requireTopicMatch: false });
  }

  const candidates: any[] = suggest?.candidates ?? [];
  if (candidates.length === 0) return;

  const acceptedContactIds = candidates.slice(0, topN).map((c) => c.contactId);
  await client.callTool('build_itinerary', {
    leaderId: suggest?.leader?.id ?? leaderId,
    ...(suggest?.event?.id ? { eventId: suggest.event.id } : { eventQuery: anchor }),
    acceptedContactIds,
    ...(suggest?.topicFocus?.length ? { topicIds: suggest.topicFocus } : {}),
  });
}

/**
 * LLM safety net: if the model produced a menu but never called build_itinerary, auto-build
 * from the top N so the demo always gets a route + map.
 */
async function ensureItinerary(client: ToolClient, opts: { leaderId: string; topN: number }): Promise<void> {
  const built = client.captured.some((c) => c.name === 'build_itinerary' && !isRejected(c.result));
  if (built) return;
  const suggest = lastCapture(client.captured, 'suggest_candidates')?.result;
  const candidates: any[] = suggest?.candidates ?? [];
  if (isRejected(suggest) || candidates.length === 0) return;

  const acceptedContactIds = candidates.slice(0, opts.topN).map((c) => c.contactId);
  try {
    await client.callTool('build_itinerary', {
      leaderId: suggest?.leader?.id ?? opts.leaderId,
      ...(suggest?.event?.id ? { eventId: suggest.event.id } : {}),
      acceptedContactIds,
      ...(suggest?.topicFocus?.length ? { topicIds: suggest.topicFocus } : {}),
    });
  } catch {
    /* advisory only */
  }
}

function answerFromCaptured(captured: CapturedCall[]): string {
  const parts = [lastCapture(captured, 'suggest_candidates')?.text, lastCapture(captured, 'build_itinerary')?.text].filter(
    (t): t is string => !!t,
  );
  if (parts.length) return parts.join('\n\n');
  return lastCapture(captured, 'search_events')?.text ?? lastCapture(captured, 'search_contacts')?.text ?? '(no results)';
}

function assemble(
  base: PlanResult,
  mode: 'llm' | 'deterministic',
  answer: string | null,
  toolCalls: { name: string; args: unknown }[],
  captured: CapturedCall[],
): PlanResult {
  const suggest = lastCapture(captured, 'suggest_candidates')?.result;
  const build = lastCapture(captured, 'build_itinerary')?.result;
  const rejected = isRejected(suggest) || isRejected(build);

  const menu: any[] | null = suggest?.candidates ?? null;
  const itinerary = build && !isRejected(build)
    ? {
        leader: build.leader,
        event: build.event,
        accepted: build.accepted,
        route: build.route,
        roi: build.roi,
        conflicts: build.conflicts,
        notMatched: build.notMatched,
      }
    : null;
  const tripMap = build?.tripMap ?? null;
  const redactedCount = build?.redactedCount ?? suggest?.redactedCount ?? null;

  return {
    ...base,
    ok: !rejected && (menu != null || itinerary != null),
    mode,
    answer,
    toolCalls,
    menu,
    itinerary,
    tripMap,
    redactedCount,
    rejected,
  };
}

export async function planTrip(req: PlanRequest): Promise<PlanResult> {
  const persona = req.persona || DEFAULT_PERSONA();
  const topN = req.topN ?? DEFAULT_TOPN();
  const leaderId = req.leaderId || resolveDefaultLeaderId();
  const url = req.serverUrl || DEFAULT_URL();

  const base: PlanResult = {
    ok: false,
    mode: 'deterministic',
    persona,
    question: req.question,
    answer: null,
    toolCalls: [],
    menu: null,
    itinerary: null,
    tripMap: null,
    redactedCount: null,
    rejected: false,
  };

  let client: ToolClient;
  try {
    client = await makeToolClient(url, persona);
  } catch (e: any) {
    return {
      ...base,
      error:
        `Cannot reach the engagements MCP server at ${url}: ${e?.message || e}. ` +
        'Start it with `npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements`.',
    };
  }

  try {
    let answer: string | null = null;
    let toolCalls: { name: string; args: unknown }[] = [];
    let mode: 'llm' | 'deterministic' = 'deterministic';

    if (isModelConfigured()) {
      const loop = await runAgentLoop({
        system: buildSystemPrompt(leaderId, topN),
        user: req.question,
        tools: AGENT_TOOLS,
        callTool: client.callTool,
        maxIterations: 8,
        logger: console,
      });
      if (loop.output !== null) {
        mode = 'llm';
        answer = loop.output;
        toolCalls = loop.toolCalls;
        await ensureItinerary(client, { leaderId, topN });
      }
    }

    if (answer === null) {
      // model unavailable or errored → deterministic router (reuses the same client/persona)
      mode = 'deterministic';
      await deterministicPlan(client, { question: req.question, leaderId, topN });
      toolCalls = client.captured.map((c) => ({ name: c.name, args: c.args }));
      answer = answerFromCaptured(client.captured);
    }

    return assemble(base, mode, answer, toolCalls, client.captured);
  } finally {
    await client.close().catch(() => {});
  }
}
