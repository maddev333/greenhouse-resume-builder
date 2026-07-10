/**
 * Planner engine output shapes that are NOT part of the stored domain schema
 * (`@greenhouse-resume-builder/shared`). These are the transient, "show-your-math" results the
 * deterministic engine returns to the capability tools and the chat/map surfaces.
 */
import type { GeoPoint, DateRange, SuggestionKind, SuggestionPlacement } from '@greenhouse-resume-builder/shared';

/** A trip anchor: a known place + date window the leader is already committed to (usually an Event). */
export interface Anchor {
  id: string;
  location: GeoPoint;
  window: DateRange;
  /** Present when the anchor is an Event (drives on-site/attendee/prospect sourcing). */
  eventId?: string;
  /** Topic context used for relevance scoring / optional hard topic filtering. */
  topicIds?: string[];
}

/** The three transparent factors behind a suggestion score. */
export interface ScoreFactors {
  stalenessNorm: number; // 0 (fresh/prospect) … 1 (very stale)
  valueNorm: number; // strategicValue / 5
  topicRelevance: number; // 1.0 topic hit · 0.5 neutral · 0.2 miss
}

/** A soft "fit" signal — never filters a candidate out, only badges it (ARCHITECTURE §6). */
export type FitFlagType = 'domain-mismatch' | 'level-gap';
export interface FitFlag {
  type: FitFlagType;
  detail: string;
}

/** A ranked, tagged candidate stop produced by `suggest()`. */
export interface Candidate {
  contactId: string;
  name: string;
  location: GeoPoint;
  /** Distance from the anchor; 0 for on-site (we meet them at the venue). */
  distanceKm: number;
  placement: SuggestionPlacement; // 'on-site' | 'off-site'
  kind: SuggestionKind; // 're-engage' | 'initiate'
  status: 'active' | 'prospect';
  isStale: boolean;
  strategicValue: number;
  score: number;
  factors: ScoreFactors;
  fitFlags: FitFlag[];
}

/** A trip-feasibility conflict — advisory; the human always decides (ARCHITECTURE §6, MVP-PLAN §4.1). */
export type ConflictType =
  | 'fit'
  | 'double-book'
  | 'travel-infeasible'
  | 'availability-budget'
  | 'opportunity-cost';

export interface Conflict {
  type: ConflictType;
  /** 'soft' = flag-only (fit, opportunity-cost); 'hard' = infeasible unless the human overrides. */
  severity: 'soft' | 'hard';
  stopId?: string;
  message: string;
  recommendation?: string;
}

// ── Routing ──

export interface RouteStop {
  id: string;
  location: GeoPoint;
  kind: SuggestionPlacement;
  /** Optional scheduled window (ISO datetimes) used by travel-infeasibility / double-book checks. */
  arrive?: string;
  depart?: string;
}

export interface RouteLeg {
  fromStopId: string; // '__origin__' for the first leg out of the anchor
  toStopId: string;
  mode: 'air' | 'ground';
  distanceKm: number;
  estTravelMins: number;
}

export interface RouteResult {
  order: RouteStop[];
  legs: RouteLeg[];
  totalKm: number;
  totalTravelMins: number;
}

// ── Trip ROI ──

export interface RoiBreakdown {
  grossValue: number; // Σ accepted suggestion scores
  airfare: number;
  perDiem: number;
  timePenalty: number;
  totalCost: number;
}

export interface RoiResult {
  roiScore: number; // grossValue − totalCost
  breakdown: RoiBreakdown;
  days: number;
  overBudget: boolean;
}
