/**
 * Strategic Engagements Travel Planner — CANONICAL TARGET SCHEMA
 * =============================================================
 *
 * This is "the schema we would ETL to." For the MVP we skip live extraction from the
 * real sources (SharePoint lists, the SharePoint Kanban, the PowerPoint "calendar",
 * and Outlook) and instead stage synthetic, already-conformed records that match these
 * shapes (see the sibling `*.json` files and `README.md`).
 *
 * Framework-free on purpose: on Platform Day-1 this file drops straight into
 * `shared/src/`; each entity is stored as per-source JSON blobs in Blob Storage
 * (source of record) and indexed into one Azure AI Search index — no Postgres.
 *
 * ENVELOPE NOTE: each record carries an envelope the AI Search indexer maps to
 * filterable trim fields — `tenantId`, `source`, `aclGroups[]`, `sensitivity`
 * (plus `createdAt`/`updatedAt`) — baked into the blob (no separate relational loader).
 * The staged `*.json` here still carry only DOMAIN fields; the Day-1 data task bakes in
 * the envelope and writes one blob per record per source (see README.md).
 */

// ── Shared scalars ──────────────────────────────────────────────────────

export type Domain = 'technical' | 'non-technical';
export type Level = 'L1' | 'L2' | 'L3' | 'L4';

/** Pre-geocoded point. `lat/lng` are populated at ETL time by the Azure Maps geocoder. */
export interface GeoPoint {
  city: string;
  state?: string;
  lat: number;
  lng: number;
}

/** Inclusive ISO-8601 date range (YYYY-MM-DD). */
export interface DateRange {
  start: string;
  end: string;
}

/** Loader-applied envelope (NOT present in the staged JSON). */
export interface BaseEntity {
  id: string;
  tenantId: string;
  createdAt: string; // ISO-8601
  updatedAt?: string; // ISO-8601
}

// ── CRM spine ───────────────────────────────────────────────────────────

/** Trip purpose / subject each engagement is anchored to. */
export interface Topic extends BaseEntity {
  name: string;
  description?: string;
  domain: Domain; // technical vs non-technical → drives the soft "fit" flag
  smeAreas: string[];
  ownerOrg?: string;
  /** The currently-approved message for this topic (null when none is approved yet). */
  approvedMessageId?: string | null;
}

/** Centrally-approved, per-topic talking points (versioned) that MUST be conveyed. */
export interface Message extends BaseEntity {
  topicId: string;
  version: number;
  status: 'draft' | 'approved';
  intendedPoints: string[];
  effectiveFrom?: string; // ISO date
  approvedBy?: string;
}

/** Pool A — a senior leader whose time we are allocating. */
export interface Leader extends BaseEntity {
  name: string;
  role: string; // echelon / billet
  domain: Domain;
  smeAreas: string[];
  level: Level;
  homeBase: GeoPoint;
  availability: DateRange[];
  daysAwayBudget: number; // max travel-days in the planning window
}

/**
 * Pool B — a person/company/org we engage.
 * `status: 'prospect'` = a NEW company we've never engaged (no `lastInteractionDate`);
 * scored by topic-fit for the "initiate" path instead of by staleness.
 */
export interface Contact extends BaseEntity {
  name: string;
  type: 'individual' | 'company' | 'org';
  org?: string;
  domain: Domain;
  smeAreas: string[];
  topicIds: string[]; // topics of interest / relevance
  level?: Level; // present for active contacts; optional for prospects
  location: GeoPoint;
  relationshipOwnerLeaderIds: string[];
  strategicValue: number; // 1–5 (5 = enterprise priority)
  status: 'active' | 'prospect';
  source?: string; // provenance, e.g. 'sharepoint:contacts' | 'exhibitor-directory:ausa-2026'
  lastInteractionDate?: string; // ISO date; ABSENT for prospects
  /**
   * DERIVED labels (projection-computed from Interactions × CadencePolicy — NOT authored;
   * recomputed on reindex, so agents stay stateless). `nextEligibleDate` = lastInteractionDate +
   * cooldownDays: the contacts agent suppresses or down-ranks a contact until this date, so a
   * just-held meeting isn't re-recommended (see ARCHITECTURE.md §16.4).
   */
  nextEligibleDate?: string; // ISO date; derived
}

