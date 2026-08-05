/**
 * Azure AI Search failure diagnostics.
 *
 * The SDK reports a misconfigured index as a bare HTTP status, which tells the operator nothing
 * about WHICH knob is wrong. Every read here is routed through {@link runSearch}, which logs the
 * request it is about to make, times it, and on failure maps the status onto the specific setting
 * (role assignment, `indexName`, `mapping.grounding.semanticConfiguration`, ...) and the config
 * file that has to change.
 */
import {
  createLogger,
  describeError,
  errorStatus,
  type Logger,
} from "../log.js";

/** What was being attempted, so a failure can name the index and the file that declared it. */
export interface SearchContext {
  /** Short label for the call, e.g. `search_contacts` or `grounding`. */
  operation: string;
  /** The index the call was aimed at. */
  index: string;
  /** Absolute path of the declaration that named that index. */
  sourcePath: string;
}

function endpoint(): string {
  return (process.env.AZURE_SEARCH_SERVICE ?? "").trim() || "(unset)";
}

/** The one thing to change, for the failures an operator can actually fix. */
function remedy(err: unknown, ctx: SearchContext): string | undefined {
  const status = errorStatus(err);
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const detail = describeError(err).toLowerCase();

  if (status === 401 || status === 403) {
    return process.env.AZURE_SEARCH_API_KEY
      ? "AZURE_SEARCH_API_KEY was rejected. Check the key belongs to this search service and has not been rotated."
      : 'The current identity cannot read the index. Assign it the "Search Index Data Reader" role on the search service, or set AZURE_SEARCH_API_KEY to a query key. Locally, run `az login` first.';
  }
  if (status === 404) {
    return `Index "${ctx.index}" does not exist on ${endpoint()}. Correct "indexName" in ${ctx.sourcePath}, or point AZURE_SEARCH_SERVICE at the service that hosts it.`;
  }
  if (status === 400 && detail.includes("semantic")) {
    return `The declared semantic configuration does not exist on index "${ctx.index}". Set mapping.grounding.semanticConfiguration to its real name in ${ctx.sourcePath}, or to null to drop the reranker.`;
  }
  if (status === 400 && detail.includes("vector")) {
    return `The vector query was rejected. mapping.grounding.vector must name a Collection(Edm.Single) field whose vector profile has a VECTORIZER, because queries send raw text. Set it to null in ${ctx.sourcePath} to fall back to keyword search.`;
  }
  if (
    status === 400 &&
    (detail.includes("field") || detail.includes("$filter"))
  ) {
    return `A field named in the declaration does not match the index. Compare \`fields\` and \`mapping\` in ${ctx.sourcePath} against the real index definition.`;
  }
  if (text.includes("getaddrinfo") || text.includes("enotfound")) {
    return `Could not resolve ${endpoint()}. Check AZURE_SEARCH_SERVICE (the service name, or the full https:// endpoint).`;
  }
  return undefined;
}

/**
 * Run one Azure Search call with diagnostics: a debug line for the request, an info line with the
 * elapsed time, and on failure an error naming the index, the declaration file and the fix. The
 * original error is kept as `cause` so nothing is lost.
 */
export async function runSearch<T>(
  log: Logger,
  ctx: SearchContext,
  request: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await request();
    log.debug(
      () =>
        `${ctx.operation}: index "${ctx.index}" responded in ${Date.now() - started}ms`,
    );
    return result;
  } catch (err) {
    const elapsed = Date.now() - started;
    const fix = remedy(err, ctx);
    const message =
      `${ctx.operation} failed against index "${ctx.index}" on ${endpoint()} after ${elapsed}ms.` +
      (fix ? `\n  ${fix}` : `\n  Declared in ${ctx.sourcePath}.`);
    log.error(message, err);
    throw new Error(`${message}\n  ${describeError(err)}`, { cause: err });
  }
}

/** Shared logger for the Azure AI Search backends. */
export const searchLog = createLogger("search");
