/** Greenhouse Resume Builder - Landing page entry */
import { useState, useEffect, useCallback } from 'react';import type { ExtractionRun, BulletDiff, RelationshipEdge, AnnotationItem } from './api';

// ── API helper (use inline to avoid circular deps) ────

const BASE = (import.meta.env.VITE_API_URL ?? '/api/v1') as string;

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.method = method;
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, init);
  if (res.status === 204 || res.status === 205) return null as unknown as T;
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(detail.error ?? `API ${method} ${path}: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── UI Types ────────────────────────────────────────────────

interface BulletWithMeta {
  bulletText: string;
  citationIds: string[];
  factKey?: string;
  sectionId: string;
  id: string;
  citations?: string[];
}

// ── Helper: render a section card ───────────────────────────

function SectionCard({ title, bullets }: { title: string; bullets: BulletWithMeta[] }) {
  return (
    <div style={{ marginBottom: '24px', background: '#fff', borderRadius: 8, padding: '16px 20px', boxShadow: '#e5e7eb 0px 1px 3px' }}>
      <h3 style={{ fontSize: '18px', fontWeight: 600, margin: '0 0 12px' }}>{title}</h3>
      {bullets.length === 0 && <p style={{ color: '#9ca3af' }}>No data extracted</p>}
      {bullets.map(b => (
        <li key={b.id} style={{ marginBottom: 8, position: 'relative', padding: '8px 12px', background: b.citationIds?.length ? '#f0fdf4' : '#fafafa', borderRadius: 6 }}>
          <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.5 }}>{b.bulletText}</p>
          {b.factKey && <small style={{ color: '#93c5fd', display: 'block', marginTop: 2 }}>{b.factKey}</small>}
          {b.citationIds?.length ? <small style={{ color: '#6b7280', display: 'block', marginTop: 4 }}>{b.citationIds.length} citation{b.citationIds.length !== 1 ? 's' : ''}</small> : null}
        </li>
      ))}
    </div>
  );
}

// ── Search Panel ────────────────────────────────────────────

function SearchPanel({ personId }: { personId?: string }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await json<{ results: any[] }>('POST', `/search?personId=${encodeURIComponent(personId || '')}`, { query: query.trim() });
      setResults(data?.results ?? []);
    } catch (e: any) {
      setError(e.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ marginBottom: '24px', padding: '16px 20px', background: '#fff7ed', borderRadius: 8, border: '1px solid #fde68a' }}>
      <h3 style={{ fontSize: '18px', fontWeight: 600, margin: '0 0 8px' }}>🔍 Search All Content</h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && doSearch()}
          placeholder="Search facts, bullets, summaries..."
          style={{ flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: '14px' }}
        />
        <button onClick={doSearch} disabled={loading || !query.trim()} style={{
          padding: '8px 16px', background: loading ? '#d1d5db' : '#d97706', color: '#fff', border: 'none', borderRadius: 6, cursor: loading ? 'default' : 'pointer', fontSize: '14px'
        }}>
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>
      {error && <p style={{ color: '#dc2626', fontSize: '12px' }}>{error}</p>}
      {!loading && results.length > 0 ? (
        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          {results.map((r: any, i: number) => (
            <div key={i} style={{ padding: '8px 10px', background: '#fff', borderRadius: 6, marginBottom: 4, fontSize: '13px' }}>
              <div style={{ fontWeight: 500, color: '#d97706' }}>{r.sectionId?.[0] || '—'} — {r.factKey || r.bulletText ? (r.bulletText || r.factValue || '').slice(0, 120) : '—'}</div>
              {(r.score != null) && <small style={{ color: '#9ca3af' }}>Score: {r.score.toFixed(3)}</small>}
            </div>
          ))}
        </div>
      ) : !loading && query.trim() ? (
        <p style={{ color: '#a3a3a3', fontSize: '13px' }}>No results found</p>
      ) : null}
    </div>
  );
}

// ── Diff View ───────────────────────────────────────────────

function DiffView({ diffs }: { diffs: BulletDiff[] }) {
  if (!diffs.length) return <p>No diff available (need at least 2 runs).</p>;
  return (
    <div style={{ background: '#fff', borderRadius: 8, padding: '16px 20px', boxShadow: '#e5e7eb 0px 1px 3px' }}>
      <h3 style={{ fontSize: '18px', fontWeight: 600, margin: '0 0 12px' }}>Version Diffs</h3>
      {diffs.map((d, i) => (
        <div key={i} style={{ marginBottom: 8, padding: '6px 10px', background: d.type === 'added' ? '#f0fdf4' : d.type === 'removed' ? '#fef2f2' : '#fff7ed', borderRadius: 6 }}>
          <span style={{ fontWeight: 600, fontSize: '11px', textTransform: 'uppercase' }}>{d.type}</span>
          {d.previousBulletText && <p style={{ margin: '4px 0', color: '#a3a3a3' }}>Old: {d.previousBulletText}</p>}
          <p style={{ margin: '4px 0', fontWeight: 500 }}>{d.currentBulletText || <em>removed</em>}</p>
        </div>
      ))}
    </div>
  );
}

// ── Annotation Panel (live-bound to API) ───────────────────

function AnnotationPanel({ personId, targetFactId }: { personId: string; targetFactId?: string }) {
  const [annotations, setAnnotations] = useState<AnnotationItem[]>([]);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!personId) return;
    setLoading(true);
    json<AnnotationItem[]>(`GET`, `/annotations${personId ? `?personId=${encodeURIComponent(personId)}` : ''}`).then(data => {
      setAnnotations(Array.isArray(data) ? data : []);
    }).catch(() => setAnnotations([])).finally(() => setLoading(false));
  }, [personId]);

  const handleSave = useCallback(() => {
    if (!comment.trim()) return;
    json<AnnotationItem>(`PUT`, `/annotations/ann-${Date.now()}`, { commentText: comment.trim(), targetFactVersionId: targetFactId }).then((saved: AnnotationItem) => {
      setAnnotations(prev => [...prev, saved]);
      setComment('');
    });
  }, [comment, targetFactId]);

  const toggleStatus = (id: string, currentStatus: 'open' | 'resolved') => {
    json<any>(`PATCH`, `/annotations/${id}`, { status: currentStatus === 'open' ? 'resolved' : 'open' as const }).then(() => {
      setAnnotations(prev => prev.map(a => a.id === id ? ({ ...a, status: currentStatus === 'open' ? 'open' as const : 'resolved' }) as AnnotationItem : a));
    });
  };

  return (
    <aside style={{ width: '280px', padding: '16px', background: '#f9fafb', borderLeft: '1px solid #e5e7eb', overflowY: 'auto' }}>
      <p style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 8px' }}>Annotations</p>
      {targetFactId && <small style={{ color: '#6b7280', display: 'block', marginBottom: 8 }}>Target: {targetFactId.slice(0, 16)}...</small>}
      <textarea value={comment} placeholder="Add a note..." onChange={e => setComment(e.target.value)} style={{ width: '100%', minHeight: 80, fontSize: '13px', padding: 8, borderRadius: 6, resize: 'vertical' }} />
      <button onClick={handleSave} style={{ marginTop: 4, fontSize: '12px', padding: '6px 12px' }}>Save Note</button>

      {loading ? (
        <p style={{ color: '#9ca3af', fontSize: '12px' }}>Loading...</p>
      ) : annotations.map(a => (
        <div key={a.id} style={{ marginBottom: 8, padding: '8px', background: a.status === 'resolved' ? '#f0fdf4' : '#fff', borderRadius: 6, fontSize: '13px' }}>
          <div>{a.commentText}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <small style={{ color: '#9ca3af' }}>{new Date(a.createdAt).toLocaleDateString()}</small>
            <button onClick={() => toggleStatus(a.id, a.status as 'open' | 'resolved')} style={{ fontSize: '10px', cursor: 'pointer' }}>{a.status === 'resolved' ? 'Reopen' : 'Resolve'}</button>
          </div>
        </div>
      ))}
    </aside>
  );
}

// ── Relationship Suggestions (live-bound to API) ────────────

function RelationshipSuggestions({ personId }: { personId: string }) {
  const [edges, setEdges] = useState<RelationshipEdge[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!personId) return;
    setLoading(true);
    json<any>(`GET`, `/inferences/${encodeURIComponent(personId)}/suggested`).then(result => {
      const candidates = result?.candidates || [];
      setEdges(Array.isArray(candidates) ? candidates : []);
    }).catch(() => setEdges([])).finally(() => setLoading(false));
  }, [personId]);

  const confirmEdge = (relId: string) => {
    json<any>(`PATCH`, `/inferences/${encodeURIComponent(relId)}`, { status: 'confirmed' as const, fromPersonId: personId }).then(() => setEdges(prev => prev.filter(e => e.relationshipId !== relId)));
  };

  const rejectEdge = (relId: string) => {
    json<any>(`PATCH`, `/inferences/${encodeURIComponent(relId)}`, { status: 'rejected' as const, fromPersonId: personId }).then(() => setEdges(prev => prev.filter(e => e.relationshipId !== relId)));
  };

  if (loading) return <p style={{ color: '#9ca3af' }}>Loading...</p>;
  return (
    <div style={{ padding: '12px', background: '#fffbe6', border: '1px solid #fef08a', borderRadius: 8, marginBottom: '12px' }}>
      <p style={{ fontWeight: 600, margin: '0 0 4px', fontSize: '13px' }}>&#9888; Suggested Relationships</p>
      {edges.length === 0 ? <p style={{ margin: 0, fontSize: '12px', color: '#a3a3a3' }}>No suggestions yet.</p> : edges.map(e => (
        <div key={e.relationshipId} style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '12px' }}>{e.fromPersonId.slice(0, 16)} → {e.toPersonId.slice(0, 16)}</span>
          <div>
            <button onClick={() => confirmEdge(e.relationshipId)} style={{ fontSize: '11px', padding: '4px 8px', marginRight: 4 }}>Confirm</button>
            <button onClick={() => rejectEdge(e.relationshipId)} style={{ fontSize: '11px', padding: '4px 8px' }}>Reject</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main App Page for a single candidate ────────────────────

export function CandidateProfilePage() {
  type Tab = 'bullets' | 'diff' | 'annotations' | 'relationships';
  const [activeTab, setActiveTab] = useState<Tab>('bullets');
  const [personId, setPersonId] = useState(() => new URLSearchParams(window.location.search).get('personId') || 'candidate-demo');
  const [loadingBullets, setLoadingBullets] = useState(false);
  const [loadingDiffs, setLoadingDiffs] = useState(false);

  useEffect(() => {
    const searchPerson = new URLSearchParams(window.location.search).get('personId');
    setPersonId(searchPerson || 'candidate-demo');
  }, []);

  const [bulletMappings, setBulletMappings] = useState<Record<string, BulletWithMeta[]>>({});
  const [factsBySection, setFactsBySection] = useState<Record<string, any[]>>({});
  const [diffResults, setDiffResults] = useState<BulletDiff[]>([]);

  useEffect(() => {
    if (!personId) return;
    setLoadingBullets(true);
    setLoadingDiffs(true);

    // Fetch bullets by section from the API.
    Promise.all([
      json<any>(`GET`, `/insights/${encodeURIComponent(personId)}/bullet-mappings`).catch(() => null),
      json<any>(`GET`, `/insights/${encodeURIComponent(personId)}/facts`).catch(() => null),
      json<BulletDiff[]>(`GET`, `/insights/${encodeURIComponent(personId)}/differences`).catch(() => []),
    ]).then(([bulletsData, factsData, diffsData]) => {
      // API returns flat ResumeBulletResponse[] — group by section client-side
      let bulletSectionsMap: Record<string, BulletWithMeta[]> = {};
      if (Array.isArray(bulletsData)) {
        for (const b of bulletsData) {
          const sec = b.sectionId || 'experience';
          if (!bulletSectionsMap[sec]) bulletSectionsMap[sec] = [];
          bulletSectionsMap[sec].push({
            id: b.bulletId ?? `b-${Math.random().toString(36).slice(6)}`,
            bulletText: b.bulletText,
            citationIds: b.citationFactVersionIds ?? [],
            sectionId: sec,
          });
        }
        setBulletMappings(bulletSectionsMap);
      } else if (bulletsData?.sections) {
        // backward-compat for grouped shape
        for (const [section, items] of Object.entries(bulletsData.sections)) {
          bulletSectionsMap[section] = (items as any[]).map((b: any) => ({
            id: b.bulletId ?? `b-${Math.random().toString(36).slice(6)}`,
            bulletText: b.bulletText,
            citationIds: b.citationFactVersionIds ?? [],
            sectionId: b.sectionId || 'experience',
          }));
        }
        setBulletMappings(bulletSectionsMap);
      }

      // Facts response: { personId, sections: Record<string, FactVersionResponse[]> }
      if (factsData?.sections) {
        const newFacts: Record<string, any[]> = {};
        for (const [section, items] of Object.entries(factsData.sections)) {
          if (Array.isArray(items)) {
            newFacts[section] = [...items];
          }
        }
        setFactsBySection(newFacts);
      }

      if (diffsData && diffsData.length > 0) {
        setDiffResults(diffsData);
      } else {
        setDiffResults([]);
      }
      setLoadingBullets(false);
      setLoadingDiffs(false);
    });
  }, [personId]);

  const tabs: Tab[] = ['bullets', 'diff', 'annotations', 'relationships'];
  return (
    <div style={{ maxWidth: 1200, margin: '48px auto', padding: '0 20px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0 }}>Greenhouse Resume Builder</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0' }}>{personId}</p>
        </div>
        <button onClick={() => setLoadingBullets(true)} disabled={loadingBullets} style={{ padding: '8px 16px', fontSize: '13px', background: loadingBullets ? '#d1d5db' : '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: loadingBullets ? 'default' : 'pointer' }}>
          {loadingBullets ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {/* Tab Navigation */}
      <nav style={{ display: 'flex', gap: 0, borderBottom: '1px solid #e5e7eb', marginBottom: 24 }}>
        {tabs.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{ padding: '8px 16px', fontSize: '13px', fontWeight: 500, borderBottom: activeTab === tab ? '2px solid #2563eb' : '2px solid transparent', color: activeTab === tab ? '#2563eb' : '#6b7280', background: 'none', borderLeft: 'none', borderTop: 'none', borderRight: 'none', cursor: 'pointer', textTransform: 'capitalize' }}>
            {tab}
          </button>
        ))}
      </nav>

      {/* Search Panel — always shown */}
      <SearchPanel personId={personId || undefined} />

      {/* Main Content Area */}
      <div style={{ display: 'flex', gap: 0 }}>
        <main style={{ flex: 1, marginRight: activeTab === 'annotations' ? 0 : 280 }}>
          {activeTab === 'bullets' && (
            <>
              <SectionCard title="Experience" bullets={bulletMappings['experience'] ?? []} />
              <SectionCard title="Skills"     bullets={bulletMappings['skills'] ?? []} />
              <SectionCard title="Education"  bullets={bulletMappings['education'] ?? []} />
              <SectionCard title="Summary"    bullets={bulletMappings['summary'] ?? []} />

              {Object.keys(factsBySection).length > 0 && (
                // Display all extracted facts grouped by section.
                <details style={{ marginTop: '16px', padding: '12px', background: '#f0fdf4', borderRadius: 8 }}>
                  <summary style={{ fontWeight: 600, fontSize: '14px', cursor: 'pointer' }}>View all extracted facts</summary>

                  {/* Facts grouped by section. */}
                  <table style={{ width: '100%', marginTop: 8, fontSize: '12px' }} cellPadding={8}>
                    {Object.entries(factsBySection).map(([section, facts]) => (
                      <tbody key={section}>
                        <tr><th>Facts — {section}</th></tr>
                        {facts.map((fact: any, i: number) => (
                          <tr key={i} style={{ borderTop: '1px solid #e5e7eb' }}>
                            <td>{JSON.stringify(fact.factKey)}</td>
                            <td>{JSON.stringify(fact.factValue)}</td>
                            <td>{fact.extractedAt ? new Date(fact.extractedAt).toLocaleDateString() : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    ))}
                  </table>
                </details>
              )}

            </>
          )}

          {activeTab === 'annotations' && <div style={{ padding: 20 }}><p>Select a bullet and click "Annotate" to view/edit notes for that fact. Annotations panel on the right, right.</p></div>}

          {activeTab === 'diff' && (
            <DiffView diffs={diffResults} />
          )}

          {activeTab === 'relationships' ? (
            personId ? <RelationshipSuggestions personId={personId} /> : <p>Please select a candidate first.</p>
          ) : (
            <div style={{ padding: 20 }}><p>Select a bullet and click "Annotate" to view/edit notes for that fact. Annotations panel to the right.</p></div>
          )}

        </main>

        {/* Annotation Panel — always rendered when annotations tab selected */}
        {activeTab === 'annotations' && personId ? <AnnotationPanel personId={personId} /> : null}
      </div>
    </div>
  );
}

// ── Landing Page ────────────────────────────────────────────

export function LandingPage() {
  const [runs, setRuns] = useState<ExtractionRun[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [sourceInput, setSourceInput] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  const [ingestStatus, setIngestStatus] = useState<'idle' | 'submitting' | 'polling' | 'done' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Load recent runs on mount
  useEffect(() => {
    fetch('/api/v1/ingestion-requests?tenantId=tenant-dev')
      .then(r => r.ok ? (r.json() as Promise<ExtractionRun[]>) : Promise.reject(''))
      .then(data => setRuns(Array.isArray(data) ? data.reverse().slice(0, 20) : []))
      .catch(() => {});
  }, []);

  const doSubmit = async () => {
    if (!sourceInput.trim() && !selectedFiles?.length) return;
    setIngestStatus('submitting');
    setErrorMessage(null);
    try {
      // Build sources from URL input (one per line, web sources)
      const sources: Array<{name :string; mimeType:string; blobPath?: string; uri?: string; sourceType:'web'|'upload';capturedAt?:string}> = sourceInput.split(/\r?\n/)
        .map(url => url.trim())
        .filter(Boolean)
        .map((url, i) => ({
          name: `source-${i}`,
          mimeType: 'text/html',
          uri: url,
          sourceType: 'web',
        }));

      if (selectedFiles) {
        for (const file of Array.from(selectedFiles)) {
          sources.push({
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            blobPath: file.webkitRelativePath ?? file.name,
            sourceType: 'upload' as any,
          });
        }
      }

      if (!sources.length) {
        setIngestStatus('error');
        setErrorMessage('Please provide at least one URL or file.');
        return;
      }

      // Submit ingestion request
      const resp = await fetch('/api/v1/ingestion-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: 'tenant-dev', sourceDocuments: sources } as any),
      });
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      const result = (await resp.json()) as Record<string, unknown>;
      const runId = (result.runId ?? result.id) as string;
      if (!runId) throw new Error('No runId in response');

      setIngestStatus('polling');

      // Poll for completion
      let attempts = 0;
      while (attempts < 120) {
        await new Promise(r => setTimeout(r, 5000));
        const status = await fetch(`/api/v1/ingestion-requests/${runId}/status`)
          .then(r => r.ok ? (r.json() as Promise<ExtractionRun>) : null);

        if (status) {
          setRuns(prev => [status, ...prev.filter(r => r.id !== runId)].slice(0, 21));

          if (status.status === 'completed' && status.personId) {
            // Navigate to candidate profile automatically
            window.history.pushState({}, '', `?personId=${status.personId}`);
            (window as any).dispatchEvent(new PopStateEvent('popstate'));
            return;
          }
          if (status.status === 'failed') {
            setIngestStatus('error');
            setErrorMessage((status as any).failedReason || 'Ingestion failed');
            return;
          }
        }
        attempts++;
      }

      // Timeout — still show polling state
      setIngestStatus('polling');

    } catch (e: any) {
      setIngestStatus('error');
      setErrorMessage(e.message || 'Submission failed');
    }
  };

  return (
    <div style={{ maxWidth: 800, margin: '48px auto', padding: '0 20px' }}>
      <h1 style={{ fontSize: '32px', fontWeight: 700, textAlign: 'center' }}>Greenhouse Resume Builder</h1>
      <p style={{ textAlign: 'center', color: '#6b7280', marginTop: 8 }}>Ingest candidate sources · Review extracted facts with citations · Build polished resumes.</p>

      {showForm && (
        <div style={{ marginTop: 24, background: '#fff', padding: 24, borderRadius: 12, boxShadow: '#e5e7eb 0 4px 6px' }}>
          <h3 style={{ margin: '0 0 16px' }}>Submit New Source</h3>

          {/* URLs — one per line */}
          <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: 4 }}>Web URLs (one per line)</label>
          <textarea
            value={sourceInput}
            onChange={e => setSourceInput(e.target.value)}
            placeholder="https://linkedin.com/in/candidate&#10;https://example.com/resume.pdf"
            rows={4}
            style={{ display: 'block', width: '100%', padding: '8px 12px', marginBottom: 8, borderRadius: 6, border: '1px solid #d1d5db', fontSize: '14px', resize: 'vertical' }}
          />

          {/* File upload */}
          <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: 8 }}>Or upload files</label>
          {selectedFiles?.length ? (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
              {Array.from(selectedFiles).map((f, i) => (
                <span key={i} style={{ padding: '4px 10px', background: '#eff6ff', borderRadius: 4, fontSize: '12px' }}>{f.name}</span>
              ))}
            </div>
          ) : null}
          <input type="file" multiple onChange={e => setSelectedFiles(e.target.files)} style={{ display: 'block', width: '100%', marginBottom: 8 }} />

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={doSubmit}
              disabled={ingestStatus === 'submitting' || ingestStatus === 'polling' || (!sourceInput.trim() && !selectedFiles?.length)}
              style={{ padding: '8px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: (ingestStatus === 'submitting' || ingestStatus === 'polling') ? 'default' : 'pointer', fontSize: '14px', opacity: (!sourceInput.trim() && !selectedFiles?.length) ? 0.5 : 1 }}
            >
              {ingestStatus === 'submitting' ? 'Submitting...' : ingestStatus === 'polling' ? 'Processing... (wait)' : 'Submit'}
            </button>
            <button onClick={() => setShowForm(false)} disabled={ingestStatus === 'submitting' || ingestStatus === 'polling'} style={{ padding: '8px 16px', background: '#e5e7eb', border: 'none', borderRadius: 6, cursor: (ingestStatus === 'submitting' || ingestStatus === 'polling') ? 'default' : 'pointer' }}>Cancel</button>
          </div>

          {/* Status messages */}
          {ingestStatus === 'error' && errorMessage && (
            <div style={{ marginTop: 12, padding: '8px 12px', background: '#fef2f2', borderRadius: 6, fontSize: '13px', color: '#dc2626' }}>
              {errorMessage}
            </div>
          )}
          {ingestStatus === 'polling' && (
            <div style={{ marginTop: 12, padding: '8px 12px', background: '#eff6ff', borderRadius: 6, fontSize: '13px', color: '#2563eb' }}>
              Processing sources... this may take a few minutes.
            </div>
          )}
        </div>
      )}

      {!showForm && ingestStatus !== 'polling' && (
        <button onClick={() => setShowForm(true)} style={{ display: 'block', margin: '16px auto', padding: '10px 20px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, fontSize: '14px' }}>+ Ingest New Source</button>
      )}

      {/* Recent Runs */}
      <div style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: 8 }}>Recent Runs</h2>
        {runs.length === 0 ? (
          <p style={{ color: '#9ca3af', fontSize: '13px' }}>No runs yet.</p>
        ) : (
          runs.map(r => (
            <div
              key={r.id}
              onClick={() => {
                  if (r.personId) {
                    window.history.pushState({}, '', `?personId=${encodeURIComponent(r.personId!)}`);
                    (window as any).dispatchEvent(new PopStateEvent('popstate'));
                  }
                }}
              style={{ padding: '8px 12px', background: '#f9fafb', borderRadius: 6, marginTop: 4, cursor: r.personId ? 'pointer' : 'default', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <span style={{ fontSize: '13px', color: r.status === 'completed' ? '#059669' : r.status === 'failed' ? '#dc2626' : '#6b7280' }}>
                {r.status === 'completed' && r.personId ? (<>✓ {r.personId}</>) : r.status || '—'}
              </span>
              <span style={{ color: '#9ca3af', fontSize: '12px' }}>{new Date(r.createdAt).toLocaleDateString()}</span>
            </div>
          ))
        )}
      </div>

      {/* Help text */}
      {!showForm && (
        <div style={{ marginTop: 32, padding: '16px', background: '#fffbeb', borderRadius: 8, border: '1px solid #fde68a' }}>
          <p style={{ margin: '0 0 4px', fontWeight: 500, fontSize: '14px' }}>How it works</p>
          <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, color: '#6b7280', fontSize: '13px' }}>
            <li>Paste candidate URLs (one per line) or upload resume files</li>
            <li>We extract experience, skills, education and summary facts with source citations</li>
            <li>Once complete, the profile opens automatically where you can review, annotate and explore relationships</li>
          </ol>
        </div>
      )}
    </div>
  );
}

// ── App Root ────────────────────────────────────────────────

export default function App() {
  // Show CandidateProfilePage only when a personId is specified in the URL,
  // otherwise show LandingPage (the entry screen for ingestion).
  const params = new URLSearchParams(window.location.search);
  const hasPersonId = params.get('personId') !== null;

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', minHeight: '100vh', background: '#f3f4f6' }}>
      {hasPersonId ? <CandidateProfilePage /> : <LandingPage />}
    </div>
  );
}
