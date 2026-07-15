import test from 'node:test';
import assert from 'node:assert/strict';
import type { Contact, Leader, Topic } from '@greenhouse-resume-builder/shared';
import { loadDataset } from './seed-loader';
import { suggestLeaders } from './leaders';

const env = { tenantId: 'army', createdAt: '2025-01-01' };
const DC = { city: 'Washington', state: 'DC', lat: 38.9072, lng: -77.0369 };
const WINDOW = { start: '2025-11-03', end: '2025-11-05' }; // 3 days

const T2: Topic = {
  ...env,
  id: 'T2',
  name: 'Cyber & Zero-Trust',
  domain: 'technical',
  smeAreas: ['cyber', 'zero-trust'],
  approvedMessageId: 'M-T2',
};

const nearTechAvail: Leader = {
  ...env,
  id: 'LA',
  name: 'Near Tech (available)',
  role: 'Commanding General',
  domain: 'technical',
  smeAreas: ['cyber'],
  level: 'L3',
  homeBase: { city: 'Arlington', state: 'VA', lat: 38.8816, lng: -77.091 },
  availability: [{ start: '2025-11-01', end: '2025-11-30' }],
  daysAwayBudget: 10,
};

const farNonTechUnavail: Leader = {
  ...env,
  id: 'LB',
  name: 'Far Non-Tech (unavailable)',
  role: 'Director',
  domain: 'non-technical',
  smeAreas: ['policy'],
  level: 'L4',
  homeBase: { city: 'Seattle', state: 'WA', lat: 47.6062, lng: -122.332 },
  availability: [],
  daysAwayBudget: 1,
};

const anchorContact: Contact = {
  ...env,
  id: 'CX',
  name: 'Anchor Cyber Contact',
  type: 'individual',
  domain: 'technical',
  smeAreas: ['cyber'],
  topicIds: ['T2'],
  level: 'L3',
  location: DC,
  relationshipOwnerLeaderIds: [],
  strategicValue: 5,
  status: 'active',
};

function staffT2() {
  return suggestLeaders({
    centroid: DC,
    window: WINDOW,
    topicIds: ['T2'],
    leaders: [farNonTechUnavail, nearTechAvail],
    topics: [T2],
    contacts: [anchorContact],
  });
}

test('suggestLeaders: near/on-topic/available leader outranks the far/off-topic one', () => {
  const opts = staffT2();
  assert.deepEqual(opts.map((o) => o.leaderId), ['LA', 'LB']);
  assert.ok(opts[0].score >= opts[1].score);
});

test('suggestLeaders: always returns options — a poor fit is ranked, never filtered out', () => {
  const opts = staffT2();
  assert.equal(opts.length, 2, 'both leaders remain as options');
  const lb = opts.find((o) => o.leaderId === 'LB')!;
  assert.equal(lb.availableInWindow, false);
  assert.ok(lb.notes.some((n) => n.includes('no availability')));
  assert.ok(lb.notes.some((n) => n.includes('domain mismatch')));
  assert.ok(lb.notes.some((n) => n.includes('budget')));
});

test('suggestLeaders: factors reflect availability, budget and topic fit', () => {
  const la = staffT2().find((o) => o.leaderId === 'LA')!;
  assert.equal(la.factors.availability, 1, 'window fully inside availability');
  assert.equal(la.factors.budgetHeadroom, 1, '10-day budget covers a 3-day window');
  assert.ok(la.factors.topicMatch > 0.5, 'cyber SME + technical domain');
  assert.ok(la.factors.proximity > 0.9, 'home base is next to the centroid');
  assert.ok(la.score >= 0 && la.score <= 1);
});

test('suggestLeaders: over the real seed, every leader is returned as a scored, sorted option', () => {
  const ds = loadDataset();
  const opts = suggestLeaders({
    centroid: DC,
    window: WINDOW,
    topicIds: ['T2'],
    leaders: ds.leaders,
    topics: ds.topics,
    contacts: ds.contacts,
  });
  assert.equal(opts.length, ds.leaders.length);
  for (const o of opts) assert.ok(o.score >= 0 && o.score <= 1, 'scores are normalized');
  for (let i = 1; i < opts.length; i++) {
    assert.ok(opts[i - 1].score >= opts[i].score, 'scores must be descending');
  }
});
