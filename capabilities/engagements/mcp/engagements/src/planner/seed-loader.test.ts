import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDataset, anchorFromEvent } from './seed-loader';

test('loadDataset: record counts match the staged seed', () => {
  const ds = loadDataset();
  assert.equal(ds.topics.length, 4);
  assert.equal(ds.messages.length, 3);
  assert.equal(ds.leaders.length, 6);
  assert.equal(ds.contacts.length, 35); // 30 active + 5 prospects
  assert.equal(ds.events.length, 6);
  assert.equal(ds.engagements.length, 3);
  assert.equal(ds.afteractions.length, 2);
});

test('loadDataset: demo clock resolves to 2025-10-06 (shiftMonths 0)', () => {
  const ds = loadDataset();
  assert.equal(ds.today, '2025-10-06');
});

test('loadDataset: the loader bakes the tenant/createdAt envelope onto every record', () => {
  const ds = loadDataset();
  for (const c of ds.contacts) {
    assert.equal(c.tenantId, 'army');
    assert.ok(c.createdAt, 'createdAt must be present');
  }
});

test('loadDataset: 30 active + 5 prospect contacts', () => {
  const ds = loadDataset();
  assert.equal(ds.contacts.filter((c) => c.status === 'active').length, 30);
  assert.equal(ds.contacts.filter((c) => c.status === 'prospect').length, 5);
});

test('anchorFromEvent: E-AUSA → DC venue, window, and T1/T3 topics', () => {
  const ds = loadDataset();
  const anchor = anchorFromEvent(ds.events.find((e) => e.id === 'E-AUSA')!);
  assert.equal(anchor.eventId, 'E-AUSA');
  assert.equal(anchor.location.city, 'Washington');
  assert.deepEqual(anchor.window, { start: '2025-10-12', end: '2025-10-15' });
  assert.deepEqual(anchor.topicIds, ['T1', 'T3']);
});