/** A travel anchor AND an attendee/exhibitor magnet (people/prospects gather here). */
export interface Event extends BaseEntity {
  name: string;
  type: 'conference' | 'convention' | 'function';
  location: GeoPoint;
  start: string; // ISO date
  end: string; // ISO date
  topicIds: string[]; // topics present
  targetAttendeeProfile?: string;
  attendingContactIds: string[]; // existing contacts on-site → engage at ~zero travel
  exhibitorProspectIds: string[]; // new companies → "initiate" (want intros?)
  scale?: { attendees?: number; exhibitors?: number; countries?: number };
}

/** A meeting/interaction (past or planned). Establishes history for the pre-brief. */
export interface Engagement extends BaseEntity {
  contactId: string;
  leaderIds: string[];
  topicId?: string;
  intendedMessageId?: string; // snapshot of the approved message governing this meeting
  date: string; // ISO date (held date or window start)
  location?: GeoPoint;
  status: 'scheduled' | 'held' | 'followup';
  tripId?: string;
  anchorEventId?: string;
  summary?: string;
  outstandingAsks?: string[];
  commitments?: string[];
  afterActionNoteIds?: string[];
  messageConveyedScore?: number;
}

/** Ingested (or pre-extracted) after-action notes → drive the message-consistency check. */
export interface AfterActionNote extends BaseEntity {
  engagementId: string;
  sourceDocRef?: string; // path to the source PDF artifact, when one exists
  extractedSummary: string;
  actualMessagePoints: string[];
  commitments?: string[];
  sentiment?: string;
  /** 'document-intelligence' when parsed live; 'seed' when pre-extracted (demo fallback). */
  ingestedVia?: 'document-intelligence' | 'seed';
}

// ── Recency & cadence (scale: stateless agents, state as labels — ARCHITECTURE.md §16) ──

/**
 * Append-only INTERACTION event — the canonical recency signal.
 * One immutable record per touch (meeting/call/email/event-touch), landed from Outlook/Kanban.
 * Unlike `Engagement` (a rich meeting record with message + after-action linkage), an Interaction
 * is minimal and NEVER mutated; a projection step rolls the latest ones up into the derived
 * `Contact.lastInteractionDate` / `Contact.nextEligibleDate` labels that drive the cooldown
 * (ARCHITECTURE.md §16.4). In the demo these can be projected from held Engagements.
 */
export interface Interaction extends BaseEntity {
  contactId: string;
  leaderIds: string[];
  topicId?: string;
  occurredAt: string; // ISO date/datetime — immutable
  kind: 'meeting' | 'call' | 'email' | 'event-touch';
  outcome?: string;
  engagementId?: string; // link back when this touch corresponds to a full Engagement
}

/**
 * Tunable cooldown policy (policy-as-data) — how long to wait before re-recommending a contact.
 * Stored as its own `policy` source so cadence is a DATA edit, not a deploy. The projection picks
 * the most specific matching rule (topicId > contactType > minStrategicValue) and computes
 * `Contact.nextEligibleDate = lastInteractionDate + cooldownDays` (ARCHITECTURE.md §16.4).
 */
export interface CadencePolicy extends BaseEntity {
  appliesTo: {
    minStrategicValue?: number; // e.g. 5
    contactType?: 'individual' | 'company' | 'org';
    topicId?: string;
  };
  cooldownDays: number; // e.g. value-5 → 90, value-2 → 270
  description?: string;
}

// ── Planner core (RUNTIME-PRODUCED — not seeded) ─────────────────────────
// The planner engine emits these at demo time; they are defined here for completeness.

export interface Trip extends BaseEntity {
  leaderId: string;
  purpose: string;
  region?: string;
  window: DateRange;
  homeBase: GeoPoint;
  anchorEventId?: string;
  stopIds: string[];
  legIds: string[];
  estCost?: number;
  roiScore?: number;
  status: 'draft' | 'proposed' | 'approved' | 'complete';
}

export interface Stop {
  id: string;
  tripId: string;
  refType: 'engagement' | 'event' | 'contact';
  refId: string;
  kind: 'on-site' | 'off-site'; // on-site = at the event venue (no travel leg)
  location: GeoPoint;
  arrive?: string;
  depart?: string;
  dwellMins?: number;
  preBriefId?: string;
}

export interface Leg {
  id: string;
  tripId: string;
  fromStopId: string;
  toStopId: string;
  mode: 'air' | 'ground';
  distanceKm: number;
  estTravelMins: number;
  cost?: number;
}

// ── Suggestion tagging (engine output shape, for reference) ──────────────

export type SuggestionKind = 're-engage' | 'initiate';
export type SuggestionPlacement = 'on-site' | 'off-site';
