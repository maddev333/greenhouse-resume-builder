import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Resume + Diff — MCP UI App (hybrid web + MCP App) for the discovery capability.
 * Runs embedded in an MCP host or standalone (calling the Discovery MCP server over HTTP).
 * Results are security-trimmed and cite the underlying facts.
 */
const SERVER_URL =
  (import.meta as any).env?.VITE_SEARCH_MCP_URL || 'http://localhost:7077/api/mcp/search';

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
  const [query, setQuery] = useState('Kubernetes platform engineers with TS clearance');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true);
    try {
      setOutput(JSON.stringify(await bridge.callTool('search_facts', { query }), null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err?.message || err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 760, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Resume + Diff</h1>
      <p style={{ color: '#555' }}>
        MCP UI App · {bridge.embedded ? 'embedded in MCP host' : 'standalone'} · capability: discovery
      </p>
      <label style={{ display: 'block' }}>
        Query
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: '100%', fontFamily: 'monospace', marginTop: 4 }}
        />
      </label>
      <button onClick={search} disabled={busy} style={{ marginTop: 8 }}>
        {busy ? 'Searching…' : 'Search facts'}
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
