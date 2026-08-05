# Capability modules

The demo is organized as **capability modules** — each a self-contained slice that bundles an
MCP capability server, an agent runtime, and an MCP UI App. The layout is intentionally modular
so new data sources / capabilities can be added without touching existing ones.

A capability bundles:

- **MCP capability server(s)** (`mcp/<server>/`) — tools exposed over Streamable HTTP, plus any
  MCP UI App resources (e.g. `ui://trip-map`).
- **An agent runtime** (`agent/`) — a TypeScript orchestration gateway plus a Python Microsoft Agent
  Framework runtime with Agent Governance Toolkit middleware and a deterministic fallback.
- **An MCP UI App / host** (`ui/`) — the browser surface.

The shared library [`mcp-core`](./mcp-core) provides MCP-server and identity/token helpers. Agent
execution and governance live in the Python package inside `agent/`.

The engagements capability applies **no security trim** — no tenant isolation, ACL or sensitivity
filtering. Any caller sees the entire corpus the configured retrieval backend holds.

## Modules

| Capability                   | MCP server                                                                                                     | Agent                                   | UI                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------- |
| [engagements](./engagements) | `mcp/engagements` (retrieval + planner tools, `ui://trip-map` App) and `mcp/discovery` (Azure Maps POI lookup) | orchestrator "chat brain" (`POST /ask`) | chat UI + MCP-Apps host |
| [mcp-core](./mcp-core)       | — (shared library: MCP server + identity helpers)                                                              | —                                       | —                       |

## Build & run

These packages join the repo's npm workspaces. From the repo root:

```bash
npm install
# REQUIRED: npm install does not compile these two libraries, and the servers import their dist/
npm run build -w @greenhouse-resume-builder/shared -w @greenhouse-resume-builder/mcp-core
npm run setup:python -w @greenhouse-resume-builder/cap-engagements-agent
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
- `ENGAGEMENTS_PYTHON_AGENT_URL` (default `http://127.0.0.1:3030`).
- `AGT_ENABLED` (default `true`) and `AGT_POLICY_PATH` (default `governance/policy.yaml`) — the
  Agent Governance Toolkit policy (prompt-injection / tool-call rules), unrelated to data access.
- `RETRIEVAL_BACKEND` (`memory` | `search` | `grounding`) plus `AZURE_SEARCH_*` and
  `ENGAGEMENTS_INDEX_SCHEMA(S)` — see
  [`engagements/mcp/engagements/README.md`](./engagements/mcp/engagements/README.md).
