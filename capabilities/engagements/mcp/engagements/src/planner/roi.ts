/**
 * Trip-ROI — the "is this trip worth it?" number the planner shows.
 *   tripRoi = Σ(accepted suggestion scores) − (airfare + perDiem·days + timePenalty·travelHours)
 * All costs are expressed in SCORE-UNITS via tunable weights so gross value and cost are comparable
 * (`weights.ts`). See `engagement-intelligence/MVP-PLAN.md` §5.1.
 */
import { DEFAULT_WEIGHTS, PlannerWeights } from './weights';
import type { RouteLeg, RoiResult } from './types';

/**
 * @param acceptedScores suggestion scores of the stops kept on the trip
 * @param legs the routed legs (air legs drive airfare; total minutes drive the time penalty)
 * @param days trip length in days (drives per-diem and the budget check)
 * @param daysAwayBudget the leader's travel-day budget for the window
 */
export function tripRoi(
  acceptedScores: number[],
  legs: RouteLeg[],
  days: number,
  daysAwayBudget: number,
  w: PlannerWeights = DEFAULT_WEIGHTS,
): RoiResult {
  const grossValue = acceptedScores.reduce((s, x) => s + x, 0);
  const airLegs = legs.filter((l) => l.mode === 'air').length;
  const airfare = airLegs * w.airfarePerAirLeg;
  const perDiem = days * w.perDiemPerDay;
  const travelHours = legs.reduce((s, l) => s + l.estTravelMins, 0) / 60;
  const timePenalty = travelHours * w.timePenaltyPerHour;
  const totalCost = airfare + perDiem + timePenalty;

  return {
    roiScore: grossValue - totalCost,
    breakdown: { grossValue, airfare, perDiem, timePenalty, totalCost },
    days,
    overBudget: days > daysAwayBudget,
  };
}
