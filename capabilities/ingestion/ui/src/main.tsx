import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Ingestion Console — MCP UI App (hybrid web + MCP App).
 *
 * Runs embedded in an MCP host (using the injected host channel) or standalone (calling
 * the Acquisition MCP server over Streamable HTTP). The app reaches the source of truth
 * only through MCP tools, never directly.
 */
const SERVER_URL =
  (import.meta as any).env?.VITE_ACQUISITION_MCP_URL || 'http://localhost:7071/api/mcp/acquisition';

interface McpBridge {
  embedded: boolean;
  callTool(name: string, args: unknown): Promise<any>;
}

function getMcpBridge(serverUrl: string): McpBridge {
  const host = (globalThis as any).mcpHost;
  if (host && typeof host.callTool === 'function') {
    return { embedded: true, callTool: (n, a) => host.callTool(n, a) };
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
  const [sources, setSources] = useState('https://example.com/candidate');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);

  async function triage() {
    setBusy(true);
    try {
      const list = sources
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((url) => ({ url }));
      setOutput(JSON.stringify(await bridge.callTool('triage_sources', { sources: list }), null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err?.message || err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 760, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Ingestion Console</h1>
      <p style={{ color: '#555' }}>
        MCP UI App · {bridge.embedded ? 'embedded in MCP host' : 'standalone'} · capability: ingestion
      </p>
      <textarea
        value={sources}
        onChange={(e) => setSources(e.target.value)}
        rows={5}
        style={{ width: '100%', fontFamily: 'monospace' }}
        placeholder="One source URL per line"
      />
      <button onClick={triage} disabled={busy} style={{ marginTop: 8 }}>
        {busy ? 'Triaging…' : 'Triage sources'}
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
