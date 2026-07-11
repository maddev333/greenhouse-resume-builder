import test from 'node:test';
import assert from 'node:assert/strict';
import { tripRoi } from './roi';
import { ORIGIN_ID } from './route';
import type { RouteLeg } from './types';

const airLeg: RouteLeg = {
  fromStopId: ORIGIN_ID,
  toStopId: 'la',
  mode: 'air',
  distanceKm: 3690,
  estTravelMins: 427,
};
const groundLeg: RouteLeg = {
  fromStopId: ORIGIN_ID,
  toStopId: 'reston',
  mode: 'ground',
  distanceKm: 28,
  estTravelMins: 49,
};

const approx = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('tripRoi = Σscores − (airfare + perDiem·days + timePenalty·hours)', () => {
  const r = tripRoi([0.8, 0.72], [airLeg], 3, 10);
  approx(r.breakdown.grossValue, 1.52);
  approx(r.breakdown.airfare, 0.35); // 1 air leg × 0.35
  approx(r.breakdown.perDiem, 0.15); // 3 days × 0.05
  approx(r.breakdown.timePenalty, (427 / 60) * 0.02);
  approx(r.breakdown.totalCost, 0.35 + 0.15 + (427 / 60) * 0.02);
  approx(r.roiScore, 1.52 - (0.35 + 0.15 + (427 / 60) * 0.02));
  assert.equal(r.overBudget, false);
});

test('tripRoi: ground-only legs incur no airfare', () => {
  const r = tripRoi([0.5], [groundLeg], 1, 10);
  approx(r.breakdown.airfare, 0);
});

test('tripRoi: days over the leader budget sets overBudget', () => {
  const r = tripRoi([0.8], [airLeg], 15, 10);
  assert.equal(r.overBudget, true);
});

test('tripRoi: no accepted stops → zero gross value', () => {
  const r = tripRoi([], [], 1, 10);
  approx(r.breakdown.grossValue, 0);
  approx(r.breakdown.airfare, 0);
});
