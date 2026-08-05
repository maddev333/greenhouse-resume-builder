/**
 * Retrieval-shim types — the local, zero-cloud stand-in for the Azure AI Search read model
 * (ARCHITECTURE §5.2). Every stored record carries a PROVENANCE ENVELOPE the AI Search indexer
 * maps to filterable fields; the shim bakes the same envelope in-memory so the identical recall
 * runs locally now and swaps to the cloud backend at M4 with no contract change.
 */
import type {
  AfterActionNote,
  Contact,
  EngagementEvent,
  Engagement,
  Leader,
  Message,
  Region,
  Topic,
} from "@greenhouse-resume-builder/shared";

/** The per-capability index routes on entity kind (one index, many sources — ARCHITECTURE §5.2). */
export type EntityType =
  | "leader"
  | "contact"
  | "event"
  | "topic"
  | "message"
  | "engagement"
  | "afteraction";

/**
 * Provenance labels baked onto every record (ARCHITECTURE §16.3). In production these ride in the
 * per-source blob; in the shim `labels.ts` derives them at load time so the seed stays domain-only.
 */
export interface RecordEnvelope {
  entityType: EntityType;
  source: string;
}

/** A domain record with its provenance envelope baked in. */
export type Labeled<T> = T & RecordEnvelope;

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
  /** Static geo gazetteer for area-first planning — public reference data. */
  regions: Region[];
}
