import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as atlas from 'azure-maps-control';
import 'azure-maps-control/dist/atlas.min.css';

/**
 * Map Pins — MCP UI App (hybrid web + MCP App) for the geospatial capability.
 * Runs embedded in an MCP host or standalone (calling the Geospatial MCP server over HTTP).
 * Calls project_map_pins to geocode location records, then plots them on an Azure Maps map.
 */
const SERVER_URL =
  (import.meta as any).env?.VITE_GEOSPATIAL_MCP_URL || 'http://localhost:7076/api/mcp/geospatial';

// Subscription key for the browser Azure Maps control, injected by vite.config.ts from the repo-root
// AZURE_MAPS_KEY (local dev only — production should use Azure Maps AAD anonymous auth).
const MAPS_KEY = ((import.meta as any).env?.VITE_AZURE_MAPS_KEY as string) || '';

const DEFAULT_LOCATIONS = ['Seattle, WA', 'Redmond, WA', 'Washington, DC', 'Austin, TX'].join('\n');

interface Pin {
  label?: string;
  address?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  locationConfidence?: string | null;
}

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

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

function App() {
  const bridge = getMcpBridge(SERVER_URL);
  const [personId, setPersonId] = useState('person-123');
  const [locationsText, setLocationsText] = useState(DEFAULT_LOCATIONS);
  const [pins, setPins] = useState<Pin[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const mapDiv = useRef<HTMLDivElement>(null);
  const mapObj = useRef<atlas.Map | null>(null);
  const markers = useRef<atlas.HtmlMarker[]>([]);
  const [mapReady, setMapReady] = useState(false);

  // Create the Azure Maps control once (only when a key is available).
  useEffect(() => {
    if (!MAPS_KEY || !mapDiv.current) return;
    const map = new atlas.Map(mapDiv.current, {
      center: [-98, 39],
      zoom: 3,
      style: 'road',
      authOptions: { authType: atlas.AuthenticationType.subscriptionKey, subscriptionKey: MAPS_KEY },
    });
    mapObj.current = map;
    map.events.add('ready', () => setMapReady(true));
    return () => {
      setMapReady(false);
      map.dispose();
      mapObj.current = null;
    };
  }, []);

  // Re-plot markers whenever pins change and the map is ready.
  useEffect(() => {
    const map = mapObj.current;
    if (!map || !mapReady) return;
    markers.current.forEach((m) => map.markers.remove(m));
    markers.current = [];
    const positions: atlas.data.Position[] = [];
    for (const p of pins) {
      if (typeof p.longitude !== 'number' || typeof p.latitude !== 'number') continue;
      const pos: atlas.data.Position = [p.longitude, p.latitude];
      positions.push(pos);
      const title = p.label || p.address || `${p.latitude}, ${p.longitude}`;
      const marker = new atlas.HtmlMarker({
        position: pos,
        popup: new atlas.Popup({
          content: `<div style="padding:8px;max-width:240px;font:13px system-ui">
            <strong>${escapeHtml(String(title))}</strong>
            ${p.address ? `<br/>${escapeHtml(p.address)}` : ''}
            ${p.locationConfidence ? `<br/><em>confidence: ${escapeHtml(p.locationConfidence)}</em>` : ''}
          </div>`,
          pixelOffset: [0, -30],
        }),
      });
      map.markers.add(marker);
      map.events.add('click', marker, () => marker.togglePopup());
      markers.current.push(marker);
    }
    if (positions.length === 1) {
      map.setCamera({ center: positions[0], zoom: 8 });
    } else if (positions.length > 1) {
      map.setCamera({ bounds: atlas.data.BoundingBox.fromPositions(positions), padding: 60 });
    }
  }, [pins, mapReady]);

  async function loadPins() {
    setBusy(true);
    setStatus('Geocoding…');
    try {
      const locations = locationsText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const result = await bridge.callTool('project_map_pins', { personId, locations });
      const got: Pin[] = Array.isArray(result?.pins) ? result.pins : [];
      setPins(got);
      if (result?.mapsConfigured === false) {
        setStatus('The MCP server has no Azure Maps key (set AZURE_MAPS_KEY for the server).');
      } else {
        setStatus(`${got.length} pin(s) from ${result?.requested ?? locations.length} location(s).`);
      }
    } catch (err: any) {
      setStatus(`Error: ${err?.message || err}`);
      setPins([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 980, margin: '1.5rem auto', padding: '0 1rem' }}>
      <h1 style={{ marginBottom: 4 }}>Map Pins</h1>
      <p style={{ color: '#555', marginTop: 0 }}>
        MCP UI App · {bridge.embedded ? 'embedded in MCP host' : 'standalone'} · capability: geospatial
      </p>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px', minWidth: 260 }}>
          <label style={{ display: 'block', marginBottom: 8 }}>
            Person ID{' '}
            <input value={personId} onChange={(e) => setPersonId(e.target.value)} style={{ fontFamily: 'monospace' }} />
          </label>
          <label style={{ display: 'block' }}>
            Locations (one per line)
            <textarea
              value={locationsText}
              onChange={(e) => setLocationsText(e.target.value)}
              rows={6}
              style={{ width: '100%', fontFamily: 'monospace', marginTop: 4 }}
            />
          </label>
          <button onClick={loadPins} disabled={busy} style={{ marginTop: 8 }}>
            {busy ? 'Loading…' : 'Load map pins'}
          </button>
          <p style={{ color: '#555', minHeight: 20 }}>{status}</p>
          {pins.length > 0 && (
            <ul style={{ paddingLeft: 18 }}>
              {pins.map((p, i) => (
                <li key={i}>
                  <strong>{p.label}</strong>
                  {typeof p.latitude === 'number' && typeof p.longitude === 'number'
                    ? ` — ${p.latitude.toFixed(4)}, ${p.longitude.toFixed(4)}`
                    : ' — (no match)'}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div style={{ flex: '2 1 420px', minWidth: 320 }}>
          {MAPS_KEY ? (
            <div
              ref={mapDiv}
              style={{ height: 460, width: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid #ddd' }}
            />
          ) : (
            <div
              style={{
                height: 460,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
                padding: 16,
                border: '1px dashed #bbb',
                borderRadius: 8,
                color: '#666',
              }}
            >
              No Azure Maps key in the browser bundle. Set <code>AZURE_MAPS_KEY</code> in the repo-root{' '}
              <code>.env</code> (or <code>VITE_AZURE_MAPS_KEY</code> in <code>ui/.env</code>) and restart the dev
              server. Pins still list on the left.
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
