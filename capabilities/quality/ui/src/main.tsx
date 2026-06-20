import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Review Queue — MCP UI App (hybrid web + MCP App) for the quality capability.
 * Runs embedded in an MCP host or standalone (calling the Quality MCP server over HTTP).
 */
const SERVER_URL =
  (import.meta as any).env?.VITE_QUALITY_MCP_URL || 'http://localhost:7073/api/mcp/quality';

interface McpBridge {
  embedded: boolean;
  callTool(name: string, args: unknown): Promise<any>;
}

function getMcpBridge(serverUrl: string): McpBridge {
  const host = (globalThis as any).mcpHost;
  if (host && typeof host.callTool === 'function') {
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
  let id = 1;
  return {
    embedded: false,
    async callTool(name, args) {
      const resp = await fetch(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }),
      });
      if (!resp.ok) throw new Error(`MCP HTTP ${resp.status}`);
      const json = await resp.json();
      if (json.error) throw new Error(json.error.message);
      return json.result?.structuredContent ?? json.result;
    },
  };
}

function App() {
  const bridge = getMcpBridge(SERVER_URL);
  const [personId, setPersonId] = useState('person-123');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      setOutput(JSON.stringify(await bridge.callTool('create_review_tasks', { personId, facts: [] }), null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err?.message || err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 760, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Review Queue</h1>
      <p style={{ color: '#555' }}>
        MCP UI App · {bridge.embedded ? 'embedded in MCP host' : 'standalone'} · capability: quality
      </p>
      <label>
        Person ID{' '}
        <input value={personId} onChange={(e) => setPersonId(e.target.value)} style={{ fontFamily: 'monospace' }} />
      </label>
      <button onClick={load} disabled={busy} style={{ marginLeft: 8 }}>
        {busy ? 'Loading…' : 'Load review tasks'}
      </button>
      <pre style={{ background: '#f5f5f5', padding: 12, marginTop: 12, overflowX: 'auto' }}>{output}</pre>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
