/**
 * In-memory engagements index — the zero-cloud stand-in for the Azure AI Search read model
 * (ARCHITECTURE §5.2–5.4). It loads the staged seed, bakes the governance envelope, and answers
 * `search_*` queries the way the real capability will: **security-trim first (server-side), then
 * recall, then preference-narrowing** — so authorized data is the ONLY thing that ever leaves the
 * index, exactly as at M4. Recall is structured/substring here (no embeddings locally); the trim
 * contract and result shape are identical to the cloud path.
 */
import type { Contact, EngagementEvent, Preferences } from '@greenhouse-resume-builder/shared';
import { loadDataset, type LoadOptions } from '../planner/seed-loader';
import { applyLabels } from './labels';
import { buildEngagementSecurityFilter, type SecurityContext } from './security';
import type { Labeled, LabeledDataset, TrimmedResult } from './types';

export interface ContactQuery {
  ctx: SecurityContext;
  /** Free-text recall over name/org/SME (a keyword stand-in for hybrid search). */
  query?: string;
  /** Structured topic recall (topic ∩). */
  topicIds?: string[];
  status?: 'active' | 'prospect';
  /** Caller preferences — NARROW/RANK only; never widen the security trim (§5.4). */
  preferences?: Preferences;
}

export interface EventQuery {
  ctx: SecurityContext;
  query?: string;
  topicIds?: string[];
}

const REJECTED = (reason: string): TrimmedResult<never> => ({
  items: [],
  filter: `(rejected: ${reason})`,
  redactedCount: 0,
});

const contactHaystack = (c: Contact): string =>
  [c.name, c.org ?? '', ...(c.smeAreas ?? []), c.location.city, c.location.state ?? '']
    .join(' ')
    .toLowerCase();

const eventHaystack = (e: EngagementEvent): string =>
  [e.id, e.name, e.location.city, e.location.state ?? ''].join(' ').toLowerCase();

/** Preference narrowing — drops out-of-policy candidates. NEVER adds any (cannot widen the trim). */
function narrowByPreferences<T extends { id: string; strategicValue: number }>(
  items: T[],
  prefs: Preferences,
): T[] {
  let out = items;
  if (prefs.doNotMeet?.length) out = out.filter((c) => !prefs.doNotMeet!.includes(c.id));
  if (typeof prefs.seniorityFloor === 'number') out = out.filter((c) => c.strategicValue >= prefs.seniorityFloor!);
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

  /** The full labeled dataset (for engine steps that need already-authorized records). */
  get labeled(): LabeledDataset {
    return this.data;
  }

  /**
   * Return contacts the caller is authorized to see, after recall + preference narrowing.
   * With no `query`/`topicIds`/`status`, returns EVERY authorized contact — the set the planner's
   * `suggest()` then scores (proving the trim runs BEFORE any scoring).
   */
  searchContacts(q: ContactQuery): TrimmedResult<Labeled<Contact>> {
    const decision = buildEngagementSecurityFilter(q.ctx);
    if (!decision.allowed) return REJECTED(decision.reason ?? 'unauthorized');

    let recall = this.data.contacts;
    if (q.status) recall = recall.filter((c) => c.status === q.status);
    if (q.topicIds?.length) recall = recall.filter((c) => (c.topicIds ?? []).some((t) => q.topicIds!.includes(t)));
    if (q.query) {
      const needle = q.query.toLowerCase();
      recall = recall.filter((c) => contactHaystack(c).includes(needle));
    }

    const authorized = recall.filter(decision.predicate);
    const redactedCount = recall.length - authorized.length;
    const items = q.preferences ? narrowByPreferences(authorized, q.preferences) : authorized;
    return { items, filter: decision.filter!, redactedCount };
  }

  /** Return authorized events (baseline-visible), optionally matched by text/topic. */
  searchEvents(q: EventQuery): TrimmedResult<Labeled<EngagementEvent>> {
    const decision = buildEngagementSecurityFilter(q.ctx);
    if (!decision.allowed) return REJECTED(decision.reason ?? 'unauthorized');

    let recall = this.data.events;
    if (q.topicIds?.length) recall = recall.filter((e) => e.topicIds.some((t) => q.topicIds!.includes(t)));
    if (q.query) {
      const needle = q.query.toLowerCase();
      recall = recall.filter((e) => eventHaystack(e).includes(needle));
    }

    const authorized = recall.filter(decision.predicate);
    return { items: authorized, filter: decision.filter!, redactedCount: recall.length - authorized.length };
  }

  /** Resolve a free-text anchor ("AUSA") to a single authorized event (best/first match), if any. */
  findEvent(ctx: SecurityContext, text: string): Labeled<EngagementEvent> | undefined {
    return this.searchEvents({ ctx, query: text }).items[0];
  }
}
