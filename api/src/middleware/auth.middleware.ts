import { Request, RequestHandler } from 'express';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from 'jose';

/**
 * MVP Entra ID authentication middleware. Three mutually exclusive modes, selected at request time:
 *
 *  1. Production verification — active whenever a JWKS endpoint is configured. Uses jose's
 *     `jwtVerify` + `createRemoteJWKSet` to verify the RSA signature, then validates audience,
 *     expiration, issuer, tenant and user claims. Configure via `AZURE_AD_JWKS_URI`, OR
 *     `AZURE_TENANT_ID` together with an audience (`AZURE_AD_CLIENT_ID` / `AZURE_AD_AUDIENCE` /
 *     `AZURE_AD_VALID_AUDIENCES`).
 *  2. Local-dev bypass — only when `ALLOW_DEV_AUTH_BYPASS=true` AND not running in production.
 *     Accepts any/no Bearer token WITHOUT signature verification (claims, if present, are trusted
 *     for convenience). Never honoured in production.
 *  3. Fail closed — if neither of the above applies, every request is rejected. We never decode and
 *     trust unverified token claims outside the explicit dev bypass, so forgetting to configure the
 *     JWKS in production cannot silently fail open to attacker-supplied identity.
 *
 * Requiring an audience before deriving the JWKS (mode 1) prevents the API from silently demanding
 * signed tokens just because `AZURE_TENANT_ID` happens to be set for other Azure SDKs
 * (DefaultAzureCredential, Postgres AAD auth, …) — without an audience there is nothing to verify.
 */

const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID ?? process.env.AZURE_AD_TENANT_ID ?? '';
const AZURE_AD_CLIENT_ID = process.env.AZURE_AD_CLIENT_ID ?? '';
const AZURE_AD_AUTHORITY_HOST = (process.env.AZURE_AD_AUTHORITY_HOST ?? process.env.AZURE_AUTHORITY_HOST ?? 'https://login.microsoftonline.com').replace(/\/+$/, '');

// Explicit, local-dev-only opt-in for the no-crypto bypass. Production must leave this unset.
const ALLOW_DEV_AUTH_BYPASS = process.env.ALLOW_DEV_AUTH_BYPASS === 'true';

// Production deployments must never fall back to the no-crypto dev paths.
const IS_PRODUCTION = (process.env.NODE_ENV ?? '').toLowerCase() === 'production';

// Accept both Azure Commercial and USGov issuer prefixes (covers all deployment targets).
const AAD_ISSUER_PREFIXES = process.env.AZURE_AD_ISSUER_PREFIXES
  ? process.env.AZURE_AD_ISSUER_PREFIXES.split(',').map((s) => s.trim()).filter(Boolean)
  : ['https://sts.windows.net/', 'https://login.microsoftonline.com/', 'https://login.microsoftonline.us/'];

const AZURE_AD_VALID_ISSUERS = splitEnv(process.env.AZURE_AD_VALID_ISSUERS);
const AZURE_AD_VALID_AUDIENCES = expectedAudiences();
const AZURE_AD_JWKS_URI = process.env.AZURE_AD_JWKS_URI
  || (AZURE_TENANT_ID && AZURE_AD_VALID_AUDIENCES.length > 0
    ? `${AZURE_AD_AUTHORITY_HOST}/${AZURE_TENANT_ID}/discovery/v2.0/keys`
    : '');

/** Remote JWKS key resolver with automatic caching (jose caches keys for cooldownDuration). */
let _azureKeySet: ReturnType<typeof createRemoteJWKSet> | null = null;

function getAzureADKeySet(): ReturnType<typeof createRemoteJWKSet> {
  if (_azureKeySet) return _azureKeySet;
  _azureKeySet = createRemoteJWKSet(new URL(AZURE_AD_JWKS_URI), {
    cooldownDuration: 60_000, // cache keys for 1 minute to avoid hitting Azure AD per-request
  });
  return _azureKeySet;
}

