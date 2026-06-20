/**
 * @greenhouse-resume-builder/llmwiki-ui · MCP Bridge
 *
 * Provides a unified tool-calling interface that works in both embedded mode
 * (via `globalThis.mcpHost.callTool` injected by an MCP host like VS Code or
 * Claude Desktop) and standalone mode (JSON-RPC over HTTP).
 *
 * This follows the exact pattern established by discovery/ui/src/main.tsx,
 * geospatial/ui/src/main.test.mtsx, relationships/ui/src/manifests/test.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface McpBridge {
  /** `true` when running inside an MCP host that provides the `mcpHost` bridge. */
  embedded: boolean;
  /** Call any LLMWiki MCP tool by name and arguments. Returns the deserialized result. */
  callTool(name: string, args: unknown): Promise<unknown>;
}

/* ------------------------------------------------------------------ */
/*  Bridge factory                                                     */
/* ------------------------------------------------------------------ */

/**
 * Create an MCP bridge for the given LLMwiki server URL.
 * Falls back from embedded (mcpHost) to standalone (HTTP JSON-RPC).
 */
export function createMcpBridge(serverUrl: string): McpBridge {
  const host = (globalThis as any).mcpHost;

  if (host && typeof host.callTool === "function") {
    // MCP Apps gate — prevent early tool calls before app.connect() completes.
    const isInMcpApp = Boolean((window as any).__MCP_APP_BRIDGE__);
    let bridgeInitOk = false;
    const pendingBridges: Array<{ name: string; args: unknown; resolve: (v: any) => void; reject: (e: Error) => void }> = [];

    if (isInMcpApp) {
      window.addEventListener(
        'message',
        function onBridgeInit(e: MessageEvent<unknown>) {
          if ((e.data as any)?.method === 'ui/notifications/initialized') {
            bridgeInitOk = true;
            for (const p of pendingBridges.splice(0)) {
              host.callTool(p.name, p.args).then(p.resolve, p.reject);
            }
            window.removeEventListener('message', onBridgeInit as EventListener);
          }
        },
        { passive: true },
      );
    } else {
      bridgeInitOk = true;
    }

    return {
      embedded: true,
      callTool: (name, args) => {
        if (!bridgeInitOk && isInMcpApp) {
          let settled = false;
          return new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
              settled = true;
              reject(new Error('MCP Apps host did not initialize in time (15s timeout)'));
            }, 15000);
            pendingBridges.push({
          name,
          args,
          resolve: (v: any) => { if (!settled) { clearTimeout(timer); resolve(v); } },
          reject: (e: Error) => { if (!settled) { clearTimeout(timer); reject(e); } },
        });
          });
        }
        return host.callTool(name, args);
      },
    };
  }

  // Standalone mode — HTTP JSON-RPC over Streamable HTTP transport.
  let id = 1;
  return {
    embedded: false,
    async callTool(name, args) {
      const resp = await fetch(serverUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: id++,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      if (!resp.ok) throw new Error(`MCP HTTP ${resp.status} calling ${name}`);
      const json = await resp.json();
      if (json.error) throw new Error(json.error.message ?? `tool ${name} failed`);
      return json.result?.structuredContent ?? json.result;
    },
  };
}
