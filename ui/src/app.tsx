import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { login, logout, getAccessToken, getActiveAccount, getIsAuthenticated } from './auth/msal';
import {
  ApiError,
  type AnnotationNode,
  type BundleNode,
  type BundleResponse,
  type CompanyNode,
  type ContactNode,
  type DiffNode,
  type EducationNode,
  type GeoCityNode,
  type GeoCoords,
  type JobApplicationNode,
  type OpeningNode,
  type PersonNode,
  type QueryBundleParams,
  type QueryBundleResult,
  type QueryDagParams,
  type QueryDagResult,
  type ResumeNode,
  type SkillNode,
  queryBundle,
  queryDag,
  queryDagById,
  searchBundles,
} from './api';
import { RelationshipGraph } from './RelationshipGraph';
import { MapView } from './MapView';

const DEFAULT_CITY = 'Chicago';
const DEFAULT_RADIUS_MI = 25;
const VERSION_LABEL = import.meta.env.VITE_APP_VERSION || 'dev';

const sectionStyle: CSSProperties = {
  background: '#fff',
  borderRadius: 10,
  boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  padding: 16,
};

function App() {
  const [apiBase, setApiBase] = useState(import.meta.env.VITE_API_BASE_URL || 'http://localhost:7071/api');
  const [bundleId, setBundleId] = useState('');
  const [bundleResult, setBundleResult] = useState<QueryBundleResult | null>(null);
  const [dagResult, setDagResult] = useState<QueryDagResult | null>(null);
  const [bundleSearchQ, setBundleSearchQ] = useState('');
  const [bundleSearchLimit, setBundleSearchLimit] = useState(10);
  const [bundleSearchResults, setBundleSearchResults] = useState<BundleResponse[]>([]);
  const [newBundleId, setNewBundleId] = useState('');
  const [newResumeUrl, setNewResumeUrl] = useState('');
  const [newResumeText, setNewResumeText] = useState('');
  const [newResumeName, setNewResumeName] = useState('');
  const [newContactFullName, setNewContactFullName] = useState('');
  const [newContactEmail, setNewContactEmail] = useState('');
  const [newContactPhone, setNewContactPhone] = useState('');
  const [newContactCity, setNewContactCity] = useState('');
  const [newContactState, setNewContactState] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenPreview, setTokenPreview] = useState<string>('');
  const [isAuthenticated, setIsAuthenticated] = useState(getIsAuthenticated());
  const [graphMode, setGraphMode] = useState<'bundle' | 'dag'>('bundle');
  const [graphSearch, setGraphSearch] = useState('');
  const [cityQuery, setCityQuery] = useState(DEFAULT_CITY);
  const [radiusMiles, setRadiusMiles] = useState<number>(DEFAULT_RADIUS_MI);
  const [mapCenter, setMapCenter] = useState<GeoCoords | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const graphContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setIsAuthenticated(getIsAuthenticated());
    setTokenPreview(getAccessToken() || '');
  }, []);

  const graphData = useMemo(() => {
    return graphMode === 'bundle' ? bundleResult?.graph ?? null : dagResult?.graph ?? null;
  }, [graphMode, bundleResult, dagResult]);

  const graphSummary = useMemo(() => {
    if (!graphData) return null;
    return {
      nodes: graphData.nodes.length,
      edges: graphData.edges.length,
      rootIds: graphData.rootIds,
      generatedAt: graphData.generatedAt,
    };
  }, [graphData]);

  async function withLoading<T>(fn: () => Promise<T>) {
    setLoading(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`${err.message}${err.details ? `\n${JSON.stringify(err.details, null, 2)}` : ''}`);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(String(err));
      }
      throw err;
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin() {
    await login();
    setIsAuthenticated(getIsAuthenticated());
    setTokenPreview(getAccessToken() || '');
  }

  function handleLogout() {
    logout();
    setIsAuthenticated(getIsAuthenticated());
    setTokenPreview('');
  }

  async function loadBundle() {
    const id = bundleId.trim();
    if (!id) {
      setError('Enter a bundle id first.');
      return;
    }

    await withLoading(async () => {
      const result = await queryBundle(apiBase, { bundleId: id });
      setBundleResult(result);
      setGraphMode('bundle');
    });
  }

  async function loadDag() {
    const id = bundleId.trim();
    if (!id) {
      setError('Enter a bundle id first.');
      return;
    }

    await withLoading(async () => {
      const result = await queryDagById(apiBase, id);
      setDagResult(result);
      setGraphMode('dag');
    });
  }

  async function runBundleSearch() {
    await withLoading(async () => {
      const results = await searchBundles(apiBase, {
        q: bundleSearchQ || undefined,
        limit: bundleSearchLimit,
      });
      setBundleSearchResults(results.results);
    });
  }

  async function createBundle() {
    if (!newBundleId.trim()) {
      setError('Bundle id is required.');
      return;
    }

    const payload: QueryBundleParams = {
      bundleId: newBundleId.trim(),
      resume: {
        name: newResumeName || undefined,
        url: newResumeUrl || undefined,
        text: newResumeText || undefined,
      },
      contact: {
        fullName: newContactFullName || undefined,
        email: newContactEmail || undefined,
        phone: newContactPhone || undefined,
        city: newContactCity || undefined,
        state: newContactState || undefined,
      },
    };

    await withLoading(async () => {
      const result = await queryBundle(apiBase, payload);
      setBundleResult(result);
      setBundleId(payload.bundleId);
      setGraphMode('bundle');
    });
  }

  async function refreshGraph() {
    if (graphMode === 'bundle') {
      await loadBundle();
    } else {
      await loadDag();
    }
  }

  async function handleCitySearch() {
    const city = cityQuery.trim() || DEFAULT_CITY;
    setCityQuery(city);
    setMapError(null);

    try {
      const result = await queryDag(apiBase, {
        city,
        radiusMiles,
      } as QueryDagParams);
      setDagResult(result);
      setGraphMode('dag');
      const cityNode = result.graph.nodes.find((n): n is GeoCityNode => n.kind === 'geo_city');
      if (cityNode?.coords) {
        setMapCenter(cityNode.coords);
      }
    } catch (err) {
      if (err instanceof Error) {
        setMapError(err.message);
      } else {
        setMapError(String(err));
      }
    }
  }

  const filteredNodes = useMemo(() => {
    if (!graphData) return [];
    const q = graphSearch.trim().toLowerCase();
    if (!q) return graphData.nodes;
    return graphData.nodes.filter((node) => JSON.stringify(node).toLowerCase().includes(q));
  }, [graphData, graphSearch]);

  return (
    <div style={{ fontFamily: 'Arial, sans-serif', margin: '0 auto', maxWidth: 1200, padding: 16 }}>
      <div
        style={{
          position: 'fixed',
          right: 16,
          bottom: 16,
          zIndex: 1000,
          padding: '6px 10px',
          borderRadius: 999,
          background: 'rgba(15, 23, 42, 0.9)',
          color: '#fff',
          fontSize: 12,
          letterSpacing: 0.3,
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
        }}
        title="UI build version"
      >
        Build {VERSION_LABEL}
      </div>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ marginBottom: 8 }}>Greenhouse Resume Builder Playground</h1>
        <p style={{ color: '#555', marginTop: 0 }}>
          Exercise bundle and DAG endpoints, visualize relationships, and inspect geospatial coverage.
        </p>
      </header>

      <section style={{ ...sectionStyle, marginBottom: 16 }}>
        <h2>API Connection</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ flex: 1, minWidth: 320 }}>
            API Base URL
            <input
              style={{ width: '100%', padding: 8, marginTop: 4 }}
              value={apiBase}
              onChange={(e) => setApiBase(e.target.value)}
            />
          </label>
          <div>
            <button onClick={handleLogin} disabled={loading || isAuthenticated} style={{ marginRight: 8 }}>
              Login
            </button>
            <button onClick={handleLogout} disabled={loading || !isAuthenticated}>
              Logout
            </button>
          </div>
        </div>
        <p style={{ marginBottom: 4 }}>Authenticated: {isAuthenticated ? 'Yes' : 'No'}</p>
        <p style={{ marginTop: 4, wordBreak: 'break-all' }}>
          Access Token: {tokenPreview ? `${tokenPreview.slice(0, 32)}…` : 'Not available'}
        </p>
      </section>

      <section style={{ ...sectionStyle, marginBottom: 16 }}>
        <h2>Open Existing Bundle / DAG</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ flex: 1, minWidth: 280 }}>
            Bundle ID
            <input
              style={{ width: '100%', padding: 8, marginTop: 4 }}
              value={bundleId}
              onChange={(e) => setBundleId(e.target.value)}
              placeholder="resume-bundle-123"
            />
          </label>
          <button onClick={loadBundle} disabled={loading}>Load Bundle</button>
          <button onClick={loadDag} disabled={loading}>Load DAG</button>
          <button onClick={refreshGraph} disabled={loading || !bundleId.trim()}>
            Refresh Current Graph
          </button>
        </div>
      </section>

      <section style={{ ...sectionStyle, marginBottom: 16 }}>
        <h2>Search Bundles</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ flex: 1, minWidth: 240 }}>
            Search query
            <input
              style={{ width: '100%', padding: 8, marginTop: 4 }}
              value={bundleSearchQ}
              onChange={(e) => setBundleSearchQ(e.target.value)}
              placeholder="name, email, company..."
            />
          </label>
          <label>
            Limit
            <input
              type="number"
              min={1}
              max={100}
              style={{ width: 100, padding: 8, marginTop: 4 }}
              value={bundleSearchLimit}
              onChange={(e) => setBundleSearchLimit(Number(e.target.value) || 10)}
            />
          </label>
          <button onClick={runBundleSearch} disabled={loading}>Search</button>
        </div>
        <ul>
          {bundleSearchResults.map((item) => (
            <li key={item.bundleId}>
              <button
                onClick={() => {
                  setBundleId(item.bundleId);
                  setBundleResult(item);
                  setGraphMode('bundle');
                }}
              >
                {item.bundleId}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section style={{ ...sectionStyle, marginBottom: 16 }}>
        <h2>Create / Update Bundle</h2>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <label>
            Bundle ID
            <input style={{ width: '100%', padding: 8, marginTop: 4 }} value={newBundleId} onChange={(e) => setNewBundleId(e.target.value)} />
          </label>
          <label>
            Resume Name
            <input style={{ width: '100%', padding: 8, marginTop: 4 }} value={newResumeName} onChange={(e) => setNewResumeName(e.target.value)} />
          </label>
          <label>
            Resume URL
            <input style={{ width: '100%', padding: 8, marginTop: 4 }} value={newResumeUrl} onChange={(e) => setNewResumeUrl(e.target.value)} />
          </label>
          <label>
            Contact Full Name
            <input
              style={{ width: '100%', padding: 8, marginTop: 4 }}
              value={newContactFullName}
              onChange={(e) => setNewContactFullName(e.target.value)}
            />
          </label>
          <label>
            Contact Email
            <input style={{ width: '100%', padding: 8, marginTop: 4 }} value={newContactEmail} onChange={(e) => setNewContactEmail(e.target.value)} />
          </label>
          <label>
            Contact Phone
            <input style={{ width: '100%', padding: 8, marginTop: 4 }} value={newContactPhone} onChange={(e) => setNewContactPhone(e.target.value)} />
          </label>
          <label>
            Contact City
            <input style={{ width: '100%', padding: 8, marginTop: 4 }} value={newContactCity} onChange={(e) => setNewContactCity(e.target.value)} />
          </label>
          <label>
            Contact State
            <input style={{ width: '100%', padding: 8, marginTop: 4 }} value={newContactState} onChange={(e) => setNewContactState(e.target.value)} />
          </label>
        </div>
        <label style={{ display: 'block', marginTop: 12 }}>
          Resume Text
          <textarea
            style={{ width: '100%', minHeight: 120, padding: 8, marginTop: 4 }}
            value={newResumeText}
            onChange={(e) => setNewResumeText(e.target.value)}
          />
        </label>
        <button onClick={createBundle} disabled={loading} style={{ marginTop: 12 }}>
          Save Bundle
        </button>
      </section>

      <section style={{ ...sectionStyle, marginBottom: 16 }}>
        <h2>City Radius Query</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label>
            City
            <input style={{ width: 200, padding: 8, marginTop: 4 }} value={cityQuery} onChange={(e) => setCityQuery(e.target.value)} />
          </label>
          <label>
            Radius (miles)
            <input
              type="number"
              min={1}
              style={{ width: 120, padding: 8, marginTop: 4 }}
              value={radiusMiles}
              onChange={(e) => setRadiusMiles(Number(e.target.value) || DEFAULT_RADIUS_MI)}
            />
          </label>
          <button onClick={handleCitySearch} disabled={loading}>Run City Search</button>
        </div>
        {mapError ? <p style={{ color: 'crimson' }}>{mapError}</p> : null}
      </section>

      {error ? (
        <section style={{ ...sectionStyle, marginBottom: 16, border: '1px solid #f5c2c7', background: '#f8d7da' }}>
          <strong>Error</strong>
          <pre style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{error}</pre>
        </section>
      ) : null}

      <section style={{ ...sectionStyle, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>Relationship Graph</h2>
            <p style={{ margin: 0, color: '#666' }}>
              Mode: <strong>{graphMode.toUpperCase()}</strong>
              {graphSummary ? ` · ${graphSummary.nodes} nodes · ${graphSummary.edges} edges` : ''}
            </p>
          </div>
          <label>
            Filter nodes
            <input style={{ marginLeft: 8, padding: 8 }} value={graphSearch} onChange={(e) => setGraphSearch(e.target.value)} />
          </label>
        </div>
        <div ref={graphContainerRef} style={{ marginTop: 16 }}>
          <RelationshipGraph graph={graphData} filteredNodes={filteredNodes} />
        </div>
      </section>

      <section style={{ ...sectionStyle, marginBottom: 16 }}>
        <h2>Map View</h2>
        <MapView graph={graphData} center={mapCenter} />
      </section>

      <section style={sectionStyle}>
        <h2>Graph JSON</h2>
        <pre style={{ maxHeight: 360, overflow: 'auto', background: '#f8f9fb', padding: 12, borderRadius: 8 }}>
          {JSON.stringify(graphData, null, 2)}
        </pre>
      </section>
    </div>
  );
}

function renderNodeLabel(node: BundleNode) {
  switch (node.kind) {
    case 'resume':
      return `Resume: ${(node as ResumeNode).name ?? node.id}`;
    case 'contact':
      return `Contact: ${(node as ContactNode).fullName ?? node.id}`;
    case 'person':
      return `Person: ${(node as PersonNode).fullName ?? node.id}`;
    case 'company':
      return `Company: ${(node as CompanyNode).name ?? node.id}`;
    case 'job_application':
      return `Application: ${(node as JobApplicationNode).title ?? node.id}`;
    case 'opening':
      return `Opening: ${(node as OpeningNode).title ?? node.id}`;
    case 'skill':
      return `Skill: ${(node as SkillNode).name ?? node.id}`;
    case 'education':
      return `Education: ${(node as EducationNode).school ?? node.id}`;
    case 'annotation':
      return `Annotation: ${(node as AnnotationNode).type ?? node.id}`;
    case 'diff':
      return `Diff: ${(node as DiffNode).name ?? node.id}`;
    case 'geo_city':
      return `City: ${(node as GeoCityNode).name ?? node.id}`;
    default:
      return node.id;
  }
}

export default App;
