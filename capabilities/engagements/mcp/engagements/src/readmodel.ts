/**
 * Read-model abstraction — the ONE seam the tools use to fetch records, so the same planner pipeline
 * runs against either backend behind an identical async contract:
 *
 *   - `memory` (default) — the in-memory {@link EngagementIndex}, loaded FRESH per call so the demo's
 *     add/update/delete + "reindex" shows immediately. Zero cloud; M0–M3 behavior unchanged.
 *   - `search` — real Azure AI Search (ARCHITECTURE §5.2).
 *
 * SEED ISOLATION: the `search` path NEVER touches `engagement-intelligence/seed`. Every record set
 * (contacts, events, leaders, topics, messages, regions) is read from the index, and `today` is the
 * real current date rather than the seed's month-shifted demo clock. A kind the index does not carry
 * comes back EMPTY — never substituted from the seed — so a partially-populated customer index is
 * visibly incomplete instead of quietly mixing in demo data.
 *
 * Selected by `RETRIEVAL_BACKEND=search|memory`. Requesting `search` without a configured service is
 * a hard error: silently degrading to `memory` would serve the demo dataset while looking healthy.
 */
import {
  EngagementIndex,
  isSearchConfigured,
  searchEngagementContacts,
  searchEngagementEvents,
  searchEngagementRecords,
  type Contact,
  type EngagementEvent,
  type Leader,
  type Message,
  type Region,
  type Topic,
  type Labeled,
  type ContactQuery,
  type EventQuery,
} from "./engine.js";

export type RetrievalBackend = "search" | "memory" | "grounding";

/** The async read surface the tools depend on (identical shape for both backends). */
export interface ReadModel {
  backend: RetrievalBackend;
  today: string;
  leaders: Labeled<Leader>[];
  /** Topic catalog (labeled, but topics are enterprise-visible reference data). */
  topics: Labeled<Topic>[];
  /** Approved talking points per topic (enterprise reference data) — powers extension options. */
  messages: Labeled<Message>[];
  /** Geo gazetteer for area-first anchoring (public reference data). */
  regions: Region[];
  searchContacts(q: ContactQuery): Promise<Labeled<Contact>[]>;
  searchEvents(q: EventQuery): Promise<Labeled<EngagementEvent>[]>;
}

/**
 * Resolve the configured backend. Defaults to `memory`; asking for `search` without a configured
 * service THROWS rather than falling back, so a misconfigured deployment can never quietly serve the
 * demo seed as if it were customer data.
 */
export function resolveBackend(): RetrievalBackend {
  const want = (process.env.RETRIEVAL_BACKEND ?? "memory").trim().toLowerCase();
  if (want === "memory") return "memory";

  if (want !== "search" && want !== "grounding") {
    throw new Error(
      `RETRIEVAL_BACKEND="${want}" is not recognised. Use memory, search, or grounding.`,
    );
  }
  if (!isSearchConfigured()) {
    throw new Error(
      `RETRIEVAL_BACKEND=${want} but AZURE_SEARCH_SERVICE is not set. Refusing to fall back to the ` +
        "in-memory seed, which would serve demo data as if it were live. Set AZURE_SEARCH_SERVICE " +
        "(plus AZURE_SEARCH_API_KEY or `az login`), or set RETRIEVAL_BACKEND=memory to use the seed " +
        "deliberately.",
    );
  }
  return want;
}

/** Today in ISO form, from the real clock (the `search` path must not use the demo clock). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build a fresh read model for a single tool call.
 *
 * `memory` re-reads the seed each call so the leader roster / `today` stay in sync with a live
 * reindex. `search` reads every set from the index and never opens the seed.
 */
export async function getReadModel(): Promise<ReadModel> {
  const backend = resolveBackend();

  if (backend === "grounding") {
    throw new Error(
      "RETRIEVAL_BACKEND=grounding serves a document/chunk RAG index, which carries no structured " +
        "contact/event/leader records, so the deterministic planner cannot run. Use the " +
        "search_grounding tool instead, or set RETRIEVAL_BACKEND=search against an index of " +
        "structured records.",
    );
  }

  if (backend === "search") {
    const [leaders, topics, messages, regions] = await Promise.all([
      searchEngagementRecords<Labeled<Leader>>("leader"),
      searchEngagementRecords<Labeled<Topic>>("topic"),
      searchEngagementRecords<Labeled<Message>>("message"),
      searchEngagementRecords<Region>("region"),
    ]);
    return {
      backend: "search",
      today: todayIso(),
      leaders,
      topics,
      messages,
      regions,
      searchContacts: (q) => searchEngagementContacts(q),
      searchEvents: (q) => searchEngagementEvents(q),
    };
  }

  const idx = EngagementIndex.load();
  return {
    backend: "memory",
    today: idx.today,
    leaders: idx.labeled.leaders,
    topics: idx.labeled.topics,
    messages: idx.labeled.messages,
    regions: idx.labeled.regions,
    searchContacts: async (q) => idx.searchContacts(q),
    searchEvents: async (q) => idx.searchEvents(q),
  };
}
