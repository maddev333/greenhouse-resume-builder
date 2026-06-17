/**
 * Caller authentication for the Durable Functions HTTP starter.
 *
 * The orchestrator persists records under a tenant/user that the caller supplies (via request body
 * or `x-tenant-id` / `x-authenticated-user-id` headers). Those values are only trustworthy if we
 * first authenticate the *caller* — otherwise anyone who can reach the endpoint could write data
 * under an arbitrary tenant. This module verifies the bearer token the API attaches (the token it
 * obtained On-Behalf-Of the user, or via managed identity) so we can apply the trusted-subsystem
 * model: authenticate the calling service, then trust the identity metadata it forwards.
 *
 * Enforcement is opt-in: it activates only when `FUNCTIONS_AUTH_AUDIENCE` (or an explicit
 * `FUNCTIONS_AUTH_JWKS_URI`) is configured, so local development and the existing dev flow are
 * unaffected. Configure this for any deployment where the endpoint is reachable without an
 * equivalent platform control (App Service Authentication / EasyAuth, APIM, or network isolation).
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

function splitEnv(value?: string): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const TENANT_ID = process.env.AZURE_TENANT_ID ?? process.env.AZURE_AD_TENANT_ID ?? '';
const AUTHORITY_HOST = (process.env.AZURE_AD_AUTHORITY_HOST ?? process.env.AZURE_AUTHORITY_HOST ?? 'https://login.microsoftonline.com').replace(/\/+$/, '');

const AUDIENCES = splitEnv(process.env.FUNCTIONS_AUTH_AUDIENCE);
const JWKS_URI = process.env.FUNCTIONS_AUTH_JWKS_URI
  || (TENANT_ID ? `${AUTHORITY_HOST}/${TENANT_ID}/discovery/v2.0/keys` : '');

const ISSUER_PREFIXES = process.env.FUNCTIONS_AUTH_ISSUER_PREFIXES
  ? splitEnv(process.env.FUNCTIONS_AUTH_ISSUER_PREFIXES)
  : ['https://sts.windows.net/', 'https://login.microsoftonline.com/', 'https://login.microsoftonline.us/'];
const VALID_ISSUERS = splitEnv(process.env.FUNCTIONS_AUTH_VALID_ISSUERS);

// Optional allow-list of permitted calling identities (the API's app/object id), matched against
// the token's `azp` / `appid` / `oid`. When empty, any valid token for the audience+tenant passes.
const ALLOWED_CALLERS = splitEnv(process.env.FUNCTIONS_AUTH_ALLOWED_CALLERS);

let _keySet: ReturnType<typeof createRemoteJWKSet> | null = null;
function keySet(): ReturnType<typeof createRemoteJWKSet> {
  if (!_keySet) _keySet = createRemoteJWKSet(new URL(JWKS_URI), { cooldownDuration: 60_000 });
  return _keySet;
}

/** True when the operator has explicitly opted into validating the calling service's token. */
export function isCallerAuthConfigured(): boolean {
  return AUDIENCES.length > 0 || Boolean(process.env.FUNCTIONS_AUTH_JWKS_URI);
}

export interface CallerIdentity {
  appId?: string;
  oid?: string;
  tid?: string;
  claims: JWTPayload;
}

function validateIssuer(payload: JWTPayload): void {
  const issuer = typeof payload.iss === 'string' ? payload.iss : '';
  if (!issuer) throw new Error('token is missing issuer claim');

  const tid = typeof payload.tid === 'string' ? payload.tid : '';
  const validIssuers = VALID_ISSUERS.map((template) =>
    template.replace(/\{tenantid\}/gi, tid).replace(/\{tenantId\}/g, tid),
  );

  if (validIssuers.length > 0) {
    if (!validIssuers.includes(issuer)) throw new Error(`issuer is not allowed: ${issuer}`);
  } else if (!ISSUER_PREFIXES.some((prefix) => issuer.startsWith(prefix))) {
    throw new Error(`issuer is not from an allowed Entra cloud: ${issuer}`);
  }

  if (TENANT_ID && !['common', 'organizations', 'consumers'].includes(TENANT_ID.toLowerCase())) {
    if (!tid) throw new Error('token is missing tenant claim (tid)');
    if (tid !== TENANT_ID) throw new Error(`token tenant ${tid} does not match configured tenant ${TENANT_ID}`);
  }
}

function checkAllowedCaller(payload: JWTPayload): void {
  if (ALLOWED_CALLERS.length === 0) return;
  const candidates = [payload.azp, payload.appid, payload.oid].filter(
    (v): v is string => typeof v === 'string',
  );
  if (!candidates.some((c) => ALLOWED_CALLERS.includes(c))) {
    throw new Error('calling identity is not in FUNCTIONS_AUTH_ALLOWED_CALLERS');
  }
}

/**
 * Verify the calling service's bearer token (signature, audience, expiry, issuer, tenant) and any
 * configured caller allow-list. Throws on any failure. Only call when isCallerAuthConfigured().
 */
export async function validateCallerToken(authHeader: string | null | undefined): Promise<CallerIdentity> {
  if (!JWKS_URI) {
    throw new Error('caller validation requires FUNCTIONS_AUTH_JWKS_URI or AZURE_TENANT_ID to be set');
  }
  if (AUDIENCES.length === 0) {
    throw new Error('caller validation requires FUNCTIONS_AUTH_AUDIENCE to be set');
  }
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    throw new Error('missing or malformed Authorization header (expected Bearer token)');
  }

  const token = authHeader.slice(7);
  const { payload } = await jwtVerify(token, keySet(), { audience: AUDIENCES });
  validateIssuer(payload);
  checkAllowedCaller(payload);

  return {
    appId: typeof payload.azp === 'string' ? payload.azp : (typeof payload.appid === 'string' ? payload.appid : undefined),
    oid: typeof payload.oid === 'string' ? payload.oid : undefined,
    tid: typeof payload.tid === 'string' ? payload.tid : undefined,
    claims: payload,
  };
}
