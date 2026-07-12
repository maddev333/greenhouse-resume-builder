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
import {
  type AreaInput,
  type Topic,
  defaultWindow,
  demoToday,
  loadTopics,
  regionChoices,
  resolveAreaInput,
  resolveDefaultLeaderId,
  rosterForPrompt,
  topicIdsFromText,
  topicsForPrompt,
} from './catalog.js';

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

// ════════════════════════════════════════════════════════════════════════════
// Phase 4 — interactive, area-first OPTIONED planning.
//
// Instead of one-shotting a plan, the orchestrator asks the human to decide along each axis:
//   1. planAreaOptions  → resolve an area (ask "which area?" if none) + a window, call the
//      capability's `plan_options` tool, and return the topic survey plus three ranked option
//      menus rendered as clarifying questions (who should go / how long / what each extra day
//      unlocks + its approved talking points).
//   2. buildAreaItinerary → take the human's picks and produce the final route + ui://trip-map.
//
// Deterministic and LLM-free: `plan_options` already does the reasoning; the orchestrator only
// resolves the anchor, forwards the persona trim, and shapes the option menus for the UI.
// ════════════════════════════════════════════════════════════════════════════

/** One selectable option in a clarifying question. */
export interface OptionChoice {
  value: string;
  label: string;
  detail?: string;
  selected?: boolean;
  recommended?: boolean;
}

/** A question the UI renders as an option group (radios for `single`, checkboxes for `multi`). */
export interface OptionQuestion {
  id: 'area' | 'leader' | 'duration' | 'extensions';
  kind: 'single' | 'multi';
  prompt: string;
  choices: OptionChoice[];
}

export interface AreaOptionsRequest {
  /** Free-text ask; the area + topic focus are parsed from it when not given explicitly. */
  question?: string;
  persona?: string;
  /** Explicit area anchor (any of these wins over parsing the question). */
  regionId?: string;
  region?: string;
  city?: string;
  state?: string;
  radiusKm?: number;
  /** Planning window; defaults to the demo clock's `today` + horizon (see catalog.defaultWindow). */
  window?: { start: string; end: string };
  leaderId?: string;
  topicIds?: string[];
  requireTopicMatch?: boolean;
  serverUrl?: string;
}

export interface AreaOptionsResult {
  ok: boolean;
  /** `clarify` = the orchestrator needs the area first; `options` = the menus are ready. */
  stage: 'clarify' | 'options';
  persona: string;
  question: string | null;
  answer: string | null;
  area: any | null;
  window: { start: string; end: string } | null;
  today: string | null;
  topicIds: string[];
  areaSurvey: any[];
  leaderOptions: any[];
  chosenLeaderId: string | null;
  durationOptions: any[];
  extensionOptions: any[];
  absorbedEventIds: string[];
  onSiteDays: number | null;
  redactedCount: number | null;
  rejected: boolean;
  /** The option groups the UI renders (who/how long/extensions), or the single "which area?" ask. */
  questions: OptionQuestion[];
  error?: string;
}

