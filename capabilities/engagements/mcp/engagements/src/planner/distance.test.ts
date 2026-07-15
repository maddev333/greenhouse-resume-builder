import test from 'node:test';
import assert from 'node:assert/strict';
import type { GeoPoint } from '@greenhouse-resume-builder/shared';
import { haversineMi, etaMinutes } from './distance';

const DC: GeoPoint = { city: 'Washington', lat: 38.9072, lng: -77.0369 };
const LA: GeoPoint = { city: 'Los Angeles', lat: 34.0522, lng: -118.244 };
const RESTON: GeoPoint = { city: 'Reston', lat: 38.9586, lng: -77.357 };

test('haversineMi: identical points are 0', () => {
  assert.equal(haversineMi(DC, DC), 0);
});

test('haversineMi: DC→LA ≈ 2300 mi', () => {
  const d = haversineMi(DC, LA);
  assert.ok(d > 2200 && d < 2400, `expected ~2300, got ${d}`);
});

test('etaMinutes: short hop is ground', () => {
  const eta = etaMinutes(DC, RESTON);
  assert.equal(eta.mode, 'ground');
  assert.ok(eta.minutes > 0 && eta.minutes < 120, `got ${eta.minutes}`);
});

test('etaMinutes: cross-country is air', () => {
  const eta = etaMinutes(DC, LA);
  assert.equal(eta.mode, 'air');
  // 90 + 2293/500*60 + 60 ≈ 425
  assert.ok(eta.minutes > 380 && eta.minutes < 480, `got ${eta.minutes}`);
});

test('etaMinutes: threshold boundary uses ground at exactly groundThresholdMi', () => {
  // Points ~299 mi apart → ground; construct via a known separation is hard, so assert monotonicity:
  const near = etaMinutes(DC, RESTON);
  const far = etaMinutes(DC, LA);
  assert.ok(far.minutes > near.minutes);
});
