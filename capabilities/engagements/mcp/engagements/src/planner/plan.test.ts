/**
 * Phase-3 planner tests — stop-derived duration, tiered duration options, and the marquee
 * "extend +N days → meet this entity on this topic; here are the approved talking points" surface,
 * plus the unified `planOptions` envelope over the real seed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate, RouteResult } from './types';
import type { Contact, Leader, Message, Topic } from '@greenhouse-resume-builder/shared';
import { loadDataset } from './seed-loader';
import { resolveArea } from './area';
import {
  DEFAULT_DWELL_MINS,
  WORKDAY_MINUTES,
  estimateDuration,
  durationOptions,
  extensionOptions,
  talkingPointsFor,
  planOptions,
} from './plan';

const env = { tenantId: 'army', createdAt: '2025-01-01' };
const DC = { city: 'Washington', state: 'DC', lat: 38.9072, lng: -77.0369 };
const RESTON = { city: 'Reston', state: 'VA', lat: 38.9586, lng: -77.357 };

/** Minimal RouteResult with N off-site stops and an explicit travel budget (all estimateDuration reads). */
function route(offSite: number, totalTravelMins: number): RouteResult {
  return {
    order: [
      { id: 'venue', location: DC, kind: 'on-site' },
      ...Array.from({ length: offSite }, (_, i) => ({ id: `o${i}`, location: RESTON, kind: 'off-site' as const })),
    ],
    legs: [],
    totalMi: 0,
    totalTravelMins,
  };
}

test('estimateDuration: on-site-only trip is just the conference days', () => {
  const d = estimateDuration(route(0, 0), 4);
  assert.equal(d.days, 4);
  assert.equal(d.offSiteStops, 0);
});

test('estimateDuration: off-site travel + dwell bucket into whole added days', () => {
  // 2 off-site: dwell = 2 * DEFAULT_DWELL_MINS (240) + 600 travel = 840 → ceil(840/480)=2 extra days.
  const d = estimateDuration(route(2, 600), 4);
  assert.equal(d.dwellMins, 2 * DEFAULT_DWELL_MINS);
  assert.equal(d.workdayMins, WORKDAY_MINUTES);
  assert.equal(d.days, 6);
});

test('estimateDuration: floors at one day even with no on-site and no stops', () => {
  assert.equal(estimateDuration(route(0, 0), 0).days, 1);
});

test('talkingPointsFor: an approved message supplies the intended points', () => {
  const t1: Topic = { ...env, id: 'T1', name: 'DIB resilience', domain: 'non-technical', smeAreas: [], ownerOrg: 'ASA(ALT)', approvedMessageId: 'M-T1-v2' };
  const m: Message = { ...env, id: 'M-T1-v2', topicId: 'T1', version: 2, status: 'approved', intendedPoints: ['Multi-year contracting stability is coming', 'Prioritize supply-chain onshoring for munitions'] };
  const tp = talkingPointsFor(t1, [m]);
  assert.equal(tp.source, 'approved-message');
  assert.ok(tp.points.includes('Multi-year contracting stability is coming'));
});

test('talkingPointsFor: no approved message → graceful coordinate-with-owner fallback', () => {
  const t3: Topic = { ...env, id: 'T3', name: 'Innovation', domain: 'non-technical', smeAreas: [], ownerOrg: 'Army Applications Lab', approvedMessageId: null };
  const tp = talkingPointsFor(t3, []);
  assert.equal(tp.source, 'coordinate');
  assert.equal(tp.points.length, 1);
  assert.ok(tp.points[0].includes('Army Applications Lab'));
});

// ── Extension options (inline fixtures for a deterministic marginal analysis) ──

const T1: Topic = { ...env, id: 'T1', name: 'Defense industrial base (DIB) resilience', domain: 'non-technical', smeAreas: ['industrial-base'], ownerOrg: 'ASA(ALT)', approvedMessageId: 'M-T1-v2' };
const T3: Topic = { ...env, id: 'T3', name: 'Defense innovation & startups', domain: 'non-technical', smeAreas: ['innovation/startups'], ownerOrg: 'Army Applications Lab', approvedMessageId: null };
const M_T1: Message = { ...env, id: 'M-T1-v2', topicId: 'T1', version: 2, status: 'approved', intendedPoints: ['Multi-year contracting stability is coming', 'Prioritize supply-chain onshoring for munitions', 'No commitments on specific program dollars'] };

const leaderL1: Leader = { ...env, id: 'L1', name: 'MG D. Whitfield', role: 'ASA(ALT) — MG', domain: 'non-technical', smeAreas: ['industrial-base'], level: 'L4', homeBase: DC, availability: [{ start: '2025-10-06', end: '2025-10-20' }], daysAwayBudget: 10 };

const meridian: Contact = { ...env, id: 'C3', name: 'Meridian Robotics', type: 'company', sector: 'industry', domain: 'non-technical', smeAreas: ['autonomy'], topicIds: ['T1', 'T3'], level: 'L3', location: RESTON, relationshipOwnerLeaderIds: ['L1'], strategicValue: 4, status: 'active', lastInteractionDate: '2024-01-01' };
const startup: Contact = { ...env, id: 'P9', name: 'NovaLift', type: 'company', sector: 'industry', domain: 'non-technical', smeAreas: ['autonomy'], topicIds: ['T3'], location: RESTON, relationshipOwnerLeaderIds: [], strategicValue: 3, status: 'prospect' };

