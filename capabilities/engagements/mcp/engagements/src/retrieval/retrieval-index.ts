/**
 * In-memory engagements index — the zero-cloud stand-in for the Azure AI Search read model
 * (ARCHITECTURE §5.2). It loads the staged seed, bakes the provenance envelope, and answers
 * `search_*` queries the way the real capability will: **recall, then preference-narrowing**.
 * Recall is structured/substring here (no embeddings locally); the result shape is identical to the
 * cloud path.
 */
import type {
  Contact,
  EngagementEvent,
  Preferences,
} from "@greenhouse-resume-builder/shared";
import { loadDataset, type LoadOptions } from "../planner/seed-loader";
import { applyLabels } from "./labels";
import type { Labeled, LabeledDataset } from "./types";

export interface ContactQuery {
  /** Free-text recall over name/org/SME (a keyword stand-in for hybrid search). */
  query?: string;
  /** Structured topic recall (topic ∩). */
  topicIds?: string[];
  status?: "active" | "prospect";
  /** Caller preferences — NARROW/RANK only. */
  preferences?: Preferences;
}

export interface EventQuery {
  query?: string;
  topicIds?: string[];
}

const contactHaystack = (c: Contact): string =>
  [
    c.name,
    c.org ?? "",
    ...(c.smeAreas ?? []),
    c.location.city,
    c.location.state ?? "",
  ]
    .join(" ")
    .toLowerCase();

const eventHaystack = (e: EngagementEvent): string =>
  [e.id, e.name, e.location.city, e.location.state ?? ""]
    .join(" ")
    .toLowerCase();

/** Preference narrowing — drops out-of-policy candidates. */
function narrowByPreferences<T extends { id: string; strategicValue: number }>(
  items: T[],
  prefs: Preferences,
): T[] {
  let out = items;
  if (prefs.doNotMeet?.length)
    out = out.filter((c) => !prefs.doNotMeet!.includes(c.id));
  if (typeof prefs.seniorityFloor === "number")
    out = out.filter((c) => c.strategicValue >= prefs.seniorityFloor!);
  return out;
}

export class EngagementIndex {
  constructor(private readonly data: LabeledDataset) {}

  /** Load + label the staged seed into an index. */
  static load(opts: LoadOptions = {}): EngagementIndex {
    return new EngagementIndex(applyLabels(loadDataset(opts)));
  }

  get today(): string {
    return this.data.today;
  }

  /** The full labeled dataset (for engine steps that need the raw records). */
  get labeled(): LabeledDataset {
    return this.data;
  }

  /**
   * Return contacts matching recall + preference narrowing.
   * With no `query`/`topicIds`/`status`, returns EVERY contact — the set the planner's
   * `suggest()` then scores.
   */
  searchContacts(q: ContactQuery): Labeled<Contact>[] {
    let recall = this.data.contacts;
    if (q.status) recall = recall.filter((c) => c.status === q.status);
    if (q.topicIds?.length)
      recall = recall.filter((c) =>
        (c.topicIds ?? []).some((t) => q.topicIds!.includes(t)),
      );
    if (q.query) {
      const needle = q.query.toLowerCase();
      recall = recall.filter((c) => contactHaystack(c).includes(needle));
    }

    return q.preferences ? narrowByPreferences(recall, q.preferences) : recall;
  }

  /** Return events, optionally matched by text/topic. */
  searchEvents(q: EventQuery): Labeled<EngagementEvent>[] {
    let recall = this.data.events;
    if (q.topicIds?.length)
      recall = recall.filter((e) =>
        e.topicIds.some((t) => q.topicIds!.includes(t)),
      );
    if (q.query) {
      const needle = q.query.toLowerCase();
      recall = recall.filter((e) => eventHaystack(e).includes(needle));
    }

    return recall;
  }

  /** Resolve a free-text anchor ("AUSA") to a single event (best/first match), if any. */
  findEvent(text: string): Labeled<EngagementEvent> | undefined {
    return this.searchEvents({ query: text })[0];
  }
}
