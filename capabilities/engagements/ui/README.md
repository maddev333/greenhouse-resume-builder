# Engagements Chat UI (M6) — a real MCP‑Apps host over the M5 orchestrator

A chat window + persona selector that drives the **M5 orchestrator** and renders the
`ui://trip-map` **MCP App** in a sandboxed iframe — the interface the MVP calls for:
_"a chat UI that supports MCP UI apps."_

```
Browser (chat host page :8080)
  │  chat + persona selector
  ├─► POST http://localhost:3020/ask { question, persona }        ← M5 orchestrator ("the brain")
  │      ⇒ { answer, menu[], itinerary, tripMap, redactedCount, rejected, mode }
  │   render: assistant text + candidate cards (chat‑native)
  │
  └─ when a tripMap comes back, embed the REAL sandboxed app:
       ├─ MCP Client → http://localhost:3010/mcp  (header x-demo-persona)
       │     readResource("ui://trip-map/trip-map.html")  → app HTML + CSP
       ├─ load sandbox proxy iframe → http://localhost:8081/sandbox.html?csp=…   (distinct origin)
       ├─ AppBridge.connect(PostMessageTransport)          (ext-apps host bridge)
       ├─ AppBridge.sendSandboxResourceReady({ html, csp })
       └─ AppBridge.sendToolResult({ structuredContent: { tripMap } })
             → the app's `ontoolresult` renders the Azure Maps trip
```

The orchestrator (server‑side) is what applies the **security trim** from the persona; this host
only reads the app shell and hands the already‑trimmed `tripMap` to the sandboxed app. The map is
the same `ui://trip-map` App a compliant MCP host (e.g. Claude Desktop) would render.

## Why a custom two‑port host (not `vite dev`)

The sandbox proxy (`src/sandbox.ts`) must run on a **different origin** from the host page — its
security self‑test deliberately fails if it can reach `window.top`. So, like the ext‑apps
`basic-host`, this package builds two single‑file bundles (`index.html`, `sandbox.html`) and
serves them on two ports via `serve.ts`, which also sets the sandbox **CSP HTTP header** (so Azure
Maps tiles from `*.atlas.microsoft.com` are allowed).

## Prerequisites

- **Node 20+** (developed on Node 24) and npm. This is an npm‑workspaces monorepo — run
  `npm install` **once at the repo root**, not inside this folder.
- **Free ports:** `8080` and `8081` (chat host + sandbox), `3010` (engagements MCP), `3020`
  (orchestrator).
- **(Optional) `az login`** — enables the Azure OpenAI LLM path. Without it the orchestrator falls
  back to a deterministic planner, so the demo still runs fully offline.
- **(Optional) live map tiles** — set `VITE_AZURE_MAPS_KEY` in the repo‑root `.env` before building;
  without a key the trip map degrades to a **schematic view** (dots + routes, no basemap).

```powershell
# from the repo root, one time:
npm install
az login          # optional (enables the LLM path)
```

## Quickstart — one command

From the repo root, build the host bundles and start **all three** servers (engagements MCP,
orchestrator, chat host) with colour‑labelled output in a single window:

```powershell
npm run demo --workspace @greenhouse-resume-builder/cap-engagements-ui
```

Then open **http://localhost:8080**. Press `Ctrl+C` to stop all three.

## Run manually (three terminals)

Prefer separate terminals (e.g. to isolate one server's logs)? Run these from the repo root:

```powershell
# 1) engagements MCP capability — MUST pin the port (repo .env sets PORT=3001)
$env:ENGAGEMENTS_MCP_PORT=3010
npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements

# 2) M5 orchestrator (the chat brain)
npm run serve --workspace @greenhouse-resume-builder/cap-engagements-agent

# 3) this chat host (builds both bundles, then serves :8080 host + :8081 sandbox)
npm run start --workspace @greenhouse-resume-builder/cap-engagements-ui
```

## Try it

Open **http://localhost:8080**, keep the persona on **EA · G8**, and send:

> _I'm planning a trip to AUSA — who should I meet on the UAS/drone topic?_

You get the assistant summary, a menu of candidate cards, and a live trip map. Switch the persona
to **EA · basic** and re‑ask: one more contact is redacted (the map/menu shrink). **No tenant**
is rejected (fail‑closed); **Cross‑tenant** returns nothing (isolation).

During development use `npm run dev` (rebuilds on change + restarts `serve.ts`).

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| MCP capability won't start, or the trip‑map chip shows `unavailable` | Port collision. The engagements MCP binds `ENGAGEMENTS_MCP_PORT ?? PORT ?? 3010`, but the repo‑root `.env` sets `PORT=3001`. Export `ENGAGEMENTS_MCP_PORT=3010` (the `demo` script already does this). |
| Trip map shows dots/lines with no basemap | No `VITE_AZURE_MAPS_KEY` at build time → schematic‑view fallback. Set it in the repo‑root `.env` and rebuild. |
| `EADDRINUSE` on start | One of `8080` / `8081` / `3010` / `3020` is already in use (often a previous `demo` run). Stop it and retry. |
| Menu cards appear but the map never loads | The host can't reach the MCP server on `:3010`. Confirm terminal 1 is up and `ENGAGEMENTS_MCP_URL` matches. |

## Config (optional env for `serve.ts`)

| Var                  | Default                        | Purpose                                  |
| -------------------- | ------------------------------ | ---------------------------------------- |
| `HOST_PORT`          | `8080`                         | chat host page                           |
| `SANDBOX_PORT`       | `8081`                         | sandbox proxy (distinct origin)          |
| `ORCHESTRATOR_URL`   | `http://localhost:3020`        | M5 orchestrator `/ask`                   |
| `ENGAGEMENTS_MCP_URL`| `http://localhost:3010/mcp`    | engagements MCP (reads the app resource) |

These are advertised to the browser via `GET /api/config`.

## Files

| File | Role |
| --- | --- |
| `src/index.tsx` | Chat UI: messages, persona selector, menu cards, `<TripMapHost>` |
| `src/implementation.ts` | Host wiring: MCP client, resource read, sandbox proxy, `AppBridge`, `renderTripMapApp` (delivers the orchestrator's `tripMap` as a tool result) |
| `src/sandbox.ts` | Sandbox proxy (outer iframe) — double‑iframe isolation + message relay |
| `serve.ts` | Two‑port server (host + CSP‑header sandbox) + `/api/config` |
| `src/theme.ts`, `src/host-styles.ts` | Host theme + MCP style variables passed to the app |
| `src/config.ts` | Client config loader (`/api/config` with localhost fallbacks) |

`src/sandbox.ts`, `src/theme.ts`, `src/host-styles.ts`, and the `serve.ts` CSP logic are adapted
from the MCP `@modelcontextprotocol/ext-apps` **basic-host** reference.
