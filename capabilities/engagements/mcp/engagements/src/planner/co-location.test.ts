import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDataset } from './seed-loader';
import { nearbyLeaders, type NearbyReasonType } from './co-location';

const PRIORITY: Record<NearbyReasonType, number> = { 'same-event': 0, 'same-contact': 1, 'nearby-geo': 2 };
const ds = loadDataset();
const AUSA = ds.events.find((e) => e.id === 'E-AUSA')!;
const AUSA_WINDOW = { start: AUSA.start, end: AUSA.end };

test('nearbyLeaders: same-event — flags leaders who own a relationship on the anchor roster', () => {
  const res = nearbyLeaders({
    planningLeaderId: 'L1',
    location: AUSA.location,
    window: AUSA_WINDOW,
    leaders: ds.leaders,
    contacts: ds.contacts,
    event: AUSA,
  });
  const ids = res.map((n) => n.leaderId);
  assert.ok(!ids.includes('L1'), 'the planning leader is never listed');
  assert.ok(ids.includes('L4'), 'L4 owns C10/C19 attending AUSA');
  assert.ok(ids.includes('L5'), 'L5 owns C16 attending AUSA');

  const l4 = res.find((n) => n.leaderId === 'L4')!;
  assert.equal(l4.primaryReason, 'same-event');
  const l4Event = l4.reasons.find((r) => r.type === 'same-event')!;
  assert.deepEqual([...(l4Event.contactIds ?? [])].sort(), ['C10', 'C19']);
  // A shared event co-locates them at the venue → awareness distance 0, even from a far home base.
  assert.equal(l4.distanceMi, 0);
  assert.ok(l4.homeBaseDistanceMi > 1000, 'L4 (Colorado) is physically far from DC');
});

test('nearbyLeaders: nearby-geo respects availability and excludes the planning leader', () => {
  const res = nearbyLeaders({
    planningLeaderId: 'L4',
    location: AUSA.location,
    window: AUSA_WINDOW,
    leaders: ds.leaders,
    contacts: ds.contacts,
    event: AUSA,
  });
  const geo = res.filter((n) => n.reasons.some((r) => r.type === 'nearby-geo')).map((n) => n.leaderId).sort();
  // Only the two DC-home-based leaders are within the default 300 mi and available in the window.
  assert.deepEqual(geo, ['L1', 'L5']);
  assert.ok(!res.some((n) => n.leaderId === 'L4'), 'planning leader excluded from geo too');
  const l5 = res.find((n) => n.leaderId === 'L5')!;
  assert.equal(l5.availableInWindow, true);
  assert.equal(l5.homeBaseDistanceMi, 0, 'L5 is home-based at the DC venue');
});

test('nearbyLeaders: same-contact fires for a stop owner regardless of geo/event, and ordering is by reason', () => {
  const res = nearbyLeaders({
    planningLeaderId: 'L1',
    location: AUSA.location,
    window: AUSA_WINDOW,
    leaders: ds.leaders,
    contacts: ds.contacts,
    event: AUSA,
    stopContactIds: ['C2', 'C5'], // C2 owner L5, C5 owner L3
  });

  const l3 = res.find((n) => n.leaderId === 'L3')!;
  assert.equal(l3.primaryReason, 'same-contact', 'L3 has no event/geo tie — only the shared stop C5');
  assert.deepEqual(l3.reasons.find((r) => r.type === 'same-contact')!.contactIds, ['C5']);

  const l5 = res.find((n) => n.leaderId === 'L5')!;
  assert.ok(l5.reasons.some((r) => r.type === 'same-contact' && (r.contactIds ?? []).includes('C2')));
  assert.ok(l5.reasons.some((r) => r.type === 'same-event'), 'L5 also owns an AUSA attendee');

  for (let i = 1; i < res.length; i++) {
    assert.ok(
      PRIORITY[res[i - 1].primaryReason] <= PRIORITY[res[i].primaryReason],
      'results are ordered same-event → same-contact → nearby-geo',
    );
  }
});

test('nearbyLeaders: the planning leader is never surfaced via a stop they own', () => {
  const res = nearbyLeaders({
    planningLeaderId: 'L1',
    location: AUSA.location,
    window: AUSA_WINDOW,
    leaders: ds.leaders,
    contacts: ds.contacts,
    event: AUSA,
    stopContactIds: ['C1'], // C1 is owned by L1 (the planning leader)
  });
  assert.ok(!res.some((n) => n.leaderId === 'L1'));
});

test('nearbyLeaders: area mode (no event) uses only geo + same-contact, and the geo radius is tunable', () => {
  const coloradoSprings = { city: 'Colorado Springs', state: 'CO', lat: 38.8339, lng: -104.821 };
  const window = { start: '2025-10-13', end: '2025-10-16' };

  const tight = nearbyLeaders({
    planningLeaderId: 'L4',
    location: coloradoSprings,
    window,
    leaders: ds.leaders,
    contacts: ds.contacts,
    nearbyRadiusMi: 100,
  });
  assert.equal(tight.length, 0, 'nobody else is home-based within 100 mi of Colorado Springs');

  const wide = nearbyLeaders({
    planningLeaderId: 'L4',
    location: coloradoSprings,
    window,
    leaders: ds.leaders,
    contacts: ds.contacts,
    nearbyRadiusMi: 2000,
  });
  const wideIds = wide.map((n) => n.leaderId);
  assert.ok(wideIds.includes('L1'), 'a 2000 mi reach pulls in the DC leaders');
  assert.ok(wide.every((n) => n.primaryReason === 'nearby-geo'), 'no event/stops → geo only');
  assert.ok(!wideIds.includes('L4'), 'planning leader still excluded');
});
