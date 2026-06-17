import { RequestHandler } from 'express';
import { jwtVerify, createRemoteJWKSet } from 'jose';

/**
 * MVP Entra ID authentication middleware.
 *
 * Dev mode (AZURE_AD_JWKS_URI not set): accepts any Bearer token, sets placeholder userId/tenantId.
 * Prod mode (AZURE_AD_JWKS_URI configured): uses jose's `jwtVerify` + `createRemoteJWKSet` to
 * cryptographically verify the RSA signature against Azure AD's JWKS endpoint, then validates
 * issuer, audience, and expiration claims — all handled by jose internally.
 */

const AZURE_AD_JWKS_URI = process.env.AZURE_AD_JWKS_URI ?? '';
const AZURE_AD_CLIENT_ID = process.env.AZURE_AD_CLIENT_ID ?? '';

// Explicit, local-dev-only opt-in for the no-crypto bypass. Production must leave this unset.
const ALLOW_DEV_AUTH_BYPASS = process.env.ALLOW_DEV_AUTH_BYPASS === 'true';

// Accept both Azure Commercial and USGov issuer prefixes (covers all deployment targets).
const AAD_ISSUER_PREFIXES = process.env.AZURE_AD_ISSUER_PREFIXES
  ? process.env.AZURE_AD_ISSUER_PREFIXES.split(',').map((s) => s.trim()).filter(Boolean)
  : ['https://sts.windows.net/', 'https://login.microsoftonline.com/', 'https://login.microsoftonline.us/'];

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
  /** Raw validated Bearer token — used as the user assertion for On-Behalf-Of downstream calls. */
  accessToken: string;
}

// ── Dev-mode placeholder validation ───────────────────────────────

/**
 * DEPRECATED (dev only): Accepts any Bearer token without cryptographic verification.
 * Remove this entirely before production deployment — it exists for local/dev environments
 * where Azure AD is not available.
 */
async function validateTokenClaimsDev(_accessToken: string): Promise<{ userId: string; tenantId: string }> {
  return { userId: 'dev-placeholder', tenantId: 'developer-tenant' };
}

// ── Prod-mode JWT validation via jose + remote JWKS ────────────────

/**
 * Validate a Bearer access token against Azure AD using jose's jwtVerify + createRemoteJWKSet.
 * Cryptographically verifies RSA signature (via kid-based key lookup), and validates
 * expiration, issuer, and audience claims — all handled by jose internally.
 */
async function validateTokenClaimsProd(accessToken: string): Promise<{ userId: string; tenantId: string }> {
  if (!AZURE_AD_JWKS_URI) {
    throw new Error('Azure AD JWKS URI not configured — set AZURE_AD_JWKS_URI');
  }

  const keySet = getAzureADKeySet();

  const result = await jwtVerify(accessToken, keySet, {
    // jose validates issuer (prefix list), audience, and expiration (exp claim)
    issuer: AAD_ISSUER_PREFIXES,
    audience: AZURE_AD_CLIENT_ID || undefined,
  });

  const payload = result.payload as Record<string, unknown>;

  // Extract subject identity (prefer oid for Entra service principals)
  const userId = (payload.oid ?? payload.uid ?? payload.sub) as string;
  if (!userId) {
    throw new Error('JWT is missing identifier claim (oid/uid/sub)');
  }

  // Extract tenant/issuer info
  return {
    userId,
    tenantId: String(payload.tid ?? 'unknown'),
  };
}

// ── Exported middleware ───────────────────────────────────────────

export const authMiddleware: RequestHandler = async (req, res, next) => {
  const authHeader = req.header('Authorization') ?? '';
  let accessToken = ''; // default to empty for dev bypass mode
  let claims: { userId: string; tenantId: string };

  // ── Verbose logging so we always know which path was taken ──
  console.error('[authMiddleware] AZURE_AD_JWKS_URI=', JSON.stringify(AZURE_AD_JWKS_URI));
  console.error('[authMiddleware] ALLOW_DEV_AUTH_BYPASS=', ALLOW_DEV_AUTH_BYPASS);
  console.error('[authMiddleware] hasAuthHeader=', !!authHeader);

  // ── Dev bypass: allow all requests locally regardless of JWKS config ──
  if (ALLOW_DEV_AUTH_BYPASS) {
    // ANY request passes, even with zero headers. No network calls.
    console.error('[authMiddleware] → dev bypass accepted (any request).');
    claims = { userId: 'dev-placeholder', tenantId: 'developer-tenant' };
  } else if (!AZURE_AD_JWKS_URI?.trim()) {
    // ── Local dev without bypass: require Bearer header ──
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      const msg = 'Dev auth requires: EITHER set ALLOW_DEV_AUTH_BYPASS=true OR send an Authorization: Bearer <token>.';
      console.error('[authMiddleware] → reject: ' + msg);
      return res.status(401).json({ error: msg });
    }
    // Accept Bearer but doesn't verify crypto
    accessToken = authHeader.slice(7);
    claims = await validateTokenClaimsDev(accessToken);
    console.error('[authMiddleware] → dev accepted, userId=' + claims.userId);
  } else {
    // ── Production: require valid Bearer ──
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header (expected Bearer token)' });
    }
    accessToken = authHeader.slice(7);
    try {
      claims = await validateTokenClaimsProd(accessToken);
      console.error('[authMiddleware] → prod verified userId=' + claims.userId);
    } catch (err: any) {
      console.error('[authMiddleware] → prod verify failed:', err.message);
      return res.status(401).json({ error: 'Invalid Bearer token: ' + err.message });
    }
  }

  // Type-safe assignment via unknown intermediate to satisfy TypeScript no-overlap check
  const authenticatedReq = req as unknown as AuthenticatedRequest;
  authenticatedReq.userId = claims.userId;
  authenticatedReq.tenantId = claims.tenantId;
  // Carry the validated token so handlers can exchange it On-Behalf-Of the user (no shared secret).
  authenticatedReq.accessToken = accessToken;

  next();
};

/**
 * Convenience decorator — apply auth globally or selectively.
 * Usage: `app.use('/api/v1', authMiddleware);`
 */
export const authenticated = () => authMiddleware;

// MODULE-LOAD DIAGNOSTIC (remove after debugging)
console.error('[auth-mw-diag] ALLOW_DEV_AUTH_BYPASS=', process.env.ALLOW_DEV_AUTH_BYPASS ?? '(UNSET)');
console.error('[auth-mw-diag] AZURE_AD_JWKS_URI=', JSON.stringify(process.env.AZURE_AD_JWKS_URI));