// ── Keycloak (generic OIDC) provider ──────────────────────────────
// Selected with AUTH_PROVIDER=keycloak. The API then verifies Keycloak-issued RS256 access tokens
// against the realm JWKS and maps Keycloak's claim shape onto AuthenticatedUser. Keycloak tokens are
// NOT valid Microsoft Entra user assertions, so On-Behalf-Of is disabled for this provider — see
// `oboAssertion` in the middleware, which keeps it undefined so downstream Azure calls fall back to
// managed identity instead of attempting (and failing) an OBO exchange.
const AUTH_PROVIDER = (process.env.AUTH_PROVIDER ?? 'entra').trim().toLowerCase();
const IS_KEYCLOAK = AUTH_PROVIDER === 'keycloak';

const KEYCLOAK_ISSUER = (process.env.KEYCLOAK_ISSUER ?? '').replace(/\/+$/, '');
const KEYCLOAK_JWKS_URI = process.env.KEYCLOAK_JWKS_URI
  || (KEYCLOAK_ISSUER ? `${KEYCLOAK_ISSUER}/protocol/openid-connect/certs` : '');
const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? '';
const KEYCLOAK_VALID_AUDIENCES = splitEnv(process.env.KEYCLOAK_AUDIENCE);
// Multi-tenant id claim. Keycloak has no Entra `tid`, so add a protocol mapper that emits this claim
// (default `tenant_id`) to preserve tenant isolation. Fallbacks (in order): KEYCLOAK_DEFAULT_TENANT,
// then the realm name parsed from the issuer, then 'unknown'.
const KEYCLOAK_TENANT_CLAIM = process.env.KEYCLOAK_TENANT_CLAIM || 'tenant_id';
const KEYCLOAK_DEFAULT_TENANT = process.env.KEYCLOAK_DEFAULT_TENANT || '';
// Client whose resource_access roles are merged with realm_access roles (defaults to the token client).
const KEYCLOAK_ROLES_CLIENT = process.env.KEYCLOAK_ROLES_CLIENT || KEYCLOAK_CLIENT_ID;

let _keycloakKeySet: ReturnType<typeof createRemoteJWKSet> | null = null;

function getKeycloakKeySet(): ReturnType<typeof createRemoteJWKSet> {
  if (_keycloakKeySet) return _keycloakKeySet;
  _keycloakKeySet = createRemoteJWKSet(new URL(KEYCLOAK_JWKS_URI), { cooldownDuration: 60_000 });
  return _keycloakKeySet;
}

/** True when the active provider has a JWKS endpoint configured (production verification is possible). */
function activeJwksConfigured(): boolean {
  return IS_KEYCLOAK ? Boolean(KEYCLOAK_JWKS_URI) : Boolean(AZURE_AD_JWKS_URI && AZURE_AD_JWKS_URI.trim());
}

/** Parse the Keycloak realm name out of an issuer like `https://host/realms/<realm>`. */
function realmFromIssuer(issuer: string): string {
  const match = /\/realms\/([^/]+)\/?$/.exec(issuer);
  return match ? decodeURIComponent(match[1]) : '';
}

/** Map the active provider's verified/decoded claims onto the shared AuthenticatedUser shape. */
function mapClaims(payload: JWTPayload): AuthenticatedUser {
  return IS_KEYCLOAK ? keycloakClaimsToUser(payload) : claimsToUser(payload);
}

/**
 * Verify a Keycloak-issued RS256 access token against the realm JWKS. jose validates the signature,
 * expiration and (when configured) audience; issuer is pinned to KEYCLOAK_ISSUER. When no explicit
 * audience is configured we fall back to checking `azp` against KEYCLOAK_CLIENT_ID so that tokens
 * whose default `aud` is "account" still validate when they were issued to our client.
 */
