/**
 * Per-request caller identity → `SecurityContext`.
 *
 * In production the UI's Keycloak token is verified and mapped to claims (ARCHITECTURE §5.4). For the
 * local MVP we accept the SAME shape over request headers so the chat host / basic-host can drive the
 * security trim without a realm:
 *
 *   x-demo-persona   EA_BASIC | EA_G8 | ADMIN | CROSS_TENANT | NO_TENANT   (fast demo switch)
 *   x-tenant-id      verified tenant claim (mandatory for access; fail-closed when absent)
 *   x-user-id        caller principal
 *   x-user-groups    comma/space-separated ACL groups (e.g. "/army,/army/g8/plans")
 *   x-user-roles     comma/space-separated roles   (e.g. "ClearedReviewer")
 *   x-user-scopes    comma/space-separated scopes  (e.g. "Engagements.ReadSensitive")
 *
 * Resolution order: explicit persona → header-built claims → default persona. The default
 * (`EA_BASIC`, enterprise baseline) makes the trim visible out-of-the-box: the canonical AUSA menu
 * comes back as {P2, C3} with C4 redacted until the caller elevates to `EA_G8`.
 */

import { PERSONAS, type SecurityContext, type PersonaName } from './engine.js';

export type HeaderBag = Record<string, string | string[] | undefined>;

export interface ResolvedContext {
  ctx: SecurityContext;
  /** Human-readable provenance for logs / the demo ("persona:EA_G8", "headers", "default:EA_BASIC"). */
  label: string;
}

const DEFAULT_PERSONA: PersonaName =
  (process.env.ENGAGEMENTS_DEMO_PERSONA as PersonaName) in PERSONAS
    ? (process.env.ENGAGEMENTS_DEMO_PERSONA as PersonaName)
    : 'EA_BASIC';

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t ? t : undefined;
}

/** Split a comma/space-separated header into a trimmed, non-empty list. */
function list(v: string | string[] | undefined): string[] {
  const raw = Array.isArray(v) ? v.join(',') : (v ?? '');
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isPersonaName(name: string | undefined): name is PersonaName {
  return !!name && name in PERSONAS;
}

/** Turn a request's headers (or any bag) into the verified caller claims for the security trim. */
export function resolveSecurityContext(headers: HeaderBag = {}): ResolvedContext {
  const personaHeader = first(headers['x-demo-persona']);
  if (isPersonaName(personaHeader)) {
    return { ctx: PERSONAS[personaHeader], label: `persona:${personaHeader}` };
  }

  const tenantId = first(headers['x-tenant-id']);
  const groups = list(headers['x-user-groups']);
  const roles = list(headers['x-user-roles']);
  const scopes = list(headers['x-user-scopes']);
  const userId = first(headers['x-user-id']);

  if (tenantId || groups.length || roles.length || scopes.length || userId) {
    return {
      ctx: { tenantId, userId, aclGroups: groups, roles, scopes },
      label: 'headers',
    };
  }

  return { ctx: PERSONAS[DEFAULT_PERSONA], label: `default:${DEFAULT_PERSONA}` };
}
