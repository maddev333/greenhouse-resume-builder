/**
 * RelationshipsExplorer — visualizes a candidate's relationship neighborhood.
 *
 * Two views over the same `GET /inferences/:personId/graph` payload:
 *   • Graph — a dependency-free SVG node-link diagram (radial layout). The center node is the
 *     current candidate; related people fan out around it. Clicking a related node navigates to
 *     that candidate. Edge colour encodes status (confirmed = solid green, suggested = dashed amber).
 *   • Map  — the same people plotted on Azure Maps using each person's primary location
 *     (`profile.location`, geocoded via the Geospatial MCP), with connecting lines for each edge.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as atlas from 'azure-maps-control';
import 'azure-maps-control/dist/atlas.min.css';
import {
  apiRelationships,
  type RelationshipGraph,
  type RelationshipGraphNode,
} from './api';
import { MAPS_KEY, projectMapPins, type LocationRecord } from './geo';

const STATUS_STYLE: Record<string, { color: string; dash?: string; label: string }> = {
  confirmed: { color: '#059669', label: 'Confirmed' },
  suggested: { color: '#d97706', dash: '6 4', label: 'Suggested' },
  rejected: { color: '#9ca3af', dash: '2 4', label: 'Rejected' },
};
const CENTER_COLOR = '#2563eb';
const NEIGHBOR_COLOR = '#0d9488';

function statusStyle(status: string) {
  return STATUS_STYLE[status] ?? { color: '#6b7280', label: status };
}

function shortLabel(node: RelationshipGraphNode): string {
  const name = (node.name ?? '').trim();
  if (name) return name.length > 22 ? `${name.slice(0, 21)}…` : name;
  return node.id.length > 16 ? `${node.id.slice(0, 15)}…` : node.id;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

// ── SVG node-link graph ───────────────────────────────────────────────────────

function GraphSvg({
  graph,
  onSelectPerson,
}: {
  graph: RelationshipGraph;
  onSelectPerson?: (id: string) => void;
}) {
  const W = 760;
  const H = 480;
  const layout = useMemo(() => {
    const center = graph.nodes.find((n) => n.isCenter) ?? graph.nodes[0];
    const others = graph.nodes.filter((n) => n.id !== center?.id);
    const cx = W / 2;
    const cy = H / 2;
    const radius = Math.min(W, H) / 2 - 80;
    const pos = new Map<string, { x: number; y: number }>();
    if (center) pos.set(center.id, { x: cx, y: cy });
    others.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(others.length, 1) - Math.PI / 2;
      pos.set(n.id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
    });
    return { pos, center };
  }, [graph]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: 480, background: '#fafafa', border: '1px solid #e5e7eb', borderRadius: 8 }}
      role="img"
      aria-label="Relationship graph"
    >
      {/* edges first so nodes render on top */}
      {graph.edges.map((e) => {
        const a = layout.pos.get(e.fromPersonId);
        const b = layout.pos.get(e.toPersonId);
        if (!a || !b) return null;
        const s = statusStyle(e.status);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const typeLabel = e.relationshipType ? e.relationshipType.replace(/_/g, ' ') : '';
        return (
          <g key={e.relationshipId}>
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={s.color}
              strokeWidth={2}
              strokeDasharray={s.dash}
              opacity={0.85}
            >
              <title>{`${typeLabel || 'related'} · ${s.label}${e.confidence ? ` · ${(e.confidence * 100).toFixed(0)}%` : ''}`}</title>
            </line>
            {typeLabel ? (
              <text x={mx} y={my - 4} fontSize={10} fill="#6b7280" textAnchor="middle" style={{ pointerEvents: 'none' }}>
                {typeLabel}
              </text>
            ) : null}
          </g>
        );
      })}

      {graph.nodes.map((n) => {
        const p = layout.pos.get(n.id);
        if (!p) return null;
        const r = n.isCenter ? 24 : 19;
        const clickable = !n.isCenter && !!onSelectPerson;
        return (
          <g
            key={n.id}
            style={{ cursor: clickable ? 'pointer' : 'default' }}
            onClick={clickable ? () => onSelectPerson!(n.id) : undefined}
          >
            <circle
              cx={p.x}
              cy={p.y}
              r={r}
              fill={n.isCenter ? CENTER_COLOR : '#fff'}
              stroke={n.isCenter ? CENTER_COLOR : NEIGHBOR_COLOR}
              strokeWidth={2.5}
            >
              <title>{`${n.name ?? n.id}${n.location ? ` — ${n.location}` : ''}`}</title>
            </circle>
            <text
              x={p.x}
              y={p.y + r + 14}
              fontSize={12}
              fontWeight={n.isCenter ? 700 : 500}
              fill="#111827"
              textAnchor="middle"
              style={{ pointerEvents: 'none' }}
            >
              {shortLabel(n)}
            </text>
            {n.location ? (
              <text x={p.x} y={p.y + r + 28} fontSize={10} fill="#9ca3af" textAnchor="middle" style={{ pointerEvents: 'none' }}>
                {n.location.length > 28 ? `${n.location.slice(0, 27)}…` : n.location}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

// ── Azure Maps overlay (people + connecting lines) ────────────────────────────

function GraphMap({ graph }: { graph: RelationshipGraph }) {
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

  const records = useMemo<LocationRecord[]>(() => {
    const seen = new Set<string>();
    const recs: LocationRecord[] = [];
    for (const n of graph.nodes) {
      const loc = (n.location ?? '').trim();
      if (!loc) continue;
      const key = loc.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      recs.push({ location: loc, category: n.isCenter ? 'current' : 'other', factKey: 'profile.location' });
    }
    return recs;
  }, [graph]);

  const [coordByLoc, setCoordByLoc] = useState<Map<string, { lat: number; lng: number; address?: string | null }>>(new Map());
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const mapDiv = useRef<HTMLDivElement>(null);
  const mapObj = useRef<atlas.Map | null>(null);
  const dataSource = useRef<atlas.source.DataSource | null>(null);
  const markers = useRef<atlas.HtmlMarker[]>([]);
  const [mapReady, setMapReady] = useState(false);

  // Geocode the distinct locations across the neighborhood (single MCP call).
  useEffect(() => {
    let cancelled = false;
    if (records.length === 0) {
      setCoordByLoc(new Map());
      setStatus('None of these candidates have a location to map.');
      return;
    }
    setBusy(true);
    setStatus('Geocoding candidate locations…');
    projectMapPins(graph.centerId, records)
      .then((res) => {
        if (cancelled) return;
        const m = new Map<string, { lat: number; lng: number; address?: string | null }>();
        for (const p of res.pins) {
          if (typeof p.latitude === 'number' && typeof p.longitude === 'number') {
            const key = String(p.query ?? p.label ?? '').toLowerCase();
            if (key) m.set(key, { lat: p.latitude, lng: p.longitude, address: p.address ?? null });
          }
        }
        setCoordByLoc(m);
        setStatus(
          res.mapsConfigured
            ? `${m.size} of ${records.length} location(s) mapped.`
            : 'The Geospatial MCP server has no Azure Maps key (set AZURE_MAPS_KEY for the server).',
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setCoordByLoc(new Map());
        setStatus(`Error: ${err?.message || err}. Is the Geospatial MCP server running on :7076?`);
      })
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [graph.centerId, records]);

  const coordFor = useCallback(
    (n: RelationshipGraphNode) => {
      const loc = (n.location ?? '').trim().toLowerCase();
      return loc ? coordByLoc.get(loc) : undefined;
    },
    [coordByLoc],
  );

  // Create the map control once (only when a browser key is available).
  useEffect(() => {
    if (!MAPS_KEY || !mapDiv.current) return;
    const map = new atlas.Map(mapDiv.current, {
      center: [-98, 39],
      zoom: 3,
      style: 'road',
      authOptions: { authType: atlas.AuthenticationType.subscriptionKey, subscriptionKey: MAPS_KEY },
    });
    mapObj.current = map;
    map.events.add('ready', () => {
      const ds = new atlas.source.DataSource();
      map.sources.add(ds);
      dataSource.current = ds;
      // Two line layers so confirmed/suggested edges look distinct.
      map.layers.add(
        new atlas.layer.LineLayer(ds, undefined, {
          strokeColor: STATUS_STYLE.confirmed.color,
          strokeWidth: 2.5,
          filter: ['==', ['get', 'status'], 'confirmed'] as any,
        }),
      );
      map.layers.add(
        new atlas.layer.LineLayer(ds, undefined, {
          strokeColor: STATUS_STYLE.suggested.color,
          strokeWidth: 2,
          strokeDashArray: [3, 3],
          filter: ['==', ['get', 'status'], 'suggested'] as any,
        }),
      );
      setMapReady(true);
    });
    return () => {
      setMapReady(false);
      dataSource.current = null;
      map.dispose();
      mapObj.current = null;
    };
  }, []);

  // Re-plot markers + edges whenever coords or the graph change.
  useEffect(() => {
    const map = mapObj.current;
    const ds = dataSource.current;
    if (!map || !ds || !mapReady) return;

    markers.current.forEach((m) => map.markers.remove(m));
    markers.current = [];
    ds.clear();

    const positions: atlas.data.Position[] = [];
    for (const n of graph.nodes) {
      const c = coordFor(n);
      if (!c) continue;
      const pos: atlas.data.Position = [c.lng, c.lat];
      positions.push(pos);
      const color = n.isCenter ? CENTER_COLOR : NEIGHBOR_COLOR;
      const marker = new atlas.HtmlMarker({
        position: pos,
        color,
        popup: new atlas.Popup({
          content: `<div style="padding:8px;max-width:240px;font:13px system-ui">
            <strong>${escapeHtml(n.name ?? n.id)}</strong>
            ${n.isCenter ? '<br/><span style="color:' + CENTER_COLOR + '">This candidate</span>' : ''}
            ${n.location ? `<br/>${escapeHtml(n.location)}` : ''}
          </div>`,
          pixelOffset: [0, -30],
        }),
      });
      map.markers.add(marker);
      map.events.add('click', marker, () => marker.togglePopup());
      markers.current.push(marker);
    }

    for (const e of graph.edges) {
      const from = nodeById.get(e.fromPersonId);
      const to = nodeById.get(e.toPersonId);
      if (!from || !to) continue;
      const ca = coordFor(from);
      const cb = coordFor(to);
      if (!ca || !cb) continue;
      if (ca.lat === cb.lat && ca.lng === cb.lng) continue; // co-located: no visible line
      ds.add(
        new atlas.data.Feature(
          new atlas.data.LineString([
            [ca.lng, ca.lat],
            [cb.lng, cb.lat],
          ]),
          { status: e.status, relationshipType: e.relationshipType },
        ),
      );
    }

    if (positions.length === 1) {
      map.setCamera({ center: positions[0], zoom: 8 });
    } else if (positions.length > 1) {
      map.setCamera({ bounds: atlas.data.BoundingBox.fromPositions(positions), padding: 70 });
    }
  }, [graph, coordByLoc, coordFor, mapReady, nodeById]);

  const unplaced = graph.nodes.filter((n) => !coordFor(n));

  return (
    <div>
      {MAPS_KEY ? (
        <div ref={mapDiv} style={{ height: 460, width: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid #e5e7eb' }} />
      ) : (
        <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16, border: '1px dashed #d1d5db', borderRadius: 8, color: '#6b7280' }}>
          No Azure Maps key in the browser bundle. Set <code>AZURE_MAPS_KEY</code> in the repo-root <code>.env</code>{' '}
          (or <code>VITE_AZURE_MAPS_KEY</code> in <code>ui/.env</code>) and restart the dev server.
        </div>
      )}
      <p style={{ color: busy ? '#2563eb' : '#6b7280', fontSize: 13, minHeight: 18, margin: '8px 0 4px' }}>{status}</p>
      {unplaced.length > 0 ? (
        <p style={{ color: '#9ca3af', fontSize: 12, margin: 0 }}>
          Not on map (no/unknown location): {unplaced.map((n) => n.name ?? n.id).join(', ')}
        </p>
      ) : null}
    </div>
  );
}

// ── Wrapper with Graph | Map toggle ───────────────────────────────────────────

export function RelationshipsExplorer({
  personId,
  onSelectPerson,
}: {
  personId: string;
  onSelectPerson?: (id: string) => void;
}) {
  const [graph, setGraph] = useState<RelationshipGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState<'graph' | 'map'>('graph');

  const load = useCallback(() => {
    if (!personId) return;
    setLoading(true);
    setError('');
    apiRelationships
      .getGraph(personId)
      .then((g) => setGraph(g))
      .catch((e) => {
        setError(e?.message || String(e));
        setGraph(null);
      })
      .finally(() => setLoading(false));
  }, [personId]);

  useEffect(() => {
    load();
  }, [load]);

  const neighborCount = graph ? graph.nodes.filter((n) => !n.isCenter).length : 0;
  const hasLocations = !!graph && graph.nodes.some((n) => (n.location ?? '').trim().length > 0);

  const tabBtn = (key: 'graph' | 'map', label: string, disabled = false) => (
    <button
      onClick={() => !disabled && setView(key)}
      disabled={disabled}
      style={{
        padding: '6px 12px',
        fontSize: 12,
        fontWeight: 600,
        border: '1px solid #d1d5db',
        background: view === key ? '#2563eb' : '#fff',
        color: disabled ? '#9ca3af' : view === key ? '#fff' : '#374151',
        cursor: disabled ? 'not-allowed' : 'pointer',
        borderRadius: 6,
      }}
      title={disabled ? 'No candidate locations available to map' : undefined}
    >
      {label}
    </button>
  );

  return (
    <div style={{ background: '#fff', borderRadius: 8, padding: '16px 20px', boxShadow: '#e5e7eb 0px 1px 3px', marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Relationship network</h3>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
            {neighborCount} connected {neighborCount === 1 ? 'person' : 'people'} · click a node to open that candidate
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {tabBtn('graph', 'Graph')}
          {tabBtn('map', 'Map', !hasLocations)}
          <button
            onClick={load}
            disabled={loading}
            style={{ padding: '6px 10px', fontSize: 12, border: '1px solid #d1d5db', background: '#fff', color: '#374151', borderRadius: 6, cursor: loading ? 'default' : 'pointer' }}
          >
            {loading ? '…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 14, fontSize: 12, color: '#6b7280', marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 14, height: 0, borderTop: `2px solid ${STATUS_STYLE.confirmed.color}`, display: 'inline-block' }} /> Confirmed
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 14, height: 0, borderTop: `2px dashed ${STATUS_STYLE.suggested.color}`, display: 'inline-block' }} /> Suggested
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: CENTER_COLOR, display: 'inline-block' }} /> This candidate
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', border: `2px solid ${NEIGHBOR_COLOR}`, display: 'inline-block' }} /> Related
        </span>
      </div>

      {loading && !graph ? (
        <p style={{ color: '#9ca3af', fontSize: 13 }}>Loading relationship graph…</p>
      ) : error ? (
        <p style={{ color: '#b91c1c', fontSize: 13 }}>Couldn’t load relationships: {error}</p>
      ) : !graph || neighborCount === 0 ? (
        <p style={{ color: '#9ca3af', fontSize: 13 }}>
          No relationships yet for this candidate. Suggested edges appear after ingestion finds people who share an
          employer.
        </p>
      ) : view === 'graph' ? (
        <GraphSvg graph={graph} onSelectPerson={onSelectPerson} />
      ) : (
        <GraphMap graph={graph} />
      )}
    </div>
  );
}
