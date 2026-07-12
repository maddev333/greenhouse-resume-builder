/**
 * Governance labeling policy (ARCHITECTURE §16.3 "one consistent envelope on every record").
 * Derives the `{ source, aclGroups, sensitivity }` envelope for each record so the staged seed can
 * stay DOMAIN-only while the shim still exercises the real security trim. In production these labels
 * ride in the per-source blob; here they are deterministic and tunable in ONE place.
 *
 * Two independent, demonstrable trim beats are wired in via the override table:
 *   - GROUP ACL  — `C4` (LTG Cole's angel-investor relationship) is need-to-know for `/army/g8/plans`
 *     ONLY (not enterprise-visible), so it appears for a g8-cleared EA and vanishes for a basic EA.
 *   - SENSITIVITY — `C12` (a sensitive venture relationship) is enterprise-group but `sensitive`, so it
 *     appears only for a caller holding a privileged role, regardless of group.
 * The two axes are orthogonal on purpose (a group-cleared EA still can't see `sensitive` rows).
 */
import type { BaseEntity } from '@greenhouse-resume-builder/shared';
import type { Dataset } from '../planner/seed-loader';
import type { EntityType, GovernanceEnvelope, Labeled, LabeledDataset, Sensitivity } from './types';

/** Enterprise-wide baseline group every Army planner holds. */
export const BASELINE_GROUP = '/army';

/** Per-record governance overrides (need-to-know). Keyed by record id. */
export const GOVERNANCE_OVERRIDES: Record<string, { aclGroups?: string[]; sensitivity?: Sensitivity }> = {
  // GROUP-ACL beat: restricted to a plans cell — NOT enterprise-visible.
  C4: { aclGroups: ['/army/g8/plans'] },
  // SENSITIVITY beat: enterprise group, but role-gated need-to-know.
  C12: { sensitivity: 'sensitive' },
};

const DEFAULT_SOURCE: Record<EntityType, string> = {
  leader: 'sharepoint:leaders',
  contact: 'sharepoint:contacts',
  event: 'sharepoint:events',
  topic: 'sharepoint:topics',
  message: 'sharepoint:messages',
  engagement: 'sharepoint:engagements',
  afteraction: 'document-intelligence:afteractions',
};

/** Derive the governance envelope for one record. */
export function deriveEnvelope(entityType: EntityType, rec: BaseEntity & { source?: string }): GovernanceEnvelope {
  const override = GOVERNANCE_OVERRIDES[rec.id] ?? {};
  return {
    entityType,
    source: rec.source ?? DEFAULT_SOURCE[entityType],
    aclGroups: override.aclGroups ?? [BASELINE_GROUP],
    sensitivity: override.sensitivity ?? 'unclassified',
  };
}

function label<T extends BaseEntity & { source?: string }>(entityType: EntityType, recs: T[]): Labeled<T>[] {
  return recs.map((r) => ({ ...r, ...deriveEnvelope(entityType, r) }));
}

/** Bake the governance envelope onto every record of a loaded {@link Dataset}. */
export function applyLabels(ds: Dataset): LabeledDataset {
  return {
    today: ds.today,
    leaders: label('leader', ds.leaders),
    contacts: label('contact', ds.contacts),
    events: label('event', ds.events),
    topics: label('topic', ds.topics),
    messages: label('message', ds.messages),
    engagements: label('engagement', ds.engagements),
    afteractions: label('afteraction', ds.afteractions),
    regions: ds.regions, // public gazetteer — no governance envelope needed
  };
}
