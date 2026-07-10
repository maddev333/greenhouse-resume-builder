import test from 'node:test';
import assert from 'node:assert/strict';
import type { GeoPoint } from '@greenhouse-resume-builder/shared';
import { loadDataset } from './seed-loader';
import {
  detectFit,
  detectDoubleBook,
  detectTravelInfeasible,
  detectAvailabilityBudget,
  detectOpportunityCost,
  type Booking,
} from './conflicts';
import type { RouteStop, RoiResult } from './types';

const DC: GeoPoint = { city: 'Washington', lat: 38.9072, lng: -77.0369 };
const LA: GeoPoint = { city: 'Los Angeles', lat: 34.0522, lng: -118.244 };
const ds = loadDataset();
const L1 = ds.leaders.find((l) => l.id === 'L1')!; // non-technical, L4
const L3 = ds.leaders.find((l) => l.id === 'L3')!; // technical, L3
const C1 = ds.contacts.find((c) => c.id === 'C1')!; // non-technical, L4

test('detectFit: domain mismatch is a single SOFT flag', () => {
  const flags = detectFit(L3, C1); // technical leader → non-technical contact
  assert.equal(flags.length, 1);
  assert.equal(flags[0].type, 'fit');
  assert.equal(flags[0].severity, 'soft');
});

test('detectFit: matched domain & level → no flag', () => {
  assert.deepEqual(detectFit(L1, C1), []);
});

test('detectDoubleBook: overlapping bookings conflict; adjacent do not', () => {
  const overlap: Booking[] = [
    { id: 'a', start: '2025-10-12T09:00:00Z', end: '2025-10-12T10:00:00Z' },
    { id: 'b', start: '2025-10-12T09:30:00Z', end: '2025-10-12T10:30:00Z' },
  ];
  const adjacent: Booking[] = [
    { id: 'a', start: '2025-10-12T09:00:00Z', end: '2025-10-12T10:00:00Z' },
    { id: 'b', start: '2025-10-12T10:00:00Z', end: '2025-10-12T11:00:00Z' },
  ];
  const c = detectDoubleBook(overlap);
  assert.equal(c.length, 1);
  assert.equal(c[0].severity, 'hard');
  assert.equal(detectDoubleBook(adjacent).length, 0);
});

test('detectTravelInfeasible: DC 09:00 → LA 10:00 same day is impossible; next-day is fine', () => {
  const tight: RouteStop[] = [
    { id: 'dc', location: DC, kind: 'off-site', depart: '2025-10-12T09:00:00Z' },
    { id: 'la', location: LA, kind: 'off-site', arrive: '2025-10-12T10:00:00Z' },
  ];
  const roomy: RouteStop[] = [
    { id: 'dc', location: DC, kind: 'off-site', depart: '2025-10-12T09:00:00Z' },
    { id: 'la', location: LA, kind: 'off-site', arrive: '2025-10-13T09:00:00Z' },
  ];
  const c = detectTravelInfeasible(tight);
  assert.equal(c.length, 1);
  assert.equal(c[0].type, 'travel-infeasible');
  assert.equal(c[0].severity, 'hard');
  assert.equal(detectTravelInfeasible(roomy).length, 0);
});

test('detectAvailabilityBudget: in-window & under budget → clean', () => {
  const c = detectAvailabilityBudget(L1, { start: '2025-10-12', end: '2025-10-15' }, 3);
  assert.deepEqual(c, []);
});

test('detectAvailabilityBudget: over budget flags a hard conflict', () => {
  const c = detectAvailabilityBudget(L1, { start: '2025-10-12', end: '2025-10-15' }, 15);
  assert.equal(c.length, 1);
  assert.equal(c[0].severity, 'hard');
});

test('detectAvailabilityBudget: window outside availability flags a hard conflict', () => {
  const c = detectAvailabilityBudget(L1, { start: '2025-11-01', end: '2025-11-03' }, 2);
  assert.equal(c.length, 1);
});

test('detectOpportunityCost: SOFT only when ROI is below threshold', () => {
  const low: RoiResult = { roiScore: 0.2, breakdown: { grossValue: 0.8, airfare: 0.35, perDiem: 0.15, timePenalty: 0.1, totalCost: 0.6 }, days: 1, overBudget: false };
  const high: RoiResult = { ...low, roiScore: 0.9 };
  const c = detectOpportunityCost(low);
  assert.equal(c.length, 1);
  assert.equal(c[0].severity, 'soft');
  assert.equal(detectOpportunityCost(high).length, 0);
});
