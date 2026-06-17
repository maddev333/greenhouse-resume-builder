import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  OnBehalfOfCredential,
} from '@azure/identity';
import { createHash } from 'crypto';

let defaultCredential: DefaultAzureCredential | undefined;
let managedIdentityCredential: ManagedIdentityCredential | undefined;

function getDefaultCredential(): DefaultAzureCredential {
  if (!defaultCredential) defaultCredential = new DefaultAzureCredential();
  return defaultCredential;
}

function oboTenantId(): string {
  return process.env.AZURE_OBO_TENANT_ID || process.env.AZURE_TENANT_ID || '';
}

function oboClientId(): string {
  return process.env.AZURE_OBO_CLIENT_ID || process.env.AZURE_AD_CLIENT_ID || process.env.AZURE_CLIENT_ID || '';
}

export function isOboConfigured(): boolean {
  return Boolean(oboTenantId() && oboClientId());
}

function federatedAssertion(): () => Promise<string> {
  const exchangeAudience = process.env.AZURE_TOKEN_EXCHANGE_AUDIENCE || 'api://AzureADTokenExchange/.default';
  const miClientId = process.env.AZURE_OBO_FEDERATED_CLIENT_ID;
  return async () => {
    if (!managedIdentityCredential) {
      managedIdentityCredential = miClientId
        ? new ManagedIdentityCredential({ clientId: miClientId })
        : new ManagedIdentityCredential();
    }
    const token = await managedIdentityCredential.getToken(exchangeAudience);
    if (!token?.token) throw new Error('Failed to acquire managed identity assertion for OBO token exchange');
    return token.token;
  };
}

const oboCache = new Map<string, OnBehalfOfCredential>();
const OBO_CACHE_MAX = 256;

export function getOboCredential(userAssertionToken: string): OnBehalfOfCredential {
  const tenantId = oboTenantId();
  const clientId = oboClientId();
  if (!tenantId || !clientId) {
    throw new Error('OBO is not configured: set AZURE_OBO_TENANT_ID and AZURE_OBO_CLIENT_ID.');
  }

  const certificatePath = process.env.AZURE_OBO_CERTIFICATE_PATH;
  const key = createHash('sha256')
    .update(`${tenantId}|${clientId}|${certificatePath || 'federated'}|${userAssertionToken}`)
    .digest('hex');
  const cached = oboCache.get(key);
  if (cached) return cached;

  const credential = certificatePath
    ? new OnBehalfOfCredential({ tenantId, clientId, certificatePath, userAssertionToken, sendCertificateChain: true })
    : new OnBehalfOfCredential({ tenantId, clientId, getAssertion: federatedAssertion(), userAssertionToken });

  if (oboCache.size >= OBO_CACHE_MAX) {
    const oldest = oboCache.keys().next().value;
    if (oldest !== undefined) oboCache.delete(oldest);
  }
  oboCache.set(key, credential);
  return credential;
}

export function getCredentialForUser(userAssertionToken?: string): DefaultAzureCredential | OnBehalfOfCredential {
  if (userAssertionToken && isOboConfigured()) return getOboCredential(userAssertionToken);
  return getDefaultCredential();
}

export async function getOboToken(userAssertionToken: string, scope: string): Promise<string> {
  const token = await getOboCredential(userAssertionToken).getToken(scope);
  if (!token?.token) throw new Error(`OBO token exchange failed for scope ${scope}`);
  return token.token;
}

export async function getServiceAuthHeaders(scope?: string, userAssertionToken?: string): Promise<Record<string, string>> {
  if (!scope) return {};
  const credential = getCredentialForUser(userAssertionToken);
  const token = await credential.getToken(scope);
  if (!token?.token) throw new Error(`Failed to acquire Entra token for scope ${scope}`);
  return { Authorization: `Bearer ${token.token}` };
}
