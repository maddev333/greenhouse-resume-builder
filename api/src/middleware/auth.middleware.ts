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

const AZURE_AD_JWKS_URI = process.env.AZURE_AD_JWKS_URI ?? ''; // Azure AD JWKS discovery URL
const AZURE_AD_CLIENT_ID = process.env.AZURE_AD_CLIENT_ID ?? ''; // API's app registration client ID

// Explicit, local-dev-only opt-in for the no-crypto bypass. Production must leave this unset.
const ALLOW_DEV_AUTH_BYPASS = process.env.ALLOW_DEV_AUTH_BYPASS === 'true';

// Accepted issuer prefixes. Defaults to Azure Commercial; override with a comma-separated
// AZURE_AD_ISSUER_PREFIXES for Azure Government / DoD (e.g. https://login.microsoftonline.us/).
const AAD_ISSUER_PREFIXES = process.env.AZURE_AD_ISSUER_PREFIXES
  ? process.env.AZURE_AD_ISSUER_PREFIXES.split(',').map((s) => s.trim()).filter(Boolean)
  : ['https://sts.windows.net/', 'https://login.microsoftonline.com/'];

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

  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header (expected Bearer token)' });
  }

  const accessToken = authHeader.slice(7);
  let claims: { userId: string; tenantId: string };

  try {
    if (AZURE_AD_JWKS_URI) {
      // Production: jose cryptographically verifies RSA signature + JWKS key resolution
      claims = await validateTokenClaimsProd(accessToken);
    } else if (ALLOW_DEV_AUTH_BYPASS) {
      // Dev-only: placeholder mode — no crypto verification. Requires explicit opt-in.
      claims = await validateTokenClaimsDev(accessToken);
    } else {
      // Fail closed: never accept unverified tokens unless dev bypass is explicitly enabled.
      return res.status(401).json({
        error: 'Authentication not configured: set AZURE_AD_JWKS_URI (or ALLOW_DEV_AUTH_BYPASS=true for local dev only)',
      });
    }
  } catch (err) {
    return res.status(401).json({ error: `Invalid Bearer token: ${(err as Error).message}` });
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
