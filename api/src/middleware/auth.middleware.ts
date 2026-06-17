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

export interface AuthenticatedRequest extends Request {
  userId: string;
  tenantId: string;
  user: AuthenticatedUser;
  /** Raw validated Bearer token — used as the user assertion for On-Behalf-Of downstream calls. */
  accessToken: string;
}

export interface AuthenticatedUser {
  id: string;
  userId: string;
  tenantId: string;
  username?: string;
  name?: string;
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
      return claimsToUser(decodeJwt(accessToken));
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

  if (AZURE_AD_JWKS_URI?.trim()) {
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
    // forgets AZURE_TENANT_ID/AZURE_AD_JWKS_URI rejects requests instead of silently failing open.
    const detail = IS_PRODUCTION && ALLOW_DEV_AUTH_BYPASS
      ? 'ALLOW_DEV_AUTH_BYPASS cannot be used in production'
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

  next();
};

/**
 * Convenience decorator — apply auth globally or selectively.
 * Usage: `app.use('/api/v1', authMiddleware);`
 */
export const authenticated = () => authMiddleware;
