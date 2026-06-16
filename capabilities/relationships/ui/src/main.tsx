import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Relationship Confirmation — MCP UI App (hybrid web + MCP App) for the relationships capability.
 * Runs embedded in an MCP host or standalone (calling the Relationships MCP server over HTTP).
 */
const SERVER_URL =
  (import.meta as any).env?.VITE_RELATIONSHIPS_MCP_URL || 'http://localhost:7074/api/mcp/relationships';

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
  const [personId, setPersonId] = useState('person-123');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);

  async function suggest() {
    setBusy(true);
    try {
      setOutput(JSON.stringify(await bridge.callTool('infer_relationships', { personId }), null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err?.message || err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 760, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Relationship Confirmation</h1>
      <p style={{ color: '#555' }}>
        MCP UI App · {bridge.embedded ? 'embedded in MCP host' : 'standalone'} · capability: relationships
      </p>
      <label>
        Person ID{' '}
        <input value={personId} onChange={(e) => setPersonId(e.target.value)} style={{ fontFamily: 'monospace' }} />
      </label>
      <button onClick={suggest} disabled={busy} style={{ marginLeft: 8 }}>
        {busy ? 'Loading…' : 'Suggest relationships'}
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
