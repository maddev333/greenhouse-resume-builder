/**
 * Claims-based security trimming for the attribute (facts) layer.
 *
 * Translates the verified Entra ID claims carried on {@link ToolCallContext} into a deterministic,
 * IL5-safe authorization decision + Azure AI Search OData `$filter`:
 *   - **Tenant isolation (row-level):** a mandatory `tenantId eq '<tid>'` clause; a call with no
 *     verified tenant claim is rejected (fail closed), so one tenant can never read another's facts.
 *   - **Attribute-level trim:** sensitive factKeys (temporal `event.*`, precise `*.location`) require a
 *     privileged Entra app role (`roles`) or delegated scope (`scp`); callers without one have those
 *     attributes redacted.
 *
 * The privileged role/scope names are cloud-configurable so they match the app registration's
 * `appRoles` / exposed API scopes:
 *   - `FACTS_SENSITIVE_READ_ROLES`  (default `ClearedReviewer,Admin`)
 *   - `FACTS_SENSITIVE_READ_SCOPES` (default `Facts.ReadSensitive`)
 */
import type { ToolCallContext } from './types';

function envList(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

/** Escape a string literal for an OData filter (single quotes are doubled per the OData grammar). */
export function odataEscapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** factKeys treated as sensitive/need-to-know: temporal `event.*` facts and any precise `*.location` fact. */
export function isSensitiveFactKey(factKey: unknown): boolean {
  return typeof factKey === 'string' && (factKey.startsWith('event.') || factKey.endsWith('.location'));
}

/** A caller may read sensitive attributes only with a privileged Entra app role or delegated scope. */
export function canReadSensitiveAttributes(ctx: Pick<ToolCallContext, 'roles' | 'scopes'>): boolean {
  const sensitiveRoles = envList('FACTS_SENSITIVE_READ_ROLES', 'ClearedReviewer,Admin');
  const sensitiveScopes = envList('FACTS_SENSITIVE_READ_SCOPES', 'Facts.ReadSensitive');
  return (ctx.roles ?? []).some((r) => sensitiveRoles.includes(r))
    || (ctx.scopes ?? []).some((s) => sensitiveScopes.includes(s));
}

/** Optional within-tenant narrowing for a facts query. */
export interface FactQueryNarrowing {
  personId?: string;
  sectionId?: string;
  factKey?: string;
}

/** Outcome of a security-trim evaluation for a facts query. */
export interface FactSecurityDecision {
  /** False when the call must be rejected (e.g. no verified tenant claim). */
  allowed: boolean;
  /** Human-readable reason when `allowed` is false. */
  reason?: string;
  /** Mandatory OData filter (tenant trim + any narrowing) to apply to the query when allowed. */
  filter?: string;
  /** Whether sensitive attributes may be returned; otherwise the caller must redact them. */
  allowSensitive: boolean;
}

/**
 * Build the mandatory security filter for a facts query from the caller's verified claims.
 * Fails closed when no tenant claim is present. `sectionId` is matched as a collection field
 * (`Collection(Edm.String)` in the `resume-facts` index).
 */
export function buildFactSecurityFilter(ctx: ToolCallContext, narrow: FactQueryNarrowing = {}): FactSecurityDecision {
  if (!ctx.tenantId) {
    return { allowed: false, reason: 'missing verified tenant claim (x-tenant-id)', allowSensitive: false };
  }
  const parts: string[] = [`tenantId eq '${odataEscapeLiteral(ctx.tenantId)}'`];
  if (narrow.personId) parts.push(`personId eq '${odataEscapeLiteral(narrow.personId)}'`);
  if (narrow.factKey) parts.push(`factKey eq '${odataEscapeLiteral(narrow.factKey)}'`);
  if (narrow.sectionId) parts.push(`sectionId/any(s: s eq '${odataEscapeLiteral(narrow.sectionId)}')`);
  return { allowed: true, filter: parts.join(' and '), allowSensitive: canReadSensitiveAttributes(ctx) };
}
