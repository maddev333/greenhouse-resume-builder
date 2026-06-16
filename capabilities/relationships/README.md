# Relationships capability (IL5)

Inferred and recruiter-authored relationship edges. Bundles one MCP server, the
agent-framework runtime, and the Relationship Confirmation UI App.

| Part | Path | Role |
|------|------|------|
| MCP server | `mcp/relationships` | `infer_relationships`, `confirm_relationship`, `upsert_explicit_relationship` |
| Agent | `agent` | self-hosted Azure OpenAI inference loop |
| UI App | `ui` | Relationship Confirmation (hybrid web + MCP App) |

## Run locally

```bash
npm run build -w @greenhouse-resume-builder/cap-relationships-mcp-relationships
cd capabilities/relationships/mcp/relationships && func start --port 7074

npm run build -w @greenhouse-resume-builder/cap-relationships-agent
node capabilities/relationships/agent/dist/agent.js person-123

npm run dev -w @greenhouse-resume-builder/cap-relationships-ui
```

## IL5 notes

- Recruiter-authored edges are authoritative over inference and stay activity/API-bound.
- Managed identity by default; deploy `mcp/relationships` behind API Management (not Container Apps).
- Cosmos remains the source of truth; introduce a graph DB only if multi-hop traversal becomes a requirement.