const cand = (c: Contact, score: number): Candidate => ({
  contactId: c.id,
  name: c.name,
  location: c.location,
  distanceMi: 34,
  placement: 'off-site',
  kind: c.status === 'prospect' ? 'initiate' : 're-engage',
  status: c.status,
  isStale: c.status === 'active',
  strategicValue: c.strategicValue,
  score,
  factors: { stalenessNorm: 1, valueNorm: c.strategicValue / 5, topicRelevance: 1 },
  fitFlags: [],
});

function offer() {
  return extensionOptions({
    base: [],
    offered: [cand(startup, 0.4), cand(meridian, 0.8)],
    centroid: DC,
    leader: leaderL1,
    window: { start: '2025-10-13', end: '2025-10-17' },
    onSiteDays: 0,
    contactsById: new Map<string, Contact>([['C3', meridian], ['P9', startup]]),
    topics: [T1, T3],
    messages: [M_T1],
    topicIds: ['T1', 'T3'],
  });
}

test('extensionOptions: unlocks a sectored entity on its topic WITH approved talking points', () => {
  const opts = offer();
  const m = opts.find((o) => o.contactId === 'C3')!;
  assert.equal(m.sector, 'industry');
  assert.equal(m.topicId, 'T1'); // first target topic the contact carries
  assert.ok(m.topicName?.includes('industrial base'));
  assert.equal(m.talkingPointsSource, 'approved-message');
  assert.ok(m.talkingPoints.includes('Multi-year contracting stability is coming'));
  assert.equal(typeof m.marginalRoi, 'number');
  assert.ok(m.extraDays >= 0 && m.totalDays >= 1);
});

test('extensionOptions: a topic with no approved message still carries a coordinate fallback', () => {
  const s = offer().find((o) => o.contactId === 'P9')!;
  assert.equal(s.topicId, 'T3');
  assert.equal(s.talkingPointsSource, 'coordinate');
  assert.ok(s.talkingPoints[0].includes('Army Applications Lab'));
});

test('extensionOptions: every option carries talking points and is ranked by marginal ROI', () => {
  const opts = offer();
  assert.equal(opts.length, 2);
  for (const o of opts) assert.ok(o.talkingPoints.length >= 1);
  for (let i = 1; i < opts.length; i++) assert.ok(opts[i - 1].marginalRoi >= opts[i].marginalRoi);
});

test('durationOptions: always offers a core tier; extended appears only when it adds stops', () => {
  const onsite = cand(meridian, 0.9); // reuse shape but mark on-site
  const candidates: Candidate[] = [
    { ...onsite, contactId: 'ON', placement: 'on-site', distanceMi: 0 },
    cand(meridian, 0.8),
    { ...cand(startup, 0.5), contactId: 'FAR', distanceMi: 900 },
  ];
  const opts = durationOptions({
    candidates,
    centroid: DC,
    leader: leaderL1,
    window: { start: '2025-10-13', end: '2025-10-17' },
    onSiteDays: 4,
    coreRadiusMi: 150,
    contactsById: new Map<string, Contact>([['C3', meridian], ['P9', startup]]),
  });
  assert.equal(opts[0].tier, 'core');
  assert.ok(opts.length >= 1);
  for (const o of opts) {
    assert.ok(o.days >= 4, 'never shorter than the on-site base');
    assert.equal(typeof o.roi.roiScore, 'number');
  }
  if (opts.length === 2) assert.ok(opts[1].days >= opts[0].days, 'extended is at least as long as core');
});

// ── Full envelope over the real seed ──

test('planOptions: NCR in AUSA week yields survey + leader + duration + extension menus', () => {
  const ds = loadDataset();
  const area = resolveArea({ regionId: 'R-NCR' }, ds.regions);
  assert.ok(area, 'R-NCR resolves from the seed gazetteer');

  const res = planOptions({
    area: area!,
    window: { start: '2025-10-13', end: '2025-10-17' },
    contacts: ds.contacts,
    events: ds.events,
    leaders: ds.leaders,
    topics: ds.topics,
    messages: ds.messages,
  });

  // B — survey
  assert.ok(res.areaSurvey.some((t) => t.topicId === 'T1'), 'NCR has a T1 footprint');
  // C — leaders (all, ranked; chosen defaults to the top option)
  assert.equal(res.leaderOptions.length, ds.leaders.length);
  assert.equal(res.chosenLeaderId, res.leaderOptions[0].leaderId);
  for (const o of res.leaderOptions) assert.ok(o.score >= 0 && o.score <= 1);
  // Event auto-absorption: AUSA is in-area + in-window → on-site days recovered.
  assert.ok(res.absorbedEventIds.includes('E-AUSA'));
  assert.equal(res.onSiteDays, 4);
  // D — duration tiers
  assert.equal(res.durationOptions[0].tier, 'core');
  assert.ok(res.durationOptions[0].days >= 4);
  assert.equal(typeof res.durationOptions[0].roi.roiScore, 'number');
  // E — extensions always carry talking points
  assert.ok(Array.isArray(res.extensionOptions));
  for (const e of res.extensionOptions) assert.ok(e.talkingPoints.length >= 1);
  // F — engagement identification across the four target audiences (Congressional / Academia / Industry / Army-internal)
  const cats = res.categoryBreakdown.map((c) => c.category);
  for (const target of ['congressional', 'academia', 'industry', 'army-internal']) {
    assert.ok(cats.includes(target as (typeof cats)[number]), `NCR breakdown must always report ${target}`);
  }
  const congressional = res.categoryBreakdown.find((c) => c.category === 'congressional')!;
  assert.ok(congressional.total >= 2, 'NCR has a Congressional footprint (C31/C32)');
  // each duration option reports its own audience mix
  for (const d of res.durationOptions) assert.equal(typeof d.categoryCounts, 'object');
});
