/**
 * The orchestrator — the "chat brain" (MVP-PLAN M5).
 *
 * Turns a natural-language trip question into an engagement plan by composing the engagements
 * capability's MCP tools. Primary path is Microsoft Agent Framework running in the governed
 * Python service; when the model is not configured/reachable it falls back to a deterministic
 * router so the demo always works offline. Either way it returns the ranked option menu, the
 * itinerary, and the `ui://trip-map` payload for the chat host to render.
 */
import {
  makeToolClient,
  DISCOVERY_URL,
  GROUNDING_TOOL_NAME,
  GroundingOnlyCapabilityError,
  type CapturedCall,
  type ToolClient,
} from "./tools.js";
import {
  discoverGovernedTools,
  isGovernanceDenial,
  isModelConfigured,
  runPythonAgent,
  type DiscoveredCapability,
  type PythonAgentDecision,
  type PythonDocumentTripPlan,
  type PythonAgentResult,
} from "./python-runtime.js";
import {
  type AreaInput,
  type EngagementCategory,
  type Topic,
  CATEGORY_LABEL,
  ENGAGEMENT_CATEGORY_ORDER,
  defaultWindow,
  demoToday,
  isSeedCatalog,
  loadLeaders,
  loadTopics,
  regionChoices,
  resolveAreaInput,
  resolveDefaultLeaderId,
  rosterForPrompt,
  topicIdsFromText,
  topicsForPrompt,
} from "./catalog.js";

function throwIfGovernanceDenied(error: unknown): void {
  if (isGovernanceDenial(error)) {
    throw error;
  }
}

export interface PlanRequest {
  question: string;
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
  /** Prior event plan supplied by the chat host for grounded conversational follow-ups. */
  context?: EventPlanContext;
  /** Recent transcript used only to resolve conversational references. */
  history?: ConversationHistoryMessage[];
  /** Engagements MCP endpoint; defaults to ENGAGEMENTS_MCP_URL or http://localhost:3010/mcp. */
  serverUrl?: string;
}

export interface ConversationHistoryMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * Minimal prior-plan state carried by the stateless HTTP chat host. Every id is re-authorized through
 * the capability before use; the gateway never treats this client-supplied context as trusted data.
 */
export interface EventPlanContext {
  version: 1;
  kind: "event";
  leaderId: string;
  eventId: string;
  contactIds: string[];
  topicIds?: string[];
  /** Optional host-managed placement of authorized contact ids onto 1-based itinerary days. */
  dayAssignments?: Record<string, number>;
}

export interface DocumentPlanCitation {
  id: string;
  title: string | null;
  url: string | null;
  parentId: string | null;
}

export interface DocumentTripPlan extends PythonDocumentTripPlan {
  citations: DocumentPlanCitation[];
}

/**
 * When a turn is `mode: 'deterministic'`, WHY the LLM tool-calling loop wasn't used — surfaced in the
 * UI so the demo explains itself:
 *   - 'area-anchored'        the ask named a known REGION → deterministic area/category-first planner (LLM-free by design)
 *   - 'event-anchored'       the ask named a known EVENT → deterministic leader-first planner (LLM-free by design)
 *   - 'contextual-follow-up' the ask elaborates a prior grounded plan → deterministic formatter
 *   - 'topic-landscape'      the ask requests a topic footprint → deterministic governed lookup
 *   - 'mcp-unavailable'      the capability server could not be reached → no planner/model turn was possible
 *   - 'model-not-configured' Azure OpenAI is not configured → deterministic fallback
 *   - 'model-unavailable'    Azure OpenAI is configured but the call failed/returned null → deterministic fallback
 *   - 'grounding-only-capability' the capability serves a document corpus (RETRIEVAL_BACKEND=grounding) → no planner surface exists
 */
export type DeterministicReason =
  | "area-anchored"
  | "event-anchored"
  | "contextual-follow-up"
  | "topic-landscape"
  | "mcp-unavailable"
  | "model-not-configured"
  | "model-unavailable"
  | "grounding-only-capability";

export interface PlanResult {
  ok: boolean;
  mode: "llm" | "deterministic";
  /** When `mode === 'deterministic'`, WHY the LLM path wasn't taken (null/absent on the LLM path). */
  deterministicReason?: DeterministicReason | null;
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
  /** Cited itinerary synthesized from search_grounding when no structured planner is connected. */
  documentPlan?: DocumentTripPlan | null;
  error?: string;

  // ── Leader-first, multi-option `/ask` envelope (additive; absent on the legacy single-plan path) ──
  /** 'answer' = grounded lookup; 'clarify' = ask a question; 'options' = itineraries; 'plan' = one itinerary. */
  stage?: "clarify" | "options" | "plan" | "answer";
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
  /** Updated grounded context for the chat host to carry into the next turn. */
  conversationContext?: EventPlanContext | null;
}

const DEFAULT_URL = (): string =>
  process.env.ENGAGEMENTS_MCP_URL || "http://localhost:3010/mcp";
const DEFAULT_TOPN = (): number => {
  const n = Number(process.env.ENGAGEMENTS_TOP_N);
  return Number.isFinite(n) && n > 0 ? n : 3;
};

export function buildSystemPrompt(
  defaultLeaderId: string | null,
  topN: number,
  groundingAvailable = false,
): string {
  const window = defaultWindow();
  const seedCatalog = isSeedCatalog();
  // The roster/topic catalogs come from the demo seed. They are only legitimate grounding when the
  // capability serves that same seed; against a customer index they are demo records the model would
  // otherwise present as real people.
  const catalogs = seedCatalog
    ? [
        "Leader roster (always use an id; engagement categories constrain who is a credible recommendation):",
        rosterForPrompt(),
        "",
        'Topic catalog (map natural language such as "UAS/drone" or "autonomy" to the grounded ids):',
        topicsForPrompt(),
      ]
    : [
        "There is NO local leader roster or topic catalog in this prompt: the capability reads a customer",
        "index, not the demo dataset. Every leader id, topic id, contact, organization, and event MUST come",
        "from a tool result in THIS turn (suggest_leaders, plan_options, search_contacts, search_events).",
        "When the tools return nothing, say plainly that the index has no match and stop — never fill the",
        "gap from prior knowledge, from these instructions, or with illustrative examples.",
      ];
  return [
    "You are the Strategic Engagements Orchestrator, the planning brain for a U.S. Army senior-leader",
    "executive assistant (EA). You own intent classification, workflow selection, tool choice, and the",
    "decision to answer, ask a grounded clarification, or finish a plan. You are the PRIMARY router for",
    "every user turn; classify the current request before considering prior conversation. Use ONLY the",
    "provided tools and any grounded catalogs in this prompt.",
    "",
    `Default planning window: ${window.start} through ${window.end}.`,
    ...(seedCatalog && defaultLeaderId
      ? [
          `Emergency fallback leader: "${defaultLeaderId}" (do not silently use it when a material leader choice is missing).`,
        ]
      : []),
    "",
    ...catalogs,
    "",
    "Decision policy:",
    "0. Contextual follow-up — when the user refers to a prior answer and the request includes prior",
    "   grounded references, do not search the follow-up sentence as a new event or area. Re-resolve",
    "   the supplied event, leader, contact, and topic ids with the relevant tools before answering.",
    "   For leader-fit questions, call search_events with the supplied eventId (event ids are searchable),",
    "   then call suggest_leaders with the returned city, state, window, and the supplied topicIds.",
    "   For questions about the current itinerary, call suggest_candidates and build_itinerary with",
    "   the supplied ids. For additional meeting options, also call search_contacts with the supplied",
    "   topicIds and exclude the already-selected contactIds. Recent conversation text is referential",
    "   context only, never authoritative data.",
    "   Return intent=lookup and stage=answer after the required verification calls.",
    "   Prior history alone does NOT make a turn a follow-up. An explicit strategic topic or new subject",
    "   starts a fresh area/event/radius/lookup workflow even when earlier trip history is present.",
    "1. Area intent — a region/city ask about why to go, who should go, or what is worth doing:",
    "   call plan_options with the default window. If no engagement category was explicitly selected,",
    "   return stage=clarify and clarify=category after grounding the choices in categoryBreakdown.",
    "   If a category was selected, use only that category's contactIds, choose the strongest eligible",
    "   leader from the grounded leader options and roster, then call build_itinerary with the same area",
    "   and window. Use the caller's day count or enough days for those contacts at two meetings/day.",
    "2. Event intent — a named conference/function the traveler is already attending: call search_events.",
    "   If no leader was explicitly selected, call suggest_leaders for the event city/window and return",
    "   stage=clarify, clarify=leader. Otherwise call suggest_candidates, then use build_itinerary to make",
    `   two or three meaningfully different grounded scope options using up to the top ${topN} candidates`,
    "   per option. A wider option may use search_contacts plus additionalContactIds for an authorized",
    "   regional swing. Return stage=options and the zero-based recommendedOptionIndex for the strongest",
    "   in-budget ROI; if only one viable itinerary exists, return stage=plan. Never silently pick a leader.",
    "3. Radius intent — a specific company/place plus a fixed number of days, without an event: call",
    "   plan_radius with that anchor, duration, and default window, then call build_itinerary with the",
    "   returned leader/anchor/stops. Never fabricate an event.",
    "4. Lookup intent — an informational contact/event/area question that does not request a trip:",
    "   use the relevant search or survey tools and answer from their results.",
    "   For a topic engagement-picture question, map the topic to its grounded id, call search_contacts",
    "   and search_events with that topicIds filter, then report who to meet, where the visible footprint",
    "   is most active, and approved-message availability from the grounded topic catalog above.",
    "5. Use stage=options only after two or more build_itinerary calls succeed; use stage=plan only after",
    "   one succeeds. Use stage=answer only for grounded lookup responses. Set category and leaderId only",
    "   when selected or grounded; otherwise return null.",
    "6. Area discovery — only when the user asks what ELSE is in the area, who they are missing, or for",
    "   organizations they do not already track: call search_businesses with the area anchor and a focus",
    "   (industry / manufacturing / technology / research / academia / government / venues). Its results are",
    "   PUBLIC place data from a separate capability — they carry no relationship history. You MUST then call",
    "   search_contacts for the same area and report a business as a new lead ONLY",
    "   when its name matches no known contact organization. Present these as awareness items, never as",
    "   existing relationships, and never place one into an itinerary: build_itinerary routes authorized",
    "   contact ids only, so an undiscovered business cannot become a stop until it is onboarded as a contact.",
    "   An awareness sweep is informational, so return intent=lookup and stage=answer — NOT intent=area,",
    "   which is reserved for actually building a trip. Only switch to intent=area if the user then asks to",
    "   plan travel around what you surfaced.",
    "7. Never invent contacts, events, ids, attributes, choices, or metrics.",
    ...(groundingAvailable
      ? [
          `8. A ${GROUNDING_TOOL_NAME} tool is also available over an indexed document corpus. Use it for`,
          "   narrative, policy, or background questions the structured tools cannot answer, and cite the",
          "   title/url of every passage you use. It returns documents, never contacts or itinerary stops.",
          "9. Keep answer concise and EA-ready. The structured decision fields control the host UI.",
        ]
      : [
          "8. Keep answer concise and EA-ready. The structured decision fields control the host UI.",
        ]),
  ].join("\n");
}

