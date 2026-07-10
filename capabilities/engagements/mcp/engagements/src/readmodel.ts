/**
 * Read-model abstraction — the ONE seam the tools use to fetch security-trimmed records, so the same
 * planner pipeline runs against either backend behind an identical async contract:
 *
 *   - `memory` (default) — the in-memory {@link EngagementIndex}, loaded FRESH per call so the demo's
 *     add/update/delete + "reindex" shows immediately. Zero cloud; M0–M3 behavior unchanged.
 *   - `search` — real Azure AI Search: the tenant + ACL + sensitivity trim is enforced SERVER-SIDE as
 *     an OData `$filter` (ARCHITECTURE §5.2–5.4). `leaders` + `today` still come from the seed (leaders
 *     are not indexed — they are the caller's own roster, not trimmed recall).
 *
 * Selected by `RETRIEVAL_BACKEND=search|memory`. `search` silently falls back to `memory` when no
 * search service is configured, so a missing `.env` never breaks the demo.
 */
import {
  EngagementIndex,
  applyLabels,
  loadDataset,
  isSearchConfigured,
  searchEngagementContacts,
  searchEngagementEvents,
  type Contact,
  type EngagementEvent,
  type Leader,
  type Labeled,
  type ContactQuery,
  type EventQuery,
  type TrimmedResult,
} from './engine.js';

export type RetrievalBackend = 'search' | 'memory';

/** The async read surface the tools depend on (identical shape for both backends). */
export interface ReadModel {
  backend: RetrievalBackend;
  today: string;
  leaders: Labeled<Leader>[];
  searchContacts(q: ContactQuery): Promise<TrimmedResult<Labeled<Contact>>>;
  searchEvents(q: EventQuery): Promise<TrimmedResult<Labeled<EngagementEvent>>>;
}

/** Resolve the configured backend (defaults to `memory`; `search` needs a configured service). */
export function resolveBackend(): RetrievalBackend {
  const want = (process.env.RETRIEVAL_BACKEND ?? 'memory').trim().toLowerCase();
  return want === 'search' && isSearchConfigured() ? 'search' : 'memory';
}

/**
 * Build a fresh read model for a single tool call. Both backends re-read the seed each call so the
 * leader roster / `today` stay in sync with a live reindex.
 */
export function getReadModel(): ReadModel {
  if (resolveBackend() === 'search') {
    const labeled = applyLabels(loadDataset()); // leaders + today only; contacts/events come from the index
    return {
      backend: 'search',
      today: labeled.today,
      leaders: labeled.leaders,
      searchContacts: (q) => searchEngagementContacts(q),
      searchEvents: (q) => searchEngagementEvents(q),
    };
  }

  const idx = EngagementIndex.load();
  return {
    backend: 'memory',
    today: idx.today,
    leaders: idx.labeled.leaders,
    searchContacts: async (q) => idx.searchContacts(q),
    searchEvents: async (q) => idx.searchEvents(q),
  };
}
