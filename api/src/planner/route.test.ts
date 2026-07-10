import test from 'node:test';
import assert from 'node:assert/strict';
import type { GeoPoint } from '@greenhouse-resume-builder/shared';
import { planRoute, ORIGIN_ID } from './route';
import type { RouteStop } from './types';

const DC: GeoPoint = { city: 'Washington', lat: 38.9072, lng: -77.0369 };
const RESTON: GeoPoint = { city: 'Reston', lat: 38.9586, lng: -77.357 };
const LA: GeoPoint = { city: 'Los Angeles', lat: 34.0522, lng: -118.244 };

test('planRoute: on-site stops come first and carry no legs', () => {
  const stops: RouteStop[] = [
    { id: 'venue', location: DC, kind: 'on-site' },
    { id: 'reston', location: RESTON, kind: 'off-site' },
    { id: 'la', location: LA, kind: 'off-site' },
  ];
  const r = planRoute(DC, stops);
  assert.equal(r.order[0].id, 'venue');
  assert.equal(r.legs.length, 2); // only the two off-site stops produce legs
});

test('planRoute: greedy nearest-neighbor sweeps Reston before LA', () => {
  const stops: RouteStop[] = [
    { id: 'la', location: LA, kind: 'off-site' },
    { id: 'reston', location: RESTON, kind: 'off-site' },
  ];
  const r = planRoute(DC, stops);
  assert.deepEqual(r.order.map((s) => s.id), ['reston', 'la']);
  assert.equal(r.legs[0].fromStopId, ORIGIN_ID);
  assert.equal(r.legs[0].toStopId, 'reston');
  assert.equal(r.legs[0].mode, 'ground');
  assert.equal(r.legs[1].fromStopId, 'reston');
  assert.equal(r.legs[1].toStopId, 'la');
  assert.equal(r.legs[1].mode, 'air');
  assert.ok(r.totalKm > 0 && r.totalTravelMins > 0);
});

test('planRoute: all on-site → no legs', () => {
  const stops: RouteStop[] = [
    { id: 'a', location: DC, kind: 'on-site' },
    { id: 'b', location: DC, kind: 'on-site' },
  ];
  const r = planRoute(DC, stops);
  assert.equal(r.legs.length, 0);
  assert.equal(r.totalKm, 0);
  assert.deepEqual(r.order.map((s) => s.id), ['a', 'b']);
});
