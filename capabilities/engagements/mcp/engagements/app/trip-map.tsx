/**
 * ui://trip-map — the ONLY MCP UI App in scope (ARCHITECTURE §9).
 *
 * Renders the `build_itinerary` result on an Azure Maps map: the anchor venue (origin) + the ordered
 * stops (on-site at the venue, then the nearest-neighbor off-site sweep) + the travel legs, with a
 * ROI/budget summary. It runs embedded in the chat host (receiving the tool result via
 * `app.ontoolresult`) and degrades gracefully to a schematic list when there is no Azure Maps key,
 * the map fails to init, or the host blocks map tiles.
 *
 * Standalone preview (no host): open with `?demo` to render a sample AUSA itinerary.
 */
import type { App, McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { useApp } from '@modelcontextprotocol/ext-apps/react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as atlas from 'azure-maps-control';
import 'azure-maps-control/dist/atlas.min.css';
import type { TripMapPayload, TripMapPoint } from '../src/app-payload';

// Baked at build by vite.config.ts from the repo-root AZURE_MAPS_KEY (local dev only).
const MAPS_KEY = ((import.meta as { env?: Record<string, string> }).env?.VITE_AZURE_MAPS_KEY as string) || '';

const KIND_COLOR: Record<TripMapPoint['kind'], string> = {
  origin: '#1f6feb', // anchor venue
  'on-site': '#2ea043', // meet at the conference (≈0 travel)
  'off-site': '#d29922', // nearby detour
};
const KIND_LABEL: Record<TripMapPoint['kind'], string> = {
  origin: 'anchor',
  'on-site': 'on-site',
  'off-site': 'off-site',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** Sample payload for standalone `?demo` preview — never used when embedded in a host. */
const DEMO_PAYLOAD: TripMapPayload = {
  title: 'MG Whitfield @ AUSA',
  caller: 'demo',
  roiScore: 3.4,
  overBudget: false,
  totalKm: 1580,
  origin: { id: 'event:E-AUSA', label: 'AUSA Annual Meeting', lat: 38.9037, lng: -77.0229, kind: 'origin', detail: 'Washington, DC · 2025-10-13→2025-10-15' },
  stops: [
    { id: 'C1', label: 'Dr. Alan Pierce', lat: 38.9037, lng: -77.0229, kind: 'on-site', detail: 're-engage · initiate · val 5 · score 0.81' },
    { id: 'C2', label: 'COL (R) Diane Fox', lat: 38.8816, lng: -77.0910, kind: 'off-site', detail: 're-engage · STALE · val 4 · score 0.74' },
    { id: 'C3', label: 'Sam Ortega (Anduril)', lat: 39.5290, lng: -76.1620, kind: 'off-site', detail: 'initiate · val 4 · score 0.66' },
    { id: 'C4', label: 'Redstone PM', lat: 34.6866, lng: -86.6689, kind: 'off-site', detail: 're-engage · STALE · val 5 · score 0.63' },
  ],
  legs: [
    { fromLat: 38.9037, fromLng: -77.0229, toLat: 38.8816, toLng: -77.091, mode: 'ground', distanceKm: 8 },
    { fromLat: 38.8816, fromLng: -77.091, toLat: 39.529, toLng: -76.162, mode: 'ground', distanceKm: 120 },
    { fromLat: 39.529, fromLng: -76.162, toLat: 34.6866, toLng: -86.6689, mode: 'air', distanceKm: 1120 },
  ],
};

// ── map view ───────────────────────────────────────────────────────────────

function MapView({ payload }: { payload: TripMapPayload }) {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapObj = useRef<atlas.Map | null>(null);
  const routeSrc = useRef<atlas.source.DataSource | null>(null);
  const markers = useRef<atlas.HtmlMarker[]>([]);
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState('');

  // Create the Azure Maps control once.
  useEffect(() => {
    if (!mapDiv.current) return;
    let map: atlas.Map;
    try {
      map = new atlas.Map(mapDiv.current, {
        center: [-92, 38],
        zoom: 3,
        style: 'road',
        showLogo: true,
        authOptions: { authType: atlas.AuthenticationType.subscriptionKey, subscriptionKey: MAPS_KEY },
      });
    } catch (err) {
      setMapError(err instanceof Error ? err.message : String(err));
      return;
    }
    mapObj.current = map;
    map.events.add('ready', () => {
      const src = new atlas.source.DataSource();
      map.sources.add(src);
      routeSrc.current = src;
      map.layers.add(
        new atlas.layer.LineLayer(src, undefined, {
          strokeColor: '#f85149',
          strokeWidth: 3,
          strokeDashArray: [2, 2],
          lineJoin: 'round',
        }),
      );
      setReady(true);
    });
    map.events.add('error', (e) => setMapError(String((e as { message?: string }).message ?? 'map error')));
    return () => {
      setReady(false);
      routeSrc.current = null;
      markers.current = [];
      try {
        map.dispose();
      } catch {
        /* noop */
      }
      mapObj.current = null;
    };
  }, []);

  // Plot pins + legs whenever the payload changes and the map is ready.
  useEffect(() => {
    const map = mapObj.current;
    const src = routeSrc.current;
    if (!map || !src || !ready) return;

    markers.current.forEach((m) => map.markers.remove(m));
    markers.current = [];
    src.clear();

    const points: TripMapPoint[] = [payload.origin, ...payload.stops];
    const positions: atlas.data.Position[] = [];
    points.forEach((p, i) => {
      const pos: atlas.data.Position = [p.lng, p.lat];
      positions.push(pos);
      const marker = new atlas.HtmlMarker({
        position: pos,
        color: KIND_COLOR[p.kind],
        text: p.kind === 'origin' ? '★' : String(i),
        popup: new atlas.Popup({
          content: `<div style="padding:8px;max-width:260px;font:13px system-ui">
            <strong>${escapeHtml(p.label)}</strong>
            <div style="color:#666;margin-top:2px">${escapeHtml(KIND_LABEL[p.kind])}${p.detail ? ` · ${escapeHtml(p.detail)}` : ''}</div>
          </div>`,
          pixelOffset: [0, -30],
        }),
      });
      map.markers.add(marker);
      map.events.add('click', marker, () => marker.togglePopup());
      markers.current.push(marker);
    });

    for (const leg of payload.legs) {
      src.add(new atlas.data.Feature(new atlas.data.LineString([[leg.fromLng, leg.fromLat], [leg.toLng, leg.toLat]])));
    }

    if (positions.length === 1) {
      map.setCamera({ center: positions[0], zoom: 8 });
    } else if (positions.length > 1) {
      map.setCamera({ bounds: atlas.data.BoundingBox.fromPositions(positions), padding: 70 });
    }
  }, [payload, ready]);

  if (mapError) return <SchematicView payload={payload} note={`Map unavailable (${mapError}). Showing the itinerary as a list.`} />;

  return (
    <div style={{ position: 'relative' }}>
      <div ref={mapDiv} style={{ height: 460, width: '100%', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(128,128,128,0.35)' }} />
      <Legend />
    </div>
  );
}

function Legend() {
  const items: TripMapPoint['kind'][] = ['origin', 'on-site', 'off-site'];
  return (
    <div className="card" style={{ position: 'absolute', top: 10, right: 10, padding: '8px 10px', fontSize: 12, lineHeight: 1.6 }}>
      {items.map((k) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: KIND_COLOR[k], display: 'inline-block' }} />
          {KIND_LABEL[k]}
        </div>
      ))}
    </div>
  );
}

// ── list / schematic fallback ────────────────────────────────────────────────

function SchematicView({ payload, note }: { payload: TripMapPayload; note?: string }) {
  const rows: TripMapPoint[] = [payload.origin, ...payload.stops];
  return (
    <div className="card" style={{ padding: 16 }}>
      {note && <p className="muted" style={{ marginTop: 0 }}>{note}</p>}
      <ol style={{ paddingLeft: 20, margin: 0 }}>
        {rows.map((p, i) => (
          <li key={p.id} style={{ marginBottom: 8 }}>
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: KIND_COLOR[p.kind], marginRight: 8 }} />
            <strong>{p.kind === 'origin' ? '★ ' : `${i}. `}{p.label}</strong>{' '}
            <span className="muted">({KIND_LABEL[p.kind]})</span>
            {p.detail && <div className="muted" style={{ marginLeft: 18 }}>{p.detail}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── header + shell ───────────────────────────────────────────────────────────

function TripMap({ payload }: { payload: TripMapPayload }) {
  const stopCount = payload.stops.length;
  const offSite = payload.stops.filter((s) => s.kind === 'off-site').length;
  return (
    <main style={{ maxWidth: 1040, margin: '1rem auto', padding: '0 1rem' }}>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 20 }}>{payload.title}</h1>
        <div className="muted" style={{ fontSize: 13, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span>{stopCount} stop(s) · {offSite} off-site</span>
          {typeof payload.totalKm === 'number' && <span>{payload.totalKm} km travel</span>}
          {typeof payload.roiScore === 'number' && (
            <span style={{ color: payload.overBudget ? '#f85149' : undefined }}>
              ROI {payload.roiScore}{payload.overBudget ? ' · OVER BUDGET' : ''}
            </span>
          )}
          {payload.caller && <span>caller: {payload.caller}</span>}
        </div>
      </header>
      {MAPS_KEY ? <MapView payload={payload} /> : <SchematicView payload={payload} note="No Azure Maps key baked into this build — showing the itinerary as a list. Set AZURE_MAPS_KEY in the repo-root .env and rebuild to see the map." />}
    </main>
  );
}

// ── host wiring ──────────────────────────────────────────────────────────────

function tripMapFromResult(result: CallToolResult | null): TripMapPayload | null {
  const sc = result?.structuredContent as { tripMap?: TripMapPayload } | undefined;
  return sc?.tripMap ?? null;
}

function ConnectedApp() {
  const [payload, setPayload] = useState<TripMapPayload | null>(null);
  const [, setHostContext] = useState<McpUiHostContext | undefined>();

  const { app, error } = useApp({
    appInfo: { name: 'Trip Map', version: '0.1.0' },
    capabilities: {},
    onAppCreated: (a: App) => {
      a.ontoolresult = async (result) => setPayload(tripMapFromResult(result));
      a.onhostcontextchanged = (ctx) => {
        if (ctx.theme) document.documentElement.dataset.theme = ctx.theme;
        setHostContext((prev) => ({ ...prev, ...ctx }));
      };
      a.onerror = (e) => console.error(e);
    },
  });

  useEffect(() => {
    const ctx = app?.getHostContext();
    if (ctx?.theme) document.documentElement.dataset.theme = ctx.theme;
    if (ctx) setHostContext(ctx);
  }, [app]);

  if (error) return <Notice>Could not connect to the MCP host: {error.message}</Notice>;
  if (!app) return <Notice>Connecting to host…</Notice>;
  if (!payload) return <Notice>Waiting for an itinerary — run <code>build_itinerary</code> to plot the trip.</Notice>;
  return <TripMap payload={payload} />;
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 1040, margin: '2rem auto', padding: '0 1rem' }}>
      <p className="muted">{children}</p>
    </main>
  );
}

function Root() {
  const demo = useMemo(() => new URLSearchParams(window.location.search).has('demo'), []);
  return demo ? <TripMap payload={DEMO_PAYLOAD} /> : <ConnectedApp />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
