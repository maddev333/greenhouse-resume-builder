/**
 * Demo `SecurityContext` personas — the fixtures that stand in for verified Keycloak claims until the
 * real realm is wired (ARCHITECTURE §5.4). Each makes ONE trim behavior observable on stage; the
 * planner/orchestrator is handed one of these as immutable input per request.
 */
import type { SecurityContext } from './security';

/** Executive assistant with only the enterprise baseline group — the default demo caller. */
export const EA_BASIC: SecurityContext = {
  tenantId: 'army',
  userId: 'ea.basic@army.mil',
  aclGroups: ['/army'],
  roles: [],
};

/** EA read into the G8 plans cell — additionally sees `/army/g8/plans` need-to-know contacts (e.g. C4). */
export const EA_G8: SecurityContext = {
  tenantId: 'army',
  userId: 'ea.g8@army.mil',
  aclGroups: ['/army', '/army/g8/plans'],
  roles: [],
};

/** Privileged reviewer — may read `sensitive` rows (e.g. C12) regardless of group membership. */
export const ADMIN: SecurityContext = {
  tenantId: 'army',
  userId: 'admin@army.mil',
  aclGroups: ['/army'],
  roles: ['ClearedReviewer'],
};

/** A caller in a DIFFERENT tenant — every Army row is trimmed by the mandatory tenant clause. */
export const CROSS_TENANT: SecurityContext = {
  tenantId: 'usmc',
  userId: 'planner@usmc.mil',
  aclGroups: ['/army', '/army/g8/plans'], // even with matching groups, tenant isolation wins
  roles: ['ClearedReviewer'],
};

/** No verified tenant claim — the security trim REJECTS the call (fail-closed). */
export const NO_TENANT: SecurityContext = {
  userId: 'anonymous',
  aclGroups: ['/army'],
};

export const PERSONAS = { EA_BASIC, EA_G8, ADMIN, CROSS_TENANT, NO_TENANT } as const;
export type PersonaName = keyof typeof PERSONAS;
