/**
 * @greenhouse-resume-builder/mcp-core
 *
 * Reusable IL5 building blocks for capability modules:
 *  - MCP server helper (Functions-hosted, Streamable HTTP)
 *  - IL5 identity/token helpers (managed-identity credential precedence)
 *  - self-hosted Azure OpenAI tool-calling loop (the agent-framework runtime)
 *  - agent governance gate (Agent Governance Toolkit integration: policy + audit)
 */
export * from './types';
export * from './identity';
export * from './mcp-server';
export * from './agent-loop';
export * from './governance';
