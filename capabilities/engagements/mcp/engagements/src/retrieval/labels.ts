/**
 * Provenance labeling policy (ARCHITECTURE §16.3 "one consistent envelope on every record").
 * Derives the `{ entityType, source }` envelope for each record so the staged seed can stay
 * DOMAIN-only. In production these labels ride in the per-source blob; here they are deterministic
 * and tunable in ONE place.
 */
import type { BaseEntity } from "@greenhouse-resume-builder/shared";
import type { Dataset } from "../planner/seed-loader";
import type {
  EntityType,
  RecordEnvelope,
  Labeled,
  LabeledDataset,
} from "./types";

const DEFAULT_SOURCE: Record<EntityType, string> = {
  leader: "sharepoint:leaders",
  contact: "sharepoint:contacts",
  event: "sharepoint:events",
  topic: "sharepoint:topics",
  message: "sharepoint:messages",
  engagement: "sharepoint:engagements",
  afteraction: "document-intelligence:afteractions",
};

/** Derive the provenance envelope for one record. */
export function deriveEnvelope(
  entityType: EntityType,
  rec: BaseEntity & { source?: string },
): RecordEnvelope {
  return {
    entityType,
    source: rec.source ?? DEFAULT_SOURCE[entityType],
  };
}

function label<T extends BaseEntity & { source?: string }>(
  entityType: EntityType,
  recs: T[],
): Labeled<T>[] {
  return recs.map((r) => ({ ...r, ...deriveEnvelope(entityType, r) }));
}

/** Bake the provenance envelope onto every record of a loaded {@link Dataset}. */
export function applyLabels(ds: Dataset): LabeledDataset {
  return {
    today: ds.today,
    leaders: label("leader", ds.leaders),
    contacts: label("contact", ds.contacts),
    events: label("event", ds.events),
    topics: label("topic", ds.topics),
    messages: label("message", ds.messages),
    engagements: label("engagement", ds.engagements),
    afteractions: label("afteraction", ds.afteractions),
    regions: ds.regions, // public gazetteer — no provenance envelope needed
  };
}
