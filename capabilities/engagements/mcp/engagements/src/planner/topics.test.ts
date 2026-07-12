import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDataset } from './seed-loader';
import { topicsInArea } from './topics';

const ds = loadDataset();
const ncr = ds.regions.find((r) => r.id === 'R-NCR')!;

function surveyNcr(radiusKm: number) {
  return topicsInArea({
    centroid: ncr.centroid,
    radiusKm,
    contacts: ds.contacts,
    events: ds.events,
    topics: ds.topics,
    cfg: ds.cfg,
  });
}

test('topicsInArea: surfaces the topics with a live footprint in the NCR', () => {
  const found = surveyNcr(ncr.defaultRadiusKm);
  const ids = found.map((t) => t.topicId);
  for (const id of ['T1', 'T2', 'T3']) assert.ok(ids.includes(id), `expected ${id} in the NCR`);
  // T4 (STEM) has no in-area contact or event → must not appear.
  assert.ok(!ids.includes('T4'), 'T4 has no NCR footprint and must be excluded');
});

test('topicsInArea: carries the approved-message badge from the topic catalog', () => {
  const found = surveyNcr(ncr.defaultRadiusKm);
  const t1 = found.find((t) => t.topicId === 'T1')!;
  const t3 = found.find((t) => t.topicId === 'T3')!;
  assert.equal(t1.hasApprovedMessage, true, 'T1 has an approved message');
  assert.equal(t3.hasApprovedMessage, false, 'T3 has no approved message yet');
});

test('topicsInArea: counts in-area events and ranks by opportunity (descending)', () => {
  const found = surveyNcr(ncr.defaultRadiusKm);
  const t1 = found.find((t) => t.topicId === 'T1')!;
  assert.ok(t1.eventCount >= 1, 'AUSA sits in the NCR and touches T1');
  assert.ok(t1.activeCount >= 1, 'NCR has active T1 contacts');
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i - 1].opportunityScore >= found[i].opportunityScore, 'scores must be descending');
  }
});

test('topicsInArea: a tight radius excludes far-away contacts', () => {
  // At 1 km only the on-centroid AUSA event contributes (T1, T3); Baltimore/Aberdeen T2 drop out.
  const ids = surveyNcr(1).map((t) => t.topicId).sort();
  assert.deepEqual(ids, ['T1', 'T3']);
  assert.ok(!ids.includes('T2'), 'T2 contacts are >1 km away and must be excluded');
});
