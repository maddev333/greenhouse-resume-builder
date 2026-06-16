/**
 * IL5 identity + token helpers.
 *
 * Credential precedence (the IL5 rule used across this repo):
 *   - On-Behalf-Of: when a signed-in user's assertion token is supplied and OBO is
 *     configured, exchange it so downstream calls run as that user (no shared secret).
 *   - else if an API key / connection string is supplied -> use it (local dev)
 *   - otherwise acquire a token via DefaultAzureCredential (managed identity = the IL5 path)
 *
 * All token scopes/authorities are cloud-configurable so a single artifact targets
 * Azure Commercial or Azure Government / DoD by configuration only.
 */
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  OnBehalfOfCredential,
} from '@azure/identity';
import { createHash } from 'node:crypto';

let _credential: DefaultAzureCredential | undefined;

function credential(): DefaultAzureCredential {
  if (!_credential) _credential = new DefaultAzureCredential();
  return _credential;
}

/** Acquire a Microsoft Entra ID bearer token for the given scope via managed identity. */
export async function getEntraToken(scope: string): Promise<string> {
  const token = await credential().getToken(scope);
  if (!token?.token) throw new Error(`Failed to acquire Entra token for scope ${scope}`);
  return token.token;
}

// ── On-Behalf-Of (OBO): pass the signed-in user's identity to a downstream API ──
//
// Secret-free by design. The middle tier authenticates itself with ONE of:
//   - a certificate (AZURE_OBO_CERTIFICATE_PATH), or
//   - a federated client assertion from its managed identity (workload identity
//     federation) — the default, requiring no secret or cert at all.
// We never use a client secret.

function oboTenantId(): string {
  return process.env.AZURE_OBO_TENANT_ID || process.env.AZURE_TENANT_ID || '';
}

function oboClientId(): string {
  return process.env.AZURE_OBO_CLIENT_ID || process.env.AZURE_CLIENT_ID || '';
}

/** True when the middle-tier app identity for OBO is configured (tenant + client id). */
export function isOboConfigured(): boolean {
  return !!(oboTenantId() && oboClientId());
}

// Federated client assertion via managed identity — the secret-free credential the
// confidential client presents during the OBO exchange (Azure / cloud only).
let _miCredential: ManagedIdentityCredential | undefined;
function federatedAssertion(): () => Promise<string> {
  const exchangeAudience = process.env.AZURE_TOKEN_EXCHANGE_AUDIENCE || 'api://AzureADTokenExchange/.default';
  const miClientId = process.env.AZURE_OBO_FEDERATED_CLIENT_ID;
  return async () => {
    if (!_miCredential) {
      _miCredential = miClientId
        ? new ManagedIdentityCredential({ clientId: miClientId })
        : new ManagedIdentityCredential();
    }
    const tok = await _miCredential.getToken(exchangeAudience);
    if (!tok?.token) throw new Error('Failed to acquire managed-identity assertion for the OBO token exchange');
    return tok.token;
  };
}

// Cache one OnBehalfOfCredential per user assertion so MSAL reuses its token cache
// (the OBO exchange is keyed by the incoming user token). Bounded to avoid growth.
const _oboCache = new Map<string, OnBehalfOfCredential>();
const OBO_CACHE_MAX = 256;

function oboCredentialFor(userAssertionToken: string): OnBehalfOfCredential {
  const tenantId = oboTenantId();
  const clientId = oboClientId();
  if (!tenantId || !clientId) {
    throw new Error('OBO is not configured: set AZURE_OBO_TENANT_ID and AZURE_OBO_CLIENT_ID.');
  }
  const certPath = process.env.AZURE_OBO_CERTIFICATE_PATH;
  const key = createHash('sha256')
    .update(`${tenantId}|${clientId}|${certPath || 'fed'}|${userAssertionToken}`)
    .digest('hex');
  const cached = _oboCache.get(key);
  if (cached) return cached;

  const cred = certPath
    ? new OnBehalfOfCredential({ tenantId, clientId, certificatePath: certPath, userAssertionToken, sendCertificateChain: true })
    : new OnBehalfOfCredential({ tenantId, clientId, getAssertion: federatedAssertion(), userAssertionToken });

  if (_oboCache.size >= OBO_CACHE_MAX) {
    const oldest = _oboCache.keys().next().value;
    if (oldest !== undefined) _oboCache.delete(oldest);
  }
  _oboCache.set(key, cred);
  return cred;
}

/**
 * Exchange a signed-in user's access token for a downstream token via the On-Behalf-Of
 * flow, so the downstream call runs as that user. Secret-free (certificate or federated
 * managed-identity assertion). Throws when OBO is not configured.
 */
export async function getOboToken(userAssertionToken: string, scope: string): Promise<string> {
  const token = await oboCredentialFor(userAssertionToken).getToken(scope);
  if (!token?.token) throw new Error(`OBO token exchange failed for scope ${scope}`);
  return token.token;
}

/**
 * Auth headers for Azure OpenAI. Precedence:
 *   1. On-Behalf-Of when a user assertion token is supplied and OBO is configured
 *      (calls run as the signed-in user; no shared secret).
 *   2. AZURE_OPENAI_API_KEY when present (local dev convenience only).
 *   3. managed-identity bearer token (the app's own identity).
 * Scope is cloud-configurable via AZURE_OPENAI_TOKEN_SCOPE
 * (Gov: https://cognitiveservices.azure.us/.default).
 */
export async function getAoaiAuthHeaders(userAssertionToken?: string): Promise<Record<string, string>> {
  const scope = process.env.AZURE_OPENAI_TOKEN_SCOPE || 'https://cognitiveservices.azure.com/.default';
  if (userAssertionToken && isOboConfigured()) {
    return { Authorization: `Bearer ${await getOboToken(userAssertionToken, scope)}` };
  }
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  if (apiKey) return { 'api-key': apiKey };
  return { Authorization: `Bearer ${await getEntraToken(scope)}` };
}

/** True when Azure OpenAI is configured (endpoint + deployment; auth is key or managed identity). */
export function isModelConfigured(): boolean {
  return !!(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_DEPLOYMENT);
}
