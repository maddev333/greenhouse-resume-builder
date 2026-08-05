/**
 * Seed loader — reads the staged `engagement-intelligence/seed/*.json` (domain-only records),
 * applies the uniform demo-clock month-shift to every date, and bakes in the loader envelope
 * (`createdAt`) so records satisfy the shared domain types. This stands in for the
 * ETL we skip in the MVP; the same typed dataset later feeds the Blob writer + AI Search indexers.
 *
 * IO is confined to this module (via `fs`) so the rest of the engine stays pure and deterministic.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AfterActionNote,
  Contact,
  DateRange,
  EngagementEvent,
  Engagement,
  Leader,
  Message,
  Region,
  Topic,
} from "@greenhouse-resume-builder/shared";
import { SEED_DIR } from "./paths";
import { loadConfig, demoToday, shiftDateByMonths, DemoConfig } from "./clock";
import type { Anchor } from "./types";

export interface Dataset {
  cfg: DemoConfig;
  today: string;
  topics: Topic[];
  messages: Message[];
  leaders: Leader[];
  contacts: Contact[];
  events: EngagementEvent[];
  engagements: Engagement[];
  afteractions: AfterActionNote[];
  regions: Region[];
}

export interface LoadOptions {
  seedDir?: string;
}

function readJson<T = unknown>(dir: string, file: string): T[] {
  return JSON.parse(readFileSync(join(dir, file), "utf8")) as T[];
}

/** Like {@link readJson} but returns `[]` when the file is absent (optional reference data). */
function readJsonSafe<T = unknown>(dir: string, file: string): T[] {
  try {
    return readJson<T>(dir, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Load the full staged dataset, clock-shifted and envelope-baked. */
export function loadDataset(opts: LoadOptions = {}): Dataset {
  const dir = opts.seedDir ?? SEED_DIR;
  const cfg = loadConfig();
  const shift = cfg.shiftMonths || 0;
  const today = demoToday(cfg);
  const sh = (iso?: string): string | undefined =>
    iso ? shiftDateByMonths(iso, shift) : iso;
  const shRange = (r: DateRange): DateRange => ({
    start: shiftDateByMonths(r.start, shift),
    end: shiftDateByMonths(r.end, shift),
  });
  const envelope = { createdAt: today };

  const topics = readJson<Topic>(dir, "topics.json").map((t) => ({
    ...envelope,
    ...t,
  }));

  const messages = readJson<Message>(dir, "messages.json").map((m) => ({
    ...envelope,
    ...m,
    effectiveFrom: sh(m.effectiveFrom),
  }));

  const leaders = readJson<Leader>(dir, "leaders.json").map((l) => ({
    ...envelope,
    ...l,
    availability: (l.availability ?? []).map(shRange),
  }));

  const contacts = readJson<Contact>(dir, "contacts.json").map((c) => ({
    ...envelope,
    ...c,
    lastInteractionDate: sh(c.lastInteractionDate),
  }));

  const events = readJson<EngagementEvent>(dir, "events.json").map((e) => ({
    ...envelope,
    ...e,
    start: shiftDateByMonths(e.start, shift),
    end: shiftDateByMonths(e.end, shift),
  }));

  const engagements = readJson<Engagement>(dir, "engagements.json").map(
    (g) => ({
      ...envelope,
      ...g,
      date: shiftDateByMonths(g.date, shift),
    }),
  );

  const afteractions = readJson<AfterActionNote>(dir, "afteractions.json").map(
    (a) => ({
      ...envelope,
      ...a,
    }),
  );

  // Regions are static reference data (pre-resolved centroids) — no date shift needed.
  const regions = readJsonSafe<Region>(dir, "regions.json").map((r) => ({
    ...envelope,
    ...r,
  }));

  return {
    cfg,
    today,
    topics,
    messages,
    leaders,
    contacts,
    events,
    engagements,
    afteractions,
    regions,
  };
}

/** Build a trip anchor from an event (its venue + window + topics). */
export function anchorFromEvent(event: EngagementEvent): Anchor {
  return {
    id: event.id,
    eventId: event.id,
    location: event.location,
    window: { start: event.start, end: event.end },
    topicIds: event.topicIds,
  };
}
