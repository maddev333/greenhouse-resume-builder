/**
 * Grounded passage retrieval over a plain document/chunk RAG index — the path for customer data that
 * is NOT structured planner records.
 *
 * This is deliberately a different query shape from `search-backend.ts`:
 *
 *   search-backend  EXHAUSTIVE  filter-only, `top: 1000`, reconstructs domain objects from a payload
 *                               field. The planner needs completeness for its feasibility math.
 *   grounding       RANKED      hybrid (BM25 + kNN) -> RRF -> optional semantic rerank, small `top`,
 *                               returns text passages + citation metadata. Relevance, not completeness.
 *
 * Conflating the two is the trap: truncating the planner's set to top-k silently corrupts distance
 * and ROI results, while returning 1000 chunks to an LLM is useless.
 *
 * NOTHING here reads `engagement-intelligence/seed` — the corpus is entirely the customer's index.
 */
import { SearchClient, AzureKeyCredential } from "@azure/search-documents";
import { DefaultAzureCredential } from "@azure/identity";
import { createLogger } from "../log.js";
import { runSearch } from "./search-errors.js";
import {
  groundingDeclaration,
  groundingMapping,
  indexName,
  searchableFields,
} from "./index-schema";

const log = createLogger("grounding");

const ENDPOINT_SUFFIX: string =
  process.env.AZURE_SEARCH_ENDPOINT_SUFFIX ?? "search.windows.net";

function serviceEndpoint(): string {
  const raw = (process.env.AZURE_SEARCH_SERVICE ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!raw) {
    throw new Error(
      "AZURE_SEARCH_SERVICE is not set (expected the service name or full https:// endpoint).",
    );
  }
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.includes(".")) return `https://${raw}`;
  return `https://${raw}.${ENDPOINT_SUFFIX}`;
}

function credential(): AzureKeyCredential | DefaultAzureCredential {
  const key = process.env.AZURE_SEARCH_API_KEY;
  if (!key) {
    log.debug(
      "no AZURE_SEARCH_API_KEY -- authenticating with DefaultAzureCredential (managed identity / az login)",
    );
  }
  return key ? new AzureKeyCredential(key) : new DefaultAzureCredential();
}

/** One retrieved passage, ready to be cited in an answer. */
export interface GroundingHit {
  /** Index document key — the citation anchor. */
  id: string;
  /** Relevance score (semantic reranker score when semantic search is configured, else BM25/RRF). */
  score: number;
  /** Passage text the answer must be grounded in. */
  content: string;
  title?: string;
  url?: string;
  /** Source document key when the index is chunked; several hits may share one parent. */
  parentId?: string;
}

export interface GroundingQuery {
  query: string;
  /** Passages to return after collapsing by parent (default 8). */
  top?: number;
  /** Extra OData `$filter` applied verbatim — caller-supplied narrowing, not access control. */
  filter?: string;
}

const DEFAULT_TOP = 8;
/** Over-fetch before collapsing: one long document can otherwise occupy every result slot. */
const OVERFETCH = 6;

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

/**
 * Retrieve ranked passages for a question.
 *
 * Hybrid whenever the declaration names a vector field: BM25 over the searchable fields plus a
 * vectorizable-text kNN query, fused by RRF. Adds the semantic L2 reranker when a semantic
 * configuration is declared. Falls back to plain keyword search otherwise, so an index without
 * vectors still works.
 *
 * The index queried is the ONE declaration in the registry carrying a `mapping.grounding` block —
 * never simply the first declaration, which in a multi-index setup is usually structured records.
 *
 * Results are over-fetched then collapsed to one passage per parent document (best-scoring chunk
 * wins), because a 24-chunk PDF would otherwise crowd out every other source.
 */
