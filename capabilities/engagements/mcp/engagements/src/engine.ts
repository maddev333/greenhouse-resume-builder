/**
 * Engine adapter — the ONE place the ESM capability bridges into the CommonJS `api/src` engine.
 *
 * `api` is a CommonJS Express app (iisnode/Windows App Service). Its planner + retrieval barrels use
 * `export *`, which Node's ESM loader (cjs-module-lexer) cannot see through for NAMED imports. So we
 * default-import the compiled module namespace (`module.exports`) and destructure the values from it —
 * this reads real runtime properties and is immune to the lexer limitation. Types are pulled via
 * `typeof import(...)` (a type-only position, fully erased) so every re-export stays strongly typed.
 *
 * Everything else in this capability imports the engine ONLY from here, so the interop lives in one file.
 */

import * as plannerNs from './planner/index.js';
import * as retrievalNs from './retrieval/index.js';

type PlannerNs = typeof import('./planner/index.js');
type RetrievalNs = typeof import('./retrieval/index.js');

const planner = plannerNs as unknown as PlannerNs;
const retrieval = retrievalNs as unknown as RetrievalNs;

// ── Planner engine (values) ──────────────────────────────────────────────
export const {
  suggest,
  planRoute,
  ORIGIN_ID,
  tripRoi,
  detectFit,
  detectDoubleBook,
  detectTravelInfeasible,
  detectAvailabilityBudget,
  detectOpportunityCost,
  loadDataset,
  anchorFromEvent,
  demoToday,
  loadConfig,
  isStale,
  staleCutoff,
  daysBetween,
  addDays,
  DEFAULT_WEIGHTS,
  SEED_DIR,
} = planner;

// ── Retrieval shim + security trim (values) ──────────────────────────────
export const {
  EngagementIndex,
  buildEngagementSecurityFilter,
  canReadSensitive,
  odataEscapeLiteral,
  PERSONAS,
  applyLabels,
  // Azure AI Search backend (M4) — the cloud swap-in behind the SAME TrimmedResult contract.
  isSearchConfigured,
  ensureEngagementIndex,
  syncEngagementDocs,
  upsertEngagementContact,
  upsertEngagementEvent,
  deleteEngagementDoc,
  searchEngagementContacts,
  searchEngagementEvents,
} = retrieval;

// ── Planner engine (types) ───────────────────────────────────────────────
export type {
  Anchor,
  Candidate,
  Conflict,
  ConflictType,
  FitFlag,
  RouteResult,
  RouteStop,
  RouteLeg,
  RoiResult,
  ScoreFactors,
} from './planner/types.js';
export type { Dataset } from './planner/seed-loader.js';
export type { PlannerWeights } from './planner/weights.js';

// ── Retrieval shim + security trim (types) ───────────────────────────────
export type {
  SecurityContext,
  SecurityDecision,
  RetrievalNarrowing,
} from './retrieval/security.js';
export type {
  ContactQuery,
  EventQuery,
} from './retrieval/retrieval-index.js';
export type {
  TrimmedResult,
  Labeled,
  LabeledDataset,
  EntityType,
  Sensitivity,
} from './retrieval/types.js';
export type { PersonaName } from './retrieval/personas.js';

// ── Canonical domain schema (types) — one source, re-exported for the tools ──
export type {
  Leader,
  Contact,
  EngagementEvent,
  Topic,
  Preferences,
  GeoPoint,
  DateRange,
} from '@greenhouse-resume-builder/shared';
