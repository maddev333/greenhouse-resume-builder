/**
 * MapView — renders a candidate's location-bearing facts on an Azure Maps map (profile page, page 2).
 *
 * Location strings are pulled from the candidate's extracted facts and geocoded by the Geospatial MCP
 * server (`project_map_pins`); this component only renders the returned pins. Degrades gracefully when
 * no Azure Maps authentication is configured (lists the pins instead of drawing the map).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as atlas from 'azure-maps-control';
import 'azure-maps-control/dist/atlas.min.css';
import {
  MAPS_CLIENT_ID,
  extractLocationRecords,
  projectMapPins,
  categoryByQuery,
  type MapPin,
  type LocationCategory,
} from './geo';

const CATEGORY_COLOR: Record<LocationCategory, string> = {
  current: '#2563eb',
  work: '#059669',
  education: '#7c3aed',
  other: '#6b7280',
};
const CATEGORY_LABEL: Record<LocationCategory, string> = {
  current: 'Current location',
  work: 'Work',
  education: 'Education',
  other: 'Other',
};

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

export function MapView({ personId, sections }: { personId: string; sections: Record<string, any[]> }) {
  const records = useMemo(() => extractLocationRecords(sections), [sections]);
  const categoryLookup = useMemo(() => categoryByQuery(records), [records]);

  const [pins, setPins] = useState<MapPin[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const mapDiv = useRef<HTMLDivElement>(null);
  const mapObj = useRef<atlas.Map | null>(null);
  const markers = useRef<atlas.HtmlMarker[]>([]);
  const [mapReady, setMapReady] = useState(false);

  // Geocode the candidate's location facts via the Geospatial MCP whenever they change.
  useEffect(() => {
    let cancelled = false;
    if (records.length === 0) {
      setPins([]);
      setStatus('');
      return;
    }
    setBusy(true);
    setStatus('Geocoding candidate locations…');
    projectMapPins(personId, records)
      .then((res) => {
        if (cancelled) return;
        setPins(res.pins);
        if (!res.mapsConfigured) {
          setStatus('The Geospatial MCP server has no Azure Maps key (set AZURE_MAPS_KEY for the server).');
        } else {
          setStatus(`${res.pins.length} of ${res.requested ?? records.length} location(s) mapped.`);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setPins([]);
        setStatus(`Error: ${err?.message || err}. Is the Geospatial MCP server running on :7076?`);
      })
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [personId, records]);

  // Create the Azure Maps control once (only when a browser key or client ID is available).
  useEffect(() => {
    const mapsKey = ((import.meta as any).env?.VITE_AZURE_MAPS_KEY as string) || '';
    if (!mapsKey && !MAPS_CLIENT_ID || !mapDiv.current) return;

    let authOptions: any;
    if (mapsKey) {
      // Local dev: subscription key authentication
      authOptions = { 
        authType: atlas.AuthenticationType.subscriptionKey, 
        subscriptionKey: mapsKey 
      };
    } else if (MAPS_CLIENT_ID) {
      // Production: AAD anonymous/authenticated authentication via client ID
      const tokenScope = ((import.meta as any).env?.VITE_AZURE_MAPS_TOKEN_SCOPE as string) || 'https://atlas.microsoft.com/.default';
      
      authOptions = { 
        authType: atlas.AuthenticationType.aad, 
        aadAppId: MAPS_CLIENT_ID,
        aadTokenProviderFunction: async () => {
          // For AAD anonymous auth with the map's client ID, we need to acquire a token.
          // In a production SPA using MSAL (which this app already has configured),
          // we would call msalInstance.acquireTokenSilent({ scopes: [tokenScope] }).
          // For now, return null to let the Azure Maps SDK handle sign-in UI.
          return null;
        },
      };
    } else {
      return; // Neither key nor client ID configured
    }

    const map = new atlas.Map(mapDiv.current, {
      center: [-98, 39],
      zoom: 3,
      style: 'road',
      authOptions,
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
      const category = categoryLookup.get(String(p.query ?? p.label ?? '').toLowerCase()) ?? 'other';
      const title = p.label || p.address || `${p.latitude}, ${p.longitude}`;
      const marker = new atlas.HtmlMarker({
        position: pos,
        color: CATEGORY_COLOR[category],
        popup: new atlas.Popup({
          content: `<div style="padding:8px;max-width:240px;font:13px system-ui">
            <strong>${escapeHtml(String(title))}</strong>
            <br/><span style="color:${CATEGORY_COLOR[category]}">${CATEGORY_LABEL[category]}</span>
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
  }, [pins, mapReady, categoryLookup]);

  if (records.length === 0) {
    return (
      <div style={{ padding: 24, background: '#fff', borderRadius: 8, color: '#6b7280', boxShadow: '#e5e7eb 0px 1px 3px' }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 600, color: '#111827' }}>Locations</h3>
        No location data for this candidate yet. Locations are extracted from profile, experience and
        education facts during ingestion.
      </div>
    );
  }

  const usedCategories = Array.from(new Set(records.map((r) => r.category)));

  return (
    <div style={{ background: '#fff', borderRadius: 8, padding: '16px 20px', boxShadow: '#e5e7eb 0px 1px 3px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Candidate locations</h3>
        <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#6b7280' }}>
          {usedCategories.map((c) => (
            <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: CATEGORY_COLOR[c], display: 'inline-block' }} />
              {CATEGORY_LABEL[c]}
            </span>
          ))}
        </div>
      </div>

      {MAPS_CLIENT_ID || import.meta.env.VITE_AZURE_MAPS_KEY ? (
        <div ref={mapDiv} style={{ height: 460, width: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid #e5e7eb' }} />
      ) : (
        <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16, border: '1px dashed #d1d5db', borderRadius: 8, color: '#6b7280' }}>
          No Azure Maps authentication configured in the browser bundle. Set <code>AZURE_MAPS_KEY</code> 
          (local dev) or <code>VITE_AZURE_MAPS_CLIENT_ID</code> and <code>VITE_AZURE_MAPS_TOKEN_SCOPE</code> 
          (production AAD auth) in <code>ui/.env</code> and restart the dev server. Geocoded
          locations still list below.
        </div>
      )}

      <p style={{ color: busy ? '#2563eb' : '#6b7280', fontSize: 13, minHeight: 18, marginBottom: 4 }}>{status}</p>

      <ul style={{ paddingLeft: 18, margin: 0, fontSize: 13, color: '#374151' }}>
        {pins.map((p, i) => {
          const category = categoryLookup.get(String(p.query ?? p.label ?? '').toLowerCase()) ?? 'other';
          const matched = typeof p.latitude === 'number' && typeof p.longitude === 'number';
          return (
            <li key={i} style={{ marginBottom: 4 }}>
              <span style={{ color: CATEGORY_COLOR[category], fontWeight: 600 }}>{CATEGORY_LABEL[category]}</span>{' '}
              — {p.label || p.query}
              {matched ? ` (${p.latitude!.toFixed(3)}, ${p.longitude!.toFixed(3)})` : ' — no geocode match'}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
