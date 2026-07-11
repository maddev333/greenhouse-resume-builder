/**
 * Claims-based security trim for the engagements read model — the LOCAL mirror of
 * `capabilities/mcp-core/src/security.ts` (`buildFactSecurityFilter`). It turns the caller's verified
 * `SecurityContext` (from Keycloak in prod; a fixture here) into ONE decision that carries BOTH:
 *   - a `predicate(record)` the in-memory shim applies now (M1, zero cloud), and
 *   - the exact OData `$filter` Azure AI Search WILL evaluate server-side at M4 (drop-in swap).
 * The two are built together so they can never diverge (ARCHITECTURE §5.4).
 *
 * Trim layers (ALL server-side; the LLM controls only query text, never the filter):
 *   1. Tenant isolation (row-level): mandatory `tenantId eq '<tid>'`; a call with no verified tenant
 *      claim is REJECTED — fail closed.
 *   2. Group ACL: `aclGroups/any(g: search.in(g, '<caller groups>'))` — a record is visible only if it
 *      shares ≥1 group with the caller (deny-by-default: a record with no shared group is invisible).
 *   3. Sensitivity: `sensitivity eq 'unclassified'` unless the caller holds a privileged role/scope.
 *   4. Optional topic narrowing (NOT security — a recall convenience mirrored into the filter).
 *
 * Privileged role/scope names are env-configurable to match the app registration (defaults match the
 * facts layer): `ENGAGEMENTS_SENSITIVE_READ_ROLES` / `ENGAGEMENTS_SENSITIVE_READ_SCOPES`.
 */
import type { Trimmable } from './types';

/** Verified caller claims (Keycloak → `keycloakClaimsToUser` in prod). Immutable orchestrator input. */
export interface SecurityContext {
  tenantId?: string;
  userId?: string;
  aclGroups?: string[];
  roles?: string[];
  scopes?: string[];
}

/** Optional within-tenant narrowing (recall convenience — never widens access). */
export interface RetrievalNarrowing {
  topicIds?: string[];
}

/** Outcome of a security-trim evaluation. */
export interface SecurityDecision {
  /** False when the call must be rejected (e.g. no verified tenant claim). */
  allowed: boolean;
  reason?: string;
  /** Mandatory OData `$filter` (tenant + ACL + sensitivity + narrowing) for AI Search. */
  filter?: string;
  /** Whether `sensitive` rows may be returned; otherwise they are trimmed. */
  allowSensitive: boolean;
  /** In-memory equivalent of `filter` — the shim applies this to each candidate record. */
  predicate: (rec: Trimmable) => boolean;
}

function envList(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

/** Escape a string literal for an OData filter (single quotes are doubled per the OData grammar). */
export function odataEscapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** A caller may read `sensitive` rows only with a privileged role or delegated scope. */
export function canReadSensitive(ctx: Pick<SecurityContext, 'roles' | 'scopes'>): boolean {
  const roles = envList('ENGAGEMENTS_SENSITIVE_READ_ROLES', 'ClearedReviewer,Admin');
  const scopes = envList('ENGAGEMENTS_SENSITIVE_READ_SCOPES', 'Engagements.ReadSensitive');
  return (ctx.roles ?? []).some((r) => roles.includes(r)) || (ctx.scopes ?? []).some((s) => scopes.includes(s));
}

/** A `search.in`-style membership clause, mirrored exactly by the predicate. */
function searchInClause(field: string, values: string[]): string {
  const list = values.map(odataEscapeLiteral).join(',');
  return `${field}/any(x: search.in(x, '${list}'))`;
}

/**
 * Build the security decision (filter string + predicate) from the caller's claims.
 * Fails closed when no tenant claim is present.
 */
export function buildEngagementSecurityFilter(
  ctx: SecurityContext,
  narrow: RetrievalNarrowing = {},
): SecurityDecision {
  if (!ctx.tenantId) {
    return {
      allowed: false,
      reason: 'missing verified tenant claim (fail-closed)',
      allowSensitive: false,
      predicate: () => false,
    };
  }

  const tenantId = ctx.tenantId;
  const groups = ctx.aclGroups ?? [];
  const allowSensitive = canReadSensitive(ctx);
  const topicIds = narrow.topicIds ?? [];

  const parts: string[] = [`tenantId eq '${odataEscapeLiteral(tenantId)}'`];
  // Group ACL — deny-by-default. With no caller groups, no record can match (sentinel keeps it false).
  parts.push(searchInClause('aclGroups', groups.length ? groups : ['\u0000__none__']));
  if (!allowSensitive) parts.push(`sensitivity eq 'unclassified'`);
  if (topicIds.length) parts.push(searchInClause('topicIds', topicIds));

  const predicate = (rec: Trimmable): boolean => {
    if (rec.tenantId !== tenantId) return false; // tenant isolation (defense-in-depth)
    if (!rec.aclGroups.some((g) => groups.includes(g))) return false; // group ACL
    if (!allowSensitive && rec.sensitivity !== 'unclassified') return false; // sensitivity gate
    if (topicIds.length && !(rec.topicIds ?? []).some((t) => topicIds.includes(t))) return false; // narrowing
    return true;
  };

  return { allowed: true, filter: parts.join(' and '), allowSensitive, predicate };
}
