import test from 'node:test';
import assert from 'node:assert/strict';
import { EngagementIndex } from './retrieval-index';
import { EA_BASIC, EA_G8, ADMIN, CROSS_TENANT, NO_TENANT } from './personas';
import type { SecurityContext } from './security';
import { suggest } from '../planner/suggest';
import { anchorFromEvent } from '../planner/seed-loader';

const idx = EngagementIndex.load();
const ids = <T extends { id: string }>(rows: T[]): string[] => rows.map((r) => r.id).sort();

test('EA_G8 sees the /army/g8/plans contact C4 but not the sensitive C12', () => {
  const r = idx.searchContacts({ ctx: EA_G8 });
  assert.ok(ids(r.items).includes('C4'));
  assert.ok(!ids(r.items).includes('C12'));
  assert.equal(r.items.length, 22); // 23 − C12
  assert.equal(r.redactedCount, 1);
  assert.match(r.filter, /tenantId eq 'army'/);
});

test('EA_BASIC is trimmed on BOTH axes (group C4 + sensitive C12)', () => {
  const r = idx.searchContacts({ ctx: EA_BASIC });
  const got = ids(r.items);
  assert.ok(!got.includes('C4'));
  assert.ok(!got.includes('C12'));
  assert.equal(r.items.length, 21);
  assert.equal(r.redactedCount, 2);
});

test('ADMIN sees the sensitive C12 but still not the g8-only C4', () => {
  const got = ids(idx.searchContacts({ ctx: ADMIN }).items);
  assert.ok(got.includes('C12'));
  assert.ok(!got.includes('C4'));
});

test('cross-tenant caller gets zero rows (tenant isolation), but the call is allowed', () => {
  const r = idx.searchContacts({ ctx: CROSS_TENANT });
  assert.equal(r.items.length, 0);
  assert.equal(r.redactedCount, 23);
  assert.doesNotMatch(r.filter, /rejected/);
});

test('missing tenant claim is rejected (fail-closed), not silently empty', () => {
  const r = idx.searchContacts({ ctx: NO_TENANT });
  assert.equal(r.items.length, 0);
  assert.match(r.filter, /rejected/);
});

/**
 * The security trim runs BEFORE the planner scores anything: feed the persona's authorized contacts
 * into `suggest()` for the AUSA/UAS trace and confirm C4 is scored for the cleared EA and simply
 * absent (never evaluated) for the basic EA — access is enforced at retrieval, not by the model.
 */
function ausaTrace(ctx: SecurityContext): string[] {
  const ds = idx.labeled;
  const event = ds.events.find((e) => e.id === 'E-AUSA')!;
  const leader = ds.leaders.find((l) => l.id === 'L1')!;
  const contacts = idx.searchContacts({ ctx }).items; // security-trimmed
  const anchor = { ...anchorFromEvent(event), topicIds: ['T3'] };
  return suggest({ leader, anchor, contacts, event, requireTopicMatch: true }).map((c) => c.contactId);
}

test('trim-before-score: C4 is suggested for EA_G8 and withheld from EA_BASIC', () => {
  const g8 = ausaTrace(EA_G8);
  const basic = ausaTrace(EA_BASIC);
  assert.deepEqual(g8, ['P2', 'C4', 'C3']); // matches the M0 canonical trace
  assert.deepEqual(basic, ['P2', 'C3']); // C4 trimmed at retrieval → never scored
});

test('findEvent resolves "AUSA" for an Army caller and nothing cross-tenant', () => {
  assert.equal(idx.findEvent(EA_G8, 'AUSA')?.id, 'E-AUSA');
  assert.equal(idx.findEvent(CROSS_TENANT, 'AUSA'), undefined);
});

test('preferences NARROW within the trim (doNotMeet drops C4; seniorityFloor gates value)', () => {
  const dropped = idx.searchContacts({ ctx: EA_G8, preferences: { doNotMeet: ['C4'] } });
  assert.ok(!ids(dropped.items).includes('C4'));

  const floored = idx.searchContacts({ ctx: EA_G8, preferences: { seniorityFloor: 5 } });
  assert.ok(floored.items.every((c) => c.strategicValue >= 5));
});
