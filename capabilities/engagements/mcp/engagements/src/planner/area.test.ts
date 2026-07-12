import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDataset } from './seed-loader';
import { resolveArea, anchorFromArea, DEFAULT_AREA_RADIUS_KM } from './area';

const ds = loadDataset();
const contactPoints = ds.contacts.map((c) => c.location);

test('resolveArea: by regionId → centroid + default radius', () => {
  const area = resolveArea({ regionId: 'R-NCR' }, ds.regions, contactPoints);
  assert.ok(area, 'R-NCR should resolve');
  assert.equal(area!.id, 'R-NCR');
  assert.equal(area!.resolvedVia, 'regionId');
  assert.equal(area!.centroid.city, 'Washington');
  assert.equal(area!.radiusKm, 120);
});

test('resolveArea: by alias is case-insensitive', () => {
  const area = resolveArea({ region: 'ncr' }, ds.regions, contactPoints);
  assert.ok(area);
  assert.equal(area!.id, 'R-NCR');
  assert.equal(area!.resolvedVia, 'regionName');
});

test('resolveArea: radiusKm override wins over the region default', () => {
  const area = resolveArea({ regionId: 'R-NCR', radiusKm: 50 }, ds.regions, contactPoints);
  assert.equal(area!.radiusKm, 50);
});

test('resolveArea: bare city falls back to an authorized record point (offline geocode)', () => {
  // Huntsville is not a region name/alias/centroid, but contact C8 is located there.
  const area = resolveArea({ city: 'Huntsville', state: 'AL' }, ds.regions, contactPoints);
  assert.ok(area, 'Huntsville should resolve from a known contact point');
  assert.equal(area!.resolvedVia, 'city');
  assert.equal(area!.centroid.city, 'Huntsville');
  assert.equal(area!.radiusKm, DEFAULT_AREA_RADIUS_KM);
});

test('resolveArea: unknown area → undefined (tool then asks the caller to pick)', () => {
  assert.equal(resolveArea({ city: 'Atlantis' }, ds.regions, contactPoints), undefined);
});

test('anchorFromArea: carries centroid + window + topics, no eventId', () => {
  const area = resolveArea({ regionId: 'R-NCR' }, ds.regions)!;
  const window = { start: '2025-11-03', end: '2025-11-07' };
  const anchor = anchorFromArea(area, window, ['T1']);
  assert.equal(anchor.id, 'R-NCR');
  assert.deepEqual(anchor.location, area.centroid);
  assert.deepEqual(anchor.window, window);
  assert.deepEqual(anchor.topicIds, ['T1']);
  assert.equal(anchor.eventId, undefined);
});
