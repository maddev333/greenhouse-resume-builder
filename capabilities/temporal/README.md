# Temporal capability (IL5)

Detects historical temporal patterns and predicts likely future candidate events with
explainable confidence. Bundles one MCP server, the agent-framework runtime, and the
Prediction Review UI App.

| Part | Path | Role |
|------|------|------|
| MCP server | `mcp/temporal` | `extract_events`, `detect_patterns`, `predict_events`, `create_alerts` |
| Agent | `agent` | self-hosted Azure OpenAI pattern/prediction loop |
| UI App | `ui` | Prediction Review (hybrid web + MCP App) |

## Run locally

```bash
npm run build -w @greenhouse-resume-builder/cap-temporal-mcp-temporal
cd capabilities/temporal/mcp/temporal && func start --port 7075

npm run build -w @greenhouse-resume-builder/cap-temporal-agent
node capabilities/temporal/agent/dist/agent.js person-123

npm run dev -w @greenhouse-resume-builder/cap-temporal-ui
```

## IL5 notes

- Predictions are never persisted as observed facts; each carries evidence, rationale,
  confidence, status, and expiration.
- Recurring recompute belongs in Durable Functions timers (control plane), not in MCP tool calls.
- Managed identity by default; deploy `mcp/temporal` behind API Management (not Container Apps).
