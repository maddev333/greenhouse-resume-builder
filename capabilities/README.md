# Capability modules (IL5 modular reference)

Self-contained, independently deployable **capability modules** for the Greenhouse Resume
Builder, structured so other teams can lift a module as a reference when building more
complex DoD **IL5** systems.

Each capability bundles:

- **1-2 MCP capability servers** (`mcp/<server>/`) — IL5-authorized **Azure Functions**
  apps exposing tools over Streamable HTTP.
- **An agent-framework runtime** (`agent/`) — the self-hosted Azure OpenAI tool-calling
  loop (the IL5 agent pattern; the managed Foundry Agent Service is IL2-only and not used).
- **An MCP UI App** (`ui/`) — a recruiter surface that also runs standalone
  (hybrid web + MCP App).

A shared library, [`mcp-core`](./mcp-core), provides the MCP server helper, the IL5
identity/token helpers (managed-identity credential precedence + cloud-configurable
scopes), and the agent loop, so every module follows the same compliant pattern.

## Modules

| Capability | MCP servers | MCP UI App |
|------------|-------------|------------|
| [ingestion](./ingestion) | acquisition, extraction | Ingestion Console |
| [quality](./quality) | quality | Review Queue |
| [relationships](./relationships) | relationships | Relationship Confirmation |
| [temporal](./temporal) | temporal | Prediction Review |
| [geospatial](./geospatial) | geospatial | Map Pins |
| [discovery](./discovery) | search | Resume + Diff |

## IL5 posture (configuration, not a fork)

- **Identity:** `DefaultAzureCredential` everywhere; supply keys only for local dev.
- **Endpoints:** cloud-configurable via env (Commercial vs Government/DoD); see
  `mvp_architecture.md` Section 7.10.
- **Hosting:** Azure Functions / App Service / AKS / ACI behind API Management — never
  Azure Container Apps (IL2-only).
- **Network:** Private Link/VNet; Streamable HTTP over TLS; no public egress.

## Build

These packages join the repo's npm workspaces. From the repo root:

```bash
npm install
npm run build -w @greenhouse-resume-builder/mcp-core
```

Each capability's MCP server runs with the Azure Functions Core Tools (`func start`) and
each UI with Vite (`npm run dev`).

## Common environment

See each module's README. Common variables:

- `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION`
- `AZURE_OPENAI_TOKEN_SCOPE` (Gov: `https://cognitiveservices.azure.us/.default`)
- `AZURE_OPENAI_API_KEY` (local dev only; omit for IL5 managed identity)
- `MCP_TOKEN_SCOPE` (agent → MCP server bearer token; IL5)
- `MCP_REQUIRE_BEARER` (`true` to require a bearer locally)
