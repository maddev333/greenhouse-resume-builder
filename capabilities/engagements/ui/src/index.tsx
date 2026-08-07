/**
 * Chat host UI (M6). A chat window that calls the M5 orchestrator (/ask) and
 * renders its answer, its option menu (candidate cards), and — when the orchestrator returns a
 * `tripMap` — the sandboxed ui://trip-map MCP App via <TripMapHost> (see ./implementation).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  connectToServer,
  getUiResource,
  renderTripMapApp,
  log,
} from "./implementation";
import { loadConfig, type HostConfig } from "./config";
import { getTheme, toggleTheme, onThemeChange, type Theme } from "./theme";
import "./global.css";

const TRIP_MAP_RESOURCE_URI = "ui://trip-map/trip-map.html";

const SAMPLE_QUESTION =
  "I'm planning a trip to AUSA — who should I meet on the UAS/drone topic?";

// Region quick-picks for the interactive planner (the known seed regions). Clicking one anchors
// the area and asks the orchestrator for the who/how-long/extensions option menus.
const REGION_QUICKPICKS: { regionId: string; label: string }[] = [
  { regionId: "R-NCR", label: "NCR" },
  { regionId: "R-BOSTON", label: "Boston" },
  { regionId: "R-BAY-AREA", label: "Bay Area" },
  { regionId: "R-FRONT-RANGE", label: "Front Range" },
  { regionId: "R-CENTRAL-TX", label: "Central TX" },
];

// ---- orchestrator response (loose mirror of PlanResult) -------------------------------------
interface MenuItem {
  contactId: string;
  name: string;
  city?: string;
  state?: string;
  placement?: string;
  kind?: string;
  status?: string;
  isStale?: boolean;
  strategicValue?: number;
  score?: number;
  distanceMi?: number;
  fitFlags?: string[];
}

// The full itinerary carried inside one option — the "drill-down" detail the EA explores on select.
interface ItineraryLeg {
  from?: string;
  to?: string;
  mode?: string;
  distanceMi?: number;
  estTravelMins?: number;
}

interface ItineraryRoute {
  order?: { id: string; city?: string; kind?: string }[];
  legs?: ItineraryLeg[];
  totalMi?: number;
  totalTravelMins?: number;
}

interface ItineraryRoi {
  roiScore?: number;
  breakdown?: {
    grossValue?: number;
    airfare?: number;
    perDiem?: number;
    timePenalty?: number;
    totalCost?: number;
  };
  days?: number;
  overBudget?: boolean;
}

interface ItineraryConflict {
  type?: string;
  severity?: string;
  message?: string;
  recommendation?: string;
}

interface NearbyLeaderRef {
  leaderId: string;
  name?: string;
  role?: string;
  level?: string;
  homeBaseCity?: string;
  distanceMi?: number;
  homeBaseDistanceMi?: number;
  availableInWindow?: boolean;
  primaryReason?: string;
}

interface ItineraryDetail {
  leader?: {
    id?: string;
    name?: string;
    role?: string;
    daysAwayBudget?: number;
  };
  event?: {
    id?: string;
    name?: string;
    city?: string;
    state?: string;
    start?: string;
    end?: string;
  };
  accepted?: MenuItem[];
  route?: ItineraryRoute;
  roi?: ItineraryRoi;
  conflicts?: ItineraryConflict[];
  nearbyLeaders?: NearbyLeaderRef[];
  notMatched?: string[];
}

// One ranked "who should go" candidate for a chosen engagement category (category-first flow).
interface LeaderPick {
  leaderId: string;
  name?: string | null;
  role?: string | null;
  score?: string | number | null;
  distanceMi?: number | null;
  availableInWindow?: boolean | null;
  why?: string;
  recommended?: boolean;
  /** Whether the current plan was built for this leader (the human's pick, else the recommendation). */
  selected?: boolean;
}

// One finished itinerary scope from the leader-first `/ask` flow.
interface AskOption {
  id: string;
  tier?: string;
  label?: string;
  /** The single engagement audience this itinerary reaches (e.g. "industry"); null on length-based options. */
  category?: string | null;
  summary?: string;
  days?: number | null;
  stopCount?: number;
  roiScore?: number | null;
  overBudget?: boolean;
  recommended?: boolean;
  contactIds?: string[];
  ok?: boolean;
  itinerary?: ItineraryDetail | null;
  tripMap?: unknown;
  categoryMix?: string | null;
  categoryCounts?: Record<string, number> | null;
  answer?: string | null;
}

interface DocumentPlanCitation {
  id: string;
  title?: string | null;
  url?: string | null;
  parentId?: string | null;
}

interface DocumentPlanMeeting {
  target: string;
  organization?: string | null;
  purpose: string;
  location?: string | null;
  time?: string | null;
  sourceIds: string[];
}

interface DocumentPlanDay {
  day: number;
  date?: string | null;
  location?: string | null;
  meetings: DocumentPlanMeeting[];
  notes: string[];
}

interface DocumentTripPlan {
  title: string;
  event?: string | null;
  destination?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  summary: string;
  days: DocumentPlanDay[];
  sourceIds: string[];
  gaps: string[];
  citations: DocumentPlanCitation[];
}

interface PlanResult {
  ok?: boolean;
  mode?: string;
  /** When mode === 'deterministic', WHY the LLM path wasn't used (surfaced as a hoverable "why" chip). */
  deterministicReason?: string | null;
  question?: string;
  answer?: string;
  toolCalls?: { name: string }[];
  menu?: MenuItem[] | null;
  itinerary?: ItineraryDetail | null;
  tripMap?: unknown;
  documentPlan?: DocumentTripPlan | null;
  error?: string;

  // Leader-first, multi-option `/ask` envelope (additive; absent on the legacy single-plan path).
  stage?: "clarify" | "options" | "plan" | "answer";
  clarify?: "leader" | "category" | null;
  /** The engagement category the plan is anchored on (category-first flow). */
  category?: string | null;
  /** Ranked "who should go" shortlist for the chosen category — recommended first (stage 'plan'). */
  leaderShortlist?: LeaderPick[];
  questions?: OptionQuestion[];
  options?: AskOption[];
  recommendedOptionId?: string | null;
  leaderId?: string | null;
  leaderName?: string | null;
  event?: {
    id?: string;
    name?: string;
    city?: string;
    state?: string;
    start?: string;
    end?: string;
  } | null;

