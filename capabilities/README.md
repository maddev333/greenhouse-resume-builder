# Capability modules

The demo is organized as **capability modules** — each a self-contained slice that bundles an
MCP capability server, an agent runtime, and an MCP UI App. The layout is intentionally modular
so new data sources / capabilities can be added without touching existing ones.

A capability bundles:

- **MCP capability server(s)** (`mcp/<server>/`) — tools exposed over Streamable HTTP, plus any
  MCP UI App resources (e.g. `ui://trip-map`).
- **An agent runtime** (`agent/`) — a self-hosted Azure OpenAI tool-calling loop that orchestrates
  the capability's tools (with a deterministic fallback when no model is configured).
- **An MCP UI App / host** (`ui/`) — the browser surface.

The shared library [`mcp-core`](./mcp-core) provides the MCP-server helper, identity/token helpers
(managed-identity credential precedence + cloud-configurable scopes), the agent loop, and an
optional governance gate — so every module follows the same pattern.

## Modules

| Capability | MCP server | Agent | UI |
|------------|------------|-------|----|
| [engagements](./engagements) | `mcp/engagements` (seed data, security trim, `suggest_candidates` / `build_itinerary`, `ui://trip-map` App) | orchestrator "chat brain" (`POST /ask`) | chat UI + MCP-Apps host |
| [mcp-core](./mcp-core) | — (shared library: MCP helper, agent loop, identity, governance) | — | — |

## Build & run

These packages join the repo's npm workspaces. From the repo root:

```bash
npm install
npm run build -w @greenhouse-resume-builder/mcp-core
```

To run the full engagements demo with one command, see the repo-root
[`README.md`](../README.md) Quickstart or [`engagements/ui/README.md`](./engagements/ui/README.md).

## Common environment

All variables are optional (see the repo-root `.env.example`). The most relevant:

- `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` — enable the LLM
  planning path (omit to use the deterministic fallback).
- `AZURE_OPENAI_TOKEN_SCOPE` (Gov: `https://cognitiveservices.azure.us/.default`).
- `MCP_REQUIRE_BEARER` (`true` to require a bearer token locally).
- `MCP_CORS_ALLOWED_ORIGINS` — browser CORS for the MCP servers. Unset reflects
  `localhost`/`127.0.0.1` (local-dev default); set to `*` or a comma-separated allow-list otherwise.
- `GOVERNANCE_ENABLED` (`true` to enforce `governance/policy.yaml` via mcp-core).
