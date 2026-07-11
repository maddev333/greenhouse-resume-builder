import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEngagementSecurityFilter,
  canReadSensitive,
  odataEscapeLiteral,
} from './security';
import { EA_BASIC, EA_G8, ADMIN, CROSS_TENANT, NO_TENANT } from './personas';
import type { Trimmable } from './types';

const rec = (over: Partial<Trimmable>): Trimmable => ({
  tenantId: 'army',
  aclGroups: ['/army'],
  sensitivity: 'unclassified',
  ...over,
});

test('odataEscapeLiteral doubles single quotes', () => {
  assert.equal(odataEscapeLiteral("O'Brien"), "O''Brien");
});

test('fail-closed: no tenant claim → rejected, no filter, deny-all predicate', () => {
  const d = buildEngagementSecurityFilter(NO_TENANT);
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? '', /tenant/i);
  assert.equal(d.filter, undefined);
  assert.equal(d.predicate(rec({})), false);
});

test('filter string composes tenant + group ACL + sensitivity clauses', () => {
  const d = buildEngagementSecurityFilter(EA_G8);
  assert.ok(d.allowed);
  assert.match(d.filter!, /tenantId eq 'army'/);
  assert.match(d.filter!, /aclGroups\/any\(x: search\.in\(x, '\/army,\/army\/g8\/plans'\)\)/);
  assert.match(d.filter!, /sensitivity eq 'unclassified'/); // EA_G8 has no privileged role
});

test('privileged role drops the sensitivity clause and allows sensitive rows', () => {
  const d = buildEngagementSecurityFilter(ADMIN);
  assert.equal(d.allowSensitive, true);
  assert.doesNotMatch(d.filter!, /sensitivity eq/);
  assert.equal(d.predicate(rec({ sensitivity: 'sensitive' })), true);
});

test('group ACL: a record is visible only if it shares a group with the caller', () => {
  const g8 = buildEngagementSecurityFilter(EA_G8).predicate;
  const basic = buildEngagementSecurityFilter(EA_BASIC).predicate;
  const c4 = rec({ aclGroups: ['/army/g8/plans'] }); // C4 — need-to-know
  assert.equal(g8(c4), true);
  assert.equal(basic(c4), false);
});

test('sensitivity gate is orthogonal to group membership', () => {
  const g8 = buildEngagementSecurityFilter(EA_G8).predicate; // group-cleared, NOT sensitive-cleared
  const admin = buildEngagementSecurityFilter(ADMIN).predicate; // sensitive-cleared, only /army group
  const c12 = rec({ sensitivity: 'sensitive' }); // C12 — enterprise group, sensitive
  assert.equal(g8(c12), false); // clearance ≠ need-to-know
  assert.equal(admin(c12), true);
});

test('tenant isolation: cross-tenant caller is denied every Army row', () => {
  const d = buildEngagementSecurityFilter(CROSS_TENANT);
  assert.ok(d.allowed); // has a tenant claim, just the wrong one
  assert.match(d.filter!, /tenantId eq 'usmc'/);
  assert.equal(d.predicate(rec({})), false); // record.tenantId 'army' ≠ 'usmc'
});

test('topic narrowing stays in sync between filter string and predicate', () => {
  const d = buildEngagementSecurityFilter(EA_BASIC, { topicIds: ['T3'] });
  assert.match(d.filter!, /topicIds\/any\(x: search\.in\(x, 'T3'\)\)/);
  assert.equal(d.predicate(rec({ topicIds: ['T3'] })), true);
  assert.equal(d.predicate(rec({ topicIds: ['T1'] })), false);
});

test('canReadSensitive honors role and scope claims', () => {
  assert.equal(canReadSensitive({ roles: ['ClearedReviewer'] }), true);
  assert.equal(canReadSensitive({ scopes: ['Engagements.ReadSensitive'] }), true);
  assert.equal(canReadSensitive({ roles: [], scopes: [] }), false);
});