  // Area intel for the clarify/options briefing ("what's worth doing there", before a leader is picked).
  area?: {
    id?: string;
    name?: string;
    city?: string;
    state?: string;
    radiusMi?: number;
  } | null;
  today?: string | null;
  topicIds?: string[];
  areaSurvey?: AreaSurveyTopic[];
  staleContacts?: StaleContactRef[];
  areaEvents?: AreaEventRef[];
  categoryBreakdown?: CategoryCoverageRef[];
  conversationContext?: EventPlanContext | null;
}

interface EventPlanContext {
  version: 1;
  kind: "event";
  leaderId: string;
  eventId: string;
  contactIds: string[];
  topicIds?: string[];
  dayAssignments?: Record<string, number>;
}

interface ConversationHistoryMessage {
  role: "user" | "assistant";
  text: string;
}

/** Reduce the last rendered plan to ids only; the gateway re-resolves every id before follow-up use. */
function eventPlanContextFromResult(
  result: PlanResult,
  selectedOption?: AskOption,
): EventPlanContext | null {
  if (result.conversationContext) {
    return result.conversationContext;
  }
  const recommended =
    selectedOption ??
    result.options?.find(
      (option) => option.id === result.recommendedOptionId,
    ) ??
    result.options?.find((option) => option.recommended) ??
    null;
  const itinerary = recommended?.itinerary ?? result.itinerary ?? null;
  const leaderId = result.leaderId ?? itinerary?.leader?.id;
  const eventId = result.event?.id ?? itinerary?.event?.id;
  const contactIds = [
    ...new Set(
      (
        recommended?.contactIds ??
        itinerary?.accepted?.map((contact) => contact.contactId) ??
        result.menu?.map((contact) => contact.contactId) ??
        []
      ).filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  if (!leaderId || !eventId || contactIds.length === 0) return null;
  return {
    version: 1,
    kind: "event",
    leaderId,
    eventId,
    contactIds,
    ...(result.topicIds?.length ? { topicIds: result.topicIds } : {}),
  };
}

// Human-readable "why this turn was deterministic" (mode !== llm) — hover the chip for the full reason.
// Keys mirror the orchestrator's DeterministicReason union.
const DETERMINISTIC_REASON: Record<string, { short: string; detail: string }> =
  {
    "area-anchored": {
      short: "area-anchored",
      detail:
        "The model was unavailable, so the governed deterministic fallback used the named region's area/category planner.",
    },
    "event-anchored": {
      short: "event-anchored",
      detail:
        "The model was unavailable, so the governed deterministic fallback used the matched event's leader-first planner.",
    },
    "contextual-follow-up": {
      short: "grounded follow-up",
      detail:
        "This request elaborates the prior itinerary. The agent reused recent conversation for reference resolution, re-authorized the plan's ids through the tools, and retained any explicit day assignments before answering.",
    },
    "topic-landscape": {
      short: "topic lookup",
      detail:
        "The model was unavailable, so the governed deterministic fallback searched authorized contacts and events for the requested topic and reported approved-message availability from the grounded catalog.",
    },
    "mcp-unavailable": {
      short: "planner unavailable",
      detail:
        "The engagements MCP capability server couldn't be reached, so no planner or model turn was possible. Check that the MCP server is running.",
    },
    "model-not-configured": {
      short: "model not configured",
      detail:
        "Azure OpenAI isn't configured (AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_DEPLOYMENT), so the deterministic router answered.",
    },
    "model-unavailable": {
      short: "model unavailable",
      detail:
        "Azure OpenAI is configured but the call failed or returned nothing, so the deterministic router answered. Check the orchestrator logs for [agent-loop] warnings.",
    },
  };

// ---- interactive planner (/plan-options + /build) -------------------------------------------
interface OptionChoice {
  value: string;
  label: string;
  detail?: string;
  selected?: boolean;
  recommended?: boolean;
}

interface OptionQuestion {
  id: "area" | "category" | "leader" | "duration" | "extensions";
  kind: "single" | "multi";
  prompt: string;
  choices: OptionChoice[];
}

interface AreaSurveyTopic {
  topicId: string;
  name?: string;
  activeCount?: number;
  prospectCount?: number;
  staleCount?: number;
  eventCount?: number;
  hasApprovedMessage?: boolean;
  opportunityScore?: number;
  reason?: string;
}

// Active in-area relationship overdue for a touch (the "re-engage while you're there" list).
interface StaleContactRef {
  contactId: string;
  name?: string;
  org?: string;
  city?: string;
  state?: string;
  strategicValue?: number;
  monthsSinceContact?: number;
  overdueDays?: number;
  reason?: string;
}

// In-area event with a freshness verdict + why.
interface AreaEventRef {
  eventId: string;
  name?: string;
  city?: string;
  status?: "lapsed" | "in-window" | "upcoming";
  daysUntil?: number;
  daysSince?: number;
  reason?: string;
}

// Per-audience coverage — the "identification across Congressional / Academia / Industry / Army-internal"
// outcome: how big each audience's in-area footprint is and how much of it the trip's options reach.
interface CategoryCoverageRef {
  category: string;
  label?: string;
  total?: number;
  activeCount?: number;
  prospectCount?: number;
  staleCount?: number;
  onItineraryCount?: number;
  covered?: boolean;
  reason?: string;
  contacts?: {
    contactId: string;
    name?: string;
    org?: string;
    city?: string;
    onItinerary?: boolean;
  }[];
}

// Loose mirror of the orchestrator's AreaOptionsResult.
interface OptionsResult {
  ok?: boolean;
  stage?: "clarify" | "options" | "unavailable";
  answer?: string | null;
  area?: {
    id?: string;
    name?: string;
    city?: string;
    state?: string;
    radiusMi?: number;
  } | null;
  window?: { start: string; end: string } | null;
  today?: string | null;
  topicIds?: string[];
  areaSurvey?: AreaSurveyTopic[];
  staleContacts?: StaleContactRef[];
  areaEvents?: AreaEventRef[];
  categoryBreakdown?: CategoryCoverageRef[];
  absorbedEventIds?: string[];
  questions?: OptionQuestion[];
  error?: string;
}

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text?: string;
  result?: PlanResult;
  options?: OptionsResult;
  error?: string;
}

// Loose mirror of the orchestrator's HotTopic (GET /topics) — a topic-first way to start a search.
interface HotTopic {
  topicId: string;
  name: string;
  reason: string;
  question: string;
  hasApprovedMessage?: boolean;
}

let nextId = 1;

// ============================================================================================
// Embedded MCP App host: renders the orchestrator's tripMap as the sandboxed ui://trip-map App.
// ============================================================================================
function TripMapHost({
  config,
  tripMap,
  answer,
}: {
  config: HostConfig;
  tripMap: unknown;
  answer?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const startedRef = useRef(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [errMsg, setErrMsg] = useState<string>("");

  useEffect(() => {
    if (startedRef.current) return; // guard against double-invoke
    startedRef.current = true;

    let disposed = false;
    let bridge: AppBridge | undefined;
    let client: Awaited<ReturnType<typeof connectToServer>> | undefined;
    const container = containerRef.current!;

    const iframe = document.createElement("iframe");
    iframe.title = "Trip map";
    iframe.style.cssText =
      "width:100%; height:440px; border:none; border-radius:8px; background:transparent;";
    container.appendChild(iframe);

    (async () => {
      try {
        client = await connectToServer(config.engagementsMcpUrl);
        const resource = await getUiResource(client, TRIP_MAP_RESOURCE_URI);
        if (disposed) return;
        bridge = await renderTripMapApp({
          client,
          iframe,
          sandboxProxyBaseUrl: config.sandboxProxyBaseUrl,
          resource,
          tripMap,
          answer,
          toolInput: { source: "engagements-orchestrator" },
        });
        if (!disposed) setStatus("ready");
      } catch (e) {
        log.error("TripMapHost failed:", e);
        if (!disposed) {
          setErrMsg(e instanceof Error ? e.message : String(e));
          setStatus("error");
        }
      }
    })();

    return () => {
      disposed = true;
      try {
        bridge?.close();
      } catch {
        /* noop */
      }
      try {
        client?.close();
      } catch {
        /* noop */
      }
      iframe.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="tripmap">
      <div className="tripmap-head">
        <span className="tripmap-title">🗺️ Trip map · ui://trip-map</span>
        <span className={`chip chip-${status}`}>
          {status === "loading"
            ? "loading sandboxed app…"
            : status === "ready"
              ? "MCP App"
              : "unavailable"}
        </span>
      </div>
      {status === "error" && (
        <div className="tripmap-error">
          Could not embed the trip-map app: {errMsg}
          <div className="muted">
            Is the engagements MCP server running on :3010 and the sandbox proxy
            on :8081?
          </div>
        </div>
      )}
      <div ref={containerRef} className="tripmap-frame" />
    </div>
  );
}

// ============================================================================================
// Menu (candidate) cards
// ============================================================================================
function MenuCard({ item, index }: { item: MenuItem; index: number }) {
  const where = [item.city, item.state].filter(Boolean).join(", ");
  return (
    <div className="card">
      <div className="card-top">
        <span className="card-rank">{index + 1}</span>
        <span className="card-name">{item.name}</span>
        {item.isStale && <span className="badge badge-stale">stale</span>}
        {item.status && (
          <span className={`badge badge-${item.status}`}>{item.status}</span>
        )}
      </div>
      <div className="card-sub">
        {where && <span>📍 {where}</span>}
        {item.placement && <span>· {item.placement}</span>}
        {item.kind && <span>· {item.kind}</span>}
      </div>
      <div className="card-metrics">
        {typeof item.strategicValue === "number" && (
          <span>value {item.strategicValue}</span>
        )}
        {typeof item.score === "number" && <span>score {item.score}</span>}
        {typeof item.distanceMi === "number" && (
          <span>{item.distanceMi} mi</span>
        )}
        {item.contactId && <span className="muted">{item.contactId}</span>}
      </div>
      {item.fitFlags && item.fitFlags.length > 0 && (
        <div className="card-flags">
          {item.fitFlags.map((f) => (
            <span key={f} className="flag">
              {f}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================================
// Interactive planner bubble — ask questions + give options, then build the itinerary.
// ============================================================================================
function OptGroup({ q, children }: { q: OptionQuestion; children: ReactNode }) {
  return (
    <div className="opt-group">
      <div className="opt-prompt">{q.prompt}</div>
      <div className="opt-list">{children}</div>
    </div>
  );
}

// The area intel briefing — "what's worth doing here": hot topics to advance, stale relationships to
// re-engage, and timely events, each with a WHY. Shown before a leader is picked so the EA can weigh
// the trip. Renders nothing when there is no intel. Shared by OptionsBubble (/plan-options) and
// AssistantBubble (/ask), so both entry points surface the same area context.
function AreaBriefing({
  survey,
  staleContacts,
  areaEvents,
  categoryBreakdown = [],
}: {
  survey: AreaSurveyTopic[];
  staleContacts: StaleContactRef[];
  areaEvents: AreaEventRef[];
  categoryBreakdown?: CategoryCoverageRef[];
}) {
  if (
    survey.length === 0 &&
    staleContacts.length === 0 &&
    areaEvents.length === 0 &&
    categoryBreakdown.length === 0
  )
    return null;
  return (
    <>
      {categoryBreakdown.length > 0 && (
        <div className="opt-intel opt-intel-categories">
          <div className="opt-intel-head">
            🎯 Engagement coverage — Congressional · Academia · Industry ·
            Army-internal
          </div>
          <ul className="opt-intel-list">
            {categoryBreakdown.map((c) => {
              const total = c.total ?? 0;
              const state =
                total === 0 ? "empty" : c.covered ? "covered" : "gap";
              return (
                <li key={c.category} className="opt-intel-row">
                  <span className="opt-intel-name">
                    {c.label ?? c.category}
                    <span className={`opt-cat-badge opt-cat-${state}`}>
                      {total}
                      {typeof c.onItineraryCount === "number" && total > 0
                        ? ` · ${c.onItineraryCount} on trip`
                        : ""}
                    </span>
                  </span>
                  <span className="opt-intel-why muted">{c.reason ?? ""}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {survey.length > 0 && (
        <div className="opt-intel">
          <div className="opt-intel-head">🔥 Hot topics here — why go now</div>
          <ul className="opt-intel-list">
            {survey.map((t) => (
              <li key={t.topicId} className="opt-intel-row">
                <span className="opt-intel-name">
                  {t.topicId}
                  {t.name ? ` ${t.name}` : ""}
                  {t.hasApprovedMessage ? " ✓" : ""}
                </span>
                <span className="opt-intel-why muted">{t.reason ?? ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {staleContacts.length > 0 && (
        <div className="opt-intel opt-intel-stale">
          <div className="opt-intel-head">
            ⏰ Stale — re-engage while you’re there
          </div>
          <ul className="opt-intel-list">
            {staleContacts.map((c) => (
              <li key={c.contactId} className="opt-intel-row">
                <span className="opt-intel-name">
                  {c.name ?? c.contactId}
                  {c.org ? ` · ${c.org}` : ""}
                  {c.city ? ` · ${c.city}` : ""}
                </span>
                <span className="opt-intel-why muted">{c.reason ?? ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {areaEvents.length > 0 && (
        <div className="opt-intel opt-intel-events">
          <div className="opt-intel-head">
            📅 Events here — timing &amp; why
          </div>
          <ul className="opt-intel-list">
            {areaEvents.map((e) => (
              <li key={e.eventId} className="opt-intel-row">
                <span className="opt-intel-name">
                  {e.name ?? e.eventId}
                  {e.city ? ` · ${e.city}` : ""}
                  {e.status ? (
                    <span className={`opt-evt-badge opt-evt-${e.status}`}>
                      {e.status}
                    </span>
                  ) : null}
                </span>
                <span className="opt-intel-why muted">{e.reason ?? ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function OptionsBubble({
  config,
  options,
  onPickRegion,
}: {
  config: HostConfig;
  options: OptionsResult;
  onPickRegion: (regionId: string, label: string) => void;
}) {
  const leaderQ = options.questions?.find((q) => q.id === "leader");
  const durationQ = options.questions?.find((q) => q.id === "duration");
  const extQ = options.questions?.find((q) => q.id === "extensions");
  const areaKey = options.area?.id ?? "area";

  const [leaderId, setLeaderId] = useState<string>(
    leaderQ?.choices.find((c) => c.selected)?.value ??
      leaderQ?.choices[0]?.value ??
      "",
  );
  const [durationTier, setDurationTier] = useState<string>(
    durationQ?.choices.find((c) => c.selected)?.value ??
      durationQ?.choices[0]?.value ??
      "core",
  );
  const [exts, setExts] = useState<Set<string>>(new Set());
  const [built, setBuilt] = useState<PlanResult | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildErr, setBuildErr] = useState<string>("");

  function toggleExt(v: string) {
    setExts((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }

  async function build() {
    if (!leaderId || building) return;
    setBuilding(true);
    setBuildErr("");
    setBuilt(null);
    try {
      const res = await fetch(`${config.orchestratorUrl}/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          regionId: options.area?.id,
          window: options.window ?? undefined,
          leaderId,
          durationTier,
          extensionContactIds: [...exts],
          topicIds: options.topicIds,
        }),
      });
      const result = (await res.json()) as PlanResult;
      if (result.error) setBuildErr(result.error);
      setBuilt(result);
    } catch (e) {
      setBuildErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  }

  if (options.error) {
    return <div className="bubble assistant error">⚠️ {options.error}</div>;
  }

  if (options.stage === "unavailable") {
    return (
      <div className="bubble assistant">
        <div className="meta-row">
          <span className="chip">document search</span>
        </div>
        {options.answer && <div className="answer">{options.answer}</div>}
      </div>
    );
  }

  // Clarify — the orchestrator needs an area first; render the region chips.
  if (options.stage === "clarify") {
    const areaQ = options.questions?.find((q) => q.id === "area");
    return (
      <div className="bubble assistant">
        <div className="meta-row">
          <span className="chip">clarify</span>
        </div>
        {options.answer && <div className="answer">{options.answer}</div>}
        <div className="opt-chips">
          {(areaQ?.choices ?? []).map((c) => (
            <button
              key={c.value}
              className="opt-chip"
              onClick={() => onPickRegion(c.value, c.label)}
            >
              {c.label}
              {c.detail && <span className="muted"> · {c.detail}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const survey = options.areaSurvey ?? [];
  const staleContacts = options.staleContacts ?? [];
  const areaEvents = options.areaEvents ?? [];
  const categoryBreakdown = options.categoryBreakdown ?? [];

  return (
    <div className="bubble assistant">
      <div className="meta-row">
        <span className="chip chip-mode">options</span>
      </div>

      {options.area && (
        <div className="opt-area">
          <strong>📍 {options.area.name}</strong>
          {typeof options.area.radiusMi === "number" && (
            <span className="muted"> · {options.area.radiusMi} mi</span>
          )}
          {options.window && (
            <span className="muted">
              {" "}
              · {options.window.start} → {options.window.end}
            </span>
          )}
        </div>
      )}

      <AreaBriefing
        survey={survey}
        staleContacts={staleContacts}
        areaEvents={areaEvents}
        categoryBreakdown={categoryBreakdown}
      />

      {leaderQ && (
        <OptGroup q={leaderQ}>
          {leaderQ.choices.map((c) => (
            <label
              key={c.value}
              className={`opt-row ${leaderId === c.value ? "opt-sel" : ""}`}
            >
              <input
                type="radio"
                name={`leader-${areaKey}`}
                checked={leaderId === c.value}
                onChange={() => setLeaderId(c.value)}
              />
              <span className="opt-label">
                {c.label}
                {c.recommended && <span className="opt-badge">top pick</span>}
              </span>
              {c.detail && <span className="opt-detail muted">{c.detail}</span>}
            </label>
          ))}
        </OptGroup>
      )}

      {durationQ && (
        <OptGroup q={durationQ}>
          {durationQ.choices.map((c) => (
            <label
              key={c.value}
              className={`opt-row ${durationTier === c.value ? "opt-sel" : ""}`}
            >
              <input
                type="radio"
                name={`dur-${areaKey}`}
                checked={durationTier === c.value}
                onChange={() => setDurationTier(c.value)}
              />
              <span className="opt-label">
                {c.label}
                {c.recommended && <span className="opt-badge">suggested</span>}
              </span>
              {c.detail && <span className="opt-detail muted">{c.detail}</span>}
            </label>
          ))}
        </OptGroup>
      )}

      {extQ && (
        <OptGroup q={extQ}>
          {extQ.choices.map((c) => (
            <label
              key={c.value}
              className={`opt-row ${exts.has(c.value) ? "opt-sel" : ""}`}
            >
              <input
                type="checkbox"
                checked={exts.has(c.value)}
                onChange={() => toggleExt(c.value)}
              />
              <span className="opt-label">{c.label}</span>
              {c.detail && <span className="opt-detail muted">{c.detail}</span>}
            </label>
          ))}
        </OptGroup>
      )}

      <button
        className="opt-build"
        onClick={build}
        disabled={building || !leaderId}
      >
        {building ? "Building…" : "Build itinerary ▸"}
      </button>

      {buildErr && <div className="answer error">{buildErr}</div>}
      {built?.answer && <div className="answer">{built.answer}</div>}
      {built?.menu && built.menu.length > 0 && (
        <div className="menu">
          {built.menu.map((m, i) => (
            <MenuCard key={m.contactId || i} item={m} index={i} />
          ))}
        </div>
      )}
      {built?.tripMap != null && (
        <TripMapHost
          config={config}
          tripMap={built.tripMap}
          answer={built.answer}
        />
      )}
    </div>
  );
}

// ============================================================================================
// Itinerary drill-down — the full detail the EA explores after selecting an option
// ============================================================================================
function OptionDetail({
  option,
  config,
}: {
  option: AskOption;
  config: HostConfig;
}) {
  const [showMap, setShowMap] = useState(false);
  const it = option.itinerary ?? undefined;
  const stops = it?.accepted ?? [];
  const route = it?.route;
  const roi = it?.roi;
  const conflicts = it?.conflicts ?? [];
  const nearby = it?.nearbyLeaders ?? [];
  const routeLine =
    route?.order && route.order.length > 0
      ? route.order.map((s) => s.city || s.id).join(" → ")
      : "";
  const num = (n: number | undefined | null, digits = 2) =>
    typeof n === "number" ? n.toFixed(digits) : "";

  return (
    <div className="opt-detail-panel">
      {/* headline stats */}
      <div className="opt-stats">
        {typeof option.days === "number" && (
          <span className="opt-stat">
            <b>{option.days}</b> days
          </span>
        )}
        {typeof option.stopCount === "number" && (
          <span className="opt-stat">
            <b>{option.stopCount}</b> meetings
          </span>
        )}
        {typeof option.roiScore === "number" && (
          <span className="opt-stat">
            ROI <b>{num(option.roiScore)}</b>
          </span>
        )}
        {typeof route?.totalMi === "number" && (
          <span className="opt-stat">
            <b>{route.totalMi}</b> mi
          </span>
        )}
        {typeof route?.totalTravelMins === "number" && (
          <span className="opt-stat">
            <b>{Math.round(route.totalTravelMins / 60)}</b> h travel
          </span>
        )}
        {option.overBudget && (
          <span className="chip chip-reject">over budget</span>
        )}
      </div>

      {routeLine && (
        <div className="opt-route">
          <span className="opt-detail-label">Route</span> {routeLine}
        </div>
      )}

      {/* the meetings themselves — the core drill-down */}
      {stops.length > 0 && (
        <div className="opt-detail-section">
          <div className="opt-detail-label">Meetings ({stops.length})</div>
          <div className="menu">
            {stops.map((m, i) => (
              <MenuCard key={m.contactId || i} item={m} index={i} />
            ))}
          </div>
        </div>
      )}

      {/* trip-ROI cost breakdown */}
      {roi?.breakdown && (
        <div className="opt-detail-section">
          <div className="opt-detail-label">Trip ROI</div>
          <div className="opt-roi muted">
            {typeof roi.breakdown.grossValue === "number" && (
              <span>gross value {num(roi.breakdown.grossValue)}</span>
            )}
            {typeof roi.breakdown.totalCost === "number" && (
              <span>· cost {num(roi.breakdown.totalCost)}</span>
            )}
            {typeof roi.breakdown.airfare === "number" && (
              <span>· airfare {num(roi.breakdown.airfare)}</span>
            )}
            {typeof roi.breakdown.perDiem === "number" && (
              <span>· per-diem {num(roi.breakdown.perDiem)}</span>
            )}
            {typeof roi.breakdown.timePenalty === "number" && (
              <span>· time {num(roi.breakdown.timePenalty)}</span>
            )}
          </div>
        </div>
      )}

      {/* advisory conflicts (fit / budget / opportunity-cost) */}
      {conflicts.length > 0 && (
        <div className="opt-detail-section">
          <div className="opt-detail-label">Advisories</div>
          <ul className="opt-advisories">
            {conflicts.map((c, i) => (
              <li
                key={i}
                className={`opt-advisory sev-${c.severity ?? "soft"}`}
              >
                <b>
                  {c.severity ?? ""}
                  {c.type ? ` / ${c.type}` : ""}
                </b>{" "}
                {c.message}
                {c.recommendation && (
                  <div className="muted">{c.recommendation}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* nearby senior-leader awareness (same event / contact / geo) */}
      {nearby.length > 0 && (
        <div className="opt-detail-section">
          <div className="opt-detail-label">Nearby senior leaders</div>
          <ul className="opt-leaders">
            {nearby.map((l) => (
              <li key={l.leaderId} className="opt-leader">
                <b>{l.name ?? l.leaderId}</b>
                {l.role && <span className="muted"> · {l.role}</span>}
                {l.primaryReason && (
                  <span className="chip chip-mode">{l.primaryReason}</span>
                )}
                {l.homeBaseCity && typeof l.homeBaseDistanceMi === "number" && (
                  <span className="muted">
                    {" "}
                    · {l.homeBaseCity} ({l.homeBaseDistanceMi} mi)
                  </span>
                )}
                {l.availableInWindow && (
                  <span className="muted"> · available</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* the map (heavy sandboxed iframe — lazy behind a toggle) */}
      {option.tripMap != null && (
        <div className="opt-detail-section">
          <button
            className="opt-chip"
            aria-expanded={showMap}
            onClick={() => setShowMap((v) => !v)}
          >
            {showMap ? "Hide map" : "Show map"}
          </button>
          {showMap && (
            <TripMapHost
              config={config}
              tripMap={option.tripMap}
              answer={option.answer ?? undefined}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================================
// Assistant bubble
// ============================================================================================
function DocumentPlanView({ plan }: { plan: DocumentTripPlan }) {
  const citationNumbers = new Map(
    plan.citations.map((citation, index) => [citation.id, index + 1]),
  );

  const SourceRefs = ({ ids }: { ids: string[] }) => (
    <span className="doc-source-refs" aria-label="Supporting sources">
      {[...new Set(ids)].map((id) => {
        const citation = plan.citations.find((item) => item.id === id);
        const number = citationNumbers.get(id);
        if (!citation || number == null) return null;
        const label = `[${number}]`;
        return citation.url ? (
          <a
            key={id}
            href={citation.url}
            target="_blank"
            rel="noreferrer"
            title={citation.title ?? id}
          >
            {label}
          </a>
        ) : (
          <span key={id} title={citation.title ?? id}>
            {label}
          </span>
        );
      })}
    </span>
  );

  return (
    <section className="doc-plan" aria-label="Document-grounded trip plan">
      <header className="doc-plan-head">
        <div>
          <div className="doc-plan-kicker">Document-grounded itinerary</div>
          <h3>{plan.title}</h3>
        </div>
        <SourceRefs ids={plan.sourceIds} />
      </header>

      <div className="doc-plan-meta">
        {plan.event && <span>{plan.event}</span>}
        {plan.destination && <span>{plan.destination}</span>}
        {(plan.startDate || plan.endDate) && (
          <span>
            {plan.startDate ?? "Date TBD"}
            {plan.endDate && plan.endDate !== plan.startDate
              ? ` to ${plan.endDate}`
              : ""}
          </span>
        )}
      </div>
      <p className="doc-plan-summary">{plan.summary}</p>

      <div className="doc-days">
        {plan.days.map((day) => (
          <section className="doc-day" key={`${day.day}-${day.date ?? "tbd"}`}>
            <div className="doc-day-head">
              <strong>Day {day.day}</strong>
              <span className="muted">
                {[day.date, day.location].filter(Boolean).join(" · ") ||
                  "Details TBD"}
              </span>
            </div>
            <ol className="doc-meetings">
              {day.meetings.map((meeting, index) => (
                <li key={`${meeting.target}-${index}`}>
                  <div className="doc-meeting-head">
                    <strong>{meeting.target}</strong>
                    <SourceRefs ids={meeting.sourceIds} />
                  </div>
                  {meeting.organization &&
                    meeting.organization !== meeting.target && (
                      <div className="muted">{meeting.organization}</div>
                    )}
                  <div>{meeting.purpose}</div>
                  {(meeting.time || meeting.location) && (
                    <div className="doc-meeting-meta muted">
                      {[meeting.time, meeting.location]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  )}
                </li>
              ))}
            </ol>
            {day.notes.length > 0 && (
              <div className="doc-day-notes muted">{day.notes.join(" · ")}</div>
            )}
          </section>
        ))}
      </div>

      {plan.gaps.length > 0 && (
        <div className="doc-gaps">
          <strong>Open details</strong>
          <ul>
            {plan.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="doc-citations">
        <strong>Sources</strong>
        <ol>
          {plan.citations.map((citation) => (
            <li key={citation.id}>
              {citation.url ? (
                <a href={citation.url} target="_blank" rel="noreferrer">
                  {citation.title ?? citation.id}
                </a>
              ) : (
                (citation.title ?? citation.id)
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function AssistantBubble({
  msg,
  config,
  onAsk,
  onPlanContext,
}: {
  msg: ChatMessage;
  config: HostConfig;
  onAsk: (
    question: string,
    leaderId?: string,
    userEcho?: string,
    category?: string,
  ) => void;
  onPlanContext: (context: EventPlanContext) => void;
}) {
  const r = msg.result;
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  if (!r) {
    return (
      <div className="bubble assistant error">
        ⚠️ {msg.error || "No response."}
      </div>
    );
  }
  const menu = r.menu ?? [];
  const tools = r.toolCalls?.map((t) => t.name) ?? [];
  const leaderQ = r.questions?.find((q) => q.id === "leader");
  const categoryQ = r.questions?.find((q) => q.id === "category");
  const isClarify = r.stage === "clarify" && (!!leaderQ || !!categoryQ);
  const isOptions = r.stage === "options" && (r.options?.length ?? 0) > 0;
  const shortlist = r.leaderShortlist ?? [];

  return (
    <div className="bubble assistant">
      <div className="meta-row">
        {r.mode && (
          <span
            className={`chip chip-mode chip-${r.mode}`}
            title={
              r.mode === "deterministic" && r.deterministicReason
                ? DETERMINISTIC_REASON[r.deterministicReason]?.detail
                : undefined
            }
          >
            {r.mode === "llm" ? "LLM" : r.mode}
          </span>
        )}
        {r.mode === "deterministic" &&
          r.deterministicReason &&
          DETERMINISTIC_REASON[r.deterministicReason] && (
            <span
              className="chip chip-why"
              title={DETERMINISTIC_REASON[r.deterministicReason].detail}
            >
              why: {DETERMINISTIC_REASON[r.deterministicReason].short}
            </span>
          )}
        {r.stage && <span className="chip chip-mode">{r.stage}</span>}
      </div>

      {r.error && <div className="answer error">{r.error}</div>}
      {r.answer && <div className="answer">{r.answer}</div>}
      {r.documentPlan && <DocumentPlanView plan={r.documentPlan} />}

      {/* "What's worth doing there" — area context shown BEFORE the leader is picked. */}
      {r.area && (
        <div className="opt-area">
          <strong>📍 {r.area.name}</strong>
          {typeof r.area.radiusMi === "number" && (
            <span className="muted"> · {r.area.radiusMi} mi</span>
          )}
        </div>
      )}
      <AreaBriefing
        survey={r.areaSurvey ?? []}
        staleContacts={r.staleContacts ?? []}
        areaEvents={r.areaEvents ?? []}
        categoryBreakdown={r.categoryBreakdown ?? []}
      />

      {/* Category-first: ASK which engagement audience to anchor the trip on (the DEFAULT area flow). */}
      {isClarify && categoryQ && (
        <div className="opt-chips">
          {categoryQ.choices.map((c) => (
            <button
              key={c.value}
              className={`opt-chip opt-chip-cat opt-cat-${c.value}`}
              disabled={!r.question}
              onClick={() =>
                r.question &&
                onAsk(
                  r.question,
                  undefined,
                  `Focus on ${c.label} engagements`,
                  c.value,
                )
              }
            >
              {c.recommended ? "★ " : ""}
              {c.label}
              {c.detail && <span className="muted"> · {c.detail}</span>}
            </button>
          ))}
        </div>
      )}

      {/* Leader-first (event-anchored): ASK which senior leader (ranked roster) before shaping options. */}
      {isClarify && leaderQ && (
        <div className="opt-chips">
          {leaderQ.choices.map((c) => (
            <button
              key={c.value}
              className="opt-chip"
              disabled={!r.question}
              onClick={() =>
                r.question && onAsk(r.question, c.value, `Plan for ${c.label}`)
              }
            >
              {c.recommended ? "★ " : ""}
              {c.label}
              {c.detail && <span className="muted"> · {c.detail}</span>}
            </button>
          ))}
        </div>
      )}

      {/* Category-first PLAN: the senior leader to send + ranked alternates (leader = OUTPUT you can override). */}
      {r.stage === "plan" && shortlist.length > 0 && (
        <div className="opt-leaders opt-leaders-rec">
          <div className="opt-intel-head">
            🎖️ Who should go — pick a senior leader to plan for
            {r.category ? (
              <span className="chip chip-cat">
                {" "}
                {String(r.category).replace("-", " ")}
              </span>
            ) : null}
          </div>
          <ul className="opt-leader-list">
            {shortlist.map((l) => {
              const isSel = l.selected ?? l.recommended;
              return (
                <li
                  key={l.leaderId}
                  className={`opt-leader${isSel ? " opt-leader-rec" : ""}`}
                >
                  <button
                    type="button"
                    className="opt-leader-pick"
                    disabled={!r.question || isSel}
                    title={
                      isSel
                        ? "Currently planning for this leader"
                        : `Re-plan this trip for ${l.name ?? l.leaderId}`
                    }
                    onClick={() =>
                      r.question &&
                      onAsk(
                        r.question,
                        l.leaderId,
                        `Plan for ${l.name ?? l.leaderId}`,
                        r.category ?? undefined,
                      )
                    }
                  >
                    <span className="opt-leader-name">
                      {l.recommended ? "★ " : ""}
                      <b>{l.name ?? l.leaderId}</b>
                      <span className="muted"> · {l.leaderId}</span>
                      {l.role ? (
                        <span className="muted"> · {l.role}</span>
                      ) : null}
                      {isSel ? (
                        <span className="chip chip-mode">planning for</span>
                      ) : (
                        <span className="chip chip-pick">pick</span>
                      )}
                      {l.recommended && !l.selected ? (
                        <span className="chip chip-mode">recommended</span>
                      ) : null}
                      {l.availableInWindow === false ? (
                        <span className="chip chip-reject">not free</span>
                      ) : null}
                    </span>
                    {l.why ? (
                      <span className="opt-intel-why muted">{l.why}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Itinerary scope options — pick one to drill into its full detail. */}
      {isOptions && (
        <div className="ask-options">
          {(r.options ?? []).map((o) => {
            const selected = selectedOptionId === o.id;
            return (
              <div
                key={o.id}
                className={`opt-card${o.recommended ? " opt-card-rec" : ""}${selected ? " opt-card-selected" : ""}`}
              >
                <button
                  className="opt-card-head opt-card-select"
                  aria-expanded={selected}
                  onClick={() => {
                    setSelectedOptionId(selected ? null : o.id);
                    if (!selected) {
                      const context = eventPlanContextFromResult(r, o);
                      if (context) onPlanContext(context);
                    }
                  }}
                >
                  <strong>{o.label ?? o.id}</strong>
                  {o.category && (
                    <span className="chip chip-cat">
                      {o.category.replace("-", " ")}
                    </span>
                  )}
                  {o.recommended && (
                    <span className="chip chip-mode">recommended</span>
                  )}
                  {o.overBudget && (
                    <span className="chip chip-reject">over budget</span>
                  )}
                  <span className="opt-card-toggle muted">
                    {selected ? "▾ details" : "▸ details"}
                  </span>
                </button>
                {o.summary && (
                  <div className="muted opt-card-summary">{o.summary}</div>
                )}
                {o.categoryMix && (
                  <div
                    className="opt-card-cats"
                    title="Engagement audiences this itinerary reaches"
                  >
                    🎯 {o.categoryMix}
                  </div>
                )}
                {selected && <OptionDetail option={o} config={config} />}
              </div>
            );
          })}
        </div>
      )}

      {/* Legacy single-plan menu + map (non-options asks). */}
      {!isOptions && menu.length > 0 && (
        <div className="menu">
          {menu.map((m, i) => (
            <MenuCard key={m.contactId || i} item={m} index={i} />
          ))}
        </div>
      )}

      {!isOptions && r.tripMap != null && (
        <TripMapHost config={config} tripMap={r.tripMap} answer={r.answer} />
      )}

      {tools.length > 0 && (
        <div className="tools muted">tools: {tools.join(" → ")}</div>
      )}
    </div>
  );
}

// ============================================================================================
// App shell
// ============================================================================================
function App() {
  const [config, setConfig] = useState<HostConfig | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>(SAMPLE_QUESTION);
  const [busy, setBusy] = useState(false);
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [hotTopics, setHotTopics] = useState<HotTopic[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const planContextRef = useRef<EventPlanContext | null>(null);

  useEffect(() => {
    loadConfig().then(setConfig);
    return onThemeChange(setThemeState);
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, busy]);

  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    fetch(`${config.orchestratorUrl}/topics`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setHotTopics(d?.topics ?? []);
      })
      .catch(() => {
        if (!cancelled) setHotTopics([]);
      });
    return () => {
      cancelled = true;
    };
  }, [config]);

  // Free-form ask — the primary interaction. `qOverride` lets a chip fire a starter question
  // without clearing whatever the user has typed. `leaderId` re-asks the SAME question once the EA
  // picks a senior leader (event-anchored flow); `category` re-asks it once the EA picks an engagement
  // category (category-first flow → build + recommend a leader); `userEcho` overrides the echoed bubble.
  async function ask(
    qOverride?: string,
    leaderId?: string,
    userEcho?: string,
    category?: string,
  ) {
    const question = (qOverride ?? input).trim();
    if (!question || busy || !config) return;
    const context =
      qOverride === undefined
        ? (planContextRef.current ?? undefined)
        : undefined;
    const history: ConversationHistoryMessage[] = messages
      .reduce<ConversationHistoryMessage[]>((items, message) => {
        if (message.role === "user" && message.text) {
          items.push({ role: "user", text: message.text });
          return items;
        }
        const text =
          message.result?.answer ?? message.options?.answer ?? message.error;
        if (text) items.push({ role: "assistant", text });
        return items;
      }, [])
      .slice(-10);
    setMessages((m) => [
      ...m,
      {
        id: nextId++,
        role: "user",
        text: userEcho ?? question,
      },
    ]);
    if (qOverride === undefined) setInput("");
    setBusy(true);
    try {
      const res = await fetch(`${config.orchestratorUrl}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question,
          ...(leaderId ? { leaderId } : {}),
          ...(category ? { category } : {}),
          ...(context ? { context } : {}),
          ...(history.length ? { history } : {}),
        }),
      });
      const result = (await res.json()) as PlanResult;
      const nextContext = eventPlanContextFromResult(result);
      if (nextContext) planContextRef.current = nextContext;
      setMessages((m) => [...m, { id: nextId++, role: "assistant", result }]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        {
          id: nextId++,
          role: "assistant",
          error: e instanceof Error ? e.message : String(e),
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  // Interactive planner — ask the orchestrator for the who/how-long/extensions option menus (or the
  // "which area?" clarify). `regionId` anchors an area directly; otherwise the free-text is parsed.
  async function planOptions(opts: {
    question?: string;
    regionId?: string;
    label?: string;
  }) {
    if (busy || !config) return;
    const userText = opts.label
      ? `Plan a trip · ${opts.label}`
      : opts.question || "Plan a trip";
    setMessages((m) => [...m, { id: nextId++, role: "user", text: userText }]);
    if (opts.question !== undefined) setInput("");
    setBusy(true);
    try {
      const res = await fetch(`${config.orchestratorUrl}/plan-options`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question:
            opts.question ??
            (opts.label ? `Plan a trip to ${opts.label}` : undefined),
          regionId: opts.regionId,
        }),
      });
      const response = (await res.json()) as OptionsResult &
        Partial<PlanResult>;
      if (response.mode || response.documentPlan) {
        const result = response as PlanResult;
        setMessages((m) => [...m, { id: nextId++, role: "assistant", result }]);
      } else {
        const options = response as OptionsResult;
        setMessages((m) => [
          ...m,
          { id: nextId++, role: "assistant", options },
        ]);
      }
    } catch (e) {
      setMessages((m) => [
        ...m,
        {
          id: nextId++,
          role: "assistant",
          error: e instanceof Error ? e.message : String(e),
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  const onPickRegion = (regionId: string, label: string) =>
    planOptions({ regionId, label });

  // Quick-start chips just KICK OFF a free-form search (never lock into the guided wizard):
  // a region/topic chip fires a natural-language question the agent then plans from.
  const onPickRegionFreeform = (label: string) =>
    ask(
      `Plan a trip to ${label} — who should go, how long, and what's worth doing there?`,
    );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <div>
            <div className="brand-title">
              Strategic Engagements — Trip Planner
            </div>
            <div className="brand-sub muted">chat host · MCP Apps</div>
          </div>
        </div>
        <div className="controls">
          <button
            className="icon-btn"
            onClick={() => setThemeState(toggleTheme())}
            title="Toggle theme"
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </div>
      </header>

      <div className="messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty">
            <p>
              Type anything and the agent plans it — who to meet, where, and for
              how long. Or start from a hot topic or an area below; you can
              always steer from there, or use <strong>Plan a trip</strong> for
              the guided area planner.
            </p>
            {hotTopics.length > 0 && (
              <div className="empty-group">
                <span className="empty-label">🔥 Hot topics</span>
                <div className="empty-picks">
                  {hotTopics.map((t) => (
                    <button
                      key={t.topicId}
                      className="sample"
                      disabled={busy || !config}
                      title={t.reason}
                      onClick={() => ask(t.question)}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="empty-group">
              <span className="empty-label">📍 Areas</span>
              <div className="empty-picks">
                {REGION_QUICKPICKS.map((r) => (
                  <button
                    key={r.regionId}
                    className="sample"
                    disabled={busy || !config}
                    onClick={() => onPickRegionFreeform(r.label)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            <button
              className="sample sample-example"
              onClick={() => setInput(SAMPLE_QUESTION)}
            >
              {SAMPLE_QUESTION}
            </button>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="row user-row">
              <div className="bubble user">{m.text}</div>
            </div>
          ) : (
            <div key={m.id} className="row assistant-row">
              {config &&
                (m.options ? (
                  <OptionsBubble
                    config={config}
                    options={m.options}
                    onPickRegion={onPickRegion}
                  />
                ) : (
                  <AssistantBubble
                    msg={m}
                    config={config}
                    onAsk={ask}
                    onPlanContext={(context) => {
                      planContextRef.current = context;
                    }}
                  />
                ))}
            </div>
          ),
        )}
        {busy && (
          <div className="row assistant-row">
            <div className="bubble assistant thinking">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          </div>
        )}
      </div>

      <div className="quickpicks">
        {hotTopics.length > 0 && (
          <>
            <span className="muted">🔥 Hot topics:</span>
            {hotTopics.map((t) => (
              <button
                key={t.topicId}
                className="qp qp-topic"
                disabled={busy || !config}
                title={t.reason}
                onClick={() => ask(t.question)}
              >
                {t.name}
              </button>
            ))}
          </>
        )}
        <span className="muted">📍 Areas:</span>
        {REGION_QUICKPICKS.map((r) => (
          <button
            key={r.regionId}
            className="qp"
            disabled={busy || !config}
            onClick={() => onPickRegionFreeform(r.label)}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
          placeholder="Ask anything — or start from a chip above… (Enter to ask, Shift+Enter for newline)"
          rows={2}
          disabled={busy || !config}
        />
        <div className="composer-actions">
          <button
            className="send"
            onClick={() => ask()}
            disabled={busy || !config || !input.trim()}
            title="Ask the agent anything — it plans from your words (who to meet, where, how long)"
          >
            {busy ? "…" : "Ask ▸"}
          </button>
          <button
            className="ask"
            onClick={() => planOptions({ question: input.trim() || undefined })}
            disabled={busy || !config}
            title="Guided area planner: who should go, how long, and what each extra day unlocks"
          >
            Plan a trip
          </button>
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
// NOTE: intentionally NOT wrapped in StrictMode — the embedded-app effect performs one-time
// imperative iframe/AppBridge setup that StrictMode's double-invoke would disrupt.
root.render(<App />);