/**
 * System prompt for a capability running RETRIEVAL_BACKEND=grounding.
 *
 * That deployment registers ONLY `search_grounding` as its data tool. Trusted Agent Framework
 * skills teach the model how to synthesize a cited plan without injecting a seed catalog.
 */
export function buildGroundingSystemPrompt(): string {
  return [
    "You are the Strategic Engagements grounded-answer assistant for a U.S. Army senior-leader",
    "executive assistant (EA).",
    "",
    `The connected capability serves a DOCUMENT corpus and exposes one corpus tool, ${GROUNDING_TOOL_NAME}.`,
    "There is no contact directory, event calendar, leader roster, topic catalog, or itinerary builder",
    "available in this deployment, and none is embedded in these instructions. Trusted planning skills",
    "are advertised separately by the runtime and contain procedure only, never trip facts.",
    "",
    "Policy:",
    `1. For a trip-planning request, first load the document-trip-planning skill and follow it. Read`,
    "   the resources it requires before searching. For other requests, use the corpus directly.",
    `2. Call ${GROUNDING_TOOL_NAME} before answering. Re-query with different wording when the first`,
    "   passages are thin; you may call it several times.",
    "3. Answer ONLY from the returned passages. Cite the title (and url when present) of each passage",
    "   you rely on.",
    "4. If no passage supports an answer, say the corpus has nothing on it and stop. Do NOT substitute",
    "   prior knowledge, generic advice, illustrative names, or example organizations — a plausible",
    "   answer with no passage behind it is the worst possible outcome here.",
    "5. Never name a person, organization, event, or leader id that did not appear in a passage.",
    '6. For a supported trip, return stage="plan", a planning intent, and documentPlan. Every',
    "   sourceIds value must be an exact hit id returned this turn. Leave leaderId null unless the",
    "   corpus explicitly defines that id.",
    '7. For a lookup or an unsupported trip, return intent="lookup", stage="answer", and no',
    "   documentPlan. Leave clarify, category, leaderId, and recommendedOptionIndex null.",
    "8. Keep answer concise and EA-ready.",
  ].join("\n");
}

function projectDocumentPlan(
  plan: PythonDocumentTripPlan,
  captured: CapturedCall[],
): DocumentTripPlan {
  const hits = new Map<string, any>();
  for (const call of captured) {
    if (call.name !== GROUNDING_TOOL_NAME) continue;
    for (const hit of call.result?.hits ?? []) {
      if (hit?.id) hits.set(String(hit.id), hit);
    }
  }
  const referenced = new Set(plan.sourceIds);
  for (const day of plan.days) {
    for (const meeting of day.meetings) {
      for (const id of meeting.sourceIds) referenced.add(id);
    }
  }
  return {
    ...plan,
    citations: [...referenced].map((id) => {
      const hit = hits.get(id);
      if (!hit) {
        throw new IncompleteAgentDecision(
          `Document plan cited a Search hit that was not captured: ${id}`,
        );
      }
      return {
        id,
        title: typeof hit.title === "string" ? hit.title : null,
        url: typeof hit.url === "string" ? hit.url : null,
        parentId: typeof hit.parentId === "string" ? hit.parentId : null,
      };
    }),
  };
}

export function normalizeConversationHistory(
  value: unknown,
): ConversationHistoryMessage[] {
  if (!Array.isArray(value)) return [];
  const normalized: ConversationHistoryMessage[] = [];
  for (const item of value.slice(-10)) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    if (
      (candidate.role !== "user" && candidate.role !== "assistant") ||
      typeof candidate.text !== "string"
    ) {
      continue;
    }
    const text = candidate.text.trim().slice(0, 2_000);
    if (text) normalized.push({ role: candidate.role, text });
  }
  return normalized;
}

