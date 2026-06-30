/**
 * Resolves the base URL of the Durable Functions app the API dispatches to.
 *
 * `FUNCTIONS_HOST` is frequently set from an Azure default hostname (e.g.
 * `myfunc.azurewebsites.net`) which has **no URL scheme**. Node's `fetch` (undici)
 * rejects scheme-less URLs with "Failed to parse URL", so we normalize here:
 *   - prepend `https://` when no `http(s)://` scheme is present
 *   - strip any trailing slashes so callers can safely append `/api/...`
 *
 * The local-dev fallback keeps its explicit `http://` scheme.
 */
export function getFunctionsBaseUrl(): string {
  const raw = (process.env.FUNCTIONS_HOST || 'http://localhost:7071').trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}
