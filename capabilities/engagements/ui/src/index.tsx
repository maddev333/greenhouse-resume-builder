/**
 * Chat host UI (M6). A chat window + persona selector that calls the M5 orchestrator (/ask) and
 * renders its answer, its option menu (candidate cards), and — when the orchestrator returns a
 * `tripMap` — the sandboxed ui://trip-map MCP App via <TripMapHost> (see ./implementation).
 */
import { useEffect, useRef, useState } from "react";
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
  distanceKm?: number;
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

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text?: string;
  persona?: string;
  result?: PlanResult;
  error?: string;
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
        {typeof item.distanceKm === "number" && <span>{item.distanceKm} km</span>}
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
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    loadConfig().then(setConfig);
    return onThemeChange(setThemeState);
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function ask() {
    const question = input.trim();
    if (!question || busy || !config) return;
    const usedPersona = persona;
    setMessages((m) => [...m, { id: nextId++, role: "user", text: question, persona: usedPersona }]);
    setInput("");
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
            <p>Ask about an upcoming trip. The orchestrator picks the tools, applies the security trim, and returns a menu + a live trip map.</p>
            <button className="sample" onClick={() => setInput(SAMPLE_QUESTION)}>
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
              {config && <AssistantBubble msg={m} config={config} />}
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
          placeholder="Ask about a trip… (Enter to send, Shift+Enter for newline)"
          rows={2}
          disabled={busy || !config}
        />
        <button className="send" onClick={ask} disabled={busy || !config || !input.trim()}>
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
// NOTE: intentionally NOT wrapped in StrictMode — the embedded-app effect performs one-time
// imperative iframe/AppBridge setup that StrictMode's double-invoke would disrupt.
root.render(<App />);
