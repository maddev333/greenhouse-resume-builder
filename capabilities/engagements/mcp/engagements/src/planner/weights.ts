/**
 * Tunable planner weights (policy-as-data). Every number the engine uses to turn geography and
 * recency into a score or a cost lives here, so the demo can "show its math" and operators can
 * tune behavior without touching logic. Values are in SCORE-UNITS unless noted (suggestion scores
 * are products of three [0,1] factors, so a single strong stop ≈ 1.0).
 *
 * See `engagement-intelligence/ARCHITECTURE.md` §6 and `MVP-PLAN.md` §5.1.
 */
export interface PlannerWeights {
  // ── ETA heuristic (distance → travel minutes) ──
  /** At/under this haversine distance a leg is driven, otherwise flown. */
  groundThresholdMi: number;
  groundSpeedMph: number;
  /** Fixed ground buffer (parking/last-mile), minutes. */
  groundBufferMins: number;
  /** Fixed air overhead before cruise (airport + security), minutes. */
  airFixedMins: number;
  airSpeedMph: number;
  /** Fixed air overhead after cruise (arrival/ground transfer), minutes. */
  airArrivalBufferMins: number;

  // ── Suggestion scoring ──
  /** Days-since-last-interaction that maps to a full staleness of 1.0 (linear, clamped). */
  stalenessSpanDays: number;
  /** Default radius (mi) for "nearby" off-site candidates around a trip anchor. */
  nearbyRadiusMi: number;
  /** |level gap| at/above which the soft "fit" level flag fires. */
  levelGapFlag: number;

  // ── Trip-ROI cost model (score-units) ──
  airfarePerAirLeg: number;
  perDiemPerDay: number;
  timePenaltyPerHour: number;
  /** Trip-ROI below this trips the (soft) opportunity-cost conflict. */
  roiThreshold: number;
}

export const DEFAULT_WEIGHTS: PlannerWeights = {
  groundThresholdMi: 300,
  groundSpeedMph: 55,
  groundBufferMins: 30,
  airFixedMins: 90,
  airSpeedMph: 500,
  airArrivalBufferMins: 60,

  stalenessSpanDays: 360,
  nearbyRadiusMi: 300,
  levelGapFlag: 2,

  airfarePerAirLeg: 0.35,
  perDiemPerDay: 0.05,
  timePenaltyPerHour: 0.02,
  roiThreshold: 0.5,
};
