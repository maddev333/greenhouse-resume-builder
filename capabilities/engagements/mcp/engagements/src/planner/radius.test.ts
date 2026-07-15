import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDataset } from './seed-loader';
import { radiusPlan, DEFAULT_MEETINGS_PER_DAY } from './radius';
import type { ResolvedArea } from './area';

const ds = loadDataset();
const leader = ds.leaders.find((l) => l.id === 'L1')!; // MG Whitfield, DC — owns C1/C3/C8
const window = { start: '2025-10-13', end: '2025-10-16' };

/** Anchor on Meridian Robotics (C3, Reston VA) — several authorized contacts sit within ~40 mi. */
const meridian = ds.contacts.find((c) => c.id === 'C3')!;
const ncrArea: ResolvedArea = {
  id: 'coords:meridian',
  name: 'Meridian Robotics',
  centroid: meridian.location,
  radiusMi: 120,
  resolvedVia: 'coords',
};

function plan(overrides: Partial<Parameters<typeof radiusPlan>[0]> = {}) {
  return radiusPlan({
    leader,
    area: ncrArea,
    window,
    days: 3,
    contacts: ds.contacts,
    events: ds.events,
    topics: ds.topics,
    messages: ds.messages,
    anchorContactId: 'C3',
    ...overrides,
  });
}

test('radiusPlan: capacity = days × meetingsPerDay (default 2)', () => {
  const r = plan({ days: 2 });
  assert.equal(r.meetingsPerDay, DEFAULT_MEETINGS_PER_DAY);
  assert.equal(r.capacity, 4);
  assert.ok(r.stops.length <= r.capacity, 'never exceeds capacity');
});

test('radiusPlan: the anchor company is pinned as the first, on-site stop (distance 0)', () => {
  const r = plan({ days: 1 }); // capacity 2
  assert.ok(r.anchor, 'anchor resolved');
  assert.equal(r.anchor!.contactId, 'C3');
  assert.equal(r.stops[0].contactId, 'C3');
  assert.equal(r.stops[0].placement, 'on-site');
  assert.equal(r.stops[0].distanceMi, 0);
});

test('radiusPlan: fixed days fill — a tight budget overflows into extension options', () => {
  const r = plan({ days: 1 }); // capacity 2 = anchor + 1 fill
  assert.equal(r.capacity, 2);
  assert.equal(r.stops.length, 2, 'anchor + one highest-value fill');
  assert.ok(r.overflowCount > 0, 'the rest of the in-radius contacts overflow');
  assert.equal(r.extensionOptions.length, r.overflowCount, 'each overflow is priced as an extension');
  for (const e of r.extensionOptions) {
    assert.ok(e.talkingPoints.length > 0, 'every extension carries talking points (approved or coordinate)');
  }
});

test('radiusPlan: extension days follow the fixed-days capacity model, not route travel', () => {
  // capacity = days(1) × perDay(2) = 2; overflow stops each need whole extra days, and every extra
  // day unlocks `perDay` more meetings — so the i-th overflow needs ⌊i / perDay⌋ + 1 day(s).
  const r = plan({ days: 1 });
  assert.ok(r.extensionOptions.length >= 3, 'enough NCR overflow to span more than one extra day');
  r.extensionOptions.forEach((e, i) => {
    const expected = Math.floor(i / r.meetingsPerDay) + 1;
    assert.equal(e.extraDays, expected, `overflow #${i} needs +${expected}d`);
    assert.equal(e.totalDays, r.days + expected, 'totalDays = fixed days + extra days');
  });
  assert.equal(r.extensionOptions[0].extraDays, 1, 'the top overflow is a single +1 day');
});

test('radiusPlan: more days fit more stops (fewer overflow) than fewer days', () => {
  const tight = plan({ days: 1 });
  const roomy = plan({ days: 5 });
  assert.ok(roomy.stops.length >= tight.stops.length);
  assert.ok(roomy.overflowCount <= tight.overflowCount);
});

test('radiusPlan: ROI and duration are costed against the FIXED days, not the route estimate', () => {
  const r = plan({ days: 4 });
  assert.equal(r.days, 4);
  assert.equal(r.duration.days, 4);
  assert.equal(r.roi.days, 4);
});

test('radiusPlan: every chosen off-site stop is inside the requested radius', () => {
  const r = plan({ days: 5 });
  for (const s of r.stops) {
    assert.ok(s.distanceMi <= ncrArea.radiusMi, `${s.contactId} within ${ncrArea.radiusMi} mi`);
  }
});

test('radiusPlan: no anchor (pure geo) → first stop is the top-scored nearby contact', () => {
  const r = plan({ anchorContactId: undefined, days: 3 });
  assert.equal(r.anchor, null);
  assert.ok(r.stops.length > 0);
  // stops are score-sorted; the leading stop is the highest-scored in-radius contact.
  assert.ok(r.stops[0].score >= r.stops[r.stops.length - 1].score);
});

test('radiusPlan: nothing within a tiny remote radius → empty plan (no anchor)', () => {
  const remote: ResolvedArea = {
    id: 'coords:remote',
    name: 'mid-Pacific',
    centroid: { city: 'nowhere', lat: 0, lng: -160 },
    radiusMi: 25,
    resolvedVia: 'coords',
  };
  const r = radiusPlan({
    leader,
    area: remote,
    window,
    days: 3,
    contacts: ds.contacts,
    events: ds.events,
    topics: ds.topics,
    messages: ds.messages,
  });
  assert.equal(r.stops.length, 0);
  assert.equal(r.overflowCount, 0);
  assert.equal(r.extensionOptions.length, 0);
});
