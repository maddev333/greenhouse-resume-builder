/**
 * Runtime config for the chat host. Defaults target the local demo topology; `serve.ts` can
 * override them via GET /api/config (so ports are not baked into the single-file bundle).
 *
 *   orchestratorUrl     M5 orchestrator  — POST {orchestratorUrl}/ask
 *   engagementsMcpUrl   engagements MCP  — read ui://trip-map/trip-map.html (persona header)
 *   sandboxProxyBaseUrl sandbox proxy    — distinct origin that isolates the MCP App
 */
export interface HostConfig {
  orchestratorUrl: string;
  engagementsMcpUrl: string;
  sandboxProxyBaseUrl: string;
}

const DEFAULTS: HostConfig = {
  orchestratorUrl: "http://localhost:3020",
  engagementsMcpUrl: "http://localhost:3010/mcp",
  sandboxProxyBaseUrl: `${window.location.protocol}//${window.location.hostname}:8081/sandbox.html`,
};

export async function loadConfig(): Promise<HostConfig> {
  try {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (res.ok) {
      const partial = (await res.json()) as Partial<HostConfig>;
      return { ...DEFAULTS, ...partial };
    }
  } catch {
    // Fall through to defaults — the static bundle can run without serve.ts /api/config.
  }
  return DEFAULTS;
}
