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
import mcpCore from "@greenhouse-resume-builder/mcp-core";
import {
  AGENT_TOOLS,
  makeToolClient,
  type CapturedCall,
  type ToolClient,
} from "./tools.js";
import {
  type AreaInput,
  type EngagementCategory,
  type Topic,
  CATEGORY_LABEL,
  ENGAGEMENT_CATEGORY_ORDER,
  defaultWindow,
  demoToday,
  loadLeaders,
  loadTopics,
  regionChoices,
  resolveAreaInput,
  resolveDefaultLeaderId,
  rosterForPrompt,
  topicIdsFromText,
  topicsForPrompt,
} from "./catalog.js";

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
  /**
   * Engagement CATEGORY to anchor the trip on (category-first flow). When set, skip the category
   * clarify and build a single-audience itinerary for this audience + recommend the best leader.
   */
  category?: EngagementCategory;
  /** Trip radius (miles) around the area centroid; defaults to the region's default radius. */
  radiusMi?: number;
  /** Trip length (days); defaults to a size that holds the chosen audience's in-area meetings. */
  days?: number;
  /** Engagements MCP endpoint; defaults to ENGAGEMENTS_MCP_URL or http://localhost:3010/mcp. */
  serverUrl?: string;
}

/**
 * When a turn is `mode: 'deterministic'`, WHY the LLM tool-calling loop wasn't used — surfaced in the
 * UI so the demo explains itself:
 *   - 'area-anchored'        the ask named a known REGION → deterministic area/category-first planner (LLM-free by design)
 *   - 'event-anchored'       the ask named a known EVENT → deterministic leader-first planner (LLM-free by design)
 *   - 'mcp-unavailable'      the capability server could not be reached → no planner/model turn was possible
 *   - 'model-not-configured' Azure OpenAI is not configured → deterministic fallback
 *   - 'model-unavailable'    Azure OpenAI is configured but the call failed/returned null → deterministic fallback
 */
export type DeterministicReason =
  | "area-anchored"
  | "event-anchored"
  | "mcp-unavailable"
  | "model-not-configured"
  | "model-unavailable";

export interface PlanResult {
  ok: boolean;
  mode: "llm" | "deterministic";
  /** When `mode === 'deterministic'`, WHY the LLM path wasn't taken (null/absent on the LLM path). */
  deterministicReason?: DeterministicReason | null;
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

  // ── Leader-first, multi-option `/ask` envelope (additive; absent on the legacy single-plan path) ──
  /** 'clarify' = ask a question first (WHICH audience); 'options' = multiple finished itineraries; 'plan' = one itinerary. */
  stage?: "clarify" | "options" | "plan";
  /**
   * What is being clarified when stage === 'clarify'. Category-first flow asks 'category' (which
   * audience to anchor the trip on); the event-anchored path still asks 'leader' (WHO to send).
   */
  clarify?: "leader" | "category" | null;
  /** The engagement category the plan is anchored on (category-first flow). */
  category?: EngagementCategory | null;
  /** Ranked "who should go" shortlist for the chosen category — recommended leader first (stage 'plan'). */
  leaderShortlist?: LeaderPick[];
  /** Clarifying questions the UI renders as option groups (the category menu, or the ranked leader roster). */
  questions?: OptionQuestion[];
  /** The finished, DIFFERENT-LENGTH itineraries to choose between (stage === 'options'). */
  options?: AreaItineraryOption[];
  /** Id of the recommended option (best in-budget ROI). */
  recommendedOptionId?: string | null;
  /** The leader the plan/options are for (null until the human picks one). */
  leaderId?: string | null;
  leaderName?: string | null;
  /** The resolved anchor event, when the ask is event-anchored. */
  event?: any | null;

  // ── Area intel for the clarify-stage briefing ("what's worth doing there", before a leader is picked) ──
  /** The resolved area/region the ask targets. */
  area?: any | null;
  /** Demo "today" the freshness verdicts are relative to. */
  today?: string | null;
  /** Topic ids surveyed for the area. */
  topicIds?: string[];
  /** Hot topics in the area (why go now). */
  areaSurvey?: any[];
  /** Active in-area relationships overdue for a touch (re-engage while there) + why. */
  staleContacts?: any[];
  /** In-area events with a freshness verdict + why. */
  areaEvents?: any[];
  /** In-area engagements rolled up by audience (Congressional / Academia / Industry / Army-internal) + coverage. */
  categoryBreakdown?: any[];
}

const DEFAULT_URL = (): string =>
  process.env.ENGAGEMENTS_MCP_URL || "http://localhost:3010/mcp";
const DEFAULT_TOPN = (): number => {
  const n = Number(process.env.ENGAGEMENTS_TOP_N);
  return Number.isFinite(n) && n > 0 ? n : 3;
};
const DEFAULT_PERSONA = (): string =>
  process.env.ENGAGEMENTS_DEMO_PERSONA || "EA_BASIC";

export function buildSystemPrompt(
  defaultLeaderId: string,
  topN: number,
): string {
  return [
    "You are the Strategic Engagements Orchestrator, the planning brain for a U.S. Army senior-leader",
    "executive assistant (EA). Turn the EA's natural-language trip question into a concrete,",
    "security-trimmed engagement plan using ONLY the provided tools.",
    "",
    'The "you\'re already going there" nudge: when a leader is already attending an anchor event,',
    "batch the highest-value people they should meet — on-site attendees/prospects (~0 extra travel)",
    "and nearby stale relationships worth re-engaging.",
    "",
    "The fixed-radius entry point: when the leader must visit a SPECIFIC company (or place) for a fixed",
    'number of days with NO anchor event ("go meet Meridian Robotics for 3 days", "2 days within 60 mi of',
    'Reston"), use plan_radius to fill the trip around that anchor, then build_itinerary with the same anchor.',
    "",
    "Leaders (use the id):",
    rosterForPrompt(),
    "",
    'Topics (map the user\'s phrasing to these ids — e.g. "UAS/drone" or "autonomy" -> T3):',
    topicsForPrompt(),
    "",
    "Rules:",
    `1. Leader: use "${defaultLeaderId}" unless the user names another leader from the roster.`,
    '2. Anchor event: if the user names one (e.g. "AUSA"), pass it as eventQuery to suggest_candidates.',
    "3. Topic: map the ask to topicIds from the catalog and pass them to suggest_candidates.",
    "4. Event-anchored flow: call suggest_candidates to get the ranked menu, then ALWAYS follow with",
    `   build_itinerary using the top ${topN} candidate ids, so the route and ui://trip-map are produced.`,
    "5. Fixed-radius flow (a specific company/place + N days, NO event): call plan_radius with the anchor",
    "   (anchorContactId, or a company name, or lat+lng, or city; plus radiusMi and days), then call",
    "   build_itinerary with the SAME anchor + days (omit acceptedContactIds to accept the auto-filled plan).",
    "   Do NOT fabricate an event for these trips.",
    "6. Never invent contacts, events, or attributes — surface only what the tools return. Some records",
    "   are hidden by the security trim; report the redactedCount the tools give you.",
    "7. Finish with a concise, EA-ready answer: a short numbered menu (id — name, org, city, why) and a",
    "   one-line itinerary summary (route + ROI + any conflicts).",
  ].join("\n");
}

/** Extract a likely anchor token from the question for the deterministic path. */
export function anchorGuess(question: string): string {
  const acronym = question.match(/\b[A-Z]{3,}\b/)?.[0];
  if (acronym) return acronym;
  // Proper-case place/event name after a preposition ("visit to Fort Bragg next week" -> "Fort Bragg").
  const proper = question.match(
    /\b(?:to|at|for|attending|visiting|visit)\s+([A-Z][\w&]*(?:\s+[A-Z][\w&]*)*)/,
  );
  if (proper?.[1]) return proper[1].trim();
  return question.trim();
}

/**
 * Deterministically pull the senior leader out of the question when the EA/planner names one — by
 * roster id ("L2") or by surname ("Whitfield"). Returns null when NO leader is named, which is the
 * signal for the leader-first workflow to ASK who they are planning for instead of defaulting to L1.
 * Pure (reads the local roster catalog).
 */
export function leaderFromQuestion(question: string): string | null {
  const q = ` ${question.toLowerCase()} `;
  const leaders = loadLeaders();
  // Explicit roster id wins ("plan AUSA for L2").
  for (const l of leaders) {
    if (new RegExp(`\\b${l.id.toLowerCase()}\\b`).test(q)) return l.id;
  }
  // Otherwise match a distinctive surname ("... for MG Whitfield ...").
  for (const l of leaders) {
    const surname = l.name
      .split(/\s+/)
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z]/g, "");
    if (
      surname &&
      surname.length >= 3 &&
      new RegExp(`\\b${surname}\\b`).test(q)
    )
      return l.id;
  }
  return null;
}

/**
 * Decide whether a free-text ask should enter the AREA-first, leader-then-options workflow. It must
 * name a KNOWN REGION (resolves to a regionId) and NOT be a fixed-duration radius ask ("3 days within
 * 60 mi of Reston" stays on the radius/legacy path). A bare locative city ("to Huntsville") is left to
 * the legacy path since it may not geocode. Returns the region anchor, or null. Pure.
 */
export function areaAskAnchor(question: string): AreaInput | null {
  if (parseRadiusAsk(question)) return null;
  const area = resolveAreaInput(question);
  return area?.regionId ? area : null;
}

/**
 * Deterministic parse of a "fixed-radius" ask: a day count PLUS a company / place / explicit radius,
 * with no anchor event. Returns null when it doesn't look like a radius trip (so the event flow runs).
 * Heuristic only — the LLM path is primary; this keeps the offline demo working for the common phrasings.
 */
export function parseRadiusAsk(
  question: string,
): { days: number; radiusMi?: number; company?: string; city?: string } | null {
  const daysM = question.match(/\b(\d+)\s*(?:day|days)\b/i);
  if (!daysM) return null;
  const days = Number(daysM[1]);
  if (!Number.isFinite(days) || days <= 0) return null;

  let radiusMi: number | undefined;
  const radM = question.match(
    /\bwithin\s+(\d+)\s*(km|kilometers?|mi|miles?)\b/i,
  );
  if (radM) {
    const n = Number(radM[1]);
    radiusMi = /^mi/i.test(radM[2]) ? n : Math.round(n * 0.621371);
  }

  // Company: proper-noun phrase after meet/visit/see/with.
  const compM = question.match(
    /\b(?:meet|meeting|visit|visiting|see|with)\s+([A-Z][\w&.]*(?:\s+[A-Z][\w&.]*)*)/,
  );
  const company = compM?.[1]?.trim();
  // Otherwise a place after a radius/proximity preposition.
  const placeM = question.match(
    /\b(?:of|near|around|in)\s+([A-Z][\w.]*(?:\s+[A-Z][\w.]*)*)/,
  );
  const city = !company ? placeM?.[1]?.trim() : undefined;

  if (!company && !city && radiusMi === undefined) return null;
  return { days, radiusMi, company, city };
}

/** Rebuild event-less build_itinerary args from a plan_radius result (anchor + fixed days + stops). */
function radiusBuildArgsFromPlan(
  plan: any,
  fallbackLeaderId: string,
): Record<string, unknown> | null {
  if (!plan?.area || typeof plan.days !== "number") return null;
  const args: Record<string, unknown> = {
    leaderId: plan.chosenLeaderId ?? fallbackLeaderId,
    days: plan.days,
    ...(plan.window ? { window: plan.window } : {}),
    ...(typeof plan.meetingsPerDay === "number"
      ? { meetingsPerDay: plan.meetingsPerDay }
      : {}),
    ...(typeof plan.area.radiusMi === "number"
      ? { radiusMi: plan.area.radiusMi }
      : {}),
  };
  if (plan.anchor?.contactId) args.anchorContactId = plan.anchor.contactId;
  else if (
    typeof plan.area.lat === "number" &&
    typeof plan.area.lng === "number"
  ) {
    args.lat = plan.area.lat;
    args.lng = plan.area.lng;
  } else if (plan.area.city) {
    args.city = plan.area.city;
    if (plan.area.state) args.state = plan.area.state;
  }
  const ids = (plan.stops ?? []).map((s: any) => s.contactId).filter(Boolean);
  if (ids.length) args.acceptedContactIds = ids;
  return args;
}

