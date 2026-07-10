/**
 * Retrieval-shim types — the local, zero-cloud stand-in for the Azure AI Search read model
 * (ARCHITECTURE §5.2–5.4). Every stored record carries a GOVERNANCE ENVELOPE the AI Search indexer
 * maps to filterable trim fields; the shim bakes the same envelope in-memory so the identical
 * security trim runs locally now and swaps to a real `$filter` at M4 with no contract change.
 */
import type {
  AfterActionNote,
  Contact,
  EngagementEvent,
  Engagement,
  Leader,
  Message,
  Topic,
} from '@greenhouse-resume-builder/shared';

/** The per-capability index routes on entity kind (one index, many sources — ARCHITECTURE §5.2). */
export type EntityType =
  | 'leader'
  | 'contact'
  | 'event'
  | 'topic'
  | 'message'
  | 'engagement'
  | 'afteraction';

/** Row-level need-to-know classification (role-gated — ARCHITECTURE §5.2/§5.4). */
export type Sensitivity = 'unclassified' | 'sensitive';

/**
 * Governance labels baked onto every record (ARCHITECTURE §16.3). In production these ride in the
 * per-source blob; in the shim `labels.ts` derives them at load time so the seed stays domain-only.
 */
export interface GovernanceEnvelope {
  entityType: EntityType;
  source: string;
  aclGroups: string[]; // group ACL — trimmed via `search.in` (must share ≥1 with the caller)
  sensitivity: Sensitivity; // role-gated need-to-know
}

/** A domain record with its governance envelope baked in. */
export type Labeled<T> = T & GovernanceEnvelope;

/** The minimal projection the security predicate evaluates (mirrors the index's filterable fields). */
export interface Trimmable {
  tenantId: string;
  aclGroups: string[];
  sensitivity: Sensitivity;
  topicIds?: string[];
}

/** The labeled dataset the in-memory index serves. */
export interface LabeledDataset {
  today: string;
  leaders: Labeled<Leader>[];
  contacts: Labeled<Contact>[];
  events: Labeled<EngagementEvent>[];
  topics: Labeled<Topic>[];
  messages: Labeled<Message>[];
  engagements: Labeled<Engagement>[];
  afteractions: Labeled<AfterActionNote>[];
}

/** A trimmed, ranked retrieval result — same shape the M4 AI Search path will return. */
export interface TrimmedResult<T> {
  items: T[];
  /** The exact OData `$filter` that AI Search WOULD evaluate server-side (shown in the demo). */
  filter: string;
  /** How many in-scope records the security trim removed (the "watch a row disappear" beat). */
  redactedCount: number;
}
