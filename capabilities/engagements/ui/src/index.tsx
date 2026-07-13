/**
 * Chat host UI (M6). A chat window + persona selector that calls the M5 orchestrator (/ask) and
 * renders its answer, its option menu (candidate cards), and — when the orchestrator returns a
 * `tripMap` — the sandboxed ui://trip-map MCP App via <TripMapHost> (see ./implementation).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { connectToServer, getUiResource, renderTripMapApp, log } from "./implementation";
import { loadConfig, type HostConfig } from "./config";
import { getTheme, toggleTheme, onThemeChange, type Theme } from "./theme";
import "./global.css";

const TRIP_MAP_RESOURCE_URI = "ui://trip-map/trip-map.html";

interface Persona {
  id: string;
  label: string;
  hint: string;
}

// The demo personas the engagements MCP server understands (x-demo-persona). The trim differs:
// EA_G8 sees the G8-scoped contact (C4) that EA_BASIC does not; NO_TENANT is fail-closed;
// CROSS_TENANT is isolated (empty).
const PERSONAS: Persona[] = [
  { id: "EA_G8", label: "EA · G8 staff", hint: "Full G8 trim — sees the extra financial-liaison contact" },
  { id: "EA_BASIC", label: "EA · basic", hint: "Baseline EA — one more contact redacted" },
  { id: "ADMIN", label: "Admin", hint: "Elevated — widest visibility" },
  { id: "CROSS_TENANT", label: "Cross-tenant", hint: "Different tenant — isolation returns nothing" },
  { id: "NO_TENANT", label: "No tenant", hint: "Missing tenant claim — access is rejected (fail-closed)" },
];

const SAMPLE_QUESTION = "I'm planning a trip to AUSA — who should I meet on the UAS/drone topic?";

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

interface PlanResult {
  ok?: boolean;
  mode?: string;
  persona?: string;
  answer?: string;
  toolCalls?: { name: string }[];
  menu?: MenuItem[] | null;
  itinerary?: unknown;
  tripMap?: unknown;
  redactedCount?: number | null;
  rejected?: boolean;
  error?: string;
}

// ---- interactive planner (/plan-options + /build) -------------------------------------------
interface OptionChoice {
  value: string;
  label: string;
  detail?: string;
  selected?: boolean;
  recommended?: boolean;
}

interface OptionQuestion {
  id: "area" | "leader" | "duration" | "extensions";
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
}

// Loose mirror of the orchestrator's AreaOptionsResult.
interface OptionsResult {
  ok?: boolean;
  stage?: "clarify" | "options";
  persona?: string;
  answer?: string | null;
  area?: { id?: string; name?: string; city?: string; state?: string; radiusMi?: number } | null;
  window?: { start: string; end: string } | null;
  today?: string | null;
  topicIds?: string[];
  areaSurvey?: AreaSurveyTopic[];
  absorbedEventIds?: string[];
  redactedCount?: number | null;
  rejected?: boolean;
  questions?: OptionQuestion[];
  error?: string;
}

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text?: string;
  persona?: string;
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
  persona,
  tripMap,
  answer,
}: {
  config: HostConfig;
  persona: string;
  tripMap: unknown;
  answer?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const startedRef = useRef(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
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
    iframe.style.cssText = "width:100%; height:440px; border:none; border-radius:8px; background:transparent;";
    container.appendChild(iframe);

    (async () => {
      try {
        client = await connectToServer(config.engagementsMcpUrl, persona);
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
          {status === "loading" ? "loading sandboxed app…" : status === "ready" ? "MCP App" : "unavailable"}
        </span>
      </div>
      {status === "error" && (
        <div className="tripmap-error">
          Could not embed the trip-map app: {errMsg}
          <div className="muted">Is the engagements MCP server running on :3010 and the sandbox proxy on :8081?</div>
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
        {item.status && <span className={`badge badge-${item.status}`}>{item.status}</span>}
      </div>
      <div className="card-sub">
        {where && <span>📍 {where}</span>}
        {item.placement && <span>· {item.placement}</span>}
        {item.kind && <span>· {item.kind}</span>}
      </div>
      <div className="card-metrics">
        {typeof item.strategicValue === "number" && <span>value {item.strategicValue}</span>}
        {typeof item.score === "number" && <span>score {item.score}</span>}
        {typeof item.distanceMi === "number" && <span>{item.distanceMi} mi</span>}
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

function OptionsBubble({
  config,
  persona,
  options,
  onPickRegion,
}: {
  config: HostConfig;
  persona: string;
  options: OptionsResult;
  onPickRegion: (regionId: string, label: string) => void;
}) {
  const leaderQ = options.questions?.find((q) => q.id === "leader");
  const durationQ = options.questions?.find((q) => q.id === "duration");
  const extQ = options.questions?.find((q) => q.id === "extensions");
  const areaKey = options.area?.id ?? "area";

  const [leaderId, setLeaderId] = useState<string>(
    leaderQ?.choices.find((c) => c.selected)?.value ?? leaderQ?.choices[0]?.value ?? "",
  );
  const [durationTier, setDurationTier] = useState<string>(
    durationQ?.choices.find((c) => c.selected)?.value ?? durationQ?.choices[0]?.value ?? "core",
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
          persona,
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

  // Clarify — the orchestrator needs an area first; render the region chips.
  if (options.stage === "clarify") {
    const areaQ = options.questions?.find((q) => q.id === "area");
    return (
      <div className="bubble assistant">
        <div className="meta-row">
          <span className="chip chip-persona">{persona}</span>
          <span className="chip">clarify</span>
        </div>
        {options.answer && <div className="answer">{options.answer}</div>}
        <div className="opt-chips">
          {(areaQ?.choices ?? []).map((c) => (
            <button key={c.value} className="opt-chip" onClick={() => onPickRegion(c.value, c.label)}>
              {c.label}
              {c.detail && <span className="muted"> · {c.detail}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const rejected = options.rejected;
  const survey = options.areaSurvey ?? [];

  return (
    <div className="bubble assistant">
      <div className="meta-row">
        <span className="chip chip-persona">{persona}</span>
        <span className="chip chip-mode">options</span>
        {rejected && <span className="chip chip-reject">access rejected</span>}
        {typeof options.redactedCount === "number" && options.redactedCount > 0 && (
          <span className="chip chip-redact">🔒 {options.redactedCount} redacted</span>
        )}
      </div>

      {options.area && (
        <div className="opt-area">
          <strong>📍 {options.area.name}</strong>
          {typeof options.area.radiusMi === "number" && <span className="muted"> · {options.area.radiusMi} mi</span>}
          {options.window && (
            <span className="muted">
              {" "}
              · {options.window.start} → {options.window.end}
            </span>
          )}
        </div>
      )}

      {survey.length > 0 && (
        <div className="opt-survey">
          <span className="muted">topics here:</span>
          {survey.map((t) => (
            <span
              key={t.topicId}
              className="flag"
              title={`${t.activeCount ?? 0} active · ${t.prospectCount ?? 0} prospect · ${t.staleCount ?? 0} stale · ${t.eventCount ?? 0} event(s)`}
            >
              {t.topicId}
              {t.name ? ` ${t.name}` : ""}
              {t.hasApprovedMessage ? " ✓" : ""}
            </span>
          ))}
        </div>
      )}

      {rejected ? (
        <div className="answer error">Access rejected — no records are visible for this persona.</div>
      ) : (
        <>
          {leaderQ && (
            <OptGroup q={leaderQ}>
              {leaderQ.choices.map((c) => (
                <label key={c.value} className={`opt-row ${leaderId === c.value ? "opt-sel" : ""}`}>
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
                <label key={c.value} className={`opt-row ${durationTier === c.value ? "opt-sel" : ""}`}>
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
                <label key={c.value} className={`opt-row ${exts.has(c.value) ? "opt-sel" : ""}`}>
                  <input type="checkbox" checked={exts.has(c.value)} onChange={() => toggleExt(c.value)} />
                  <span className="opt-label">{c.label}</span>
                  {c.detail && <span className="opt-detail muted">{c.detail}</span>}
                </label>
              ))}
            </OptGroup>
          )}

          <button className="opt-build" onClick={build} disabled={building || !leaderId}>
            {building ? "Building…" : "Build itinerary ▸"}
          </button>
        </>
      )}

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
        <TripMapHost config={config} persona={persona} tripMap={built.tripMap} answer={built.answer} />
      )}
    </div>
  );
}

// ============================================================================================
// Assistant bubble
// ============================================================================================
function AssistantBubble({ msg, config }: { msg: ChatMessage; config: HostConfig }) {
  const r = msg.result;
  if (!r) {
    return <div className="bubble assistant error">⚠️ {msg.error || "No response."}</div>;
  }
  const persona = msg.persona || r.persona || "";
  const menu = r.menu ?? [];
  const tools = r.toolCalls?.map((t) => t.name) ?? [];

  return (
    <div className="bubble assistant">
      <div className="meta-row">
        <span className="chip chip-persona">{persona}</span>
        {r.mode && <span className={`chip chip-mode chip-${r.mode}`}>{r.mode === "llm" ? "LLM" : r.mode}</span>}
        {r.rejected && <span className="chip chip-reject">access rejected</span>}
        {typeof r.redactedCount === "number" && r.redactedCount > 0 && (
          <span className="chip chip-redact">🔒 {r.redactedCount} redacted</span>
        )}
      </div>

      {r.error && <div className="answer error">{r.error}</div>}
      {r.answer && <div className="answer">{r.answer}</div>}

      {menu.length > 0 && (
        <div className="menu">
          {menu.map((m, i) => (
            <MenuCard key={m.contactId || i} item={m} index={i} />
          ))}
        </div>
      )}

      {r.tripMap != null && (
        <TripMapHost config={config} persona={persona} tripMap={r.tripMap} answer={r.answer} />
      )}

      {tools.length > 0 && <div className="tools muted">tools: {tools.join(" → ")}</div>}
    </div>
  );
}

// ============================================================================================
// App shell
// ============================================================================================
function App() {
  const [config, setConfig] = useState<HostConfig | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [persona, setPersona] = useState<string>("EA_G8");
  const [input, setInput] = useState<string>(SAMPLE_QUESTION);
  const [busy, setBusy] = useState(false);
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [hotTopics, setHotTopics] = useState<HotTopic[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    loadConfig().then(setConfig);
    return onThemeChange(setThemeState);
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  // Hot topics are persona-trimmed, so refetch whenever the caller (persona) changes. A rejected
  // persona (e.g. NO_TENANT) yields none — the same security-trim beat as the rest of the demo.
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    fetch(`${config.orchestratorUrl}/topics?persona=${encodeURIComponent(persona)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setHotTopics(d?.rejected ? [] : (d?.topics ?? []));
      })
      .catch(() => {
        if (!cancelled) setHotTopics([]);
      });
    return () => {
      cancelled = true;
    };
  }, [config, persona]);

  // Free-form ask — the primary interaction. `qOverride` lets a chip fire a starter question
  // without clearing whatever the user has typed.
  async function ask(qOverride?: string) {
    const question = (qOverride ?? input).trim();
    if (!question || busy || !config) return;
    const usedPersona = persona;
    setMessages((m) => [...m, { id: nextId++, role: "user", text: question, persona: usedPersona }]);
    if (qOverride === undefined) setInput("");
    setBusy(true);
    try {
      const res = await fetch(`${config.orchestratorUrl}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, persona: usedPersona }),
      });
      const result = (await res.json()) as PlanResult;
      setMessages((m) => [...m, { id: nextId++, role: "assistant", persona: usedPersona, result }]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { id: nextId++, role: "assistant", persona: usedPersona, error: e instanceof Error ? e.message : String(e) },
      ]);
    } finally {
      setBusy(false);
    }
  }

  // Interactive planner — ask the orchestrator for the who/how-long/extensions option menus (or the
  // "which area?" clarify). `regionId` anchors an area directly; otherwise the free-text is parsed.
  async function planOptions(opts: { question?: string; regionId?: string; label?: string }) {
    if (busy || !config) return;
    const usedPersona = persona;
    const userText = opts.label ? `Plan a trip · ${opts.label}` : opts.question || "Plan a trip";
    setMessages((m) => [...m, { id: nextId++, role: "user", text: userText, persona: usedPersona }]);
    if (opts.question !== undefined) setInput("");
    setBusy(true);
    try {
      const res = await fetch(`${config.orchestratorUrl}/plan-options`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: opts.question, regionId: opts.regionId, persona: usedPersona }),
      });
      const options = (await res.json()) as OptionsResult;
      setMessages((m) => [...m, { id: nextId++, role: "assistant", persona: usedPersona, options }]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { id: nextId++, role: "assistant", persona: usedPersona, error: e instanceof Error ? e.message : String(e) },
      ]);
    } finally {
      setBusy(false);
    }
  }

  const onPickRegion = (regionId: string, label: string) => planOptions({ regionId, label });

  // Quick-start chips just KICK OFF a free-form search (never lock into the guided wizard):
  // a region/topic chip fires a natural-language question the agent then plans from.
  const onPickRegionFreeform = (label: string) =>
    ask(`Plan a trip to ${label} — who should go, how long, and what's worth doing there?`);

  const activePersona = PERSONAS.find((p) => p.id === persona);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <div>
            <div className="brand-title">Strategic Engagements — Trip Planner</div>
            <div className="brand-sub muted">chat host · MCP Apps · persona-trimmed retrieval</div>
          </div>
        </div>
        <div className="controls">
          <label className="persona-select">
            <span className="muted">persona</span>
            <select value={persona} onChange={(e) => setPersona(e.target.value)} disabled={busy}>
              {PERSONAS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <button className="icon-btn" onClick={() => setThemeState(toggleTheme())} title="Toggle theme">
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </div>
      </header>

      {activePersona && <div className="persona-hint muted">{activePersona.hint}</div>}

      <div className="messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty">
            <p>
              Type anything and the agent plans it — who to meet, where, and for how long. Or start from a hot topic
              or an area below; you can always steer from there, or use <strong>Plan a trip</strong> for the guided
              area planner.
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
                  <button key={r.regionId} className="sample" disabled={busy || !config} onClick={() => onPickRegionFreeform(r.label)}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            <button className="sample sample-example" onClick={() => setInput(SAMPLE_QUESTION)}>
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
                    persona={m.persona || m.options.persona || persona}
                    options={m.options}
                    onPickRegion={onPickRegion}
                  />
                ) : (
                  <AssistantBubble msg={m} config={config} />
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
              <button key={t.topicId} className="qp qp-topic" disabled={busy || !config} title={t.reason} onClick={() => ask(t.question)}>
                {t.name}
              </button>
            ))}
          </>
        )}
        <span className="muted">📍 Areas:</span>
        {REGION_QUICKPICKS.map((r) => (
          <button key={r.regionId} className="qp" disabled={busy || !config} onClick={() => onPickRegionFreeform(r.label)}>
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