function lastCapture(
  captured: CapturedCall[],
  name: string,
): CapturedCall | undefined {
  for (let i = captured.length - 1; i >= 0; i--)
    if (captured[i].name === name) return captured[i];
  return undefined;
}

function isRejected(result: any): boolean {
  return !!result?.rejected;
}

/**
 * No-LLM fallback: anchor -> suggest -> build, mirroring what the model would compose.
 * Drives the shared client; results are read from `client.captured` by the caller.
 */
async function deterministicPlan(
  client: ToolClient,
  opts: { question: string; leaderId: string; topN: number },
): Promise<void> {
  const { question, leaderId, topN } = opts;

  // Fixed-radius ask ("meet <Company> for N days", "N days within X mi of <place>") → plan_radius → build.
  const radiusAsk = parseRadiusAsk(question);
  if (radiusAsk) {
    const planArgs: Record<string, unknown> = {
      leaderId,
      days: radiusAsk.days,
      window: defaultWindow(),
    };
    if (typeof radiusAsk.radiusMi === "number")
      planArgs.radiusMi = radiusAsk.radiusMi;
    if (radiusAsk.company) planArgs.company = radiusAsk.company;
    else if (radiusAsk.city) planArgs.city = radiusAsk.city;
    const plan: any = await client.callTool("plan_radius", planArgs);
    if (isRejected(plan)) return;
    if (!plan?.error && (plan?.stops?.length ?? 0) > 0) {
      const buildArgs = radiusBuildArgsFromPlan(plan, leaderId);
      if (buildArgs) {
        await client.callTool("build_itinerary", buildArgs);
        return;
      }
    }
    // else: not a resolvable radius trip → fall through to the event-anchored flow.
  }

  const topicIds = topicIdsFromText(question);
  const anchor = anchorGuess(question);

  let suggest: any = await client.callTool("suggest_candidates", {
    leaderId,
    eventQuery: anchor,
    ...(topicIds.length ? { topicIds } : {}),
  });
  if (isRejected(suggest)) return;

  // Widen if the topic filter zeroed the menu.
  if ((suggest?.candidates?.length ?? 0) === 0 && topicIds.length) {
    suggest = await client.callTool("suggest_candidates", {
      leaderId,
      eventQuery: anchor,
      topicIds,
      requireTopicMatch: false,
    });
  }

  const candidates: any[] = suggest?.candidates ?? [];
  if (candidates.length === 0) return;

  const acceptedContactIds = candidates.slice(0, topN).map((c) => c.contactId);
  await client.callTool("build_itinerary", {
    leaderId: suggest?.leader?.id ?? leaderId,
    ...(suggest?.event?.id
      ? { eventId: suggest.event.id }
      : { eventQuery: anchor }),
    acceptedContactIds,
    ...(suggest?.topicFocus?.length ? { topicIds: suggest.topicFocus } : {}),
  });
}

/**
 * LLM safety net: if the model produced a menu but never called build_itinerary, auto-build
 * from the top N (event flow) or from the plan_radius anchor (radius flow) so the demo always
 * gets a route + map.
 */
