import test from 'node:test';
import assert from 'node:assert/strict';
import type { Contact, EngagementEvent, GeoPoint } from '@greenhouse-resume-builder/shared';
import { loadDataset } from './seed-loader';
import type { DemoConfig } from './clock';
import { staleContactsInArea, eventsInArea } from './area-intel';

const ds = loadDataset();
const centralTx = ds.regions.find((r) => r.id === 'R-CENTRAL-TX')!;

// ── Seed-based: the flagship "Plan a trip to Central TX" query ──────────────

test('staleContactsInArea: Central TX surfaces the overdue relationships (C6, C29), not the fresh ones', () => {
  const stale = staleContactsInArea({
    centroid: centralTx.centroid,
    radiusMi: centralTx.defaultRadiusMi,
    contacts: ds.contacts,
    cfg: ds.cfg,
  });
  const ids = stale.map((c) => c.contactId);
  assert.ok(ids.includes('C6'), 'Lone Star Dynamics (last touched Jan) is stale');
  assert.ok(ids.includes('C29'), 'Hill Country Innovation Hub (last touched Feb) is stale');
  // C9 Alamo Cyber Range (Jun) is a fresh active; C30 UT Austin (Sep) is fresh; prospects have no history.
  assert.ok(!ids.includes('C9'), 'Alamo Cyber Range was touched recently → not stale');
  assert.ok(!ids.includes('C30'), 'UT Austin was touched recently → not stale');
  for (const c of stale) assert.ok(c.reason.includes('cadence'), 'each stale contact carries a why');
});

test('staleContactsInArea: sorts most-overdue first', () => {
  const stale = staleContactsInArea({ centroid: centralTx.centroid, radiusMi: centralTx.defaultRadiusMi, contacts: ds.contacts, cfg: ds.cfg });
  for (let i = 1; i < stale.length; i++) {
    assert.ok(stale[i - 1].daysSinceContact >= stale[i].daysSinceContact, 'descending days-since-contact');
  }
  assert.equal(stale[0].contactId, 'C6', 'the coldest relationship (Jan) leads');
});

test('eventsInArea: Central TX flags the Lone Star Expo as an upcoming on-site magnet', () => {
  const events = eventsInArea({ centroid: centralTx.centroid, radiusMi: centralTx.defaultRadiusMi, events: ds.events, cfg: ds.cfg });
  const expo = events.find((e) => e.eventId === 'E-TX');
  assert.ok(expo, 'the Lone Star Defense Tech Expo is in-area');
  assert.equal(expo!.status, 'upcoming');
  assert.ok((expo!.daysUntil ?? 0) > 0, 'it has a positive days-until countdown');
  assert.ok(expo!.reason.includes('on-site magnet'), 'the why names it as a magnet');
});

// ── Synthetic: deterministic classification + overdue math ──────────────────

const CFG: DemoConfig = { today: '2025-10-06', staleCutoffDays: 180, shiftMonths: 0 };
const AT: GeoPoint = { city: 'Austin', state: 'TX', lat: 30.2672, lng: -97.7431 };
const FAR: GeoPoint = { city: 'Boston', state: 'MA', lat: 42.3601, lng: -71.0589 };

function contact(over: Partial<Contact> & Pick<Contact, 'id'>): Contact {
  return {
    id: over.id,
    name: over.name ?? over.id,
    type: 'company',
    domain: 'technical',
    smeAreas: [],
    topicIds: over.topicIds ?? ['T1'],
    location: over.location ?? AT,
    relationshipOwnerLeaderIds: [],
    strategicValue: over.strategicValue ?? 3,
    status: over.status ?? 'active',
    lastInteractionDate: over.lastInteractionDate,
    ...over,
  } as Contact;
}

test('staleContactsInArea: excludes fresh actives, prospects, and out-of-radius contacts; computes overdue math', () => {
  const contacts: Contact[] = [
    contact({ id: 'A', lastInteractionDate: '2025-01-10' }), // 269d ago → stale
    contact({ id: 'B', lastInteractionDate: '2025-09-20' }), // 16d ago → fresh
    contact({ id: 'C', status: 'prospect', lastInteractionDate: undefined }), // no history
    contact({ id: 'D', lastInteractionDate: '2024-01-01', location: FAR }), // stale but far
  ];
  const stale = staleContactsInArea({ centroid: AT, radiusMi: 90, contacts, cfg: CFG });
  assert.deepEqual(stale.map((c) => c.contactId), ['A'], 'only the in-area, overdue active');
  const a = stale[0];
  assert.equal(a.daysSinceContact, 269);
  assert.equal(a.overdueDays, 89); // 269 − 180
  assert.equal(a.monthsSinceContact, 9);
  assert.ok(a.reason.includes('2025-01-10') && a.reason.includes('89d past the 180-day cadence'));
});

function evt(over: Partial<EngagementEvent> & Pick<EngagementEvent, 'id' | 'start' | 'end'>): EngagementEvent {
  return {
    id: over.id,
    name: over.name ?? over.id,
    type: 'conference',
    location: over.location ?? AT,
    start: over.start,
    end: over.end,
    topicIds: over.topicIds ?? ['T1'],
    attendingContactIds: [],
    exhibitorProspectIds: [],
    ...over,
  } as EngagementEvent;
}

test('eventsInArea: classifies lapsed / in-window / upcoming and ranks by urgency', () => {
  const events: EngagementEvent[] = [
    evt({ id: 'LAPSED', start: '2025-07-28', end: '2025-08-01' }), // ended 66d ago
    evt({ id: 'NOW', start: '2025-10-01', end: '2025-10-10' }), // spans today
    evt({ id: 'SOON', start: '2025-10-13', end: '2025-10-14' }), // in 7d
    evt({ id: 'ELSEWHERE', start: '2025-10-13', end: '2025-10-14', location: FAR }), // out of radius
  ];
  const got = eventsInArea({ centroid: AT, radiusMi: 90, events, cfg: CFG });
  assert.deepEqual(got.map((e) => e.eventId), ['NOW', 'SOON', 'LAPSED'], 'in-window → upcoming → lapsed');
  assert.equal(got.find((e) => e.eventId === 'SOON')!.daysUntil, 7);
  assert.equal(got.find((e) => e.eventId === 'LAPSED')!.daysSince, 66);
  assert.ok(got.find((e) => e.eventId === 'LAPSED')!.reason.includes('follow-up overdue'));
});