function buildAgentUserPrompt(
  req: PlanRequest,
  context: EventPlanContext | null,
): string {
  const selections: Record<string, unknown> = {};
  if (req.leaderId) selections.leaderId = req.leaderId;
  if (req.category) selections.category = req.category;
  if (typeof req.days === "number") selections.days = req.days;
  if (typeof req.radiusMi === "number") selections.radiusMi = req.radiusMi;
  const sections = [req.question];
  const history = normalizeConversationHistory(req.history);
  if (history.length > 0) {
    sections.push(
      "",
      "Recent conversation (referential context only; verify factual claims with tools):",
      ...history.map(
        (message) =>
          `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`,
      ),
    );
  }
  if (context) {
    sections.push(
      "",
      "Prior grounded plan references supplied by the host. Re-resolve these ids with tools before using them:",
      JSON.stringify({
        eventId: context.eventId,
        leaderId: context.leaderId,
        contactIds: context.contactIds,
        topicIds: context.topicIds ?? [],
        dayAssignments: context.dayAssignments ?? {},
      }),
    );
  }
  if (Object.keys(selections).length > 0) {
    sections.push(
      "",
      "Authoritative selections supplied by the caller (do not override them):",
      JSON.stringify(selections),
    );
  }
  return sections.join("\n");
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

/** True when the user is asking to expand the current itinerary into a daily view. */
export function isDayByDayFollowUp(question: string): boolean {
  const q = question.trim().toLowerCase();
  return (
    /\bday[\s-]+by[\s-]+day\b/.test(q) ||
    /\bdaily\s+(?:breakdown|break\s+down|itinerary|schedule|agenda|plan)\b/.test(
      q,
    ) ||
    /\b(?:break|lay|map)\s+(?:it|this|the\s+(?:trip|plan|itinerary))?\s*(?:down\s+)?by\s+day\b/.test(
      q,
    ) ||
    /\bwhat(?:'s|\s+is|\s+does|\s+will)?\s+(?:happen(?:s)?\s+)?(?:on\s+)?each\s+day\b/.test(
      q,
    )
  );
}

export type ContextualEventQuestionKind =
  | "day-by-day"
  | "day-detail"
  | "schedule-edit"
  | "leader-fit"
  | "alternatives"
  | "meetings"
  | "route"
  | "value"
  | "risks"
  | "nearby-leaders"
  | "overview";

/** Classify common plan questions for the deterministic model-outage fallback. */
export function contextualEventQuestionKind(
  question: string,
): ContextualEventQuestionKind {
  const q = question.trim().toLowerCase();
  if (isDayByDayFollowUp(question)) return "day-by-day";
  if (parseDayScheduleEdit(question)) return "schedule-edit";
  if (/\bday\s*\d{1,2}\b/.test(q)) return "day-detail";
  if (
    /\b(?:nearby|other)\s+leaders?\b/.test(q) ||
    /\bleaders?.{0,25}\b(?:nearby|there|attending|overlap)\b/.test(q)
  ) {
    return "nearby-leaders";
  }
  if (
    /\b(?:which|what|best|right|ideal|recommended?)\b.{0,45}\bleaders?\b/.test(
      q,
    ) ||
    /\bleaders?\b.{0,45}\b(?:best|fit|right|ideal|recommended?)\b/.test(q) ||
    /\bwho\s+should\s+(?:go|attend|lead|staff)\b/.test(q) ||
    (leaderFromQuestion(question) != null &&
      /\b(?:fit|better|best|work|suit|should|could|can)\b/.test(q))
  ) {
    return "leader-fit";
  }
  if (
    /\bwho\s+else\b/.test(q) ||
    /\b(?:add|another|alternative|replace|swap)\b/.test(q)
  ) {
    return "alternatives";
  }
  if (/\b(?:risk|conflict|issue|problem|warning|concern|feasib)\w*\b/.test(q)) {
    return "risks";
  }
  if (/\b(?:roi|return|cost|value|worth|budget|payoff)\b/.test(q)) {
    return "value";
  }
  if (
    /\b(?:route|travel|distance|drive|flight|order|sequence|where)\b/.test(q)
  ) {
    return "route";
  }
  if (
    /\b(?:meet|meeting|contact|company|organization|engagement)\w*\b/.test(q) ||
    /\bwhy\s+(?:these|them)\b/.test(q)
  ) {
    return "meetings";
  }
  return "overview";
}

/** Strong backward references that cannot be resolved safely without prior grounded plan state. */
export function requiresPriorGroundedContext(question: string): boolean {
  if (isTopicLandscapeQuestion(question)) return false;
  const q = question.trim();
  const lower = q.toLowerCase();
  return (
    isDayByDayFollowUp(q) ||
    /\bday\s*\d{1,2}\b/i.test(q) ||
    /\b(?:this|that|it|these|those|previous|prior|above)\b/.test(lower) ||
    /\b(?:current|existing)\s+(?:plan|trip|itinerary|route|schedule)\b/.test(
      lower,
    ) ||
    /\bthe\s+(?:plan|trip|itinerary|route|schedule|meetings?)\b/.test(lower)
  );
}

/** A standalone topic-footprint question, including the text emitted by the hot-topic chips. */
export function isTopicLandscapeQuestion(question: string): boolean {
  if (topicIdsFromText(question).length === 0) return false;
  const q = question.toLowerCase();
  return (
    /\bengagement\s+picture\b/.test(q) ||
    /\bwhere\b.{0,35}\b(?:active|activity|hot|footprint)\b/.test(q) ||
    /\bapproved\s+message\b/.test(q) ||
    /\bwho\s+should\s+we\s+meet\b/.test(q) ||
    /\bwhat(?:'s| is)\s+hot\b/.test(q)
  );
}

/**
 * A context-sensitive turn either explicitly points backward or asks about a plan facet without
 * naming a new anchor. This keeps new "at AUSA" / "in Boston" asks on the normal discovery paths.
 */
export function isContextualFollowUpQuestion(question: string): boolean {
  const q = question.trim();
  const lower = q.toLowerCase();
  if (requiresPriorGroundedContext(q)) return true;
  // An explicit strategic topic starts a fresh lookup unless the user also points backward.
  if (topicIdsFromText(q).length > 0) return false;
  if (
    /\bwhat(?:'s| is)\s+hot\b/.test(lower) ||
    /\b(?:search|find|look\s+up)\b/.test(lower) ||
    /^what(?:'s| is)\s+(?!this\b|that\b|it\b|the\b)(?:an?\s+)?[\w&.-]+(?:\s+[\w&.-]+){0,4}\??$/i.test(
      q,
    )
  ) {
    return false;
  }
  const explicitAnchor =
    areaAskAnchor(q) != null ||
    /\b(?:at|to|for|about|attending|visiting|in)\s+(?!(?:this|that|it|these|those)\b)(?!the\s+(?:plan|trip|event|itinerary)\b)[\w&.-]+(?:\s+[\w&.-]+){0,4}/i.test(
      q,
    );
  if (explicitAnchor) return false;
  if (contextualEventQuestionKind(q) !== "overview") return true;
  return (
    q.split(/\s+/).length <= 12 &&
    /^(?:and|also|so|then|what|why|how|when|where|can|could|should|is|are|does|will|tell|compare)\b/i.test(
      q,
    )
  );
}

/**
 * Validate untrusted chat context. The subsequent MCP calls independently re-resolve the event
 * and every contact id.
 */
export function normalizeEventPlanContext(
  value: unknown,
): EventPlanContext | null {
  if (!value || typeof value !== "object") return null;
  const context = value as Record<string, unknown>;
  if (
    context.version !== 1 ||
    context.kind !== "event" ||
    typeof context.leaderId !== "string" ||
    !context.leaderId.trim() ||
    typeof context.eventId !== "string" ||
    !context.eventId.trim() ||
    !Array.isArray(context.contactIds)
  ) {
    return null;
  }

  const contactIds = [
    ...new Set(
      context.contactIds.filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      ),
    ),
  ].slice(0, 50);
  if (contactIds.length === 0) return null;

  const topicIds = Array.isArray(context.topicIds)
    ? [
        ...new Set(
          context.topicIds.filter(
            (id): id is string =>
              typeof id === "string" && id.trim().length > 0,
          ),
        ),
      ].slice(0, 20)
    : undefined;
  const allowedContactIds = new Set(contactIds);
  const dayAssignments =
    context.dayAssignments &&
    typeof context.dayAssignments === "object" &&
    !Array.isArray(context.dayAssignments)
      ? Object.fromEntries(
          Object.entries(context.dayAssignments as Record<string, unknown>)
            .filter(
              ([contactId, day]) =>
                allowedContactIds.has(contactId) &&
                Number.isInteger(day) &&
                Number(day) >= 1 &&
                Number(day) <= 31,
            )
            .map(([contactId, day]) => [contactId, Number(day)]),
        )
      : {};

  return {
    version: 1,
    kind: "event",
    leaderId: context.leaderId.trim(),
    eventId: context.eventId.trim(),
    contactIds,
    ...(topicIds?.length ? { topicIds } : {}),
    ...(Object.keys(dayAssignments).length ? { dayAssignments } : {}),
  };
}

export interface DayScheduleEdit {
  day: number;
}

/** Parse an explicit request to place an item onto a numbered itinerary day. */
export function parseDayScheduleEdit(question: string): DayScheduleEdit | null {
  if (
    !/\b(?:add|put|place|move|shift|schedule|book|slot|include)\b/i.test(
      question,
    )
  ) {
    return null;
  }
  const day = Number(question.match(/\bday\s*(\d{1,2})\b/i)?.[1]);
  return Number.isInteger(day) && day > 0 ? { day } : null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const FOLLOW_UP_WORKDAY_MINS = 8 * 60;
const FOLLOW_UP_DWELL_MINS = 120;

function addIsoDays(day: string, offset: number): string {
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time)
    ? new Date(time + offset * DAY_MS).toISOString().slice(0, 10)
    : day;
}

function inclusiveDays(start?: string, end?: string): number {
  if (!start || !end || !ISO_DAY.test(start) || !ISO_DAY.test(end)) return 0;
  const delta =
    Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Number.isFinite(delta) && delta >= 0
    ? Math.floor(delta / DAY_MS) + 1
    : 0;
}

function displayDay(day: string): string {
  if (!ISO_DAY.test(day)) return day;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}

function contactWithLocation(contact: any): string {
  const location = [contact?.city, contact?.state].filter(Boolean).join(", ");
  return `${contact?.name ?? contact?.contactId ?? "Unnamed contact"}${
    location ? ` (${location})` : ""
  }`;
}

function contactName(contact: any): string {
  return contact?.name ?? contact?.contactId ?? "Unnamed contact";
}

interface EventDaySlot {
  date: string;
  eventDay: boolean;
  contacts: any[];
  travelMins: number;
}

interface EventDaySchedule {
  days: EventDaySlot[];
  totalDays: number;
  assignmentByContactId: Map<string, number>;
  legsByDestination: Map<string, any>;
}

function buildEventDaySchedule(
  build: any,
  dayAssignments: Record<string, number> = {},
): EventDaySchedule | null {
  const event = build?.event;
  const start = event?.start;
  if (!event?.name || !start || !ISO_DAY.test(start)) return null;

  const accepted: any[] = Array.isArray(build?.accepted) ? build.accepted : [];
  const acceptedById = new Map<string, any>(
    accepted
      .filter((contact) => contact?.contactId)
      .map((contact) => [contact.contactId, contact]),
  );
  const orderedIds: string[] = Array.isArray(build?.route?.order)
    ? build.route.order
        .map((stop: any) => stop?.id)
        .filter((id: unknown): id is string => typeof id === "string")
    : [];
  const ordered = [
    ...orderedIds
      .map((id) => acceptedById.get(id))
      .filter((contact): contact is any => !!contact),
    ...accepted.filter(
      (contact) => !orderedIds.includes(String(contact?.contactId ?? "")),
    ),
  ];
  const onSiteDays = Math.max(
    1,
    Number(build?.duration?.onSiteDays) ||
      inclusiveDays(event.start, event.end) ||
      1,
  );
  const offSite = ordered.filter((contact) => contact?.placement !== "on-site");
  const statedDays =
    Number(build?.duration?.days) || Number(build?.days) || onSiteDays;
  const assignmentMax = Math.max(
    0,
    ...Object.entries(dayAssignments)
      .filter(([contactId]) => acceptedById.has(contactId))
      .map(([, day]) => Number(day) || 0),
  );
  const totalDays = Math.max(
    onSiteDays + (offSite.length > 0 ? 1 : 0),
    statedDays,
    assignmentMax,
  );
  const days: EventDaySlot[] = Array.from(
    { length: totalDays },
    (_, index) => ({
      date: addIsoDays(start, index),
      eventDay: index < onSiteDays,
      contacts: [],
      travelMins: 0,
    }),
  );
  const legsByDestination = new Map<string, any>(
    (Array.isArray(build?.route?.legs) ? build.route.legs : [])
      .filter((leg: any) => typeof leg?.to === "string")
      .map((leg: any) => [leg.to, leg]),
  );
  const assignmentByContactId = new Map<string, number>();
  const place = (contact: any, dayNumber: number): void => {
    const day = days[dayNumber - 1];
    if (!day || !contact?.contactId) return;
    day.contacts.push(contact);
    assignmentByContactId.set(contact.contactId, dayNumber);
    if (contact.placement !== "on-site") {
      day.travelMins += Math.max(
        0,
        Number(legsByDestination.get(contact.contactId)?.estTravelMins) || 0,
      );
    }
  };

  for (const contact of ordered) {
    const assignedDay = dayAssignments[contact.contactId];
    if (
      Number.isInteger(assignedDay) &&
      assignedDay >= 1 &&
      assignedDay <= totalDays
    ) {
      place(contact, assignedDay);
    }
  }

  const unassignedOnSite = ordered.filter(
    (contact) =>
      contact?.placement === "on-site" &&
      !assignmentByContactId.has(contact.contactId),
  );
  unassignedOnSite.forEach((contact, index) => {
    place(contact, Math.min(index + 1, onSiteDays));
  });

  const unassignedOffSite = offSite.filter(
    (contact) => !assignmentByContactId.has(contact.contactId),
  );
  const extraDays = Math.max(1, totalDays - onSiteDays);
  let elapsedMins = 0;
  for (const contact of unassignedOffSite) {
    const travelMins = Math.max(
      0,
      Number(legsByDestination.get(contact.contactId)?.estTravelMins) || 0,
    );
    elapsedMins += travelMins + FOLLOW_UP_DWELL_MINS;
    const extraDayIndex = Math.min(
      extraDays - 1,
      Math.max(0, Math.ceil(elapsedMins / FOLLOW_UP_WORKDAY_MINS) - 1),
    );
    place(contact, onSiteDays + extraDayIndex + 1);
  }

  return {
    days,
    totalDays,
    assignmentByContactId,
    legsByDestination,
  };
}

/**
 * Render the capability's event itinerary as a grounded daily sequence. It does not invent meeting
 * times or activities: empty conference days are called out, and off-site stops follow route order.
 */
export function renderEventDayByDay(
  build: any,
  dayAssignments: Record<string, number> = {},
): string {
  const event = build?.event;
  const schedule = buildEventDaySchedule(build, dayAssignments);
  if (!schedule) {
    return "The grounded itinerary does not include enough event-date detail for a day-by-day breakdown.";
  }

  const leader =
    build?.leader?.name ?? build?.leader?.id ?? "the selected leader";
  const lines = schedule.days.map((day, index) => {
    const prefix = `${index + 1}. Day ${index + 1} — ${displayDay(day.date)}:`;
    if (day.eventDay) {
      if (day.contacts.length === 0) {
        return `${prefix} ${event.name} anchor day; no specific contact meeting is assigned in the current itinerary.`;
      }
      const onSite = day.contacts.filter(
        (contact) => contact?.placement === "on-site",
      );
      const offSite = day.contacts.filter(
        (contact) => contact?.placement !== "on-site",
      );
      const parts = [event.name];
      if (onSite.length) {
        parts.push(
          `on-site ${onSite.length === 1 ? "meeting" : "meetings"} with ${onSite
            .map(contactName)
            .join(" → ")}`,
        );
      }
      if (offSite.length) {
        parts.push(
          `off-site ${offSite.length === 1 ? "meeting" : "meetings"} with ${offSite
            .map(contactWithLocation)
            .join(" → ")}`,
        );
      }
      const travel =
        day.travelMins > 0
          ? ` Estimated route-leg travel: ${Math.round(day.travelMins)} min.`
          : "";
      return `${prefix} ${parts.join("; ")}.${travel}`;
    }
    if (day.contacts.length > 0) {
      const travel =
        day.travelMins > 0
          ? ` Estimated route travel: ${Math.round(day.travelMins)} min.`
          : "";
      return `${prefix} Off-site swing: ${day.contacts
        .map(contactWithLocation)
        .join(" → ")}.${travel}`;
    }
    return `${prefix} No specific contact meeting is assigned in the current itinerary.`;
  });

  return [
    `Day-by-day for ${leader} at ${event.name} (${schedule.totalDays} days)`,
    "",
    ...lines,
    "",
    "Exact meeting times are not present in the grounded itinerary; this preserves only the authorized stops, event dates, route order, and travel estimates.",
  ].join("\n");
}

function metric(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "—";
}

function renderLeaderFit(build: any, leaders: any[]): string {
  const top = leaders[0];
  if (!top) {
    return "No authorized leader ranking is available for the current event and topic.";
  }
  const currentId = build?.leader?.id;
  const current = leaders.find((leader) => leader?.leaderId === currentId);
  const eventName = build?.event?.name ?? "the current event";
  const why = [
    `topic fit ${metric(top?.factors?.topicMatch)}`,
    top.availableInWindow
      ? "available in the event window"
      : "not available in the event window",
    typeof top.distanceMi === "number"
      ? `${Math.round(top.distanceMi)} mi from the event area`
      : null,
    `budget headroom ${metric(top?.factors?.budgetHeadroom)}`,
  ].filter(Boolean);
  const comparison =
    current && current.leaderId !== top.leaderId
      ? `The current plan uses ${current.name} (${current.leaderId}), ranked ${leaders.indexOf(current) + 1} at ${metric(current.score)}.`
      : `The current plan already uses the top-ranked leader.`;
  const alternatives = leaders
    .slice(1, 3)
    .map(
      (leader, index) =>
        `${index + 2}. ${leader.name} (${leader.leaderId}) — fit ${metric(leader.score)}${
          leader.availableInWindow ? "" : " · unavailable"
        }`,
    );
  return [
    `Best fit for ${eventName}: ${top.name} (${top.leaderId}) — composite fit ${metric(top.score)}.`,
    `Why: ${why.join(" · ")}.`,
    comparison,
    ...(alternatives.length ? ["Next best:", ...alternatives] : []),
  ].join("\n");
}

function renderMeetings(build: any, explain: boolean): string {
  const accepted: any[] = build?.accepted ?? [];
  if (accepted.length === 0)
    return "The current itinerary has no authorized meetings.";
  const lines = accepted.map((contact, index) => {
    const details = [
      contact.placement,
      contact.kind,
      contact.status,
      `value ${contact.strategicValue ?? "—"}`,
      `score ${contact.score ?? "—"}`,
    ].filter(Boolean);
    if (explain && contact.factors) {
      details.push(
        `topic ${contact.factors.topic ?? "—"}`,
        `relationship need ${contact.factors.staleness ?? "—"}`,
      );
    }
    const name =
      contact.placement === "on-site"
        ? `${contactName(contact)} (on-site at the event)`
        : contactWithLocation(contact);
    return `${index + 1}. ${name} — ${details.join(" · ")}`;
  });
  return [
    `${accepted.length} authorized meeting${accepted.length === 1 ? "" : "s"} in the current itinerary:`,
    ...lines,
  ].join("\n");
}

function renderAlternatives(
  context: EventPlanContext,
  suggest: any,
  broaderContacts: any[],
): string {
  const selected = new Set(context.contactIds);
  const localAlternatives = (suggest?.candidates ?? []).filter(
    (candidate: any) => !selected.has(candidate?.contactId),
  );
  const localIds = new Set(
    localAlternatives.map((candidate: any) => candidate?.contactId),
  );
  const regionalAlternatives = (broaderContacts ?? [])
    .filter(
      (contact: any) =>
        !selected.has(contact?.id) && !localIds.has(contact?.id),
    )
    .sort(
      (a: any, b: any) =>
        Number(b?.strategicValue ?? 0) - Number(a?.strategicValue ?? 0),
    );
  const alternatives = [
    ...localAlternatives.map((candidate: any) => ({
      id: candidate.contactId,
      name: candidate.name,
      city: candidate.city,
      state: candidate.state,
      detail: `${candidate.placement} · ${candidate.kind} · score ${candidate.score ?? "—"}`,
    })),
    ...regionalAlternatives.map((contact: any) => ({
      id: contact.id,
      name: contact.name,
      city: contact.city,
      state: contact.state,
      detail: `regional option · ${contact.status ?? "status unknown"} · value ${contact.strategicValue ?? "—"}`,
    })),
  ];
  if (alternatives.length === 0) {
    return "No additional authorized candidates are available for the current event and topic.";
  }
  return [
    "Additional authorized candidates for this event:",
    ...alternatives
      .slice(0, 5)
      .map(
        (candidate: any, index: number) =>
          `${index + 1}. ${contactWithLocation(candidate)} — ${candidate.detail}`,
      ),
    "Adding one would require rebuilding the itinerary and rechecking duration, ROI, and conflicts.",
  ].join("\n");
}

function renderRoute(build: any): string {
  const accepted = new Map<string, any>(
    (build?.accepted ?? []).map((contact: any) => [contact.contactId, contact]),
  );
  const order: any[] = build?.route?.order ?? [];
  const orderedNames = order.map((stop) => {
    const contact = accepted.get(stop.id) ?? {
      contactId: stop.id,
      city: stop.city,
    };
    return contact?.placement === "on-site" || stop?.kind === "on-site"
      ? `${contactName(contact)} (on-site at ${build?.event?.name ?? "the event"})`
      : contactWithLocation(contact);
  });
  const legs: any[] = build?.route?.legs ?? [];
  return [
    `Route: ${orderedNames.length ? orderedNames.join(" → ") : "no routed stops"}.`,
    `Total travel: ${Math.round(Number(build?.route?.totalMi) || 0)} mi · ${Math.round(Number(build?.route?.totalTravelMins) || 0)} min.`,
    ...legs.map(
      (leg, index) =>
        `${index + 1}. ${leg.mode ?? "travel"} to ${contactName(accepted.get(leg.to) ?? { contactId: leg.to })}: ${Math.round(Number(leg.distanceMi) || 0)} mi · ${Math.round(Number(leg.estTravelMins) || 0)} min`,
    ),
  ].join("\n");
}

function renderValue(build: any): string {
  const roi = build?.roi;
  if (!roi) return "The current itinerary has no grounded ROI calculation.";
  const breakdown = roi.breakdown ?? {};
  return [
    `Trip ROI: ${metric(roi.roiScore)}${roi.overBudget ? " · OVER BUDGET" : " · within budget"}.`,
    `Gross value ${metric(breakdown.grossValue)} minus total cost ${metric(breakdown.totalCost)}.`,
    `Cost detail: airfare ${metric(breakdown.airfare)} · per diem ${metric(breakdown.perDiem)} · time penalty ${metric(breakdown.timePenalty)}.`,
  ].join("\n");
}

function renderRisks(build: any): string {
  const conflicts: any[] = build?.conflicts ?? [];
  if (conflicts.length === 0) {
    return "No conflicts are flagged for the current authorized itinerary.";
  }
  return [
    `${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} flagged:`,
    ...conflicts.map(
      (conflict, index) =>
        `${index + 1}. ${conflict.severity}/${conflict.type}: ${conflict.message}${
          conflict.recommendation
            ? ` Recommendation: ${conflict.recommendation}`
            : ""
        }`,
    ),
  ].join("\n");
}

function renderNearbyLeaders(build: any): string {
  const leaders: any[] = build?.nearbyLeaders ?? [];
  if (leaders.length === 0) {
    return "No other senior leaders are flagged at or near the current itinerary.";
  }
  return [
    "Other senior leaders at or near this itinerary:",
    ...leaders.map(
      (leader, index) =>
        `${index + 1}. ${leader.name ?? leader.leaderId} (${leader.leaderId}) — ${leader.primaryReason ?? "nearby"}${
          leader.availableInWindow === false ? " · unavailable" : ""
        }`,
    ),
  ].join("\n");
}

function renderEventOverview(build: any): string {
  const event = build?.event;
  const accepted: any[] = build?.accepted ?? [];
  return [
    `${build?.leader?.name ?? "Selected leader"} at ${event?.name ?? "the current event"} (${event?.start ?? "?"}–${event?.end ?? "?"}).`,
    `${accepted.length} meeting${accepted.length === 1 ? "" : "s"} · ${build?.duration?.days ?? "?"} days · ROI ${metric(build?.roi?.roiScore)}.`,
    `Meetings: ${accepted.map(contactName).join(", ") || "none"}.`,
    `Travel: ${Math.round(Number(build?.route?.totalMi) || 0)} mi / ${Math.round(Number(build?.route?.totalTravelMins) || 0)} min · conflicts: ${(build?.conflicts ?? []).length}.`,
  ].join("\n");
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namedContactInQuestion(contacts: any[], question: string): any | null {
  const lower = question.toLowerCase();
  for (const contact of contacts) {
    const id = String(contact?.contactId ?? "");
    if (id && new RegExp(`\\b${regexEscape(id)}\\b`, "i").test(question)) {
      return contact;
    }
    const name = String(contact?.name ?? "").trim();
    if (name.length >= 3 && lower.includes(name.toLowerCase())) return contact;
  }
  return null;
}

function applyDayScheduleEdit(
  build: any,
  context: EventPlanContext,
  question: string,
): { answer: string; context: EventPlanContext } {
  const edit = parseDayScheduleEdit(question);
  const schedule = buildEventDaySchedule(build, context.dayAssignments ?? {});
  if (!edit || !schedule) {
    return {
      answer:
        "I could not resolve a valid itinerary day from that scheduling request.",
      context,
    };
  }
  if (edit.day > schedule.totalDays) {
    return {
      answer: `The current itinerary has ${schedule.totalDays} days, so Day ${edit.day} is outside the grounded plan.`,
      context,
    };
  }

  const accepted: any[] = build?.accepted ?? [];
  const targetContactIds = new Set(
    schedule.days[edit.day - 1]?.contacts
      .map((contact) => contact?.contactId)
      .filter(Boolean) ?? [],
  );
  const named = namedContactInQuestion(accepted, question);
  const routeOrder: string[] = (build?.route?.order ?? [])
    .map((stop: any) => stop?.id)
    .filter((id: unknown): id is string => typeof id === "string");
  const ordered = [...accepted].sort(
    (a, b) =>
      routeOrder.indexOf(a?.contactId) - routeOrder.indexOf(b?.contactId),
  );
  const selected =
    named ??
    ordered.find(
      (contact) =>
        contact?.placement !== "on-site" &&
        !targetContactIds.has(contact?.contactId) &&
        context.dayAssignments?.[contact?.contactId] == null,
    ) ??
    ordered.find(
      (contact) =>
        contact?.placement !== "on-site" &&
        !targetContactIds.has(contact?.contactId),
    ) ??
    null;
  if (!selected) {
    return {
      answer:
        `Day ${edit.day} already contains every currently selected meeting that can be placed there. ` +
        "Ask who else is available if you want to expand the authorized contact set.",
      context,
    };
  }

  const priorDay = schedule.assignmentByContactId.get(selected.contactId);
  if (priorDay === edit.day) {
    return {
      answer: `${contactName(selected)} is already assigned to Day ${edit.day}.\n\n${renderEventDayByDay(
        build,
        context.dayAssignments,
      )}`,
      context,
    };
  }

  const dayAssignments = {
    ...(context.dayAssignments ?? {}),
    [selected.contactId]: edit.day,
  };
  const updatedContext: EventPlanContext = {
    ...context,
    dayAssignments,
  };
  const leg = schedule.legsByDestination.get(selected.contactId);
  const travel =
    selected.placement !== "on-site" && leg
      ? ` The route leg is ${Math.round(Number(leg.distanceMi) || 0)} mi / ${Math.round(
          Number(leg.estTravelMins) || 0,
        )} min.`
      : "";
  const moved =
    priorDay != null
      ? ` This moves the existing authorized meeting from Day ${priorDay}; no new contact was invented.`
      : "";
  return {
    answer:
      `Scheduled ${contactName(selected)} on Day ${edit.day}.${moved}${travel}\n\n` +
      renderEventDayByDay(build, dayAssignments),
    context: updatedContext,
  };
}

async function buildEventContextualFollowUp(
  client: ToolClient,
  base: PlanResult,
  context: EventPlanContext,
  question: string,
): Promise<PlanResult> {
  await client.callTool("suggest_candidates", {
    leaderId: context.leaderId,
    eventId: context.eventId,
    ...(context.topicIds?.length ? { topicIds: context.topicIds } : {}),
    requireTopicMatch: false,
  });
  const suggest =
    lastCapture(client.captured, "suggest_candidates")?.result ?? {};
  if (!suggest.event || suggest.error) {
    return {
      ...base,
      deterministicReason: "contextual-follow-up",
      answer: suggest.error ?? "The prior anchor event is no longer available.",
      toolCalls: client.captured.map((call) => ({
        name: call.name,
        args: call.args,
      })),
    };
  }

  const nearbyIds = new Set(
    (suggest.candidates ?? [])
      .map((candidate: any) => candidate?.contactId)
      .filter(Boolean),
  );
  const acceptedContactIds = context.contactIds.filter((id) =>
    nearbyIds.has(id),
  );
  const additionalContactIds = context.contactIds.filter(
    (id) => !nearbyIds.has(id),
  );
  await client.callTool("build_itinerary", {
    leaderId: context.leaderId,
    eventId: context.eventId,
    acceptedContactIds,
    ...(additionalContactIds.length ? { additionalContactIds } : {}),
    ...(context.topicIds?.length ? { topicIds: context.topicIds } : {}),
    requireTopicMatch: false,
  });

  const build = lastCapture(client.captured, "build_itinerary")?.result ?? {};
  const itinerary = extractItinerary(build);
  const kind = contextualEventQuestionKind(question);
  const acceptedIds: string[] = (build?.accepted ?? [])
    .map((contact: any) => contact?.contactId)
    .filter((id: unknown): id is string => typeof id === "string");
  const refreshedContext =
    normalizeEventPlanContext({
      ...context,
      leaderId: build?.leader?.id ?? context.leaderId,
      eventId: build?.event?.id ?? context.eventId,
      contactIds: acceptedIds.length ? acceptedIds : context.contactIds,
    }) ?? context;
  let leaders: any[] = [];
  let broaderContacts: any[] = [];
  if (
    !build.error &&
    itinerary &&
    kind === "leader-fit" &&
    build.event?.city &&
    build.event?.start &&
    build.event?.end
  ) {
    await client.callTool("suggest_leaders", {
      city: build.event.city,
      window: { start: build.event.start, end: build.event.end },
      ...(refreshedContext.topicIds?.length
        ? { topicIds: refreshedContext.topicIds }
        : {}),
    });
    leaders =
      lastCapture(client.captured, "suggest_leaders")?.result?.leaders ?? [];
  }
  if (!build.error && itinerary && kind === "alternatives") {
    await client.callTool("search_contacts", {
      ...(refreshedContext.topicIds?.length
        ? { topicIds: refreshedContext.topicIds }
        : {}),
    });
    broaderContacts =
      lastCapture(client.captured, "search_contacts")?.result?.contacts ?? [];
  }
  const scheduleEdit =
    !build.error && itinerary && kind === "schedule-edit"
      ? applyDayScheduleEdit(build, refreshedContext, question)
      : null;
  const responseContext = scheduleEdit?.context ?? refreshedContext;
  const answer = build.error
    ? build.error
    : !itinerary
      ? "The prior itinerary could not be rebuilt from the current contacts."
      : scheduleEdit
        ? scheduleEdit.answer
        : kind === "day-by-day"
          ? renderEventDayByDay(build, refreshedContext.dayAssignments)
          : kind === "day-detail"
            ? renderEventDayByDay(build, refreshedContext.dayAssignments)
            : kind === "leader-fit"
              ? renderLeaderFit(build, leaders)
              : kind === "alternatives"
                ? renderAlternatives(refreshedContext, suggest, broaderContacts)
                : kind === "meetings"
                  ? renderMeetings(build, /\bwhy\b/i.test(question))
                  : kind === "route"
                    ? renderRoute(build)
                    : kind === "value"
                      ? renderValue(build)
                      : kind === "risks"
                        ? renderRisks(build)
                        : kind === "nearby-leaders"
                          ? renderNearbyLeaders(build)
                          : renderEventOverview(build);
  return {
    ...base,
    ok: !build.error && itinerary != null,
    deterministicReason: "contextual-follow-up",
    answer,
    toolCalls: client.captured.map((call) => ({
      name: call.name,
      args: call.args,
    })),
    menu: null,
    itinerary,
    tripMap: null,
    stage: "plan",
    clarify: null,
    leaderId: build.leader?.id ?? context.leaderId,
    leaderName: build.leader?.name ?? suggest.leader?.name ?? null,
    event: build.event ?? suggest.event ?? null,
    topicIds: refreshedContext.topicIds ?? suggest.topicFocus ?? [],
    conversationContext: responseContext,
  };
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

async function buildTopicLandscape(
  client: ToolClient,
  topicIds: string[],
  base: PlanResult,
): Promise<PlanResult> {
  const contactsRes: any = await client.callTool("search_contacts", {
    topicIds,
  });
  const eventsRes: any = await client.callTool("search_events", { topicIds });

  const contacts = [...(contactsRes?.contacts ?? [])].sort(
    (a: any, b: any) =>
      Number(b.strategicValue ?? 0) - Number(a.strategicValue ?? 0) ||
      String(a.name).localeCompare(String(b.name)),
  );
  const events = [...(eventsRes?.events ?? [])];
  const topics = loadTopics().filter((topic) => topicIds.includes(topic.id));
  const topicName =
    topics.map((topic) => topic.name).join(" / ") || topicIds.join(", ");
  const locations = new Map<
    string,
    { label: string; contacts: number; events: number }
  >();
  for (const item of [...contacts, ...events]) {
    const label =
      [item.city, item.state].filter(Boolean).join(", ") ||
      "Location unavailable";
    const key = label.toLowerCase();
    const row = locations.get(key) ?? { label, contacts: 0, events: 0 };
    if ("status" in item) row.contacts += 1;
    else row.events += 1;
    locations.set(key, row);
  }
  const activeLocations = [...locations.values()].sort(
    (a, b) =>
      b.contacts + b.events - (a.contacts + a.events) ||
      b.contacts - a.contacts ||
      a.label.localeCompare(b.label),
  );
  const approved = topics.filter((topic) => topic.approvedMessageId);
  const meetingText = contacts.length
    ? contacts
        .slice(0, 5)
        .map(
          (contact: any, index: number) =>
            `${index + 1}. ${contact.name}${contact.org ? ` (${contact.org})` : ""} — ` +
            `${contact.city}, ${contact.state}; ${contact.status}; strategic value ${contact.strategicValue}.`,
        )
        .join("\n")
    : "No contacts are currently visible for this topic.";
  const locationText = activeLocations.length
    ? activeLocations
        .slice(0, 5)
        .map(
          (location) =>
            `${location.label} (${location.contacts} contact${location.contacts === 1 ? "" : "s"}, ` +
            `${location.events} event${location.events === 1 ? "" : "s"})`,
        )
        .join("; ")
    : "No contact or event locations are currently visible.";
  const messageText =
    approved.length === topics.length && topics.length > 0
      ? `Yes — an approved message is cataloged for ${topicName}.`
      : approved.length > 0
        ? `Partially — approved messaging is cataloged for ${approved.map((topic) => topic.name).join(", ")}, but not every matched topic.`
        : `No approved message is cataloged for ${topicName}.`;

  return {
    ...base,
    ok: true,
    stage: "answer",
    deterministicReason: "topic-landscape",
    answer:
      `Current engagement picture for ${topicName}:\n\n` +
      `Who to meet\n${meetingText}\n\n` +
      `Most active locations\n${locationText}\n\n` +
      `Approved message\n${messageText}`,
    topicIds,
    toolCalls: client.captured.map((call) => ({
      name: call.name,
      args: call.args,
    })),
  };
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

  const menu: any[] | null = suggest?.candidates ?? null;
  const itinerary = extractItinerary(build);
  const tripMap = build?.tripMap ?? null;

  return {
    ...base,
    ok: menu != null || itinerary != null,
    mode,
    deterministicReason: mode === "deterministic" ? deterministicReason : null,
    answer,
    toolCalls,
    menu,
    itinerary,
    tripMap,
  };
}

class IncompleteAgentDecision extends Error {}

function capturedFromAgent(loop: PythonAgentResult): CapturedCall[] {
  return loop.captured.map(({ name, args, result, text }) => ({
    name,
    args,
    result,
    text,
  }));
}

/**
 * Project a failed `makeToolClient` into a plan result. A grounding-only capability is reachable and
 * healthy — it simply has no planner surface — so it must not be reported as an outage.
 */
function toolClientFailure(
  base: PlanResult,
  url: string,
  error: any,
): PlanResult {
  if (error instanceof GroundingOnlyCapabilityError) {
    return {
      ...base,
      deterministicReason: "grounding-only-capability",
      error: error.message,
    };
  }
  return {
    ...base,
    deterministicReason: "mcp-unavailable",
    error:
      `Cannot initialize the governed Python agent path for engagements MCP ${url}: ${error?.message || error}. ` +
      "Start the MCP server and the engagements agent workspace services.",
  };
}

function firstCapturedEvent(captured: CapturedCall[]): any | null {
  return (
    lastCapture(captured, "build_itinerary")?.result?.event ??
    lastCapture(captured, "suggest_candidates")?.result?.event ??
    lastCapture(captured, "search_events")?.result?.events?.[0] ??
    null
  );
}

function isCompleteBuildResult(result: any): boolean {
  return !!(
    result?.leader &&
    Array.isArray(result?.accepted) &&
    result.accepted.length > 0 &&
    result?.route &&
    result?.roi
  );
}

function groundedLeaderShortlist(
  category: EngagementCategory | null,
  selectedLeaderId: string | null,
  options: any[],
): LeaderPick[] {
  if (!category || !selectedLeaderId) return [];
  const rosterById = new Map(
    loadLeaders().map((leader) => [leader.id, leader]),
  );
  const eligible = (options ?? []).filter((option) =>
    rosterById.get(option?.leaderId)?.engagementCategories?.includes(category),
  );
  const selected =
    (options ?? []).find((option) => option?.leaderId === selectedLeaderId) ??
    null;
  const ordered = [
    ...(selected ? [selected] : []),
    ...eligible.filter((option) => option?.leaderId !== selectedLeaderId),
  ];
  return ordered.map((option) => ({
    leaderId: option.leaderId,
    name: option.name ?? null,
    role: option.role ?? null,
    score: option.score ?? null,
    distanceMi:
      typeof option.distanceMi === "number" ? option.distanceMi : null,
    availableInWindow:
      typeof option.availableInWindow === "boolean"
        ? option.availableInWindow
        : null,
    why: leaderWhy(option),
    recommended: option.leaderId === selectedLeaderId,
    selected: option.leaderId === selectedLeaderId,
  }));
}

/**
 * Adapt the framework's grounded decision and captured MCP results to the existing chat contract.
 * Intent and stage come from the agent; this function only projects authoritative tool data for the UI.
 */
export function agentDecisionToPlanResult(
  base: PlanResult,
  decision: PythonAgentDecision,
  captured: CapturedCall[],
): PlanResult {
  const toolCalls = captured.map((call) => ({
    name: call.name,
    args: call.args,
  }));
  const plan = lastCapture(captured, "plan_options")?.result;
  const radius = lastCapture(captured, "plan_radius")?.result;
  const survey = lastCapture(captured, "survey_area")?.result;
  const leadersResult = lastCapture(captured, "suggest_leaders")?.result;
  const suggest = lastCapture(captured, "suggest_candidates")?.result;
  const successfulBuildCalls = captured.filter(
    (call) =>
      call.name === "build_itinerary" && isCompleteBuildResult(call.result),
  );
  const build = successfulBuildCalls.at(-1)?.result;
  const event = firstCapturedEvent(captured);
  const source = plan ?? radius ?? survey ?? {};
  const lookupCalls = captured.filter(
    (call) => call.name === "search_contacts" || call.name === "search_events",
  );
  const lookupTopicIds = [
    ...new Set(
      lookupCalls.flatMap((call) => {
        const args = call.args as { topicIds?: unknown };
        return Array.isArray(args?.topicIds)
          ? args.topicIds.filter((id): id is string => typeof id === "string")
          : [];
      }),
    ),
  ];

  if (decision.documentPlan) {
    if (decision.stage !== "plan" || decision.intent === "lookup") {
      throw new IncompleteAgentDecision(
        "A document plan requires a planning intent and the plan stage.",
      );
    }
    return {
      ...base,
      ok: true,
      mode: "llm",
      deterministicReason: null,
      answer: decision.answer,
      toolCalls,
      stage: "plan",
      clarify: null,
      category: null,
      leaderId: decision.leaderId,
      leaderName: null,
      menu: null,
      itinerary: null,
      tripMap: null,
      documentPlan: projectDocumentPlan(decision.documentPlan, captured),
    };
  }

  if (decision.stage === "options") {
    if (successfulBuildCalls.length < 2) {
      throw new IncompleteAgentDecision(
        "Agent returned options without at least two built itineraries.",
      );
    }
    const recommendedIndex = decision.recommendedOptionIndex ?? 0;
    if (
      !Number.isInteger(recommendedIndex) ||
      recommendedIndex < 0 ||
      recommendedIndex >= successfulBuildCalls.length
    ) {
      throw new IncompleteAgentDecision(
        "Agent recommended an itinerary option that was not built.",
      );
    }
    const options: AreaItineraryOption[] = successfulBuildCalls.map(
      (call, index) => {
        const result = call.result;
        const days = result?.duration?.days ?? result?.days ?? null;
        const accepted: any[] = result?.accepted ?? [];
        const roiScore = result?.roi?.roiScore ?? null;
        const overBudget = !!result?.roi?.overBudget;
        const categoryCounts = result?.categoryCoverage?.counts ?? null;
        const categoryMix = result?.categoryCoverage?.summary ?? null;
        return {
          id: `agent-option-${index + 1}`,
          tier: lengthSize(index, successfulBuildCalls.length),
          label:
            typeof days === "number"
              ? `${days}-day itinerary`
              : `Itinerary option ${index + 1}`,
          category: decision.category,
          summary:
            `${accepted.length} meeting(s) · ROI ${roi2(roiScore)}` +
            (overBudget ? " · OVER BUDGET" : ""),
          days,
          stopCount: accepted.length,
          roiScore,
          overBudget,
          recommended: index === recommendedIndex,
          contactIds: accepted
            .map((contact: any) => contact?.contactId)
            .filter(Boolean),
          ok: true,
          itinerary: extractItinerary(result),
          tripMap: result?.tripMap ?? null,
          categoryMix,
          categoryCounts,
          answer: call.text || null,
        };
      },
    );
    const recommended = options[recommendedIndex];
    const recommendedBuild = successfulBuildCalls[recommendedIndex].result;
    const leaderId = decision.leaderId ?? recommendedBuild?.leader?.id ?? null;
    return {
      ...base,
      ok: true,
      mode: "llm",
      deterministicReason: null,
      answer: decision.answer,
      toolCalls,
      stage: "options",
      clarify: null,
      category: decision.category,
      leaderId,
      leaderName: recommendedBuild?.leader?.name ?? null,
      event: recommendedBuild?.event ?? event,
      area: recommendedBuild?.area ?? source?.area ?? null,
      options,
      recommendedOptionId: recommended.id,
      menu: recommendedBuild?.accepted ?? null,
      itinerary: recommended.itinerary,
      tripMap: recommended.tripMap,
    };
  }

  if (decision.stage === "clarify") {
    if (decision.clarify === "category") {
      const question = categoryClarifyQuestion(plan?.categoryBreakdown ?? []);
      if (question.choices.length === 0) {
        throw new IncompleteAgentDecision(
          "Agent requested a category without grounded category options.",
        );
      }
      return {
        ...base,
        ok: true,
        mode: "llm",
        deterministicReason: null,
        answer: decision.answer,
        toolCalls,
        stage: "clarify",
        clarify: "category",
        category: null,
        leaderId: null,
        questions: [question],
        area: plan?.area ?? null,
        today: plan?.today ?? null,
        topicIds: plan?.topicIds ?? [],
        areaSurvey: plan?.areaSurvey ?? [],
        staleContacts: plan?.staleContacts ?? [],
        areaEvents: plan?.areaEvents ?? [],
        categoryBreakdown: plan?.categoryBreakdown ?? [],
      };
    }

    if (decision.clarify === "leader") {
      const leaders =
        leadersResult?.leaders ??
        plan?.leaderOptions ??
        radius?.leaderOptions ??
        [];
      if (leaders.length === 0) {
        throw new IncompleteAgentDecision(
          "Agent requested a leader without grounded leader options.",
        );
      }
      return {
        ...base,
        ok: true,
        mode: "llm",
        deterministicReason: null,
        answer: decision.answer,
        toolCalls,
        stage: "clarify",
        clarify: "leader",
        leaderId: null,
        event,
        area: leadersResult?.area ?? plan?.area ?? radius?.area ?? null,
        questions: [
          leaderClarifyQuestion(leaders, leaders[0]?.leaderId ?? null),
        ],
      };
    }

    throw new IncompleteAgentDecision(
      "Agent returned a clarification without a supported clarification type.",
    );
  }

  if (decision.stage === "answer" && decision.intent !== "lookup") {
    throw new IncompleteAgentDecision(
      "Agent returned an informational answer for a planning intent.",
    );
  }

  if (decision.stage === "plan" && decision.intent !== "lookup" && !build) {
    throw new IncompleteAgentDecision(
      "Agent marked the response as a plan without building an itinerary.",
    );
  }

  const projectionCaptured = [
    ...captured.filter((call) => call.name !== "build_itinerary"),
    ...successfulBuildCalls,
  ];
  const projected = assemble(
    base,
    "llm",
    decision.answer,
    toolCalls,
    projectionCaptured,
  );
  const itinerary = extractItinerary(build);
  const leaderId =
    decision.leaderId ??
    build?.leader?.id ??
    radius?.chosenLeaderId ??
    suggest?.leader?.id ??
    null;
  const leaderName =
    build?.leader?.name ??
    (
      plan?.leaderOptions ??
      radius?.leaderOptions ??
      leadersResult?.leaders ??
      []
    ).find((leader: any) => leader?.leaderId === leaderId)?.name ??
    null;
  const leaderShortlist = groundedLeaderShortlist(
    decision.category,
    leaderId,
    plan?.leaderOptions ?? radius?.leaderOptions ?? [],
  );
  const menu = projected.menu ?? build?.accepted ?? radius?.stops ?? null;

  return {
    ...projected,
    ok:
      decision.stage === "answer"
        ? decision.answer.trim().length > 0
        : itinerary != null,
    deterministicReason: null,
    stage: decision.stage === "answer" ? "answer" : "plan",
    clarify: null,
    category: decision.category,
    leaderId,
    leaderName,
    leaderShortlist,
    event,
    area: build?.area ?? source?.area ?? null,
    today: source?.today ?? build?.today ?? null,
    topicIds: source?.topicIds ?? suggest?.topicFocus ?? lookupTopicIds,
    areaSurvey: source?.areaSurvey ?? survey?.topics ?? [],
    staleContacts: source?.staleContacts ?? survey?.staleContacts ?? [],
    areaEvents: source?.areaEvents ?? survey?.areaEvents ?? [],
    categoryBreakdown:
      source?.categoryBreakdown ?? build?.categoryBreakdown ?? [],
    menu,
    itinerary,
    tripMap: build?.tripMap ?? null,
  };
}

export async function planTrip(req: PlanRequest): Promise<PlanResult> {
  const topN = req.topN ?? DEFAULT_TOPN();
  const url = req.serverUrl || DEFAULT_URL();

  const base: PlanResult = {
    ok: false,
    mode: "deterministic",
    question: req.question,
    answer: null,
    toolCalls: [],
    menu: null,
    itinerary: null,
    tripMap: null,
    stage: "plan",
    clarify: null,
  };

  const contextualQuestion = isContextualFollowUpQuestion(req.question);
  const suppliedEventContext = normalizeEventPlanContext(req.context);
  const eventContext = contextualQuestion ? suppliedEventContext : null;

  const contextualKind = eventContext
    ? contextualEventQuestionKind(req.question)
    : null;

  // Explicit schedule mutations are host-managed so a model can never invent or silently move a
  // meeting. All semantic reads and lookups go to Agent Framework first.
  if (eventContext && contextualKind === "schedule-edit") {
    let mutationClient: ToolClient;
    try {
      mutationClient = await makeToolClient(url);
    } catch (e: any) {
      throwIfGovernanceDenied(e);
      return toolClientFailure(base, url, e);
    }
    try {
      return await buildEventContextualFollowUp(
        mutationClient,
        base,
        eventContext,
        req.question,
      );
    } finally {
      await mutationClient.close().catch(() => {});
    }
  }

  // Microsoft Agent Framework is the primary semantic interface. Prior context is advisory and may
  // be stale; the agent decides whether the current question refers to it.
  if (isModelConfigured()) {
    // Ask the capability what it actually serves BEFORE composing a prompt. A grounding-only
    // deployment has no planner tools, and running the planning prompt against it produces a
    // confident answer built from the prompt's own catalogs instead of the customer's index.
    let capability: DiscoveredCapability | null = null;
    try {
      capability = await discoverGovernedTools({
        mcpUrl: url,
        discoveryMcpUrl: DISCOVERY_URL(),
      });
    } catch (error) {
      throwIfGovernanceDenied(error);
      console.warn(
        `[python-agent] capability discovery failed; using deterministic fallback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (capability) {
      const groundingOnly = capability.backend === "grounding";
      try {
        const loop = await runPythonAgent({
          system: groundingOnly
            ? buildGroundingSystemPrompt()
            : buildSystemPrompt(
                isSeedCatalog() ? resolveDefaultLeaderId() : null,
                topN,
                capability.tools.includes(GROUNDING_TOOL_NAME),
              ),
          user: buildAgentUserPrompt(
            req,
            groundingOnly ? null : suppliedEventContext,
          ),
          mcpUrl: url,
          maxIterations: 10,
          discoveryMcpUrl: DISCOVERY_URL(),
        });
        return agentDecisionToPlanResult(
          base,
          loop.decision,
          capturedFromAgent(loop),
        );
      } catch (error) {
        throwIfGovernanceDenied(error);
        // There is no deterministic planner for a document corpus: falling through would call nine
        // tools the capability does not register and report the failure as a planning result.
        if (groundingOnly) {
          return {
            ...base,
            deterministicReason: "grounding-only-capability",
            stage: "answer",
            error:
              `The grounded answer could not be produced from the document corpus at ${url}: ` +
              `${error instanceof Error ? error.message : String(error)}. ` +
              "This capability runs RETRIEVAL_BACKEND=grounding, so there is no deterministic " +
              "planner to fall back to.",
          };
        }
        console.warn(
          `[python-agent] framework decision failed; using deterministic fallback: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  if (
    contextualQuestion &&
    !eventContext &&
    requiresPriorGroundedContext(req.question)
  ) {
    return {
      ...base,
      deterministicReason: "contextual-follow-up",
      answer:
        "I need the prior grounded itinerary in this conversation to answer that follow-up. Reopen the plan or name the event, leader, and selected meetings.",
    };
  }

  let client: ToolClient;
  try {
    client = await makeToolClient(url);
  } catch (e: any) {
    throwIfGovernanceDenied(e);
    return toolClientFailure(base, url, e);
  }

  try {
    const topicIds = topicIdsFromText(req.question);
    if (isTopicLandscapeQuestion(req.question)) {
      return await buildTopicLandscape(client, topicIds, base);
    }

    if (eventContext && contextualQuestion) {
      return await buildEventContextualFollowUp(
        client,
        base,
        eventContext,
        req.question,
      );
    }

    // ── Deterministic fallback: area/category-first workflow for known-region asks ───────────────
    // A KNOWN-REGION ask ("Plan a trip to Boston", "what's worth doing in the Bay Area") drives a
    // CATEGORY-FIRST flow: survey the area, roll its hot topics / timely events / key contacts up by
    // engagement category, and ASK which audience to anchor on. Once the human picks a category (with
    // the trip's radius/days), build ONE single-audience itinerary for that audience and RECOMMEND the
    // best senior leader to send. The leader is the OUTPUT of the plan, not the first question. This
    // runs BEFORE the event branch so a region that merely HOSTS an event (Boston → New England Defense
    // Innovation Forum) still gets the category briefing rather than auto-anchoring on the event.
    const areaAnchor = areaAskAnchor(req.question);
    if (areaAnchor) {
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
          : `No engagements found around ${intel.area?.name ?? "this area"}.`,
        area: intel.area,
        today: intel.today,
        topicIds: intel.topicIds ?? topicIds,
        areaSurvey: intel.areaSurvey,
        staleContacts: intel.staleContacts,
        areaEvents: intel.areaEvents,
        categoryBreakdown: intel.categoryBreakdown,
        questions: hasCats ? [catQ] : [],
        toolCalls: toolCalls(),
      };
    }

    // ── Deterministic fallback: leader-first options for an explicitly named event ───────────────
    // When the ask anchors on an authorized EVENT the user NAMES ("a trip to AUSA") — and the token is
    // not itself a known region — keep the "you're already going there" flow: make WHO explicit (a
    // ranked roster), then present several DIFFERENT-LENGTH itineraries (conference footprint → regional
    // swing) to compare. Radius asks ("3 days within 60 mi of Reston") keep the legacy path.
    const event = await resolveEventAnchor(client, req.question);
    if (event) {
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
      });
      const pr = optionsToPlanResult(base, opts, event);
      pr.deterministicReason = "event-anchored";
      pr.toolCalls = client.captured.map((c) => ({
        name: c.name,
        args: c.args,
      }));
      return pr;
    }

    // ── Deterministic single-itinerary fallback (non-event asks: radius trips, free-form) ───────
    const leaderId = req.leaderId || resolveDefaultLeaderId();
    const deterministicReason: DeterministicReason = isModelConfigured()
      ? "model-unavailable"
      : "model-not-configured";

    await deterministicPlan(client, {
      question: req.question,
      leaderId,
      topN,
    });
    const toolCalls = client.captured.map((c) => ({
      name: c.name,
      args: c.args,
    }));
    const answer = answerFromCaptured(client.captured);

    return assemble(
      base,
      "deterministic",
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
// resolves the anchor and shapes the option menus for the UI.
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
  /** `clarify` = needs a decision; `options` = menus ready; `unavailable` = no planner surface. */
  stage: "clarify" | "options" | "unavailable";
  /** When `stage:'clarify'`, WHICH decision is pending (drives the single question returned). */
  clarify: "area" | "leader" | null;
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
  /** The option groups the UI renders (who/how long/extensions), or the single "which area?" ask. */
  questions: OptionQuestion[];
  error?: string;
}

export interface AreaBuildRequest {
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
  question: string | null,
  window: { start: string; end: string } | null,
): AreaOptionsResult {
  return {
    ok: false,
    stage: "options",
    clarify: null,
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
  const url = req.serverUrl || DEFAULT_URL();
  const window = req.window || defaultWindow();

  const area = resolveAreaAnchor(req);
  if (!area) {
    return {
      ...emptyOptions(req.question ?? null, window),
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
    client = await makeToolClient(url);
  } catch (e: any) {
    throwIfGovernanceDenied(e);
    if (e instanceof GroundingOnlyCapabilityError) {
      return {
        ...emptyOptions(req.question ?? null, window),
        stage: "unavailable",
        answer:
          "Guided trip planning is unavailable in document search mode. Ask a question about the indexed documents, or use a planner-backed data source for contacts, events, and leaders.",
      };
    }
    return {
      ...emptyOptions(req.question ?? null, window),
      error:
        `Cannot initialize the governed Python agent path for engagements MCP ${url}: ${e?.message || e}. ` +
        "Start the MCP server and the engagements agent workspace services.",
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
        ...emptyOptions(req.question ?? null, window),
        stage: "clarify",
        clarify: "area",
        answer: plan.error,
        questions: [areaClarifyQuestion()],
      };
    }

    const leaderOptions: any[] = plan.leaderOptions ?? [];

    // STAGE 1a — ask WHO first. When the caller has not named a leader, make choosing the senior
    // leader an explicit decision (top pick flagged recommended) before we shape the duration and
    // extension menus, which are leader-specific. The UI re-calls plan-options with the picked
    // leaderId to advance to the option menus.
    if (!req.leaderId && leaderOptions.length > 0) {
      return {
        ...emptyOptions(req.question ?? null, plan.window ?? window),
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
        questions: [leaderClarifyQuestion(leaderOptions, plan.chosenLeaderId)],
      };
    }

    return {
      ok: (plan.leaderOptions?.length ?? 0) > 0,
      stage: "options",
      clarify: null,
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
      questions: buildOptionQuestions(plan),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Backend-aware entry for the UI's "Plan a trip" action. Structured backends retain the existing
 * deterministic option wizard; a grounding-only corpus uses the skill-enabled model path and
 * returns a cited documentPlan (or a grounded explanation of what evidence is missing).
 */
export async function planGuidedTrip(
  req: AreaOptionsRequest,
): Promise<AreaOptionsResult | PlanResult> {
  const url = req.serverUrl || DEFAULT_URL();
  let capability: DiscoveredCapability;
  try {
    capability = await discoverGovernedTools({
      mcpUrl: url,
      discoveryMcpUrl: DISCOVERY_URL(),
    });
  } catch {
    return planAreaOptions(req);
  }

  if (capability.backend === "planner") {
    return planAreaOptions(req);
  }

  const cityState = [req.city, req.state].filter(Boolean).join(", ");
  const explicitArea = req.region ?? (cityState || undefined) ?? req.regionId;
  const question =
    req.question?.trim() ||
    (explicitArea
      ? `Plan a trip to ${explicitArea} using the indexed documents.`
      : "Help me plan a trip using the indexed documents. Identify the event or destination details you need from me.");
  return planTrip({
    question,
    radiusMi: req.radiusMi,
    serverUrl: url,
  });
}

/** Project a build_itinerary structuredContent into the compact itinerary the chat host renders. */
function extractItinerary(build: any): any | null {
  if (!build) return null;
  return {
    leader: build.leader,
    event: build.event,
    anchor: build.anchor,
    area: build.area,
    window: build.window,
    days: build.duration?.days ?? build.days,
    duration: build.duration,
    meetingsPerDay: build.meetingsPerDay,
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
  const itinerary = extractItinerary(build);
  return {
    ...base,
    ok: itinerary != null,
    toolCalls: captured.map((c) => ({ name: c.name, args: c.args })),
    menu: build?.accepted ?? null,
    itinerary,
    tripMap: build?.tripMap ?? null,
  };
}

/**
 * STAGE 2 — turn the human's picks (leader + duration tier + toggled extensions) into the final
 * itinerary + ui://trip-map. Prefers the UI-supplied `acceptedContactIds` (already derived from the
 * option menus); otherwise re-runs `plan_options` for the chosen leader to derive them. Always calls
 * `build_itinerary`, which re-resolves every id server-side.
 */
export async function buildAreaItinerary(
  req: AreaBuildRequest,
): Promise<PlanResult> {
  const url = req.serverUrl || DEFAULT_URL();
  const window = req.window || defaultWindow();

  const base: PlanResult = {
    ok: false,
    mode: "deterministic",
    question: req.leaderId
      ? `Build itinerary for ${req.leaderId}`
      : "Build itinerary",
    answer: null,
    toolCalls: [],
    menu: null,
    itinerary: null,
    tripMap: null,
  };

  if (!req.leaderId)
    return { ...base, error: "leaderId is required to build an itinerary." };

  const area = resolveAreaAnchor(req);

  let client: ToolClient;
  try {
    client = await makeToolClient(url);
  } catch (e: any) {
    throwIfGovernanceDenied(e);
    return {
      ...base,
      error:
        `Cannot initialize the governed Python agent path for engagements MCP ${url}: ${e?.message || e}. ` +
        "Start the MCP server and the engagements agent workspace services.",
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
  const url = req.serverUrl || DEFAULT_URL();
  const window = req.window || defaultWindow();

  const empty: AreaItineraryOptionsResult = {
    ok: false,
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
    client = await makeToolClient(url);
  } catch (e: any) {
    throwIfGovernanceDenied(e);
    return {
      ...empty,
      error:
        `Cannot initialize the governed Python agent path for engagements MCP ${url}: ${e?.message || e}. ` +
        "Start the MCP server and the engagements agent workspace services.",
    };
  }

  try {
    const topicIds = req.topicIds ?? [];
    const anchorArgs = areaArgs(area, req.radiusMi);
    const maxDays = Math.max(1, Math.round(req.maxDays ?? 7));

    // A fixed-duration (radius) build_itinerary: fills `days × meetingsPerDay` best stops
    // in the area — NO event anchor, so `days` fully controls the trip length. When `acceptedContactIds`
    // is passed it routes EXACTLY that set (re-resolved server-side) — the seam that forces a
    // single-audience itinerary. Auto-fills (capacity) when omitted (the probe).
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
    if (probe.error) return { ...empty, error: probe.error };

    const base = {
      ...empty,
      area: probe.area ?? null,
      window: probe.window ?? window,
      today: probe.today ?? null,
      topicIds,
      leaderName: probe.leader?.name ?? null,
      categoryBreakdown: probe.categoryBreakdown ?? [],
    };

    const availableStops = probe.accepted?.length ?? 0;
    if (availableStops === 0)
      return {
        ...base,
        error: `No stops in ${probe.area?.name ?? "this area"} for ${req.leaderId}.`,
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
  leaderId: string | null,
): AreaItineraryOptionsResult {
  return {
    ok: false,
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
    event: null,
  };
}

/**
 * Decide whether an ask is EVENT-anchored (vs. a radius/free-form trip) and resolve the anchor event.
 * Returns the top event matching the question's anchor token, or null. A parseable radius
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
  } catch (error) {
    throwIfGovernanceDenied(error);
    return null;
  }
  const res = lastCapture(client.captured, "search_events")?.result ?? {};
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
  } catch (error) {
    throwIfGovernanceDenied(error);
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
    };
  } catch (error) {
    throwIfGovernanceDenied(error);
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
    maxDays?: number;
  },
): Promise<AreaItineraryOptionsResult> {
  const topicIds = args.topicIds ?? [];
  const empty = emptyEventOptions(args.leaderId);

  // 1) The on-site + local nearby pool (the "you're already going there" batch) + the resolved event.
  await client.callTool("suggest_candidates", {
    leaderId: args.leaderId,
    ...(args.eventId ? { eventId: args.eventId } : {}),
    ...(args.eventQuery ? { eventQuery: args.eventQuery } : {}),
    ...(topicIds.length ? { topicIds } : {}),
  });
  const sug = lastCapture(client.captured, "suggest_candidates")?.result ?? {};
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
  };
  if (nearbyIds.length === 0) {
    return {
      ...base,
      error: `No candidates for ${args.leaderId} at ${event.name}.`,
    };
  }

  // 2) Far, on-topic, ACTIVE stops beyond the nearby pool — the regional-swing sources,
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
  const url = req.serverUrl || DEFAULT_URL();
  const empty = emptyEventOptions(req.leaderId ?? null);
  if (!req.leaderId)
    return {
      ...empty,
      error: "leaderId is required to build itinerary options.",
    };

  let client: ToolClient;
  try {
    client = await makeToolClient(url);
  } catch (e: any) {
    throwIfGovernanceDenied(e);
    return {
      ...empty,
      error:
        `Cannot initialize the governed Python agent path for engagements MCP ${url}: ${e?.message || e}. ` +
        "Start the MCP server and the engagements agent workspace services.",
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
    topicIds: opts.topicIds ?? base.topicIds ?? [],
    options: opts.options,
    recommendedOptionId: opts.recommendedOptionId,
    itinerary: rec?.itinerary ?? null,
    tripMap: rec?.tripMap ?? null,
    menu: rec?.itinerary?.accepted ?? null,
    categoryBreakdown:
      opts.categoryBreakdown ?? (base as any).categoryBreakdown ?? [],
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
  error?: string;
}

/**
 * STAGE 2 (category-first) — build ONE single-audience itinerary for the chosen engagement category and
 * recommend WHO should go. Reuses the open client + the intel already gathered by {@link rankRosterForArea}
 * (ranked `leaderOptions` + the per-audience `categoryBreakdown`): route EXACTLY the chosen audience's
 * in-area contacts (`acceptedContactIds`, re-resolved server-side → never blends audiences), then rank
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
  };
  if (contactIds.length === 0) {
    return {
      ...base,
      error: `No ${label} engagements in ${args.areaResolved?.name ?? "this area"} to build a trip around.`,
    };
  }

  // The itinerary is single-audience regardless of leader (we force this audience's contacts), so any
  // leader routes the same stops; the leader only re-tunes ROI/availability (the "who should
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
  questions: OptionQuestion[];
  error?: string;
}

export interface RadiusBuildRequest {
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
 * trip plus the who/extend menus.
 */
export async function planRadiusOptions(
  req: RadiusOptionsRequest,
): Promise<RadiusOptionsResult> {
  const url = req.serverUrl || DEFAULT_URL();
  const window = req.window || defaultWindow();

  const empty: RadiusOptionsResult = {
    ok: false,
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
    questions: [],
  };

  let client: ToolClient;
  try {
    client = await makeToolClient(url);
  } catch (e: any) {
    throwIfGovernanceDenied(e);
    return {
      ...empty,
      error:
        `Cannot initialize the governed Python agent path for engagements MCP ${url}: ${e?.message || e}. ` +
        "Start the MCP server and the engagements agent workspace services.",
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

    return {
      ok: (plan.stops?.length ?? 0) > 0,
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
      questions: buildRadiusQuestions(plan),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * STAGE 2 (radius) — turn the human's picks (leader + toggled extensions) into the final event-less
 * itinerary + ui://trip-map. `build_itinerary` re-resolves every id server-side.
 */
export async function buildRadiusItinerary(
  req: RadiusBuildRequest,
): Promise<PlanResult> {
  const url = req.serverUrl || DEFAULT_URL();
  const window = req.window || defaultWindow();

  const base: PlanResult = {
    ok: false,
    mode: "deterministic",
    question: req.leaderId
      ? `Build radius itinerary for ${req.leaderId}`
      : "Build radius itinerary",
    answer: null,
    toolCalls: [],
    menu: null,
    itinerary: null,
    tripMap: null,
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
    client = await makeToolClient(url);
  } catch (e: any) {
    throwIfGovernanceDenied(e);
    return {
      ...base,
      error:
        `Cannot initialize the governed Python agent path for engagements MCP ${url}: ${e?.message || e}. ` +
        "Start the MCP server and the engagements agent workspace services.",
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
// Ranks the seed taxonomy by the caller's live footprint: active vs prospect
// contacts, on-site events, upcoming events, and whether an approved message exists. The UI shows
// these as chips; clicking one just sends the topic's `question` to the free-form /ask agent, so
// the human can then steer wherever they like.
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
  serverUrl?: string;
}

export interface HotTopicsResult {
  ok: boolean;
  topics: HotTopic[];
  error?: string;
}

/** The free-form question a hot-topic chip sends to the agent. */
export function hotTopicQuestion(name: string): string {
  return `What's the engagement picture on ${name} right now — who should we meet, where is it most active, and is there an approved message?`;
}

/**
 * Pure ranker: fold the caller's contacts + events into a per-topic footprint and
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
 * Rank the seed topics by the caller's footprint. Two cheap tool calls
 * (search_contacts + search_events with no filter) feed the pure ranker above.
 */
export async function hotTopics(
  req: HotTopicsRequest,
): Promise<HotTopicsResult> {
  const url = req.serverUrl || DEFAULT_URL();
  const base: HotTopicsResult = {
    ok: false,
    topics: [],
  };

  let client: ToolClient;
  try {
    client = await makeToolClient(url);
  } catch (e: any) {
    throwIfGovernanceDenied(e);
    return {
      ...base,
      error:
        `Cannot initialize the governed Python agent path for engagements MCP ${url}: ${e?.message || e}. ` +
        "Start the MCP server and the engagements agent workspace services.",
    };
  }

  try {
    const contactsRes: any = await client.callTool("search_contacts", {});
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
    };
  } catch (e: any) {
    throwIfGovernanceDenied(e);
    return { ...base, error: e?.message || String(e) };
  } finally {
    await client.close().catch(() => {});
  }
}

// ── Area discovery: organizations in the travel area the traveler does NOT already track ─────────
//
// The Area Discovery capability returns PUBLIC place data with no relationship history, so the
// "is this new?" judgement is made HERE, by diffing those names against the caller's contacts.

/** Corporate suffixes and articles stripped before matching a POI name to a tracked organization. */
const ORG_NOISE =
  /\b(inc|llc|corp|corporation|co|company|ltd|limited|plc|group|holdings|the)\b/g;

/** Shorter normalized names are matched only on equality — "ABC" must not swallow "ABC Systems". */
const MIN_CONTAINMENT_LENGTH = 5;

export function normalizeOrgName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(ORG_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface AreaBusiness {
  name: string;
  category: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number;
  lng: number;
  distanceMi: number | null;
  url: string | null;
  /** Contact id when this business is already a tracked relationship. */
  knownContactId: string | null;
  knownContactName: string | null;
}

/** Pure diff — exported so the matching rules are testable without a server. */
export function diffAgainstKnownContacts(
  businesses: any[],
  contacts: any[],
): AreaBusiness[] {
  const known = contacts
    .map((c) => ({ contact: c, org: normalizeOrgName(String(c?.org ?? "")) }))
    .filter((entry) => entry.org.length > 0);

  return businesses.map((b): AreaBusiness => {
    const name = normalizeOrgName(String(b?.name ?? ""));
    const hit = name
      ? known.find(({ org }) => {
          if (org === name) return true;
          const shorter = Math.min(org.length, name.length);
          if (shorter < MIN_CONTAINMENT_LENGTH) return false;
          return org.includes(name) || name.includes(org);
        })
      : undefined;

    return {
      name: b?.name ?? "",
      category: b?.category ?? null,
      address: b?.address ?? null,
      city: b?.city ?? null,
      state: b?.state ?? null,
      lat: b?.lat,
      lng: b?.lng,
      distanceMi: b?.distanceMi ?? null,
      url: b?.url ?? null,
      knownContactId: hit?.contact?.id ?? null,
      knownContactName: hit?.contact?.name ?? hit?.contact?.org ?? null,
    };
  });
}

export interface DiscoverAreaRequest {
  city?: string;
  state?: string;
  lat?: number;
  lng?: number;
  query?: string;
  focus?: string[];
  radiusMi?: number;
  limit?: number;
  serverUrl?: string;
}

export interface DiscoverAreaResult {
  ok: boolean;
  anchor: any | null;
  /** Every business found, each flagged known/new. */
  businesses: AreaBusiness[];
  /** Only the ones with no matching relationship — the "make me aware" list. */
  newBusinesses: AreaBusiness[];
  knownCount: number;
  error?: string;
}

/**
 * Sweep the area around a travel anchor and report which organizations are NEW to this caller.
 *
 * Both calls go through the governed Python runtime, so AGT policy and the hash-chained audit log
 * cover the discovery lookup exactly like every engagements tool.
 */
export async function discoverAreaBusinesses(
  req: DiscoverAreaRequest,
): Promise<DiscoverAreaResult> {
  const url = req.serverUrl || DEFAULT_URL();
  const base: DiscoverAreaResult = {
    ok: false,
    anchor: null,
    businesses: [],
    newBusinesses: [],
    knownCount: 0,
  };

  if (
    !req.city &&
    !(typeof req.lat === "number" && typeof req.lng === "number")
  ) {
    return {
      ...base,
      error:
        "Provide an anchor: a city (with optional state) or a lat/lng pair.",
    };
  }

  let client: ToolClient;
  try {
    client = await makeToolClient(url);
  } catch (e: any) {
    throwIfGovernanceDenied(e);
    return {
      ...base,
      error:
        `Cannot initialize the governed Python agent path for engagements MCP ${url}: ${e?.message || e}. ` +
        "Start the MCP server and the engagements agent workspace services.",
    };
  }

  try {
    const found: any = await client.callTool("search_businesses", {
      city: req.city,
      state: req.state,
      lat: req.lat,
      lng: req.lng,
      query: req.query,
      focus: req.focus,
      radiusMi: req.radiusMi,
      limit: req.limit,
    });
    if (found?.error) return { ...base, error: String(found.error) };

    const contactsRes: any = await client.callTool("search_contacts", {
      query: req.city || undefined,
    });

    const businesses = diffAgainstKnownContacts(
      found?.businesses ?? [],
      contactsRes?.contacts ?? [],
    );
    const newBusinesses = businesses.filter((b) => b.knownContactId === null);

    return {
      ...base,
      ok: true,
      anchor: found?.anchor ?? null,
      businesses,
      newBusinesses,
      knownCount: businesses.length - newBusinesses.length,
    };
  } catch (e: any) {
    throwIfGovernanceDenied(e);
    return { ...base, error: e?.message || String(e) };
  } finally {
    await client.close().catch(() => {});
  }
}