export async function searchGrounding(
  q: GroundingQuery,
): Promise<GroundingHit[]> {
  const schema = groundingDeclaration();
  const g = schema && groundingMapping(schema);
  if (!schema || !g) {
    const message =
      "No index declaration carries a `mapping.grounding` block, so no configured index can " +
      "answer grounded questions. Add grounding.content (and optionally " +
      "title/url/parentId/vector) to one of the index schema config files.";
    log.error(message);
    throw new Error(message);
  }

  const top = Math.max(1, q.top ?? DEFAULT_TOP);
  const keyField = schema.mapping.key;
  const select = [keyField, g.content, g.title, g.url, g.parentId].filter(
    (f): f is string => Boolean(f),
  );

  const options: Record<string, unknown> = {
    top: top * OVERFETCH,
    select: [...new Set(select)],
    searchFields: searchableFields(schema),
  };
  if (q.filter) options.filter = q.filter;

  if (g.vector) {
    options.vectorSearchOptions = {
      queries: [
        {
          kind: "text",
          text: q.query,
          fields: [g.vector],
          kNearestNeighborsCount: top * OVERFETCH,
        },
      ],
    };
  }
  if (g.semanticConfiguration) {
    options.queryType = "semantic";
    options.semanticSearchOptions = {
      configurationName: g.semanticConfiguration,
    };
  }

  const index = indexName(schema);
  const mode = g.vector ? "hybrid (BM25 + kNN/RRF)" : "keyword (BM25)";
  log.info(
    `query "${q.query}" -> declaration "${schema.id}", index "${index}", ${mode}` +
      `${g.semanticConfiguration ? " + semantic rerank" : ""}, top=${top}, fetch=${top * OVERFETCH}` +
      `${q.filter ? ", caller filter applied" : ""}`,
  );
  log.debug(() => `search options ${JSON.stringify(options)}`);

  const client = new SearchClient<Record<string, unknown>>(
    serviceEndpoint(),
    index,
    credential(),
  );
  const started = Date.now();
  const resp = await runSearch(
    log,
    { operation: "search_grounding", index, sourcePath: schema.sourcePath },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => client.search(q.query, options as any),
  );

  const hits: GroundingHit[] = [];
  let empty = 0;
  for await (const r of resp.results) {
    const doc = r.document;
    const content = str(doc[g.content]);
    if (!content) {
      empty += 1;
      continue; // a chunk with no text cannot ground anything
    }

    const rr = r as unknown as { rerankerScore?: number; score: number };
    hits.push({
      id: String(doc[keyField] ?? ""),
      score: rr.rerankerScore ?? rr.score,
      content,
      title: g.title ? str(doc[g.title]) : undefined,
      url: g.url ? str(doc[g.url]) : undefined,
      parentId: g.parentId ? str(doc[g.parentId]) : undefined,
    });
  }

  const collapsed = collapseByParent(hits, top);
  log.info(
    `${collapsed.length} passage(s) from ${hits.length} chunk(s) in ${Date.now() - started}ms`,
  );
  if (empty) {
    log.warn(
      `${empty} result(s) had no text in "${g.content}" and were dropped -- check mapping.grounding.content names the passage field in ${schema.sourcePath}`,
    );
  }
  if (!collapsed.length) {
    log.warn(
      `nothing matched "${q.query}" in index "${index}". The index may be empty, the query may not ` +
        `match any content, or ${q.filter ? "the caller filter may exclude everything" : `"${g.content}" may not be the searchable passage field`}.`,
    );
  }
  log.debug(
    () =>
      collapsed
        .map(
          (h, i) =>
            `  #${i + 1} score=${h.score.toFixed(4)} id=${h.id}${h.parentId ? ` parent=${h.parentId}` : ""}${h.title ? ` title=${h.title}` : ""}`,
        )
        .join("\n") || "  (no passages)",
  );

  return collapsed;
}

/** Keep the best-scoring passage per parent document, then take the top N. */
function collapseByParent(hits: GroundingHit[], top: number): GroundingHit[] {
  const best = new Map<string, GroundingHit>();
  for (const hit of hits) {
    const key = hit.parentId ?? hit.id;
    const current = best.get(key);
    if (!current || hit.score > current.score) best.set(key, hit);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, top);
}
