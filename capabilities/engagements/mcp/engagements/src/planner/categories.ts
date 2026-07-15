/**
 * Engagement CATEGORY coverage — the "are we engaging across the board?" layer that sits on top of the
 * area survey. Given a geographic area (centroid + radius) and the already-authorized contacts, it rolls
 * every in-area engagement up into the four strategic audiences an Army leader balances on one trip —
 * Congressional, Academia, Industry, Army-internal (plus a catch-all `other`) — and reports, per audience:
 * who's here, how many are stale/prospect, the strategic weight, and how many are actually on the
 * itinerary options (so a COVERAGE GAP — e.g. "no Congressional engagement on this trip" — is visible).
 *
 * Pure + deterministic (the security trim runs upstream, so this only ever sees records the caller may
 * read). It complements {@link topicsInArea} (WHICH topics are hot) and {@link staleContactsInArea} (WHICH
 * specific relationships are overdue): this answers WHICH AUDIENCES a trip's options reach, and why.
 */
import type { Contact, EngagementCategory, GeoPoint, Sector } from '@greenhouse-resume-builder/shared';
import { CATEGORY_LABEL, ENGAGEMENT_CATEGORIES, categoryForSector } from '@greenhouse-resume-builder/shared';
import { haversineMi } from './distance';
import { isStale, loadConfig, DemoConfig } from './clock';

/** A single in-area engagement, tagged with its audience + whether it landed on an itinerary option. */
export interface CategoryContactRef {
  contactId: string;
  name: string;
  org?: string;
  sector?: Sector;
  city?: string;
  distanceMi: number;
  strategicValue: number;
  status: 'active' | 'prospect';
  isStale: boolean;
  /** True when this engagement appears on at least one duration/extension option. */
  onItinerary: boolean;
}

/** Per-audience coverage: who's in the area, and how much of it the trip's options actually reach. */
export interface CategoryCoverage {
  category: EngagementCategory;
  label: string;
  total: number;
  activeCount: number;
  prospectCount: number;
  staleCount: number;
  strategicValueSum: number;
  /** How many of this audience's in-area engagements are on at least one itinerary/extension option. */
  onItineraryCount: number;
  /** Whether the trip's options touch this audience at all (a coverage GAP when false but `total > 0`). */
  covered: boolean;
  /** EVERY in-area contact id for this audience (report order), so a caller can build a single-audience itinerary. */
  contactIds: string[];
  /** Up to `topN` representative engagements, most stale → most strategic first. */
  contacts: CategoryContactRef[];
  /** One-line "who's here / where the gap is" summary. */
  reason: string;
}

export interface CategoryBreakdownInput {
  centroid: GeoPoint;
  radiusMi: number;
  /** Security-trimmed contacts (only records the caller may read). */
  contacts: Contact[];
  /** Contact ids that appear on at least one itinerary/extension option (drives coverage + gaps). */
  itineraryContactIds?: Iterable<string>;
  /** Cap on representative contacts listed per audience (default 3). */
  topN?: number;
  cfg?: DemoConfig;
}

function coverageReason(
  category: EngagementCategory,
  total: number,
  staleCount: number,
  prospectCount: number,
  onItineraryCount: number,
  itineraryKnown: boolean,
): string {
  if (total === 0) return `no ${CATEGORY_LABEL[category]} engagements identified in this area`;
  const parts = [`${total} engagement${total > 1 ? 's' : ''}`];
  if (staleCount) parts.push(`${staleCount} stale (re-engage)`);
  if (prospectCount) parts.push(`${prospectCount} prospect${prospectCount > 1 ? 's' : ''}`);
  if (itineraryKnown) {
    parts.push(onItineraryCount > 0 ? `${onItineraryCount} on the itinerary` : 'none on the itinerary yet — coverage gap');
  }
  return parts.join(' · ');
}

/**
 * Roll the caller's in-area engagements up into the four target audiences (+ `other`) and report each
 * audience's footprint and itinerary coverage. The four TARGET audiences are ALWAYS emitted — even at
 * zero — so a gap ("no Congressional engagement here") is explicit; `other` is emitted only when present.
 * Ordered per {@link ENGAGEMENT_CATEGORIES}.
 */
export function categoryBreakdown(input: CategoryBreakdownInput): CategoryCoverage[] {
  const cfg = input.cfg ?? loadConfig();
  const topN = input.topN ?? 3;
  const onTrip = new Set<string>(input.itineraryContactIds ?? []);
  const itineraryKnown = onTrip.size > 0;

  const buckets = new Map<EngagementCategory, CategoryContactRef[]>();
  for (const cat of ENGAGEMENT_CATEGORIES) buckets.set(cat, []);

  for (const c of input.contacts) {
    const distanceMi = haversineMi(input.centroid, c.location);
    if (distanceMi > input.radiusMi) continue;
    const cat = categoryForSector(c.sector);
    const stale = c.status === 'active' && isStale(c.lastInteractionDate, cfg);
    buckets.get(cat)!.push({
      contactId: c.id,
      name: c.name,
      org: c.org,
      sector: c.sector,
      city: c.location.city,
      distanceMi: Math.round(distanceMi),
      strategicValue: c.strategicValue ?? 0,
      status: c.status,
      isStale: stale,
      onItinerary: onTrip.has(c.id),
    });
  }

  const out: CategoryCoverage[] = [];
  for (const cat of ENGAGEMENT_CATEGORIES) {
    const refs = buckets.get(cat)!;
    if (cat === 'other' && refs.length === 0) continue; // target audiences always shown; `other` only if present
    refs.sort(
      (a, b) =>
        Number(b.isStale) - Number(a.isStale) ||
        b.strategicValue - a.strategicValue ||
        a.contactId.localeCompare(b.contactId),
    );
    const activeCount = refs.filter((r) => r.status === 'active').length;
    const prospectCount = refs.filter((r) => r.status === 'prospect').length;
    const staleCount = refs.filter((r) => r.isStale).length;
    const strategicValueSum = refs.reduce((sum, r) => sum + r.strategicValue, 0);
    const onItineraryCount = refs.filter((r) => r.onItinerary).length;
    out.push({
      category: cat,
      label: CATEGORY_LABEL[cat],
      total: refs.length,
      activeCount,
      prospectCount,
      staleCount,
      strategicValueSum,
      onItineraryCount,
      covered: onItineraryCount > 0,
      contactIds: refs.map((r) => r.contactId),
      contacts: refs.slice(0, topN),
      reason: coverageReason(cat, refs.length, staleCount, prospectCount, onItineraryCount, itineraryKnown),
    });
  }
  return out;
}

/** Count a stop set by audience (drives each itinerary option's "who does it reach" mix). */
export function categoryCountsForStops(
  stops: { contactId: string }[],
  contactsById: Map<string, Contact>,
): Partial<Record<EngagementCategory, number>> {
  const counts: Partial<Record<EngagementCategory, number>> = {};
  for (const s of stops) {
    const cat = categoryForSector(contactsById.get(s.contactId)?.sector);
    counts[cat] = (counts[cat] ?? 0) + 1;
  }
  return counts;
}

/** Render an audience-count map as a compact "Industry×2 · Academia×1" line (report order). */
export function summarizeCategoryCounts(counts: Partial<Record<EngagementCategory, number>>): string {
  const parts = ENGAGEMENT_CATEGORIES.filter((c) => (counts[c] ?? 0) > 0).map(
    (c) => `${CATEGORY_LABEL[c]}×${counts[c]}`,
  );
  return parts.join(' · ');
}
