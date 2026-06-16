# Discovery capability (IL5)

Natural-language talent discovery over the facts and relationships indexes, plus resume
assembly and version diffing. Bundles one MCP server, the agent-framework runtime, and the
Resume + Diff UI App.

| Part | Path | Role |
|------|------|------|
| MCP server | `mcp/search` | `search_facts`, `search_relationships`, `index_upsert` |
| Agent | `agent` | self-hosted Azure OpenAI retrieval loop |
| UI App | `ui` | Resume + Diff (hybrid web + MCP App) |

## Run locally

```bash
npm run build -w @greenhouse-resume-builder/cap-discovery-mcp-search
cd capabilities/discovery/mcp/search && func start --port 7077

npm run build -w @greenhouse-resume-builder/cap-discovery-agent
node capabilities/discovery/agent/dist/agent.js "Kubernetes engineers with TS clearance"

npm run dev -w @greenhouse-resume-builder/cap-discovery-ui
```

## IL5 notes

- Queries are security-trimmed per document; the index stores only IL5-authorized fields.
- The agent surfaces only tool-returned, cited results — no invented candidates/attributes.
- Azure AI Search is IL5-authorized; managed identity by default; deploy `mcp/search`
  behind API Management (not Container Apps).
