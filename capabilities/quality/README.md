# Quality capability (IL5)

Citation + conflict guardrails before facts become resume bullets. Bundles one MCP
server, the agent-framework runtime, and the Review Queue UI App.

| Part | Path | Role |
|------|------|------|
| MCP server | `mcp/quality` | `check_citations`, `detect_conflicts`, `create_review_tasks` |
| Agent | `agent` | self-hosted Azure OpenAI guardrail loop |
| UI App | `ui` | Review Queue (hybrid web + MCP App) |

## Run locally

```bash
npm run build -w @greenhouse-resume-builder/cap-quality-mcp-quality
cd capabilities/quality/mcp/quality && func start --port 7073

npm run build -w @greenhouse-resume-builder/cap-quality-agent
node capabilities/quality/agent/dist/agent.js person-123

npm run dev -w @greenhouse-resume-builder/cap-quality-ui
```

## IL5 notes

- Deterministic guardrails run in IL5 compute independent of any model service.
- Managed identity by default; deploy `mcp/quality` behind API Management (not Container Apps).
- Handlers are typed stubs; wire them to the target CitationGuard/Conflict/ReviewTask agents.
