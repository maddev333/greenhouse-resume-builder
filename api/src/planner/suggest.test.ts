import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDataset, anchorFromEvent } from './seed-loader';
import { suggest } from './suggest';

/**
 * The canonical AUSA / UAS-drone trace (ARCHITECTURE §5.3, MVP-PLAN §5.1):
 * EA asks "who should MG Whitfield (L1) meet on UAS/drone (T3) at AUSA (E-AUSA)?"
 * Expect exactly: P2 Sentinel Drone (on-site exhibitor prospect → initiate),
 * C3 Meridian Robotics + C4 Capital Defense Angels (nearby, stale → re-engage).
 * C11 Hub Robotics is on-topic (T3) but in Boston (>500 km) → correctly excluded.
 */
function ausaSuggest(requireTopicMatch: boolean) {
  const ds = loadDataset();
  const event = ds.events.find((e) => e.id === 'E-AUSA')!;
  const leader = ds.leaders.find((l) => l.id === 'L1')!;
  const anchor = { ...anchorFromEvent(event), topicIds: ['T3'] };
  return suggest({ leader, anchor, contacts: ds.contacts, event, requireTopicMatch });
}

test('AUSA/UAS trace: requireTopicMatch → exactly {C3, C4, P2}', () => {
  const cands = ausaSuggest(true);
  const ids = cands.map((c) => c.contactId).sort();
  assert.deepEqual(ids, ['C3', 'C4', 'P2']);
});

test('AUSA/UAS trace: ranked P2 > C4 > C3 (prospect value, then staleness)', () => {
  const cands = ausaSuggest(true);
  assert.deepEqual(cands.map((c) => c.contactId), ['P2', 'C4', 'C3']);
  for (let i = 1; i < cands.length; i++) {
    assert.ok(cands[i - 1].score >= cands[i].score, 'scores must be descending');
  }
});

test('AUSA/UAS trace: P2 is an on-site initiate prospect with no staleness', () => {
  const p2 = ausaSuggest(true).find((c) => c.contactId === 'P2')!;
  assert.equal(p2.placement, 'on-site');
  assert.equal(p2.kind, 'initiate');
  assert.equal(p2.status, 'prospect');
  assert.equal(p2.isStale, false);
  assert.equal(p2.factors.stalenessNorm, 0);
});

test('AUSA/UAS trace: C3 & C4 are off-site, stale re-engagements with clean fit for L1', () => {
  const cands = ausaSuggest(true);
  for (const id of ['C3', 'C4']) {
    const c = cands.find((x) => x.contactId === id)!;
    assert.equal(c.placement, 'off-site');
    assert.equal(c.kind, 're-engage');
    assert.equal(c.status, 'active');
    assert.equal(c.isStale, true);
    assert.equal(c.fitFlags.length, 0, `L1 (non-technical L4) should have no fit flags vs ${id}`);
  }
});

test('without requireTopicMatch, on-site attendees surface too (e.g. C8)', () => {
  const cands = ausaSuggest(false);
  const c8 = cands.find((c) => c.contactId === 'C8');
  assert.ok(c8, 'attendee C8 should appear when topics are not required');
  assert.equal(c8!.placement, 'on-site');
  assert.ok(cands.length > 3);
});
