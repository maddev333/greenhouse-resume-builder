# Ingestion capability (IL5)

Turns raw sources into evidence-grounded facts. Bundles two MCP servers, the
agent-framework runtime, and the Ingestion Console UI App.

| Part | Path | Role |
|------|------|------|
| MCP server | `mcp/acquisition` | `triage_sources`, `fetch_web_snapshot`, `extract_document`, `normalize_text` |
| MCP server | `mcp/extraction` | `extract_experience`, `extract_skills`, `extract_education`, `generate_summary` |
| Agent | `agent` | self-hosted Azure OpenAI loop driving the two servers |
| UI App | `ui` | Ingestion Console (hybrid web + MCP App) |

## Run locally

```bash
# from repo root, after `npm install` and building mcp-core
npm run build -w @greenhouse-resume-builder/cap-ingestion-mcp-acquisition
npm run build -w @greenhouse-resume-builder/cap-ingestion-mcp-extraction

# start each MCP server (separate terminals / ports)
cd capabilities/ingestion/mcp/acquisition && func start --port 7071
cd capabilities/ingestion/mcp/extraction && func start --port 7072

# run the agent against the servers
npm run build -w @greenhouse-resume-builder/cap-ingestion-agent
node capabilities/ingestion/agent/dist/agent.js "https://example.com/candidate"

# run the UI App standalone
npm run dev -w @greenhouse-resume-builder/cap-ingestion-ui
```

## IL5 notes

- Managed identity by default (set `AZURE_OPENAI_API_KEY` only for local dev).
- Set `AZURE_OPENAI_TOKEN_SCOPE` and `MCP_TOKEN_SCOPE` for Government/DoD clouds.
- Deploy each `mcp/*` as its own Functions app behind API Management; never Container Apps.
- Handlers are typed stubs; wire them to the real `functions/src/activities` (inside the
  durable boundary) so canonical Cosmos writes stay activity-bound.
