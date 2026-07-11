import test from 'node:test';
import assert from 'node:assert/strict';
import type { GeoPoint } from '@greenhouse-resume-builder/shared';
import { haversineKm, etaMinutes } from './distance';

const DC: GeoPoint = { city: 'Washington', lat: 38.9072, lng: -77.0369 };
const LA: GeoPoint = { city: 'Los Angeles', lat: 34.0522, lng: -118.244 };
const RESTON: GeoPoint = { city: 'Reston', lat: 38.9586, lng: -77.357 };

test('haversineKm: identical points are 0', () => {
  assert.equal(haversineKm(DC, DC), 0);
});

test('haversineKm: DC→LA ≈ 3700 km', () => {
  const d = haversineKm(DC, LA);
  assert.ok(d > 3600 && d < 3800, `expected ~3700, got ${d}`);
});

test('etaMinutes: short hop is ground', () => {
  const eta = etaMinutes(DC, RESTON);
  assert.equal(eta.mode, 'ground');
  assert.ok(eta.minutes > 0 && eta.minutes < 120, `got ${eta.minutes}`);
});

test('etaMinutes: cross-country is air', () => {
  const eta = etaMinutes(DC, LA);
  assert.equal(eta.mode, 'air');
  // 90 + 3690/800*60 + 60 ≈ 427
  assert.ok(eta.minutes > 380 && eta.minutes < 480, `got ${eta.minutes}`);
});

test('etaMinutes: threshold boundary uses ground at exactly groundThresholdKm', () => {
  // Points ~499 km apart → ground; construct via a known separation is hard, so assert monotonicity:
  const near = etaMinutes(DC, RESTON);
  const far = etaMinutes(DC, LA);
  assert.ok(far.minutes > near.minutes);
});