export interface AreaBuildRequest {
  persona?: string;
  regionId?: string;
  region?: string;
  city?: string;
  state?: string;
  radiusKm?: number;
  window?: { start: string; end: string };
  /** Chosen leader (from the leader option menu). */
  leaderId: string;
  /** Chosen duration tier; used to derive the base stop set when `acceptedContactIds` is absent. */
  durationTier?: 'core' | 'extended';
  /** Extension stops the human toggled on. */
  extensionContactIds?: string[];
  /** Explicit final stop set (preferred — the UI already derived it from the option menus). */
  acceptedContactIds?: string[];
  /** Anchor event for the map; defaults to the area's first auto-absorbed in-window event. */
  anchorEventId?: string;
  topicIds?: string[];
  serverUrl?: string;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Merge an explicit area anchor with one parsed from the free-text question. */
function resolveAreaAnchor(req: { regionId?: string; region?: string; city?: string; state?: string; question?: string }): AreaInput | null {
  if (req.regionId || req.region || req.city) {
    const out: AreaInput = {};
    if (req.regionId) out.regionId = req.regionId;
    if (req.region) out.region = req.region;
    if (req.city) out.city = req.city;
    if (req.state) out.state = req.state;
    return out;
  }
  return req.question ? resolveAreaInput(req.question) : null;
}

/** Only forward the area keys the caller actually set (avoids sending `undefined` over JSON-RPC). */
function areaArgs(area: AreaInput, radiusKm?: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (area.regionId) out.regionId = area.regionId;
  if (area.region) out.region = area.region;
  if (area.city) out.city = area.city;
  if (area.state) out.state = area.state;
  if (typeof radiusKm === 'number') out.radiusKm = radiusKm;
  return out;
}

/** The "which area?" clarifying question — the known region chips. */
export function areaClarifyQuestion(): OptionQuestion {
  return {
    id: 'area',
    kind: 'single',
    prompt: 'Which area do you want to anchor the trip on?',
    choices: regionChoices().map((c) => ({ value: c.value, label: c.label, detail: c.detail })),
  };
}

/**
 * Shape a `plan_options` result into the who/how-long/extensions option menus. Pure — takes the
 * tool's structuredContent and returns the questions the UI renders (top pick pre-selected).
 */
export function buildOptionQuestions(plan: any): OptionQuestion[] {
  const questions: OptionQuestion[] = [];

  const leaders: any[] = plan?.leaderOptions ?? [];
  if (leaders.length) {
    questions.push({
      id: 'leader',
      kind: 'single',
      prompt: 'Who should go?',
      choices: leaders.map((o) => ({
        value: o.leaderId,
        label: `${o.leaderId} — ${o.name}`,
        detail:
          `${o.role} · fit ${o.score}` +
          (o.availableInWindow === false ? ' · not free in window' : '') +
          (typeof o.distanceKm === 'number' ? ` · ${o.distanceKm} km` : ''),
        selected: o.leaderId === plan.chosenLeaderId,
        recommended: o.leaderId === plan.chosenLeaderId,
      })),
    });
  }

  const durations: any[] = plan?.durationOptions ?? [];
  if (durations.length) {
    questions.push({
      id: 'duration',
      kind: 'single',
      prompt: 'How long should the trip be?',
      choices: durations.map((d, i) => ({
        value: d.tier,
        label: `${cap(d.tier)} — ${d.days} day(s)`,
        detail: `${d.stops?.length ?? 0} stop(s) · ROI ${d.roiScore}` + (d.overBudget ? ' · OVER BUDGET' : ''),
        selected: i === 0,
        recommended: i === 0,
      })),
    });
  }

  const extensions: any[] = plan?.extensionOptions ?? [];
  if (extensions.length) {
    questions.push({
      id: 'extensions',
      kind: 'multi',
      prompt: 'Extend the trip? Each extra day unlocks another meeting (optional).',
      choices: extensions.map((e) => ({
        value: e.contactId,
        label: `+${e.extraDays}d → ${e.name}` + (e.sector ? ` (${e.sector})` : ''),
        detail:
          `${e.topicName ?? e.topicId ?? 'topic —'} · mROI ${e.marginalRoi}` +
          (e.overBudget ? ' · over budget' : '') +
          ` · ${e.talkingPointsSource === 'approved-message' ? 'approved talking points' : 'coordinate points'}`,
        selected: false,
      })),
    });
  }

  return questions;
}

/**
 * Resolve the final accepted stop set from the human's picks: the chosen duration tier's stops
 * plus any toggled-on extension stops (deduped). Pure.
 */
export function selectedContactIds(plan: any, sel: { durationTier?: string; extensionContactIds?: string[] }): string[] {
  const durations: any[] = plan?.durationOptions ?? [];
  const tier = sel.durationTier ?? durations[0]?.tier;
  const chosen = durations.find((d) => d.tier === tier) ?? durations[0];
  const baseIds: string[] = (chosen?.stops ?? []).map((s: any) => s.contactId);
  return [...new Set([...baseIds, ...(sel.extensionContactIds ?? [])])];
}

/** The area's default anchor event for the map (first auto-absorbed in-window event). */
function defaultAnchorEventId(plan: any): string | undefined {
  return Array.isArray(plan?.absorbedEventIds) ? plan.absorbedEventIds[0] : undefined;
}

function emptyOptions(persona: string, question: string | null, window: { start: string; end: string } | null): AreaOptionsResult {
  return {
    ok: false,
    stage: 'options',
    persona,
    question,
    answer: null,
    area: null,
    window,
    today: null,
    topicIds: [],
    areaSurvey: [],
    leaderOptions: [],
    chosenLeaderId: null,
    durationOptions: [],
    extensionOptions: [],
    absorbedEventIds: [],
    onSiteDays: null,
    redactedCount: null,
    rejected: false,
    questions: [],
  };
}

/**
 * STAGE 1 — survey an area and return the ranked option menus. When no area can be resolved from
 * the request or the free-text question, returns `stage:'clarify'` with the region chips instead
 * of guessing.
 */
export async function planAreaOptions(req: AreaOptionsRequest): Promise<AreaOptionsResult> {
  const persona = req.persona || DEFAULT_PERSONA();
  const url = req.serverUrl || DEFAULT_URL();
  const window = req.window || defaultWindow();

  const area = resolveAreaAnchor(req);
  if (!area) {
    return {
      ...emptyOptions(persona, req.question ?? null, window),
      stage: 'clarify',
      answer: 'Which area should we plan around? Pick a region (or name a city).',
      questions: [areaClarifyQuestion()],
    };
  }

  const topicIds = req.topicIds?.length ? req.topicIds : req.question ? topicIdsFromText(req.question) : [];

  let client: ToolClient;
  try {
    client = await makeToolClient(url, persona);
  } catch (e: any) {
    return {
      ...emptyOptions(persona, req.question ?? null, window),
      error:
        `Cannot reach the engagements MCP server at ${url}: ${e?.message || e}. ` +
        'Start it with `npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements`.',
    };
  }

  try {
    await client.callTool('plan_options', {
      ...areaArgs(area, req.radiusKm),
      window,
      ...(req.leaderId ? { leaderId: req.leaderId } : {}),
      ...(topicIds.length ? { topicIds } : {}),
      requireTopicMatch: req.requireTopicMatch ?? false,
    });

    const cap0 = lastCapture(client.captured, 'plan_options');
    const plan = cap0?.result ?? {};
    const answer = cap0?.text ?? null;

    // Area could not be resolved server-side → ask for it explicitly.
    if (plan.error) {
      return {
        ...emptyOptions(persona, req.question ?? null, window),
        stage: 'clarify',
        answer: plan.error,
        questions: [areaClarifyQuestion()],
      };
    }

    const rejected = !!plan.rejected;
    return {
      ok: !rejected && (plan.leaderOptions?.length ?? 0) > 0,
      stage: 'options',
      persona,
      question: req.question ?? null,
      answer,
      area: plan.area ?? null,
      window: plan.window ?? window,
      today: plan.today ?? null,
      topicIds: plan.topicIds ?? topicIds,
      areaSurvey: plan.areaSurvey ?? [],
      leaderOptions: plan.leaderOptions ?? [],
      chosenLeaderId: plan.chosenLeaderId ?? null,
      durationOptions: plan.durationOptions ?? [],
      extensionOptions: plan.extensionOptions ?? [],
      absorbedEventIds: plan.absorbedEventIds ?? [],
      onSiteDays: plan.onSiteDays ?? null,
      redactedCount: plan.redactedCount ?? null,
      rejected,
      questions: rejected ? [] : buildOptionQuestions(plan),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

function assembleBuild(base: PlanResult, captured: CapturedCall[]): PlanResult {
  const build = lastCapture(captured, 'build_itinerary')?.result;
  const rejected = isRejected(build);
  const itinerary =
    build && !rejected
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
  return {
    ...base,
    ok: !rejected && itinerary != null,
    toolCalls: captured.map((c) => ({ name: c.name, args: c.args })),
    menu: build?.accepted ?? null,
    itinerary,
    tripMap: build?.tripMap ?? null,
    redactedCount: build?.redactedCount ?? null,
    rejected,
  };
}

/**
 * STAGE 2 — turn the human's picks (leader + duration tier + toggled extensions) into the final
 * itinerary + ui://trip-map. Prefers the UI-supplied `acceptedContactIds` (already derived from the
 * option menus); otherwise re-runs `plan_options` for the chosen leader to derive them. Always calls
 * `build_itinerary`, which re-authorizes every id server-side, so the persona trim still holds.
 */
export async function buildAreaItinerary(req: AreaBuildRequest): Promise<PlanResult> {
  const persona = req.persona || DEFAULT_PERSONA();
  const url = req.serverUrl || DEFAULT_URL();
  const window = req.window || defaultWindow();

  const base: PlanResult = {
    ok: false,
    mode: 'deterministic',
    persona,
    question: req.leaderId ? `Build itinerary for ${req.leaderId}` : 'Build itinerary',
    answer: null,
    toolCalls: [],
    menu: null,
    itinerary: null,
    tripMap: null,
    redactedCount: null,
    rejected: false,
  };

  if (!req.leaderId) return { ...base, error: 'leaderId is required to build an itinerary.' };

  const area = resolveAreaAnchor(req);

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
    let acceptedContactIds = req.acceptedContactIds ?? [];
    let anchorEventId = req.anchorEventId;
    const topicIds = req.topicIds ?? [];

    // Fallback: derive the stop set (and anchor/topics) from a fresh plan_options for this leader.
    if (acceptedContactIds.length === 0 || !anchorEventId) {
      if (!area) return { ...base, error: 'An area (regionId/region/city) is required to build the itinerary.' };
      await client.callTool('plan_options', {
        ...areaArgs(area, req.radiusKm),
        window,
        leaderId: req.leaderId,
        ...(topicIds.length ? { topicIds } : {}),
        requireTopicMatch: false,
      });
      const plan = lastCapture(client.captured, 'plan_options')?.result ?? {};
      if (plan.rejected) return { ...assembleBuild(base, client.captured), rejected: true, answer: 'Access rejected — no verified tenant claim.' };
      if (plan.error) return { ...base, error: plan.error };
      if (acceptedContactIds.length === 0) {
        acceptedContactIds = selectedContactIds(plan, { durationTier: req.durationTier, extensionContactIds: req.extensionContactIds });
      }
      anchorEventId = anchorEventId ?? defaultAnchorEventId(plan);
    }

    if (acceptedContactIds.length === 0) {
      return { ...base, error: 'No stops resolved for the itinerary — pick a duration tier or accept at least one contact.' };
    }

    await client.callTool('build_itinerary', {
      leaderId: req.leaderId,
      ...(anchorEventId ? { eventId: anchorEventId } : area?.city ? { eventQuery: area.city } : {}),
      acceptedContactIds,
      // NOTE: deliberately NO topicIds here. The area-first selection spans multiple topics; passing a
      // topic focus would make build_itinerary's index-level searchContacts({topicIds}) pre-filter to
      // that single topic and drop the cross-topic stops the human just picked. requireTopicMatch:false
      // keeps the anchor event's own topics from culling them either.
      requireTopicMatch: false,
    });

    const built = assembleBuild(base, client.captured);
    built.answer = lastCapture(client.captured, 'build_itinerary')?.text ?? built.answer;
    return built;
  } finally {
    await client.close().catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Hot topics — a topic-first way to INITIATE a search (not a locked flow).
//
// Ranks the seed taxonomy by the caller's live footprint (persona-trimmed): active vs prospect
// contacts, on-site events, upcoming events, and whether an approved message exists. The UI shows
// these as chips; clicking one just sends the topic's `question` to the free-form /ask agent, so
// the human can then steer wherever they like. NO_TENANT/cross-tenant => empty (same trim beat).
// ════════════════════════════════════════════════════════════════════════════

export interface HotTopic {
  topicId: string;
  name: string;
  activeCount: number;
  prospectCount: number;
  eventCount: number;
  upcomingEventCount: number;
  hasApprovedMessage: boolean;
  /** Footprint score (fixed(2) string) the chips are ranked by, hottest first. */
  score: string;
  /** One-line "why it's hot" for the chip tooltip. */
  reason: string;
  /** The natural-language ask a chip fires into /ask — free-form, never a locked wizard. */
  question: string;
}

export interface HotTopicsRequest {
  persona?: string;
  serverUrl?: string;
}

export interface HotTopicsResult {
  ok: boolean;
  persona: string;
  rejected: boolean;
  topics: HotTopic[];
  redactedCount: number | null;
  error?: string;
}

/** The free-form question a hot-topic chip sends to the agent. */
export function hotTopicQuestion(name: string): string {
  return `What's the engagement picture on ${name} right now — who should we meet, where is it most active, and is there an approved message?`;
}

/**
 * Pure ranker: fold the caller's authorized contacts + events into a per-topic footprint and
 * sort hottest-first. Kept side-effect-free so it is unit-testable without a live server.
 * Only topics with a non-zero footprint are returned (a topic no one can see is not "hot").
 */
export function rankHotTopics(
  contacts: { topicIds?: string[]; status?: string }[],
  events: { topicIds?: string[]; start?: string }[],
  topics: Topic[],
  today: string,
): HotTopic[] {
  const ranked = topics.map((t) => {
    const tc = contacts.filter((c) => c.topicIds?.includes(t.id));
    const activeCount = tc.filter((c) => c.status === 'active').length;
    const prospectCount = tc.filter((c) => c.status === 'prospect').length;
    const te = events.filter((e) => e.topicIds?.includes(t.id));
    const eventCount = te.length;
    const upcomingEventCount = te.filter((e) => (e.start ?? '') >= today).length;
    const hasApprovedMessage = !!t.approvedMessageId;

    const score = activeCount * 1 + upcomingEventCount * 1.5 + eventCount * 0.5 + prospectCount * 0.3 + (hasApprovedMessage ? 0.5 : 0);
    const reason = [
      activeCount ? `${activeCount} active` : null,
      prospectCount ? `${prospectCount} prospect` : null,
      upcomingEventCount ? `${upcomingEventCount} upcoming event${upcomingEventCount > 1 ? 's' : ''}` : eventCount ? `${eventCount} event${eventCount > 1 ? 's' : ''}` : null,
      hasApprovedMessage ? 'approved message' : null,
    ]
      .filter(Boolean)
      .join(' · ');

    return {
      topicId: t.id,
      name: t.name,
      activeCount,
      prospectCount,
      eventCount,
      upcomingEventCount,
      hasApprovedMessage,
      score: score.toFixed(2),
      reason: reason || 'no live footprint',
      question: hotTopicQuestion(t.name),
    };
  });

  // "Hot" requires a real footprint (contacts/events). An approved message alone is readiness,
  // not activity, so it only boosts ordering among topics that already have a footprint.
  return ranked
    .filter((t) => t.activeCount + t.prospectCount + t.eventCount > 0)
    .sort((a, b) => Number(b.score) - Number(a.score) || a.name.localeCompare(b.name));
}

/**
 * Rank the seed topics by the caller's authorized footprint. Two cheap, already-trimmed tool
 * calls (search_contacts + search_events with no filter) feed the pure ranker above.
 */
export async function hotTopics(req: HotTopicsRequest): Promise<HotTopicsResult> {
  const persona = req.persona || DEFAULT_PERSONA();
  const url = req.serverUrl || DEFAULT_URL();
  const base: HotTopicsResult = { ok: false, persona, rejected: false, topics: [], redactedCount: null };

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
    const contactsRes: any = await client.callTool('search_contacts', {});
    if (contactsRes?.rejected) {
      return { ...base, ok: true, rejected: true, redactedCount: contactsRes.redactedCount ?? null };
    }
    const eventsRes: any = await client.callTool('search_events', {});
    const topics = rankHotTopics(contactsRes?.contacts ?? [], eventsRes?.events ?? [], loadTopics(), demoToday());
    return { ...base, ok: true, topics, redactedCount: contactsRes?.redactedCount ?? null };
  } catch (e: any) {
    return { ...base, error: e?.message || String(e) };
  } finally {
    await client.close().catch(() => {});
  }
}