async function ensureItinerary(
  client: ToolClient,
  opts: { leaderId: string; topN: number },
): Promise<void> {
  const built = client.captured.some(
    (c) => c.name === "build_itinerary" && !isRejected(c.result),
  );
  if (built) return;

  // Radius flow: a plan_radius result with stops but no build → auto-build the event-less itinerary.
  const radius = lastCapture(client.captured, "plan_radius")?.result;
  if (radius && !isRejected(radius) && (radius.stops?.length ?? 0) > 0) {
    const args = radiusBuildArgsFromPlan(radius, opts.leaderId);
    if (args) {
      try {
        await client.callTool("build_itinerary", args);
      } catch {
        /* advisory only */
      }
      return;
    }
  }

  const suggest = lastCapture(client.captured, "suggest_candidates")?.result;
  const candidates: any[] = suggest?.candidates ?? [];
  if (isRejected(suggest) || candidates.length === 0) return;

  const acceptedContactIds = candidates
    .slice(0, opts.topN)
    .map((c) => c.contactId);
  try {
    await client.callTool("build_itinerary", {
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
  const parts = [
    lastCapture(captured, "suggest_candidates")?.text,
    lastCapture(captured, "build_itinerary")?.text,
  ].filter((t): t is string => !!t);
  if (parts.length) return parts.join("\n\n");
  return (
    lastCapture(captured, "search_events")?.text ??
    lastCapture(captured, "search_contacts")?.text ??
    "(no results)"
  );
}

function assemble(
  base: PlanResult,
  mode: "llm" | "deterministic",
  answer: string | null,
  toolCalls: { name: string; args: unknown }[],
  captured: CapturedCall[],
  deterministicReason: DeterministicReason | null = null,
): PlanResult {
  const suggest = lastCapture(captured, "suggest_candidates")?.result;
  const build = lastCapture(captured, "build_itinerary")?.result;
  const rejected = isRejected(suggest) || isRejected(build);

  const menu: any[] | null = suggest?.candidates ?? null;
  const itinerary = extractItinerary(build);
  const tripMap = build?.tripMap ?? null;
  const redactedCount = build?.redactedCount ?? suggest?.redactedCount ?? null;

  return {
    ...base,
    ok: !rejected && (menu != null || itinerary != null),
    mode,
    deterministicReason: mode === "deterministic" ? deterministicReason : null,
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
  const url = req.serverUrl || DEFAULT_URL();

  const base: PlanResult = {
    ok: false,
    mode: "deterministic",
    persona,
    question: req.question,
    answer: null,
    toolCalls: [],
    menu: null,
    itinerary: null,
    tripMap: null,
    redactedCount: null,
    rejected: false,
    stage: "plan",
    clarify: null,
  };

  let client: ToolClient;
  try {
    client = await makeToolClient(url, persona);
  } catch (e: any) {
    return {
      ...base,
      deterministicReason: "mcp-unavailable",
      error:
        `Cannot reach the engagements MCP server at ${url}: ${e?.message || e}. ` +
        "Start it with `npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements`.",
    };
  }

  try {
    // ── Area/CATEGORY-first workflow (KNOWN-REGION asks — the DEFAULT for "Plan a trip to X") ─────
    // A KNOWN-REGION ask ("Plan a trip to Boston", "what's worth doing in the Bay Area") drives a
    // CATEGORY-FIRST flow: survey the area, roll its hot topics / timely events / key contacts up by
    // engagement category, and ASK which audience to anchor on. Once the human picks a category (with
    // the trip's radius/days), build ONE single-audience itinerary for that audience and RECOMMEND the
    // best senior leader to send. The leader is the OUTPUT of the plan, not the first question. This
    // runs BEFORE the event branch so a region that merely HOSTS an event (Boston → New England Defense
    // Innovation Forum) still gets the category briefing rather than auto-anchoring on the event.
    const areaAnchor = areaAskAnchor(req.question);
    if (areaAnchor) {
      const topicIds = topicIdsFromText(req.question);
      const category = req.category ?? categoryFromQuestion(req.question);
      const daysM = req.question.match(/\b(\d+)\s*(?:day|days)\b/i);
      const days = req.days ?? (daysM ? Number(daysM[1]) : undefined);
      const intel = await rankRosterForArea(client, areaAnchor, topicIds);
      const toolCalls = () =>
        client.captured.map((c) => ({ name: c.name, args: c.args }));

      // STAGE 2 — a category is chosen: build the single-audience itinerary + recommend WHO should go.
      if (category) {
        const plan = await buildCategoryPlan(client, {
          area: areaAnchor,
          category,
          leaderId: req.leaderId,
          leaderOptions: intel.leaders,
          categoryBreakdown: intel.categoryBreakdown,
          areaResolved: intel.area,
          today: intel.today,
          redactedCount: intel.redactedCount,
          topicIds: intel.topicIds ?? topicIds,
          radiusMi: req.radiusMi,
          days,
        });
        const pr = categoryPlanToResult(base, plan);
        pr.deterministicReason = "area-anchored";
        pr.areaSurvey = intel.areaSurvey;
        pr.staleContacts = intel.staleContacts;
        pr.areaEvents = intel.areaEvents;
        pr.topicIds = intel.topicIds ?? topicIds;
        pr.toolCalls = toolCalls();
        return pr;
      }

      // STAGE 1 — no category yet: show the area briefing grouped by engagement category + ASK which one.
      const catQ = categoryClarifyQuestion(intel.categoryBreakdown);
      const hasCats = catQ.choices.length > 0;
      const hasIntel =
        intel.areaSurvey.length +
          intel.staleContacts.length +
          intel.areaEvents.length >
        0;
      return {
        ...base,
        ok: hasCats,
        stage: "clarify",
        clarify: "category",
        deterministicReason: "area-anchored",
        leaderId: null,
        answer: hasCats
          ? `Here's what's worth doing around ${intel.area?.name ?? "this area"}, grouped by engagement category` +
            (hasIntel
              ? " — hot topics to advance, stale relationships to re-engage, and timely events are below. "
              : ". ") +
            `Which engagement category should this trip focus on? Once you pick, I'll build the itinerary and recommend the best senior leader to send.`
          : `No engagements found around ${intel.area?.name ?? "this area"} for this persona.`,
        area: intel.area,
        today: intel.today,
        topicIds: intel.topicIds ?? topicIds,
        areaSurvey: intel.areaSurvey,
        staleContacts: intel.staleContacts,
        areaEvents: intel.areaEvents,
        categoryBreakdown: intel.categoryBreakdown,
        redactedCount: intel.redactedCount,
        questions: hasCats ? [catQ] : [],
        toolCalls: toolCalls(),
      };
    }

    // ── Leader-first, multi-option workflow (an explicitly-named EVENT that is NOT a known region) ─
    // When the ask anchors on an authorized EVENT the user NAMES ("a trip to AUSA") — and the token is
    // not itself a known region — keep the "you're already going there" flow: make WHO explicit (a
    // ranked roster), then present several DIFFERENT-LENGTH itineraries (conference footprint → regional
    // swing) to compare. Radius asks ("3 days within 60 mi of Reston") keep the legacy path.
    const event = await resolveEventAnchor(client, req.question);
    if (event) {
      const topicIds = topicIdsFromText(req.question);
      const leaderId = req.leaderId || leaderFromQuestion(req.question);
      if (!leaderId) {
        const leaders = await rankRosterForEvent(client, event, topicIds);
        return {
          ...base,
          ok: leaders.length > 0,
          stage: "clarify",
          clarify: "leader",
          deterministicReason: "event-anchored",
          leaderId: null,
          event,
          answer:
            `Which senior leader are you planning for around ${event.name} (${event.city})? ` +
            `${leaders.length} option(s) — top pick recommended, but you decide.`,
          questions: [
            leaderClarifyQuestion(leaders, leaders[0]?.leaderId ?? null),
          ],
          toolCalls: client.captured.map((c) => ({
            name: c.name,
            args: c.args,
          })),
        };
      }
      const opts = await buildEventOptions(client, {
        leaderId,
        eventId: event.id,
        topicIds,
        persona,
      });
      const pr = optionsToPlanResult(base, opts, event);
      pr.deterministicReason = "event-anchored";
      pr.toolCalls = client.captured.map((c) => ({
        name: c.name,
        args: c.args,
      }));
      return pr;
    }

    // ── Legacy single-itinerary path (non-event asks: radius trips, free-form) ──────────────────
    const leaderId = req.leaderId || resolveDefaultLeaderId();
    let answer: string | null = null;
    let toolCalls: { name: string; args: unknown }[] = [];
    let mode: "llm" | "deterministic" = "deterministic";
    // Why we'd stay deterministic on this free-form path: no model configured at all, or the model errored/timed out.
    const deterministicReason: DeterministicReason = isModelConfigured()
      ? "model-unavailable"
      : "model-not-configured";

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
        mode = "llm";
        answer = loop.output;
        toolCalls = loop.toolCalls;
        await ensureItinerary(client, { leaderId, topN });
      }
    }

    if (answer === null) {
      // model unavailable or errored → deterministic router (reuses the same client/persona)
      mode = "deterministic";
      await deterministicPlan(client, {
        question: req.question,
        leaderId,
        topN,
      });
      toolCalls = client.captured.map((c) => ({ name: c.name, args: c.args }));
      answer = answerFromCaptured(client.captured);
    }

    return assemble(
      base,
      mode,
      answer,
      toolCalls,
      client.captured,
      deterministicReason,
    );
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
  id: "area" | "category" | "leader" | "duration" | "extensions";
  kind: "single" | "multi";
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
  radiusMi?: number;
  /** Planning window; defaults to the demo clock's `today` + horizon (see catalog.defaultWindow). */
  window?: { start: string; end: string };
  leaderId?: string;
  topicIds?: string[];
  requireTopicMatch?: boolean;
  serverUrl?: string;
}

export interface AreaOptionsResult {
  ok: boolean;
  /** `clarify` = the orchestrator needs a decision first; `options` = the menus are ready. */
  stage: "clarify" | "options";
  /** When `stage:'clarify'`, WHICH decision is pending (drives the single question returned). */
  clarify: "area" | "leader" | null;
  persona: string;
  question: string | null;
  answer: string | null;
  area: any | null;
  window: { start: string; end: string } | null;
  today: string | null;
  topicIds: string[];
  areaSurvey: any[];
  /** Active in-area relationships overdue for a touch (who + why), for the "re-engage" panel. */
  staleContacts: any[];
  /** In-area events with a freshness verdict (lapsed follow-up / in-window / upcoming magnet) + why. */
  areaEvents: any[];
  /**
   * In-area engagements rolled up into the four target audiences (+ `other`) with per-audience footprint
   * and itinerary coverage — the "identification across Congressional / Academia / Industry / Army-internal".
   */
  categoryBreakdown: any[];
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
  radiusMi?: number;
  window?: { start: string; end: string };
  /** Chosen leader (from the leader option menu). */
  leaderId: string;
  /** Chosen duration tier; used to derive the base stop set when `acceptedContactIds` is absent. */
  durationTier?: "core" | "extended";
  /** Extension stops the human toggled on. */
  extensionContactIds?: string[];
  /** Explicit final stop set (preferred — the UI already derived it from the option menus). */
  acceptedContactIds?: string[];
  /** Anchor event for the map; defaults to the area's first auto-absorbed in-window event. */
  anchorEventId?: string;
  topicIds?: string[];
  // ── Multi-length options (buildAreaItineraryOptions only) ──
  /** How many different-length options to present (default 3). */
  optionCount?: number;
  /** Longest trip to consider / probe the stop pool with (default 7 days). */
  maxDays?: number;
  /** Explicit trip lengths (days) to offer — overrides the auto-spread. */
  targetDays?: number[];
  /** Meetings packed per day in each option (default: server's own default, ~2). */
  meetingsPerDay?: number;
  serverUrl?: string;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Merge an explicit area anchor with one parsed from the free-text question. */
function resolveAreaAnchor(req: {
  regionId?: string;
  region?: string;
  city?: string;
  state?: string;
  question?: string;
}): AreaInput | null {
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
function areaArgs(area: AreaInput, radiusMi?: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (area.regionId) out.regionId = area.regionId;
  if (area.region) out.region = area.region;
  if (area.city) out.city = area.city;
  if (area.state) out.state = area.state;
  if (typeof radiusMi === "number") out.radiusMi = radiusMi;
  return out;
}

/** The "which area?" clarifying question — the known region chips. */
export function areaClarifyQuestion(): OptionQuestion {
  return {
    id: "area",
    kind: "single",
    prompt: "Which area do you want to anchor the trip on?",
    choices: regionChoices().map((c) => ({
      value: c.value,
      label: c.label,
      detail: c.detail,
    })),
  };
}

/** Shape ranked leader options into selectable choices (the recommended/top pick flagged). Pure. */
function leaderChoices(
  leaders: any[],
  chosenLeaderId: string | null | undefined,
): OptionChoice[] {
  return (leaders ?? []).map((o) => ({
    value: o.leaderId,
    label: `${o.leaderId} — ${o.name}`,
    detail:
      `${o.role} · fit ${o.score}` +
      (o.availableInWindow === false ? " · not free in window" : "") +
      (typeof o.distanceMi === "number" ? ` · ${o.distanceMi} mi` : ""),
    selected: o.leaderId === chosenLeaderId,
    recommended: o.leaderId === chosenLeaderId,
  }));
}

/**
 * The "which senior leader?" clarifying question — asked up front so the EA/planner commits to WHO
 * they are planning for before the trip is shaped. The ranked top pick is flagged as recommended,
 * but nothing is decided until the human answers.
 */
export function leaderClarifyQuestion(
  leaders: any[],
  chosenLeaderId?: string | null,
): OptionQuestion {
  return {
    id: "leader",
    kind: "single",
    prompt: "Which senior leader are you planning for?",
    choices: leaderChoices(leaders, chosenLeaderId),
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
      id: "leader",
      kind: "single",
      prompt: "Who should go?",
      choices: leaderChoices(leaders, plan.chosenLeaderId),
    });
  }

  const durations: any[] = plan?.durationOptions ?? [];
  if (durations.length) {
    questions.push({
      id: "duration",
      kind: "single",
      prompt: "How long should the trip be?",
      choices: durations.map((d, i) => ({
        value: d.tier,
        label: `${cap(d.tier)} — ${d.days} day(s)`,
        detail:
          `${d.stops?.length ?? 0} stop(s) · ROI ${d.roiScore}` +
          (d.overBudget ? " · OVER BUDGET" : "") +
          (d.categoryMix ? ` · ${d.categoryMix}` : ""),
        selected: i === 0,
        recommended: i === 0,
      })),
    });
  }

  const extensions: any[] = plan?.extensionOptions ?? [];
  if (extensions.length) {
    questions.push({
      id: "extensions",
      kind: "multi",
      prompt:
        "Extend the trip? Each extra day unlocks another meeting (optional).",
      choices: extensions.map((e) => ({
        value: e.contactId,
        label:
          `+${e.extraDays}d → ${e.name}` + (e.sector ? ` (${e.sector})` : ""),
        detail:
          `${e.topicName ?? e.topicId ?? "topic —"} · mROI ${e.marginalRoi}` +
          (e.overBudget ? " · over budget" : "") +
          ` · ${e.talkingPointsSource === "approved-message" ? "approved talking points" : "coordinate points"}` +
          (e.categoryLabel ? ` · ${e.categoryLabel}` : ""),
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
export function selectedContactIds(
  plan: any,
  sel: { durationTier?: string; extensionContactIds?: string[] },
): string[] {
  const durations: any[] = plan?.durationOptions ?? [];
  const tier = sel.durationTier ?? durations[0]?.tier;
  const chosen = durations.find((d) => d.tier === tier) ?? durations[0];
  const baseIds: string[] = (chosen?.stops ?? []).map((s: any) => s.contactId);
  return [...new Set([...baseIds, ...(sel.extensionContactIds ?? [])])];
}

/** The area's default anchor event for the map (first auto-absorbed in-window event). */
function defaultAnchorEventId(plan: any): string | undefined {
  return Array.isArray(plan?.absorbedEventIds)
    ? plan.absorbedEventIds[0]
    : undefined;
}

function emptyOptions(
  persona: string,
  question: string | null,
  window: { start: string; end: string } | null,
): AreaOptionsResult {
  return {
    ok: false,
    stage: "options",
    clarify: null,
    persona,
    question,
    answer: null,
    area: null,
    window,
    today: null,
    topicIds: [],
    areaSurvey: [],
    staleContacts: [],
    areaEvents: [],
    categoryBreakdown: [],
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
export async function planAreaOptions(
  req: AreaOptionsRequest,
): Promise<AreaOptionsResult> {
  const persona = req.persona || DEFAULT_PERSONA();
  const url = req.serverUrl || DEFAULT_URL();
  const window = req.window || defaultWindow();

  const area = resolveAreaAnchor(req);
  if (!area) {
    return {
      ...emptyOptions(persona, req.question ?? null, window),
      stage: "clarify",
      clarify: "area",
      answer:
        "Which area should we plan around? Pick a region (or name a city).",
      questions: [areaClarifyQuestion()],
    };
  }

  const topicIds = req.topicIds?.length
    ? req.topicIds
    : req.question
      ? topicIdsFromText(req.question)
      : [];

  let client: ToolClient;
  try {
    client = await makeToolClient(url, persona);
  } catch (e: any) {
    return {
      ...emptyOptions(persona, req.question ?? null, window),
      error:
        `Cannot reach the engagements MCP server at ${url}: ${e?.message || e}. ` +
        "Start it with `npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements`.",
    };
  }

  try {
    await client.callTool("plan_options", {
      ...areaArgs(area, req.radiusMi),
      window,
      ...(req.leaderId ? { leaderId: req.leaderId } : {}),
      ...(topicIds.length ? { topicIds } : {}),
      requireTopicMatch: req.requireTopicMatch ?? false,
    });

    const cap0 = lastCapture(client.captured, "plan_options");
    const plan = cap0?.result ?? {};
    const answer = cap0?.text ?? null;

    // Area could not be resolved server-side → ask for it explicitly.
    if (plan.error) {
      return {
        ...emptyOptions(persona, req.question ?? null, window),
        stage: "clarify",
        clarify: "area",
        answer: plan.error,
        questions: [areaClarifyQuestion()],
      };
    }

    const rejected = !!plan.rejected;
    const leaderOptions: any[] = plan.leaderOptions ?? [];

    // STAGE 1a — ask WHO first. When the caller has not named a leader, make choosing the senior
    // leader an explicit decision (top pick flagged recommended) before we shape the duration and
    // extension menus, which are leader-specific. The UI re-calls plan-options with the picked
    // leaderId to advance to the option menus.
    if (!rejected && !req.leaderId && leaderOptions.length > 0) {
      return {
        ...emptyOptions(persona, req.question ?? null, plan.window ?? window),
        stage: "clarify",
        clarify: "leader",
        answer:
          `Which senior leader are you planning for around ${plan.area?.name ?? "this area"}? ` +
          `${leaderOptions.length} option(s) — top pick recommended.`,
        area: plan.area ?? null,
        today: plan.today ?? null,
        topicIds: plan.topicIds ?? topicIds,
        areaSurvey: plan.areaSurvey ?? [],
        staleContacts: plan.staleContacts ?? [],
        areaEvents: plan.areaEvents ?? [],
        categoryBreakdown: plan.categoryBreakdown ?? [],
        leaderOptions,
        chosenLeaderId: plan.chosenLeaderId ?? null,
        absorbedEventIds: plan.absorbedEventIds ?? [],
        onSiteDays: plan.onSiteDays ?? null,
        redactedCount: plan.redactedCount ?? null,
        questions: [leaderClarifyQuestion(leaderOptions, plan.chosenLeaderId)],
      };
    }

    return {
      ok: !rejected && (plan.leaderOptions?.length ?? 0) > 0,
      stage: "options",
      clarify: null,
      persona,
      question: req.question ?? null,
      answer,
      area: plan.area ?? null,
      window: plan.window ?? window,
      today: plan.today ?? null,
      topicIds: plan.topicIds ?? topicIds,
      areaSurvey: plan.areaSurvey ?? [],
      staleContacts: plan.staleContacts ?? [],
      areaEvents: plan.areaEvents ?? [],
      categoryBreakdown: plan.categoryBreakdown ?? [],
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

/** Project a build_itinerary structuredContent into the compact itinerary the chat host renders. */
function extractItinerary(build: any): any | null {
  if (!build || isRejected(build)) return null;
  return {
    leader: build.leader,
    event: build.event,
    anchor: build.anchor,
    area: build.area,
    days: build.days,
    capacity: build.capacity,
    accepted: build.accepted,
    route: build.route,
    roi: build.roi,
    conflicts: build.conflicts,
    // Feature: surface other senior leaders at the same event/contact or nearby (from build_itinerary).
    nearbyLeaders: build.nearbyLeaders ?? [],
    // Audience mix of the committed stops (Congressional / Academia / Industry / Army-internal).
    categoryCoverage: build.categoryCoverage ?? null,
    extensionOptions: build.extensionOptions,
    notMatched: build.notMatched,
  };
}

function assembleBuild(base: PlanResult, captured: CapturedCall[]): PlanResult {
  const build = lastCapture(captured, "build_itinerary")?.result;
  const rejected = isRejected(build);
  const itinerary = extractItinerary(build);
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
export async function buildAreaItinerary(
  req: AreaBuildRequest,
): Promise<PlanResult> {
  const persona = req.persona || DEFAULT_PERSONA();
  const url = req.serverUrl || DEFAULT_URL();
  const window = req.window || defaultWindow();

  const base: PlanResult = {
    ok: false,
    mode: "deterministic",
    persona,
    question: req.leaderId
      ? `Build itinerary for ${req.leaderId}`
      : "Build itinerary",
    answer: null,
    toolCalls: [],
    menu: null,
    itinerary: null,
    tripMap: null,
    redactedCount: null,
    rejected: false,
  };

  if (!req.leaderId)
    return { ...base, error: "leaderId is required to build an itinerary." };

  const area = resolveAreaAnchor(req);

  let client: ToolClient;
  try {
    client = await makeToolClient(url, persona);
  } catch (e: any) {
    return {
      ...base,
      error:
        `Cannot reach the engagements MCP server at ${url}: ${e?.message || e}. ` +
        "Start it with `npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements`.",
    };
  }

  try {
    let acceptedContactIds = req.acceptedContactIds ?? [];
    let anchorEventId = req.anchorEventId;
    const topicIds = req.topicIds ?? [];

    // Fallback: derive the stop set (and anchor/topics) from a fresh plan_options for this leader.
    if (acceptedContactIds.length === 0 || !anchorEventId) {
      if (!area)
        return {
          ...base,
          error:
            "An area (regionId/region/city) is required to build the itinerary.",
        };
      await client.callTool("plan_options", {
        ...areaArgs(area, req.radiusMi),
        window,
        leaderId: req.leaderId,
        ...(topicIds.length ? { topicIds } : {}),
        requireTopicMatch: false,
      });
      const plan = lastCapture(client.captured, "plan_options")?.result ?? {};
      if (plan.rejected)
        return {
          ...assembleBuild(base, client.captured),
          rejected: true,
          answer: "Access rejected — no verified tenant claim.",
        };
      if (plan.error) return { ...base, error: plan.error };
      if (acceptedContactIds.length === 0) {
        acceptedContactIds = selectedContactIds(plan, {
          durationTier: req.durationTier,
          extensionContactIds: req.extensionContactIds,
        });
      }
      anchorEventId = anchorEventId ?? defaultAnchorEventId(plan);
    }

    if (acceptedContactIds.length === 0) {
      return {
        ...base,
        error:
          "No stops resolved for the itinerary — pick a duration tier or accept at least one contact.",
      };
    }

    await client.callTool("build_itinerary", {
      leaderId: req.leaderId,
      ...(anchorEventId
        ? { eventId: anchorEventId }
        : area?.city
          ? { eventQuery: area.city }
          : {}),
      acceptedContactIds,
      // NOTE: deliberately NO topicIds here. The area-first selection spans multiple topics; passing a
      // topic focus would make build_itinerary's index-level searchContacts({topicIds}) pre-filter to
      // that single topic and drop the cross-topic stops the human just picked. requireTopicMatch:false
      // keeps the anchor event's own topics from culling them either.
      requireTopicMatch: false,
    });

    const built = assembleBuild(base, client.captured);
    built.answer =
      lastCapture(client.captured, "build_itinerary")?.text ?? built.answer;
    return built;
  } finally {
    await client.close().catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════════════════
// STAGE 2 (options) — once the senior leader is chosen, present MULTIPLE fully-built itinerary
// options GROUPED BY ENGAGEMENT CATEGORY for the EA/planner to compare and proceed with. Each option
// is a SINGLE-audience trip (Congressional-only, Academia-only, …) — we never blend audiences on one
// itinerary, because which audience a leader would meet on a trip depends on their billet. The offered
// categories are the intersection of the SELECTED LEADER's `engagementCategories` and the audiences
// actually present in the area; each option packs that audience's authorized in-area meetings, so every
// option is a complete trip — route, trip-ROI, advisory conflicts, nearby senior leaders, its own ui://trip-map.
// ════════════════════════════════════════════════════════════════════════════

/** One selectable, fully-costed itinerary the EA can proceed with. */
export interface AreaItineraryOption {
  /** Stable id the UI/CLI selects by — the engagement category (e.g. "congressional" | "industry"). */
  id: string;
  /** Relative size bucket: 'short' | 'standard' | 'extended'. */
  tier: string;
  label: string;
  /** The single engagement audience this itinerary reaches (e.g. "industry"); null on the legacy length path. */
  category: EngagementCategory | null;
  /** One-line card summary (meetings · ROI · budget flag). */
  summary: string;
  days: number | null;
  stopCount: number;
  roiScore: any;
  overBudget: boolean;
  /** The best-value pick (highest in-budget ROI) — pre-selected in the UI. */
  recommended: boolean;
  contactIds: string[];
  ok: boolean;
  /** Fully-built itinerary (leader/route/roi/conflicts/nearbyLeaders). */
  itinerary: any | null;
  /** The ui://trip-map payload for this specific option. */
  tripMap: any | null;
  /** This option's engagement-audience mix, e.g. "Industry×2" (single-audience by construction). */
  categoryMix: string | null;
  /** Raw per-audience counts backing {@link categoryMix}. */
  categoryCounts: Record<string, number> | null;
  answer: string | null;
}

export interface AreaItineraryOptionsResult {
  ok: boolean;
  persona: string;
  question: string | null;
  leaderId: string | null;
  leaderName: string | null;
  area: any | null;
  window: { start: string; end: string } | null;
  today: string | null;
  topicIds: string[];
  /** The finished itineraries the EA chooses between — each a DIFFERENT engagement category (single-audience). */
  options: AreaItineraryOption[];
  /** Id of the recommended option (best in-budget ROI). */
  recommendedOptionId: string | null;
  /** Area-wide engagement footprint across the four audiences (from the probe build). */
  categoryBreakdown?: any[];
  redactedCount: number | null;
  rejected: boolean;
  /** The resolved anchor event, when the options are event-anchored (else null/absent). */
  event?: any | null;
  error?: string;
}

/**
 * Pure: pick the DISTINCT trip lengths (in days) to offer. `fullDays` = enough days to see every
 * authorized stop (`ceil(stops / meetingsPerDay)`, capped at `maxDays`); we then spread `count`
 * evenly-spaced, distinct day-lengths from a short visit up to that full tour. An explicit
 * `targetDays` list wins outright. Guarantees the options genuinely differ in length.
 */
export function itineraryLengthTargets(opts: {
  availableStops: number;
  meetingsPerDay?: number;
  count?: number;
  maxDays?: number;
  targetDays?: number[];
}): number[] {
  if (opts.targetDays?.length) {
    return [
      ...new Set(opts.targetDays.map((d) => Math.max(1, Math.round(d)))),
    ].sort((a, b) => a - b);
  }
  const perDay = Math.max(1, Math.round(opts.meetingsPerDay ?? 2));
  const maxDays = Math.max(1, Math.round(opts.maxDays ?? 7));
  const fullDays = Math.min(
    maxDays,
    Math.max(1, Math.ceil(Math.max(0, opts.availableStops) / perDay)),
  );
  const count = Math.max(1, Math.round(opts.count ?? 3));
  if (fullDays <= 1 || count === 1) return [fullDays];
  const lo = fullDays >= 4 ? 2 : 1;
  const out = new Set<number>();
  for (let i = 0; i < count; i++) {
    const d = Math.round(lo + ((fullDays - lo) * i) / (count - 1));
    out.add(Math.min(fullDays, Math.max(1, d)));
  }
  return [...out].sort((a, b) => a - b);
}

/** Name a length by its position in the offered spread (shortest → 'short', longest → 'extended'). */
function lengthSize(
  index: number,
  total: number,
): "short" | "standard" | "extended" {
  if (total <= 1) return "standard";
  if (index === 0) return "short";
  if (index === total - 1) return "extended";
  return "standard";
}

const roi2 = (n: unknown): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : String(n ?? "—");

/** One engagement category to build a single-audience itinerary for, plus the stops that back it. */
export interface CategoryTarget {
  category: EngagementCategory;
  label: string;
  /** EVERY authorized in-area contact id for this audience (drives the single-audience `acceptedContactIds`). */
  contactIds: string[];
}

/**
 * Pure: pick which engagement CATEGORIES to offer the chosen leader as single-audience itineraries.
 * We intersect the leader's `engagementCategories` (which audiences THIS billet would meet) with the
 * audiences actually present in the area (`breakdown` entries with contacts), returning them in report
 * order. When the leader has no authored categories, we fall back to EVERY audience present — so the
 * flow still yields category-grouped options. Guarantees single-audience, leader-appropriate options.
 */
export function leaderCategoryTargets(opts: {
  leaderCategories?: readonly string[] | null;
  breakdown: { category?: string; total?: number; contactIds?: string[] }[];
}): CategoryTarget[] {
  const present = new Map<string, string[]>();
  for (const b of opts.breakdown ?? []) {
    const ids = b.contactIds ?? [];
    if (b.category && ids.length > 0) present.set(b.category, ids);
  }
  const allow =
    opts.leaderCategories && opts.leaderCategories.length
      ? new Set(opts.leaderCategories)
      : null;
  const out: CategoryTarget[] = [];
  for (const cat of ENGAGEMENT_CATEGORY_ORDER) {
    if (allow && !allow.has(cat)) continue;
    const ids = present.get(cat);
    if (!ids) continue;
    out.push({ category: cat, label: CATEGORY_LABEL[cat], contactIds: ids });
  }
  return out;
}

/** One ranked "who should go" candidate for a chosen engagement category (category-first flow). */
export interface LeaderPick {
  leaderId: string;
  name?: string | null;
  role?: string | null;
  /** The capability's composite fit score (topic SME + proximity + availability + …). */
  score?: string | number | null;
  distanceMi?: number | null;
  availableInWindow?: boolean | null;
  /** One-line rationale ("SME fit 0.82 · 45 mi · free in window"). */
  why: string;
  /** The capability's algorithmic top pick for this audience. */
  recommended: boolean;
  /** Whether THIS plan was built for this leader (the human's pick, else the recommendation). */
  selected?: boolean;
}

/** Compose a leader option's one-line "why send them" rationale from its fit factors. Pure. */
function leaderWhy(o: any): string {
  const parts: string[] = [];
  const fit = o?.factors?.topicMatch ?? o?.score;
  if (fit != null && fit !== "") parts.push(`SME fit ${fit}`);
  if (typeof o?.distanceMi === "number") parts.push(`${o.distanceMi} mi`);
  parts.push(
    o?.availableInWindow === false ? "not free in window" : "free in window",
  );
  return parts.join(" · ");
}

/**
 * STAGE 1 (category-first) — turn the area's per-audience breakdown into the "which engagement category
 * should this trip focus on?" menu. Only audiences actually PRESENT in the area (with ≥1 engagement) are
 * offered — `other` is never offered. The recommended default is the audience with the highest strategic
 * weight (tie: most stale relationships to re-engage, then most engagements). Pure + deterministic.
 */
export function categoryClarifyQuestion(breakdown: any[]): OptionQuestion {
  const present = (breakdown ?? []).filter(
    (c) => (c?.total ?? 0) > 0 && c?.category && c.category !== "other",
  );
  const ranked = [...present].sort(
    (a, b) =>
      (b?.strategicValueSum ?? 0) - (a?.strategicValueSum ?? 0) ||
      (b?.staleCount ?? 0) - (a?.staleCount ?? 0) ||
      (b?.total ?? 0) - (a?.total ?? 0),
  );
  const rec = ranked[0]?.category ?? null;
  return {
    id: "category",
    kind: "single",
    prompt: "Which engagement category should this trip focus on?",
    choices: present.map((c) => ({
      value: c.category,
      label: c.label ?? c.category,
      detail: c.reason ?? `${c.total ?? 0} engagement(s)`,
      selected: c.category === rec,
      recommended: c.category === rec,
    })),
  };
}

/**
 * STAGE 2 (category-first) — pure: from the area's ranked leader options, pick WHO should go for the
 * CHOSEN engagement category. Keeps only leaders whose billet engages that audience (leaders.json
 * `engagementCategories`), best composite-fit first (recommended), the rest as alternates. When NO
 * leader in the roster engages the audience we fall back to the best-fit leader overall (`fellBack`),
 * so the flow always yields a "who should go" recommendation. The leader is the OUTPUT, not an input.
 */
export function bestLeadersForCategory(opts: {
  category: string;
  leaderOptions: any[];
  roster: { id: string; engagementCategories?: readonly string[] }[];
}): {
  recommended: LeaderPick | null;
  alternates: LeaderPick[];
  fellBack: boolean;
} {
  const engages = new Set(
    (opts.roster ?? [])
      .filter((l) =>
        (l.engagementCategories ?? []).includes(opts.category as any),
      )
      .map((l) => l.id),
  );
  const availOf = (x: any) => (x?.availableInWindow === false ? 0 : 1);
  const scoreOf = (x: any) =>
    Number.isFinite(Number(x?.score)) ? Number(x.score) : 0;
  const ranked = [...(opts.leaderOptions ?? [])].sort(
    (a, b) =>
      scoreOf(b) - scoreOf(a) ||
      availOf(b) - availOf(a) ||
      (a?.distanceMi ?? 1e9) - (b?.distanceMi ?? 1e9),
  );
  const matching = ranked.filter((o) => engages.has(o.leaderId));
  const fellBack = matching.length === 0;
  const chosen = matching.length ? matching : ranked;
  const picks: LeaderPick[] = chosen.map((o, i) => ({
    leaderId: o.leaderId,
    name: o.name ?? null,
    role: o.role ?? null,
    score: o.score ?? null,
    distanceMi: typeof o.distanceMi === "number" ? o.distanceMi : null,
    availableInWindow:
      typeof o.availableInWindow === "boolean" ? o.availableInWindow : null,
    why: leaderWhy(o),
    recommended: i === 0,
  }));
  return {
    recommended: picks[0] ?? null,
    alternates: picks.slice(1),
    fellBack,
  };
}

/**
 * Deterministically pull an engagement CATEGORY out of the question when the EA names one ("plan an
 * industry trip to Boston", "congressional visit"). Returns null when none is named — the signal to
 * SHOW the category menu and let the human pick. Conservative (won't guess from a bare area ask). Pure.
 */
export function categoryFromQuestion(
  question: string,
): EngagementCategory | null {
  const q = ` ${(question ?? "").toLowerCase()} `;
  if (
    /\b(congressional|congress|capitol|legislat\w*|hasc|sasc|appropriations)\b/.test(
      q,
    )
  )
    return "congressional";
  if (/\b(academ\w*|universit\w*|professor|research lab\w*|stem)\b/.test(q))
    return "academia";
  if (
    /\b(industry|industrial|commercial|vendors?|defense industr\w*|primes?)\b/.test(
      q,
    )
  )
    return "industry";
  if (
    /\b(army[- ]internal|internal army|garrison|installation|unit visit)\b/.test(
      q,
    )
  )
    return "army-internal";
  return null;
}

/**
 * STAGE 2 (options) — for the CHOSEN leader, build one complete itinerary per ENGAGEMENT CATEGORY the
 * leader engages (Congressional-only, Industry-only, …) so the EA compares finished SINGLE-AUDIENCE
 * trips and proceeds with one. We never blend audiences on a trip: which audience a leader would meet
 * depends on their billet, so the offered categories are the intersection of the leader's
 * `engagementCategories` and the audiences present in the area. Each option forces its audience via
 * `build_itinerary`'s `acceptedContactIds` (that category's in-area contacts), re-authorized server-side.
 */
export async function buildAreaItineraryOptions(
  req: AreaBuildRequest,
): Promise<AreaItineraryOptionsResult> {
  const persona = req.persona || DEFAULT_PERSONA();
  const url = req.serverUrl || DEFAULT_URL();
  const window = req.window || defaultWindow();

  const empty: AreaItineraryOptionsResult = {
    ok: false,
    persona,
    question: req.leaderId
      ? `Itinerary options for ${req.leaderId}`
      : "Itinerary options",
    leaderId: req.leaderId ?? null,
    leaderName: null,
    area: null,
    window,
    today: null,
    topicIds: [],
    options: [],
    recommendedOptionId: null,
    redactedCount: null,
    rejected: false,
  };

  if (!req.leaderId)
    return {
      ...empty,
      error: "leaderId is required to build itinerary options.",
    };
  const area = resolveAreaAnchor(req);
  if (!area)
    return {
      ...empty,
      error:
        "An area (regionId/region/city) is required to build itinerary options.",
    };

  let client: ToolClient;
  try {
    client = await makeToolClient(url, persona);
  } catch (e: any) {
    return {
      ...empty,
      error:
        `Cannot reach the engagements MCP server at ${url}: ${e?.message || e}. ` +
        "Start it with `npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements`.",
    };
  }

  try {
    const topicIds = req.topicIds ?? [];
    const anchorArgs = areaArgs(area, req.radiusMi);
    const maxDays = Math.max(1, Math.round(req.maxDays ?? 7));

    // A fixed-duration (radius) build_itinerary: fills `days × meetingsPerDay` best authorized stops
    // in the area — NO event anchor, so `days` fully controls the trip length. When `acceptedContactIds`
    // is passed it routes EXACTLY that set (re-authorized server-side) — the seam that forces a
    // single-audience itinerary. Auto-fills (capacity) when omitted (the probe). Persona trim always holds.
    const radiusBuild = (days: number, acceptedContactIds?: string[]) =>
      client.callTool("build_itinerary", {
        leaderId: req.leaderId,
        ...anchorArgs,
        days,
        ...(typeof req.meetingsPerDay === "number"
          ? { meetingsPerDay: req.meetingsPerDay }
          : {}),
        ...(acceptedContactIds?.length ? { acceptedContactIds } : {}),
        window,
        ...(topicIds.length ? { topicIds } : {}),
        requireTopicMatch: false,
      });

    // Probe the longest sensible trip to size the area's authorized stop pool (drives the spread).
    await radiusBuild(maxDays);
    const probeCap = lastCapture(client.captured, "build_itinerary");
    const probe = probeCap?.result ?? {};
    if (isRejected(probe))
      return {
        ...empty,
        rejected: true,
        error: "Access rejected — no verified tenant claim.",
      };
    if (probe.error) return { ...empty, error: probe.error };

    const base = {
      ...empty,
      area: probe.area ?? null,
      window: probe.window ?? window,
      today: probe.today ?? null,
      topicIds,
      leaderName: probe.leader?.name ?? null,
      redactedCount: probe.redactedCount ?? null,
      categoryBreakdown: probe.categoryBreakdown ?? [],
    };

    const availableStops = probe.accepted?.length ?? 0;
    if (availableStops === 0)
      return {
        ...base,
        error: `No authorized stops in ${probe.area?.name ?? "this area"} for ${req.leaderId}.`,
      };

    const perDay = probe.meetingsPerDay ?? req.meetingsPerDay ?? 2;

    // Which SINGLE-AUDIENCE itineraries to offer THIS leader: the audiences they engage
    // (leaders.json `engagementCategories`) ∩ the audiences actually present in the area (probe
    // breakdown). No leader categories authored → every audience present (still one trip per category).
    const leaderCats =
      loadLeaders().find((l) => l.id === req.leaderId)?.engagementCategories ??
      null;
    const targets = leaderCategoryTargets({
      leaderCategories: leaderCats,
      breakdown: base.categoryBreakdown,
    });
    if (targets.length === 0) {
      return {
        ...base,
        error:
          `No engagements in ${probe.area?.name ?? "this area"} match ${base.leaderName ?? req.leaderId}'s ` +
          `engagement categories (${leaderCats?.join(", ") ?? "any"}).`,
      };
    }

    const options: AreaItineraryOption[] = [];
    for (const t of targets) {
      // Force a single-audience trip: route EXACTLY this category's in-area contacts. `acceptedContactIds`
      // ignores capacity, so `days` only drives the ROI/budget math — size it to hold every in-audience
      // meeting (≈ ceil(stops / perDay)), capped at maxDays.
      const days = Math.min(
        maxDays,
        Math.max(1, Math.ceil(t.contactIds.length / perDay)),
      );
      await radiusBuild(days, t.contactIds);
      const cap = lastCapture(client.captured, "build_itinerary");
      const build = cap?.result ?? {};
      const itinerary = extractItinerary(build);
      const stops: any[] = build.accepted ?? [];
      if (stops.length === 0) continue; // this audience yielded no routable stop for the leader — skip it
      options.push({
        id: t.category,
        tier: t.category,
        label: `${t.label} engagements`,
        category: t.category,
        summary:
          `${stops.length} ${t.label} meeting(s) · ${build?.days ?? days} day(s) · ROI ${roi2(build?.roi?.roiScore)}` +
          (build?.roi?.overBudget ? " · OVER BUDGET" : ""),
        days: build?.days ?? days,
        stopCount: stops.length,
        roiScore: build?.roi?.roiScore ?? null,
        overBudget: !!build?.roi?.overBudget,
        recommended: false,
        contactIds: stops.map((s: any) => s.contactId),
        ok: itinerary != null,
        itinerary,
        tripMap: build?.tripMap ?? null,
        categoryMix: build?.categoryCoverage?.summary ?? null,
        categoryCounts: build?.categoryCoverage?.counts ?? null,
        answer: cap?.text ?? null,
      });
    }

    if (options.length === 0) {
      return {
        ...base,
        error: `No single-audience itinerary could be built in ${probe.area?.name ?? "this area"} for ${req.leaderId}.`,
      };
    }

    // Recommend the best-value AUDIENCE: highest ROI among in-budget options (fallback: highest ROI,
    // then the most meetings). Every option is a valid choice — this is just the pre-selected one.
    const pickable = options.filter((o) => o.ok);
    const ranked = [...pickable].sort(
      (a, b) =>
        Number(a.overBudget) - Number(b.overBudget) ||
        Number(b.roiScore) - Number(a.roiScore) ||
        b.stopCount - a.stopCount,
    );
    const recommendedOptionId = ranked[0]?.id ?? options[0]?.id ?? null;
    for (const o of options) o.recommended = o.id === recommendedOptionId;

    return { ...base, ok: pickable.length > 0, options, recommendedOptionId };
  } finally {
    await client.close().catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════════════════
// EVENT-anchored, DIFFERENT-LENGTH options — the `/ask` leader-first path.
//
// For an event ask ("a trip to AUSA"), the EA first commits to WHO (leader-clarify), then compares
// several finished itineraries of DIFFERENT lengths. Unlike the area/radius filler, an event trip must
// KEEP the on-site attendees (only includable in event mode), so we vary length by the DEPTH of an
// optional regional swing — extra authorized on-topic stops in OTHER metros, appended via
// build_itinerary's `additionalContactIds` (each re-authorized + scored server-side):
//   • Conference footprint — on-site + local nearby only (already-there batch, ~event span).
//   • + Regional swing     — footprint plus the best far metro(s) (one added flight → longer).
//   • + Full regional tour — footprint plus every far metro (a real regional sweep → longest).
// Every option is complete (route, ROI, conflicts, nearby senior leaders, its own ui://trip-map).
// ════════════════════════════════════════════════════════════════════════════

/** Cap on regional-swing stops so trips stay realistic and the map stays readable. */
const MAX_SWING_STOPS = 4;

export interface EventBuildRequest {
  persona?: string;
  /** Leader whose time is being allocated — required to build options. */
  leaderId: string;
  /** Anchor event by id (e.g. "E-AUSA") or free text ("AUSA"); or parsed from `question`. */
  eventId?: string;
  eventQuery?: string;
  question?: string;
  topicIds?: string[];
  /** Optional budget guard — drop options longer than this many days. */
  maxDays?: number;
  serverUrl?: string;
}

/** Blank event-options envelope. */
function emptyEventOptions(
  persona: string,
  leaderId: string | null,
): AreaItineraryOptionsResult {
  return {
    ok: false,
    persona,
    question: leaderId
      ? `Itinerary options for ${leaderId}`
      : "Itinerary options",
    leaderId: leaderId ?? null,
    leaderName: null,
    area: null,
    window: null,
    today: null,
    topicIds: [],
    options: [],
    recommendedOptionId: null,
    redactedCount: null,
    rejected: false,
    event: null,
  };
}

/**
 * Decide whether an ask is EVENT-anchored (vs. a radius/free-form trip) and resolve the anchor event.
 * Returns the top authorized event matching the question's anchor token, or null. A parseable radius
 * ask ("3 days within 60 mi of Reston") is deliberately NOT treated as an event anchor.
 */
async function resolveEventAnchor(
  client: ToolClient,
  question: string,
): Promise<any | null> {
  if (parseRadiusAsk(question)) return null;
  const query = anchorGuess(question);
  if (!query) return null;
  try {
    await client.callTool("search_events", { query });
  } catch {
    return null;
  }
  const res = lastCapture(client.captured, "search_events")?.result ?? {};
  if (res.rejected) return null;
  const events: any[] = res.events ?? [];
  const q = query.toLowerCase();
  return (
    events.find(
      (e) =>
        e.name?.toLowerCase().includes(q) || e.city?.toLowerCase().includes(q),
    ) ??
    events[0] ??
    null
  );
}

/**
 * Rank the senior-leader roster for an event so the EA can pick WHO to plan for. Uses `suggest_leaders`
 * anchored on the event's city + window (SME fit, proximity, availability); falls back to the local
 * roster (unranked) if the tool can't rank. Pure enough to shape into a leader-clarify question.
 */
async function rankRosterForEvent(
  client: ToolClient,
  event: any,
  topicIds: string[],
): Promise<any[]> {
  try {
    await client.callTool("suggest_leaders", {
      city: event.city,
      ...(event.state ? { state: event.state } : {}),
      window: { start: event.start, end: event.end },
      ...(topicIds.length ? { topicIds } : {}),
    });
    const leaders: any[] =
      lastCapture(client.captured, "suggest_leaders")?.result?.leaders ?? [];
    if (leaders.length) return leaders;
  } catch {
    /* fall through to the local roster */
  }
  return loadLeaders().map((l) => ({
    leaderId: l.id,
    name: l.name,
    role: l.role,
  }));
}

/**
 * Rank the senior-leader roster for an AREA (a resolved region/city) so the EA can pick WHO to plan
 * for. Uses the capability's `plan_options` tool (SME fit + proximity + availability in the planning
 * window) and returns its ranked `leaderOptions` plus the resolved area (for the clarify prompt).
 * Falls back to the local roster (unranked) if the tool can't rank. Drives the leader-clarify step of
 * the area-first `/ask` flow off the same reasoning the guided `/plan-options` menus use.
 */
async function rankRosterForArea(
  client: ToolClient,
  area: AreaInput,
  topicIds: string[],
): Promise<{
  leaders: any[];
  area: any | null;
  today: string | null;
  topicIds: string[];
  areaSurvey: any[];
  staleContacts: any[];
  areaEvents: any[];
  categoryBreakdown: any[];
  redactedCount: number | null;
}> {
  const roster = () =>
    loadLeaders().map((l) => ({ leaderId: l.id, name: l.name, role: l.role }));
  const emptyIntel = {
    today: null,
    topicIds,
    areaSurvey: [] as any[],
    staleContacts: [] as any[],
    areaEvents: [] as any[],
    categoryBreakdown: [] as any[],
    redactedCount: null,
  };
  try {
    await client.callTool("plan_options", {
      ...areaArgs(area),
      window: defaultWindow(),
      ...(topicIds.length ? { topicIds } : {}),
      requireTopicMatch: false,
    });
    const res = lastCapture(client.captured, "plan_options")?.result ?? {};
    const leaders: any[] = res.leaderOptions ?? [];
    return {
      leaders: leaders.length ? leaders : roster(),
      area: res.area ?? null,
      today: res.today ?? null,
      topicIds: res.topicIds ?? topicIds,
      areaSurvey: res.areaSurvey ?? [],
      staleContacts: res.staleContacts ?? [],
      areaEvents: res.areaEvents ?? [],
      categoryBreakdown: res.categoryBreakdown ?? [],
      redactedCount: res.redactedCount ?? null,
    };
  } catch {
    return { leaders: roster(), area: null, ...emptyIntel };
  }
}

/** Scope label for an event option by how many regional-swing stops it adds. */
function swingScope(farCount: number, farTotal: number): string {
  if (farCount === 0) return "Conference footprint";
  if (farCount >= farTotal && farTotal > 0) return "Full regional tour";
  return "Regional swing";
}

/**
 * Build the DIFFERENT-LENGTH, event-anchored options for a CHOSEN leader (given an open client). Keeps
 * the on-site/nearby "already-there" batch in every option and varies length by the depth of an
 * optional regional swing. Returns finished options (route/ROI/conflicts/nearbyLeaders/trip-map each).
 */
async function buildEventOptions(
  client: ToolClient,
  args: {
    leaderId: string;
    eventId?: string;
    eventQuery?: string;
    topicIds?: string[];
    persona?: string;
    maxDays?: number;
  },
): Promise<AreaItineraryOptionsResult> {
  const persona = args.persona || DEFAULT_PERSONA();
  const topicIds = args.topicIds ?? [];
  const empty = emptyEventOptions(persona, args.leaderId);

  // 1) The on-site + local nearby pool (the "you're already going there" batch) + the resolved event.
  await client.callTool("suggest_candidates", {
    leaderId: args.leaderId,
    ...(args.eventId ? { eventId: args.eventId } : {}),
    ...(args.eventQuery ? { eventQuery: args.eventQuery } : {}),
    ...(topicIds.length ? { topicIds } : {}),
  });
  const sug = lastCapture(client.captured, "suggest_candidates")?.result ?? {};
  if (sug.rejected)
    return {
      ...empty,
      rejected: true,
      error: "Access rejected — no verified tenant claim.",
    };
  if (!sug.event)
    return {
      ...empty,
      error: sug.reason ?? sug.error ?? "Could not resolve the anchor event.",
    };

  const event = sug.event;
  const leaderName = sug.leader?.name ?? null;
  const nearbyIds: string[] = (sug.candidates ?? []).map(
    (c: any) => c.contactId,
  );
  const base = {
    ...empty,
    event,
    leaderName,
    topicIds,
    today: sug.today ?? null,
    redactedCount: sug.redactedCount ?? null,
  };
  if (nearbyIds.length === 0) {
    return {
      ...base,
      error: `No authorized candidates for ${args.leaderId} at ${event.name}.`,
    };
  }

  // 2) Far, authorized, on-topic, ACTIVE stops beyond the nearby pool — the regional-swing sources,
  //    ranked by strategic value then staleness. Capped so trips stay realistic.
  await client.callTool("search_contacts", {
    ...(topicIds.length ? { topicIds } : {}),
  });
  const far: string[] = (
    (lastCapture(client.captured, "search_contacts")?.result
      ?.contacts as any[]) ?? []
  )
    .filter((c) => c.status === "active" && !nearbyIds.includes(c.id))
    .sort(
      (a, b) =>
        (b.strategicValue ?? 0) - (a.strategicValue ?? 0) ||
        String(a.lastInteractionDate ?? "").localeCompare(
          String(b.lastInteractionDate ?? ""),
        ),
    )
    .map((c) => c.id)
    .slice(0, MAX_SWING_STOPS);

  // 3) Scope tiers = cumulative regional-swing depth: footprint (0) → mid → full tour (all far).
  const farCounts = [...new Set([0, Math.ceil(far.length / 2), far.length])]
    .filter((n) => n <= far.length)
    .sort((a, b) => a - b);
  const maxDays =
    typeof args.maxDays === "number"
      ? Math.max(1, Math.round(args.maxDays))
      : undefined;

  const options: AreaItineraryOption[] = [];
  for (const count of farCounts) {
    await client.callTool("build_itinerary", {
      leaderId: args.leaderId,
      eventId: event.id,
      acceptedContactIds: nearbyIds,
      ...(count > 0 ? { additionalContactIds: far.slice(0, count) } : {}),
      ...(topicIds.length ? { topicIds } : {}),
      requireTopicMatch: false,
    });
    const cap = lastCapture(client.captured, "build_itinerary");
    const build = cap?.result ?? {};
    if (isRejected(build))
      return {
        ...base,
        rejected: true,
        error: "Access rejected — no verified tenant claim.",
      };
    const itinerary = extractItinerary(build);
    const days = build?.duration?.days ?? null;
    if (maxDays != null && typeof days === "number" && days > maxDays) continue;
    const stops: any[] = build.accepted ?? [];
    const scope = swingScope(count, far.length);
    const opt: AreaItineraryOption = {
      id: typeof days === "number" ? `${days}d` : `opt${options.length + 1}`,
      tier: "standard",
      label: typeof days === "number" ? `${days}-day trip — ${scope}` : scope,
      category: null,
      summary:
        `${scope} · ${stops.length} meeting(s) · ROI ${roi2(build?.roi?.roiScore)}` +
        (build?.roi?.overBudget ? " · OVER BUDGET" : ""),
      days,
      stopCount: stops.length,
      roiScore: build?.roi?.roiScore ?? null,
      overBudget: !!build?.roi?.overBudget,
      recommended: false,
      contactIds: stops.map((s: any) => s.contactId),
      ok: itinerary != null,
      itinerary,
      tripMap: build?.tripMap ?? null,
      categoryMix: build?.categoryCoverage?.summary ?? null,
      categoryCounts: build?.categoryCoverage?.counts ?? null,
      answer: cap?.text ?? null,
    };
    // Keep options strictly DIFFERENT in length: if a deeper swing didn't add a day, keep the richer one.
    const prev = options[options.length - 1];
    if (prev && prev.days === opt.days) {
      if (opt.stopCount > prev.stopCount) options[options.length - 1] = opt;
      continue;
    }
    options.push(opt);
  }

  for (let i = 0; i < options.length; i++)
    options[i].tier = lengthSize(i, options.length);

  // Recommend the best-value trip: highest ROI among in-budget options (fallback: highest ROI, shorter).
  const pickable = options.filter((o) => o.ok);
  const ranked = [...pickable].sort(
    (a, b) =>
      Number(a.overBudget) - Number(b.overBudget) ||
      Number(b.roiScore) - Number(a.roiScore) ||
      (a.days ?? 0) - (b.days ?? 0),
  );
  const recommendedOptionId = ranked[0]?.id ?? options[0]?.id ?? null;
  for (const o of options) o.recommended = o.id === recommendedOptionId;

  return { ...base, ok: pickable.length > 0, options, recommendedOptionId };
}

/**
 * Public entry: build the DIFFERENT-LENGTH, event-anchored options for a chosen leader (opens its own
 * client). Used by the CLI/tests; the `/ask` path calls the internal builder with a shared client.
 */
export async function buildEventItineraryOptions(
  req: EventBuildRequest,
): Promise<AreaItineraryOptionsResult> {
  const persona = req.persona || DEFAULT_PERSONA();
  const url = req.serverUrl || DEFAULT_URL();
  const empty = emptyEventOptions(persona, req.leaderId ?? null);
  if (!req.leaderId)
    return {
      ...empty,
      error: "leaderId is required to build itinerary options.",
    };

  let client: ToolClient;
  try {
    client = await makeToolClient(url, persona);
  } catch (e: any) {
    return {
      ...empty,
      error:
        `Cannot reach the engagements MCP server at ${url}: ${e?.message || e}. ` +
        "Start it with `npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements`.",
    };
  }

  try {
    const eventQuery =
      req.eventQuery ?? (req.question ? anchorGuess(req.question) : undefined);
    const topicIds = req.topicIds?.length
      ? req.topicIds
      : req.question
        ? topicIdsFromText(req.question)
        : [];
    if (!req.eventId && !eventQuery)
      return {
        ...empty,
        error: "An event (eventId/eventQuery/question) is required.",
      };
    return await buildEventOptions(client, {
      leaderId: req.leaderId,
      eventId: req.eventId,
      eventQuery,
      topicIds,
      persona,
      maxDays: req.maxDays,
    });
  } finally {
    await client.close().catch(() => {});
  }
}

/** Fold an event-options result into the `/ask` PlanResult envelope (recommended option = the primary). */
export function optionsToPlanResult(
  base: PlanResult,
  opts: AreaItineraryOptionsResult,
  event: any | null,
): PlanResult {
  const rec =
    opts.options.find((o) => o.id === opts.recommendedOptionId) ??
    opts.options[0] ??
    null;
  const where = event
    ? `${event.name} (${event.city})`
    : (opts.area?.name ?? "the area");
  // Area options are SINGLE-AUDIENCE (grouped by engagement category); event options vary by length.
  const byCategory =
    opts.options.length > 0 && opts.options.every((o) => o.category);
  const lede = byCategory
    ? `${opts.leaderName ?? opts.leaderId} @ ${where} — ${opts.options.length} itinerary option(s), one per engagement category ` +
      `${opts.leaderName ?? opts.leaderId} engages (each a single-audience trip; pick the audience for this visit):`
    : `${opts.leaderName ?? opts.leaderId} @ ${where} — ${opts.options.length} itinerary option(s) of different lengths:`;
  const answer = opts.ok
    ? `${lede}\n` +
      opts.options
        .map(
          (o) =>
            `  • ${o.label}: ${o.summary}${o.recommended ? "  ← recommended" : ""}`,
        )
        .join("\n")
    : (opts.error ?? "No itinerary options could be built.");
  return {
    ...base,
    ok: opts.ok,
    mode: "deterministic",
    stage: "options",
    clarify: null,
    answer,
    leaderId: opts.leaderId,
    leaderName: opts.leaderName,
    event: opts.event ?? event,
    options: opts.options,
    recommendedOptionId: opts.recommendedOptionId,
    itinerary: rec?.itinerary ?? null,
    tripMap: rec?.tripMap ?? null,
    menu: rec?.itinerary?.accepted ?? null,
    categoryBreakdown:
      opts.categoryBreakdown ?? (base as any).categoryBreakdown ?? [],
    redactedCount: opts.redactedCount,
    rejected: opts.rejected,
    error: opts.error,
  };
}

/** The finished single-audience CATEGORY plan (category-first flow): one itinerary + the "who should go" shortlist. */
interface CategoryPlanResult {
  ok: boolean;
  category: EngagementCategory;
  categoryLabel: string;
  area: any | null;
  today: string | null;
  window: { start: string; end: string };
  /** The leader the itinerary was built for (the recommended one). */
  leaderId: string | null;
  leaderName: string | null;
  /** Ranked "who should go" — recommended first, then alternates. */
  leaderShortlist: LeaderPick[];
  /** True when no roster leader is authored for this audience (best-overall fit was used). */
  fellBack: boolean;
  days: number | null;
  stopCount: number;
  roiScore: number | null;
  overBudget: boolean;
  itinerary: any | null;
  tripMap: any | null;
  contactIds: string[];
  categoryBreakdown: any[];
  redactedCount: number | null;
  rejected: boolean;
  error?: string;
}

/**
 * STAGE 2 (category-first) — build ONE single-audience itinerary for the chosen engagement category and
 * recommend WHO should go. Reuses the open client + the intel already gathered by {@link rankRosterForArea}
 * (ranked `leaderOptions` + the per-audience `categoryBreakdown`): route EXACTLY the chosen audience's
 * in-area contacts (`acceptedContactIds`, re-authorized server-side → never blends audiences), then rank
 * the best senior leader for that audience. The itinerary is the star; the leader is the OUTPUT.
 */
async function buildCategoryPlan(
  client: ToolClient,
  args: {
    area: AreaInput;
    category: EngagementCategory;
    /** The human's explicit "who should go" override (they clicked an alternate); else the recommendation is used. */
    leaderId?: string;
    leaderOptions: any[];
    categoryBreakdown: any[];
    areaResolved: any | null;
    today: string | null;
    redactedCount: number | null;
    topicIds: string[];
    radiusMi?: number;
    days?: number;
    maxDays?: number;
    meetingsPerDay?: number;
    window?: { start: string; end: string };
  },
): Promise<CategoryPlanResult> {
  const window = args.window || defaultWindow();
  const label = CATEGORY_LABEL[args.category];
  const target = (args.categoryBreakdown ?? []).find(
    (c) => c?.category === args.category,
  );
  const contactIds: string[] = target?.contactIds ?? [];
  const roster = loadLeaders();
  const { recommended, alternates, fellBack } = bestLeadersForCategory({
    category: args.category,
    leaderOptions: args.leaderOptions,
    roster,
  });
  // The ranked "who should go" shortlist. The human may OVERRIDE the top pick by selecting any leader in
  // it (e.g. real-world availability the model can't see); we mark that leader `selected` and plan for
  // them. `recommended` stays on the algorithmic best so the UI can still show "★ recommended".
  const ranked = recommended ? [recommended, ...alternates] : [];
  const pickedId =
    args.leaderId && ranked.some((l) => l.leaderId === args.leaderId)
      ? args.leaderId
      : (recommended?.leaderId ?? null);
  const shortlist = ranked.map((l) => ({
    ...l,
    selected: l.leaderId === pickedId,
  }));
  const chosen = shortlist.find((l) => l.selected) ?? null;
  const base: CategoryPlanResult = {
    ok: false,
    category: args.category,
    categoryLabel: label,
    area: args.areaResolved,
    today: args.today,
    window,
    leaderId: chosen?.leaderId ?? recommended?.leaderId ?? null,
    leaderName: chosen?.name ?? recommended?.name ?? null,
    leaderShortlist: shortlist,
    fellBack,
    days: null,
    stopCount: 0,
    roiScore: null,
    overBudget: false,
    itinerary: null,
    tripMap: null,
    contactIds,
    categoryBreakdown: args.categoryBreakdown ?? [],
    redactedCount: args.redactedCount,
    rejected: false,
  };
  if (contactIds.length === 0) {
    return {
      ...base,
      error: `No ${label} engagements in ${args.areaResolved?.name ?? "this area"} to build a trip around.`,
    };
  }

  // The itinerary is single-audience regardless of leader (we force this audience's contacts), so any
  // authorized leader routes the same stops; the leader only re-tunes ROI/availability (the "who should
  // go" layer). We build for the SELECTED leader (the human's pick, else the recommendation).
  const leaderId =
    chosen?.leaderId ??
    args.leaderOptions[0]?.leaderId ??
    resolveDefaultLeaderId();
  const perDay = args.meetingsPerDay ?? 2;
  const maxDays = Math.max(1, Math.round(args.maxDays ?? 7));
  const days =
    args.days != null
      ? Math.max(1, Math.round(args.days))
      : Math.min(maxDays, Math.max(1, Math.ceil(contactIds.length / perDay)));

  await client.callTool("build_itinerary", {
    leaderId,
    ...areaArgs(args.area, args.radiusMi),
    days,
    ...(typeof args.meetingsPerDay === "number"
      ? { meetingsPerDay: args.meetingsPerDay }
      : {}),
    acceptedContactIds: contactIds,
    window,
    ...(args.topicIds.length ? { topicIds: args.topicIds } : {}),
    requireTopicMatch: false,
  });
  const cap = lastCapture(client.captured, "build_itinerary");
  const build = cap?.result ?? {};
  if (isRejected(build))
    return {
      ...base,
      rejected: true,
      error: "Access rejected — no verified tenant claim.",
    };
  if (build.error) return { ...base, error: build.error };
  const itinerary = extractItinerary(build);
  const stops: any[] = build.accepted ?? [];

  return {
    ...base,
    ok: itinerary != null && stops.length > 0,
    leaderId,
    leaderName: build?.leader?.name ?? chosen?.name ?? null,
    area: build?.area ?? args.areaResolved,
    today: build?.today ?? args.today,
    days: build?.days ?? days,
    stopCount: stops.length,
    roiScore: build?.roi?.roiScore ?? null,
    overBudget: !!build?.roi?.overBudget,
    itinerary,
    tripMap: build?.tripMap ?? null,
    contactIds: stops.map((s: any) => s.contactId),
    redactedCount: build?.redactedCount ?? args.redactedCount,
  };
}

/** Fold a single-audience category plan into the `/ask` PlanResult envelope (stage 'plan'; leader = the human's selection, defaulting to the recommendation). */
export function categoryPlanToResult(
  base: PlanResult,
  plan: CategoryPlanResult,
): PlanResult {
  const where = plan.area?.name ?? "this area";
  const rec = plan.leaderShortlist.find((l) => l.recommended) ?? null;
  const sel = plan.leaderShortlist.find((l) => l.selected) ?? rec;
  const overridden = !!sel && !!rec && sel.leaderId !== rec.leaderId;
  const alts = plan.leaderShortlist.filter((l) => l.leaderId !== sel?.leaderId);
  let answer: string;
  if (!plan.ok) {
    answer =
      plan.error ??
      `No ${plan.categoryLabel} itinerary could be built for ${where}.`;
  } else {
    const lede =
      `${plan.categoryLabel}-focused trip around ${where}: ${plan.stopCount} meeting(s) over ${plan.days} day(s) · ` +
      `ROI ${roi2(plan.roiScore)}${plan.overBudget ? " · OVER BUDGET" : ""}.`;
    const who = sel
      ? `\n${overridden ? "Planning for" : "Best senior leader to send:"} ${sel.leaderId}${sel.name ? ` — ${sel.name}` : ""}` +
        `${sel.role ? ` (${sel.role})` : ""} · ${sel.why}.` +
        (overridden && rec
          ? ` (Your pick; recommended was ${rec.leaderId}${rec.name ? ` — ${rec.name}` : ""}.)`
          : "") +
        (!overridden && plan.fellBack
          ? " (No roster leader is authored for this audience — best overall fit shown.)"
          : "")
      : "";
    const others = alts.length
      ? `\nAlternates (pick one to re-plan for them): ${alts.map((a) => `${a.leaderId}${a.name ? ` (${a.name})` : ""}`).join(", ")}.`
      : "";
    answer = lede + who + others;
  }
  return {
    ...base,
    ok: plan.ok,
    mode: "deterministic",
    stage: "plan",
    clarify: null,
    category: plan.category,
    answer,
    leaderId: plan.leaderId,
    leaderName: plan.leaderName,
    leaderShortlist: plan.leaderShortlist,
    itinerary: plan.itinerary,
    tripMap: plan.tripMap,
    menu: plan.itinerary?.accepted ?? null,
    area: plan.area,
    today: plan.today,
    categoryBreakdown: plan.categoryBreakdown,
    redactedCount: plan.redactedCount,
    rejected: plan.rejected,
    error: plan.error,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Fixed-radius, event-OPTIONAL planning — "a leader must visit a SPECIFIC company (or place) for N
// days". Mirrors the area-first two-stage seam (options → build) but the DURATION is fixed up front,
// so instead of duration tiers the plan fills the days and offers extension options. Same trim beat.
// ════════════════════════════════════════════════════════════════════════════

export interface RadiusOptionsRequest {
  question?: string;
  persona?: string;
  /** Anchor: a must-meet company (id or name), a raw coordinate, or a city/region. */
  anchorContactId?: string;
  company?: string;
  lat?: number;
  lng?: number;
  city?: string;
  state?: string;
  region?: string;
  regionId?: string;
  radiusMi?: number;
  /** FIXED trip length (days on the ground). */
  days: number;
  meetingsPerDay?: number;
  window?: { start: string; end: string };
  leaderId?: string;
  topicIds?: string[];
  requireTopicMatch?: boolean;
  serverUrl?: string;
}

export interface RadiusOptionsResult {
  ok: boolean;
  persona: string;
  question: string | null;
  answer: string | null;
  anchor: any | null;
  area: any | null;
  window: { start: string; end: string } | null;
  today: string | null;
  days: number | null;
  meetingsPerDay: number | null;
  capacity: number | null;
  topicIds: string[];
  areaSurvey: any[];
  leaderOptions: any[];
  chosenLeaderId: string | null;
  stops: any[];
  route: any | null;
  roi: any | null;
  conflicts: any[];
  categoryBreakdown: any[];
  extensionOptions: any[];
  redactedCount: number | null;
  rejected: boolean;
  questions: OptionQuestion[];
  error?: string;
}

export interface RadiusBuildRequest {
  persona?: string;
  anchorContactId?: string;
  company?: string;
  lat?: number;
  lng?: number;
  city?: string;
  state?: string;
  region?: string;
  regionId?: string;
  radiusMi?: number;
  days: number;
  meetingsPerDay?: number;
  window?: { start: string; end: string };
  /** Chosen leader (from the leader option menu). */
  leaderId: string;
  /** Explicit final stop set; when omitted, the fixed-days auto-fill is accepted. */
  acceptedContactIds?: string[];
  /** Extension stops the human toggled on (merged into the accepted set). */
  extensionContactIds?: string[];
  topicIds?: string[];
  serverUrl?: string;
}

/** Only forward the anchor keys the caller actually set (avoids sending `undefined` over JSON-RPC). */
function radiusAnchorArgs(req: {
  anchorContactId?: string;
  company?: string;
  lat?: number;
  lng?: number;
  city?: string;
  state?: string;
  region?: string;
  regionId?: string;
  radiusMi?: number;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (req.anchorContactId) out.anchorContactId = req.anchorContactId;
  if (req.company) out.company = req.company;
  if (typeof req.lat === "number") out.lat = req.lat;
  if (typeof req.lng === "number") out.lng = req.lng;
  if (req.city) out.city = req.city;
  if (req.state) out.state = req.state;
  if (req.region) out.region = req.region;
  if (req.regionId) out.regionId = req.regionId;
  if (typeof req.radiusMi === "number") out.radiusMi = req.radiusMi;
  return out;
}

/** Shape a `plan_radius` result into who-should-go + optional trip-extension menus. Pure. */
export function buildRadiusQuestions(plan: any): OptionQuestion[] {
  const questions: OptionQuestion[] = [];

  const leaders: any[] = plan?.leaderOptions ?? [];
  if (leaders.length) {
    questions.push({
      id: "leader",
      kind: "single",
      prompt: "Who should go?",
      choices: leaderChoices(leaders, plan.chosenLeaderId),
    });
  }

  const extensions: any[] = plan?.extensionOptions ?? [];
  if (extensions.length) {
    questions.push({
      id: "extensions",
      kind: "multi",
      prompt:
        "Extend the trip? Each extra day unlocks another meeting (optional).",
      choices: extensions.map((e) => ({
        value: e.contactId,
        label:
          `+${e.extraDays}d → ${e.name}` + (e.sector ? ` (${e.sector})` : ""),
        detail:
          `${e.topicName ?? e.topicId ?? "topic —"} · mROI ${e.marginalRoi}` +
          (e.overBudget ? " · over budget" : "") +
          ` · ${e.talkingPointsSource === "approved-message" ? "approved talking points" : "coordinate points"}` +
          (e.categoryLabel ? ` · ${e.categoryLabel}` : ""),
        selected: false,
      })),
    });
  }

  return questions;
}

/**
 * STAGE 1 (radius) — anchor on a company/coordinate/city + a fixed day count and return the filled
 * trip plus the who/extend menus. Fail-closed on NO_TENANT (empty menus).
 */
export async function planRadiusOptions(
  req: RadiusOptionsRequest,
): Promise<RadiusOptionsResult> {
  const persona = req.persona || DEFAULT_PERSONA();
  const url = req.serverUrl || DEFAULT_URL();
  const window = req.window || defaultWindow();

  const empty: RadiusOptionsResult = {
    ok: false,
    persona,
    question: req.question ?? null,
    answer: null,
    anchor: null,
    area: null,
    window,
    today: null,
    days: req.days ?? null,
    meetingsPerDay: null,
    capacity: null,
    topicIds: [],
    areaSurvey: [],
    leaderOptions: [],
    chosenLeaderId: null,
    stops: [],
    route: null,
    roi: null,
    conflicts: [],
    categoryBreakdown: [],
    extensionOptions: [],
    redactedCount: null,
    rejected: false,
    questions: [],
  };

  let client: ToolClient;
  try {
    client = await makeToolClient(url, persona);
  } catch (e: any) {
    return {
      ...empty,
      error:
        `Cannot reach the engagements MCP server at ${url}: ${e?.message || e}. ` +
        "Start it with `npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements`.",
    };
  }

  try {
    await client.callTool("plan_radius", {
      ...radiusAnchorArgs(req),
      days: req.days,
      ...(typeof req.meetingsPerDay === "number"
        ? { meetingsPerDay: req.meetingsPerDay }
        : {}),
      window,
      ...(req.leaderId ? { leaderId: req.leaderId } : {}),
      ...(req.topicIds?.length ? { topicIds: req.topicIds } : {}),
      requireTopicMatch: req.requireTopicMatch ?? false,
    });

    const cap0 = lastCapture(client.captured, "plan_radius");
    const plan = cap0?.result ?? {};
    if (plan.error) return { ...empty, error: plan.error };

    const rejected = !!plan.rejected;
    return {
      ok: !rejected && (plan.stops?.length ?? 0) > 0,
      persona,
      question: req.question ?? null,
      answer: cap0?.text ?? null,
      anchor: plan.anchor ?? null,
      area: plan.area ?? null,
      window: plan.window ?? window,
      today: plan.today ?? null,
      days: plan.days ?? req.days,
      meetingsPerDay: plan.meetingsPerDay ?? null,
      capacity: plan.capacity ?? null,
      topicIds: plan.topicIds ?? [],
      areaSurvey: plan.areaSurvey ?? [],
      leaderOptions: plan.leaderOptions ?? [],
      chosenLeaderId: plan.chosenLeaderId ?? null,
      stops: plan.stops ?? [],
      route: plan.route ?? null,
      roi: plan.roi ?? null,
      conflicts: plan.conflicts ?? [],
      categoryBreakdown: plan.categoryBreakdown ?? [],
      extensionOptions: plan.extensionOptions ?? [],
      redactedCount: plan.redactedCount ?? null,
      rejected,
      questions: rejected ? [] : buildRadiusQuestions(plan),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * STAGE 2 (radius) — turn the human's picks (leader + toggled extensions) into the final event-less
 * itinerary + ui://trip-map. `build_itinerary` re-authorizes every id server-side, so the trim holds.
 */
export async function buildRadiusItinerary(
  req: RadiusBuildRequest,
): Promise<PlanResult> {
  const persona = req.persona || DEFAULT_PERSONA();
  const url = req.serverUrl || DEFAULT_URL();
  const window = req.window || defaultWindow();

  const base: PlanResult = {
    ok: false,
    mode: "deterministic",
    persona,
    question: req.leaderId
      ? `Build radius itinerary for ${req.leaderId}`
      : "Build radius itinerary",
    answer: null,
    toolCalls: [],
    menu: null,
    itinerary: null,
    tripMap: null,
    redactedCount: null,
    rejected: false,
  };

  if (!req.leaderId)
    return { ...base, error: "leaderId is required to build an itinerary." };
  if (!req.days)
    return {
      ...base,
      error: "days is required to build a fixed-radius itinerary.",
    };

  let client: ToolClient;
  try {
    client = await makeToolClient(url, persona);
  } catch (e: any) {
    return {
      ...base,
      error:
        `Cannot reach the engagements MCP server at ${url}: ${e?.message || e}. ` +
        "Start it with `npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements`.",
    };
  }

  try {
    const accepted = [
      ...new Set([
        ...(req.acceptedContactIds ?? []),
        ...(req.extensionContactIds ?? []),
      ]),
    ];
    await client.callTool("build_itinerary", {
      leaderId: req.leaderId,
      ...radiusAnchorArgs(req),
      days: req.days,
      ...(typeof req.meetingsPerDay === "number"
        ? { meetingsPerDay: req.meetingsPerDay }
        : {}),
      window,
      ...(accepted.length ? { acceptedContactIds: accepted } : {}),
      ...(req.topicIds?.length ? { topicIds: req.topicIds } : {}),
      requireTopicMatch: false,
    });

    const built = assembleBuild(base, client.captured);
    built.answer =
      lastCapture(client.captured, "build_itinerary")?.text ?? built.answer;
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
    const activeCount = tc.filter((c) => c.status === "active").length;
    const prospectCount = tc.filter((c) => c.status === "prospect").length;
    const te = events.filter((e) => e.topicIds?.includes(t.id));
    const eventCount = te.length;
    const upcomingEventCount = te.filter(
      (e) => (e.start ?? "") >= today,
    ).length;
    const hasApprovedMessage = !!t.approvedMessageId;

    const score =
      activeCount * 1 +
      upcomingEventCount * 1.5 +
      eventCount * 0.5 +
      prospectCount * 0.3 +
      (hasApprovedMessage ? 0.5 : 0);
    const reason = [
      activeCount ? `${activeCount} active` : null,
      prospectCount ? `${prospectCount} prospect` : null,
      upcomingEventCount
        ? `${upcomingEventCount} upcoming event${upcomingEventCount > 1 ? "s" : ""}`
        : eventCount
          ? `${eventCount} event${eventCount > 1 ? "s" : ""}`
          : null,
      hasApprovedMessage ? "approved message" : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      topicId: t.id,
      name: t.name,
      activeCount,
      prospectCount,
      eventCount,
      upcomingEventCount,
      hasApprovedMessage,
      score: score.toFixed(2),
      reason: reason || "no live footprint",
      question: hotTopicQuestion(t.name),
    };
  });

  // "Hot" requires a real footprint (contacts/events). An approved message alone is readiness,
  // not activity, so it only boosts ordering among topics that already have a footprint.
  return ranked
    .filter((t) => t.activeCount + t.prospectCount + t.eventCount > 0)
    .sort(
      (a, b) =>
        Number(b.score) - Number(a.score) || a.name.localeCompare(b.name),
    );
}

/**
 * Rank the seed topics by the caller's authorized footprint. Two cheap, already-trimmed tool
 * calls (search_contacts + search_events with no filter) feed the pure ranker above.
 */
export async function hotTopics(
  req: HotTopicsRequest,
): Promise<HotTopicsResult> {
  const persona = req.persona || DEFAULT_PERSONA();
  const url = req.serverUrl || DEFAULT_URL();
  const base: HotTopicsResult = {
    ok: false,
    persona,
    rejected: false,
    topics: [],
    redactedCount: null,
  };

  let client: ToolClient;
  try {
    client = await makeToolClient(url, persona);
  } catch (e: any) {
    return {
      ...base,
      error:
        `Cannot reach the engagements MCP server at ${url}: ${e?.message || e}. ` +
        "Start it with `npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements`.",
    };
  }

  try {
    const contactsRes: any = await client.callTool("search_contacts", {});
    if (contactsRes?.rejected) {
      return {
        ...base,
        ok: true,
        rejected: true,
        redactedCount: contactsRes.redactedCount ?? null,
      };
    }
    const eventsRes: any = await client.callTool("search_events", {});
    const topics = rankHotTopics(
      contactsRes?.contacts ?? [],
      eventsRes?.events ?? [],
      loadTopics(),
      demoToday(),
    );
    return {
      ...base,
      ok: true,
      topics,
      redactedCount: contactsRes?.redactedCount ?? null,
    };
  } catch (e: any) {
    return { ...base, error: e?.message || String(e) };
  } finally {
    await client.close().catch(() => {});
  }
}