async function validateKeycloakProd(accessToken: string): Promise<AuthenticatedUser> {
  if (!KEYCLOAK_JWKS_URI) {
    throw new Error('Keycloak JWKS URI not configured — set KEYCLOAK_ISSUER or KEYCLOAK_JWKS_URI');
  }
  if (KEYCLOAK_VALID_AUDIENCES.length === 0 && !KEYCLOAK_CLIENT_ID) {
    throw new Error('Keycloak audience not configured — set KEYCLOAK_AUDIENCE or KEYCLOAK_CLIENT_ID');
  }

  const result = await jwtVerify(accessToken, getKeycloakKeySet(), {
    issuer: KEYCLOAK_ISSUER || undefined,
    audience: KEYCLOAK_VALID_AUDIENCES.length > 0 ? KEYCLOAK_VALID_AUDIENCES : undefined,
  });

  if (KEYCLOAK_VALID_AUDIENCES.length === 0 && KEYCLOAK_CLIENT_ID) {
    const azp = typeof result.payload.azp === 'string' ? result.payload.azp : '';
    if (azp !== KEYCLOAK_CLIENT_ID) {
      throw new Error(`JWT authorized party ${azp || '(none)'} does not match Keycloak client ${KEYCLOAK_CLIENT_ID}`);
    }
  }

  return keycloakClaimsToUser(result.payload);
}

/** Map Keycloak's claim shape (sub, realm_access.roles, scope, …) onto AuthenticatedUser. */
function keycloakClaimsToUser(payload: JWTPayload): AuthenticatedUser {
  const userId = String(payload.sub ?? '');
  if (!userId) throw new Error('JWT is missing subject claim (sub)');

  const claimTenant = (payload as Record<string, unknown>)[KEYCLOAK_TENANT_CLAIM];
  const issuer = typeof payload.iss === 'string' ? payload.iss : KEYCLOAK_ISSUER;
  const tenantId = (typeof claimTenant === 'string' && claimTenant)
    || KEYCLOAK_DEFAULT_TENANT
    || realmFromIssuer(issuer)
    || 'unknown';

  const realmAccess = (payload as Record<string, any>).realm_access;
  const resourceAccess = (payload as Record<string, any>).resource_access;
  const realmRoles: unknown[] = Array.isArray(realmAccess?.roles) ? realmAccess.roles : [];
  const clientRoles: unknown[] = KEYCLOAK_ROLES_CLIENT && Array.isArray(resourceAccess?.[KEYCLOAK_ROLES_CLIENT]?.roles)
    ? resourceAccess[KEYCLOAK_ROLES_CLIENT].roles
    : [];
  const roles = [...new Set([...realmRoles, ...clientRoles].map(String))];

  const scope = (payload as Record<string, unknown>).scope;
  const groups = (payload as Record<string, unknown>).groups;

  return {
    id: userId,
    userId,
    tenantId: String(tenantId),
    username: typeof payload.preferred_username === 'string'
      ? payload.preferred_username
      : typeof payload.email === 'string'
        ? payload.email
        : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    roles: roles.length > 0 ? roles : undefined,
    groups: Array.isArray(groups) ? groups.map(String) : undefined,
    scopes: typeof scope === 'string' ? scope.split(' ').filter(Boolean) : undefined,
    claims: payload,
  };
}

export interface AuthenticatedRequest extends Request {
  userId: string;
  tenantId: string;
  user: AuthenticatedUser;
  /** Raw validated Bearer token — used as the user assertion for On-Behalf-Of downstream calls. */
  accessToken: string;
  /**
   * Bearer token to use as the On-Behalf-Of user assertion for downstream Azure calls. Set only when
   * the active provider issues Entra tokens (OBO-eligible); undefined for Keycloak, so consumers fall
   * back to managed identity instead of attempting an OBO exchange that Azure AD would reject.
   */
  oboAssertion?: string;
}

export interface AuthenticatedUser {
  id: string;
  userId: string;
  tenantId: string;
  username?: string;
  name?: string;
  /** Entra app roles (`roles` claim) — primary RBAC signal for attribute-layer authorization. */
  roles?: string[];
  /** Entra security-group object IDs (`groups` claim) — need-to-know / program membership filtering. */
  groups?: string[];
  /** Entra delegated scopes (`scp` claim, space-delimited) granted to the calling app. */
  scopes?: string[];
  claims?: JWTPayload;
}

function splitEnv(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function expectedAudiences(): string[] {
  const configured = [
    ...splitEnv(process.env.AZURE_AD_VALID_AUDIENCES),
    process.env.AZURE_AD_AUDIENCE,
    AZURE_AD_CLIENT_ID,
    AZURE_AD_CLIENT_ID ? `api://${AZURE_AD_CLIENT_ID}` : '',
  ];
  return [...new Set(configured.filter(Boolean) as string[])];
}

// ── Dev-mode placeholder validation ───────────────────────────────

/**
 * Dev only — reached ONLY behind the explicit `ALLOW_DEV_AUTH_BYPASS` opt-in (and never in
 * production). Accepts any Bearer token without cryptographic verification; if a JWT is present its
 * claims are decoded purely for local convenience and must not be trusted as a security boundary.
 */
async function validateTokenClaimsDev(accessToken: string): Promise<AuthenticatedUser> {
  if (accessToken) {
    try {
      return mapClaims(decodeJwt(accessToken));
    } catch {
      // Dev mode may use opaque placeholder tokens.
    }
  }
  return {
    id: 'dev-placeholder',
    userId: 'dev-placeholder',
    tenantId: 'developer-tenant',
  };
}

// ── Prod-mode JWT validation via jose + remote JWKS ────────────────

/**
 * Validate a Bearer access token against Azure AD using jose's jwtVerify + createRemoteJWKSet.
 * Cryptographically verifies RSA signature (via kid-based key lookup), and validates
 * expiration and audience via jose, then validates issuer/tenant/user claims explicitly.
 */
async function validateTokenClaimsProd(accessToken: string): Promise<AuthenticatedUser> {
  if (IS_KEYCLOAK) return validateKeycloakProd(accessToken);

  if (!AZURE_AD_JWKS_URI) {
    throw new Error('Microsoft Entra JWKS URI not configured — set AZURE_AD_JWKS_URI or AZURE_TENANT_ID');
  }

  if (AZURE_AD_VALID_AUDIENCES.length === 0) {
    throw new Error('Microsoft Entra token audience not configured — set AZURE_AD_CLIENT_ID, AZURE_AD_AUDIENCE, or AZURE_AD_VALID_AUDIENCES');
  }

  const keySet = getAzureADKeySet();

  const result = await jwtVerify(accessToken, keySet, {
    // jose validates signature, audience, nbf, and exp. Issuer is checked below because
    // Entra v1/v2 issuers include tenant-specific suffixes while this repo configures prefixes.
    audience: AZURE_AD_VALID_AUDIENCES,
  });

  validateIssuer(result.payload);
  return claimsToUser(result.payload);
}

function claimsToUser(payload: JWTPayload): AuthenticatedUser {
  // Extract subject identity (prefer oid for Entra users/service principals).
  const userId = String(payload.oid ?? payload.sub ?? '');
  if (!userId) {
    throw new Error('JWT is missing identifier claim (oid/uid/sub)');
  }

  return {
    id: userId,
    userId,
    tenantId: String(payload.tid ?? 'unknown'),
    username: typeof payload.preferred_username === 'string'
      ? payload.preferred_username
      : typeof payload.upn === 'string'
        ? payload.upn
        : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    // Entra authorization claims, surfaced for attribute-layer security trimming. `roles`/`groups`
    // arrive as arrays; `scp` is a single space-delimited string of delegated scopes.
    roles: Array.isArray(payload.roles) ? payload.roles.map(String) : undefined,
    groups: Array.isArray(payload.groups) ? payload.groups.map(String) : undefined,
    scopes: typeof payload.scp === 'string' ? payload.scp.split(' ').filter(Boolean) : undefined,
    claims: payload,
  };
}

function validateIssuer(payload: JWTPayload): void {
  const issuer = typeof payload.iss === 'string' ? payload.iss : '';
  if (!issuer) throw new Error('JWT is missing issuer claim');

  const tenantId = typeof payload.tid === 'string' ? payload.tid : '';
  const validIssuers = AZURE_AD_VALID_ISSUERS.map((issuerTemplate) =>
    issuerTemplate
      .replace(/\{tenantid\}/gi, tenantId)
      .replace(/\{tenantId\}/g, tenantId),
  );

  if (validIssuers.length > 0) {
    if (!validIssuers.includes(issuer)) {
      throw new Error(`JWT issuer is not allowed: ${issuer}`);
    }
  } else if (!AAD_ISSUER_PREFIXES.some((prefix) => issuer.startsWith(prefix))) {
    throw new Error(`JWT issuer is not from an allowed Entra cloud: ${issuer}`);
  }

  if (AZURE_TENANT_ID && !['common', 'organizations', 'consumers'].includes(AZURE_TENANT_ID.toLowerCase())) {
    if (!tenantId) throw new Error('JWT is missing tenant claim (tid)');
    if (tenantId !== AZURE_TENANT_ID) {
      throw new Error(`JWT tenant ${tenantId} does not match configured tenant ${AZURE_TENANT_ID}`);
    }
  }
}

// ── Exported middleware ───────────────────────────────────────────

export const authMiddleware: RequestHandler = async (req, res, next) => {
  const authHeader = req.header('Authorization') ?? '';
  let accessToken = ''; // default to empty for dev bypass mode
  let user: AuthenticatedUser;

  if (activeJwksConfigured() && !(ALLOW_DEV_AUTH_BYPASS && !IS_PRODUCTION)) {
    // ── Production: cryptographically verify the Bearer token ──
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header (expected Bearer token)' });
    }
    accessToken = authHeader.slice(7);
    try {
      user = await validateTokenClaimsProd(accessToken);
    } catch (err: any) {
      console.error('[authMiddleware] token verification failed:', err.message);
      return res.status(401).json({ error: 'Invalid Bearer token: ' + err.message });
    }
  } else if (ALLOW_DEV_AUTH_BYPASS && !IS_PRODUCTION) {
    // ── Explicit local-dev opt-in: accept any/no Bearer without crypto verification ──
    // Reached only outside production; never trust these claims as a security boundary.
    if (authHeader.toLowerCase().startsWith('bearer ')) {
      accessToken = authHeader.slice(7);
    }
    user = await validateTokenClaimsDev(accessToken);
  } else {
    // ── Fail closed: not configured for verification, and no (non-prod) dev bypass. ──
    // We deliberately do NOT decode-and-trust unverified claims here, so a production deploy that
    // forgets the provider's JWKS/audience config rejects requests instead of silently failing open.
    const detail = IS_PRODUCTION && ALLOW_DEV_AUTH_BYPASS
      ? 'ALLOW_DEV_AUTH_BYPASS cannot be used in production'
      : IS_KEYCLOAK
        ? 'set KEYCLOAK_ISSUER + an audience (KEYCLOAK_AUDIENCE or KEYCLOAK_CLIENT_ID) for production, or ALLOW_DEV_AUTH_BYPASS=true for local development'
        : 'set AZURE_TENANT_ID + an audience (AZURE_AD_CLIENT_ID/AZURE_AD_AUDIENCE) for production, or ALLOW_DEV_AUTH_BYPASS=true for local development';
    console.error(`[authMiddleware] Authentication is not configured — ${detail}.`);
    return res.status(500).json({ error: 'Authentication is not configured' });
  }

  const authenticatedReq = req as unknown as AuthenticatedRequest;
  authenticatedReq.user = user;
  authenticatedReq.userId = user.userId;
  authenticatedReq.tenantId = user.tenantId;
  // Carry the validated token so handlers can exchange it On-Behalf-Of the user (no shared secret).
  authenticatedReq.accessToken = accessToken;
  // Only Entra tokens are valid Azure OBO user assertions; Keycloak tokens are not, so leave the
  // assertion undefined for Keycloak and let downstream Azure calls use managed identity.
  authenticatedReq.oboAssertion = IS_KEYCLOAK ? undefined : (accessToken || undefined);

  next();
};

/**
 * Convenience decorator — apply auth globally or selectively.
 * Usage: `app.use('/api/v1', authMiddleware);`
 */
export const authenticated = () => authMiddleware;
