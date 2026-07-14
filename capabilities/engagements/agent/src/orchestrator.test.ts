/**
 * Unit tests for the orchestrator's pure helpers — the grounding catalog, topic mapping, anchor
 * extraction, and the tool surface. These do NOT need a live MCP server or Azure OpenAI (the
 * end-to-end LLM/deterministic paths are exercised against a running capability, see README).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadLeaders, loadRegions, loadTopics, defaultWindow, regionChoices, resolveAreaInput, resolveDefaultLeaderId, rosterForPrompt, topicIdsFromText, topicsForPrompt } from './catalog.js';
import { AGENT_TOOLS } from './tools.js';
import { anchorGuess, areaAskAnchor, areaClarifyQuestion, buildOptionQuestions, buildRadiusQuestions, buildSystemPrompt, itineraryLengthTargets, hotTopicQuestion, leaderClarifyQuestion, leaderFromQuestion, optionsToPlanResult, parseRadiusAsk, rankHotTopics, selectedContactIds } from './orchestrator.js';

test('topicIdsFromText maps UAS/drone to T3', () => {
  assert.deepEqual(topicIdsFromText('who should I meet on UAS/drone?'), ['T3']);
});

test('topicIdsFromText maps cyber -> T2 and industrial base -> T1', () => {
  assert.deepEqual(topicIdsFromText('cyber zero-trust modernization'), ['T2']);
  assert.deepEqual(topicIdsFromText('defense industrial base and acquisition'), ['T1']);
});

test('topicIdsFromText returns [] for an unmapped ask', () => {
  assert.deepEqual(topicIdsFromText('lunch plans'), []);
});

test('seed roster loads 6 leaders including L1', () => {
  const leaders = loadLeaders();
  assert.equal(leaders.length, 6);
  assert.ok(leaders.some((l) => l.id === 'L1'));
});

test('seed topics load T1..T4', () => {
  assert.deepEqual(loadTopics().map((t) => t.id), ['T1', 'T2', 'T3', 'T4']);
});

test('resolveDefaultLeaderId resolves to a real leader', () => {
  assert.ok(loadLeaders().some((l) => l.id === resolveDefaultLeaderId()));
});

test('AGENT_TOOLS expose the 5 engagements tools with required fields', () => {
  assert.deepEqual(
    AGENT_TOOLS.map((t) => t.name),
    ['search_contacts', 'search_events', 'suggest_candidates', 'plan_radius', 'build_itinerary'],
  );
  const suggest = AGENT_TOOLS.find((t) => t.name === 'suggest_candidates')!;
  assert.deepEqual((suggest.parameters as any).required, ['leaderId']);
  const radius = AGENT_TOOLS.find((t) => t.name === 'plan_radius')!;
  assert.deepEqual((radius.parameters as any).required, ['days']);
  const build = AGENT_TOOLS.find((t) => t.name === 'build_itinerary')!;
  // build_itinerary now serves BOTH event and radius modes, so only the leader is universally required.
  assert.deepEqual((build.parameters as any).required, ['leaderId']);
});

test('anchorGuess extracts the AUSA acronym from the canonical demo question', () => {
  assert.equal(anchorGuess("I'm planning a trip to AUSA, who should I meet on UAS/drone?"), 'AUSA');
});

test('anchorGuess falls back to the phrase after a preposition', () => {
  assert.equal(anchorGuess('planning a visit to Fort Bragg next week'), 'Fort Bragg');
});

// ── Leader-first `/ask`: name the senior leader, or ASK who ─────────────────

test('leaderFromQuestion returns null when NO leader is named (→ ask WHO first)', () => {
  assert.equal(leaderFromQuestion("I'm planning a trip to AUSA — who should I meet on the UAS/drone topic?"), null);
});

test('leaderFromQuestion matches an explicit roster id', () => {
  assert.equal(leaderFromQuestion('Plan AUSA for L2 on recruiting'), 'L2');
});

test('leaderFromQuestion matches a distinctive surname', () => {
  assert.equal(leaderFromQuestion('Build an AUSA itinerary for MG Whitfield'), 'L1');
  assert.equal(leaderFromQuestion('what should Nguyen do at AUSA?'), 'L6');
});

// ── Fixed-radius planning: parse + menu helpers ─────────────────────────────

test('parseRadiusAsk extracts days + company after meet/visit', () => {
  assert.deepEqual(parseRadiusAsk('plan 3 days meeting Meridian Robotics'), {
    days: 3,
    radiusMi: undefined,
    company: 'Meridian Robotics',
    city: undefined,
  });
});

test('parseRadiusAsk extracts days + place after a proximity preposition', () => {
  assert.deepEqual(parseRadiusAsk('2 days around Reston'), {
    days: 2,
    radiusMi: undefined,
    company: undefined,
    city: 'Reston',
  });
});

test('parseRadiusAsk parses an explicit within-X-mi radius (kept in miles)', () => {
  const r = parseRadiusAsk('plan 4 days within 50 mi of Reston');
  assert.equal(r?.days, 4);
  assert.equal(r?.radiusMi, 50); // 50 mi kept as-is
  assert.equal(r?.city, 'Reston');
});

test('parseRadiusAsk returns null for an event-style ask (no company/place/radius)', () => {
  // Must NOT hijack the canonical event flow ("AUSA for 3 days").
  assert.equal(parseRadiusAsk('planning to attend AUSA for 3 days'), null);
});

test('parseRadiusAsk returns null when there is no day count', () => {
  assert.equal(parseRadiusAsk('meet Meridian Robotics next month'), null);
});

test('buildRadiusQuestions surfaces the leader menu with the chosen leader pre-selected', () => {
  const plan = {
    chosenLeaderId: 'L1',
    leaderOptions: [
      { leaderId: 'L1', name: 'Gen. Vance', role: 'CG', score: 9, distanceMi: 12 },
      { leaderId: 'L2', name: 'Lt. Gen. Ruiz', role: 'DCG', score: 6 },
    ],
    extensionOptions: [
      { contactId: 'C9', name: 'Acme Labs', sector: 'academia', extraDays: 1, marginalRoi: 4, topicName: 'UAS', talkingPointsSource: 'approved-message' },
    ],
  };
  const qs = buildRadiusQuestions(plan);
  const leader = qs.find((q) => q.id === 'leader')!;
  assert.equal(leader.kind, 'single');
  assert.ok(leader.choices.find((c) => c.value === 'L1')?.selected);
  const ext = qs.find((q) => q.id === 'extensions')!;
  assert.equal(ext.kind, 'multi');
  assert.equal(ext.choices[0].value, 'C9');
});

test('buildRadiusQuestions returns [] when the plan has no leaders or extensions', () => {
  assert.deepEqual(buildRadiusQuestions({ leaderOptions: [], extensionOptions: [] }), []);
});

test('system prompt embeds the roster and the chosen default leader + topN', () => {
  const prompt = buildSystemPrompt('L1', 3);
  assert.ok(prompt.includes('L1:'));
  assert.ok(prompt.includes('"L1"'));
  assert.ok(prompt.includes('top 3'));
  assert.ok(rosterForPrompt().length > 0 && topicsForPrompt().includes('T3'));
});

// ── Phase 4 — interactive, area-first OPTIONED planning ─────────────────────

test('seed regions load with NCR + its aliases', () => {
  const regions = loadRegions();
  const ncr = regions.find((r) => r.id === 'R-NCR');
  assert.ok(ncr, 'R-NCR should exist');
  assert.ok(ncr!.aliases.includes('NCR'));
});

test('resolveAreaInput maps a region alias to its region id (longest match wins)', () => {
  assert.deepEqual(resolveAreaInput("plan a trip to the Bay Area on autonomy"), { regionId: 'R-BAY-AREA' });
  assert.deepEqual(resolveAreaInput('what should we do in Washington DC?'), { regionId: 'R-NCR' });
});

test('resolveAreaInput resolves the "Central TX" shorthand to R-CENTRAL-TX (the flagship area query)', () => {
  assert.deepEqual(
    resolveAreaInput("Plan a trip to Central TX — who should go, how long, and what's worth doing there?"),
    { regionId: 'R-CENTRAL-TX' },
  );
  assert.deepEqual(resolveAreaInput('anything happening in central tx?'), { regionId: 'R-CENTRAL-TX' });
});

test('resolveAreaInput falls back to a city after a locative preposition', () => {
  assert.deepEqual(resolveAreaInput('any reason to travel to Huntsville next month?'), { city: 'Huntsville' });
});

test('resolveAreaInput returns null when nothing anchors an area', () => {
  assert.equal(resolveAreaInput('what should i have for lunch'), null);
});

test('areaAskAnchor routes a KNOWN-REGION ask into the area-first leader→options flow', () => {
  assert.deepEqual(
    areaAskAnchor("Plan a trip to Central TX — who should go, how long, and what's worth doing there?"),
    { regionId: 'R-CENTRAL-TX' },
  );
  assert.deepEqual(areaAskAnchor('what is worth doing in the Bay Area?'), { regionId: 'R-BAY-AREA' });
});

test('areaAskAnchor declines event asks, bare cities, and fixed-radius asks (they keep their own paths)', () => {
  assert.equal(areaAskAnchor('plan a trip to AUSA'), null); // event token, not a known region
  assert.equal(areaAskAnchor('any reason to travel to Huntsville next month?'), null); // locative city, not a region
  assert.equal(areaAskAnchor('3 days within 60 mi of Reston'), null); // fixed-radius ask
  assert.equal(areaAskAnchor('what should i have for lunch'), null);
});

test('optionsToPlanResult renders an AREA options envelope (no event) — area name + stage:options + recommended', () => {
  const base = {
    ok: false, mode: 'deterministic', persona: 'EA_G8', question: 'q', answer: null, toolCalls: [],
    menu: null, itinerary: null, tripMap: null, redactedCount: null, rejected: false, stage: 'plan', clarify: null,
  } as any;
  const opts = {
    ok: true, persona: 'EA_G8', question: 'Itinerary options for L1', leaderId: 'L1', leaderName: 'MG D. Whitfield',
    area: { name: 'Central Texas' }, window: { start: '2025-10-06', end: '2025-10-31' }, today: '2025-10-06',
    topicIds: ['T3'],
    options: [
      { id: '2d', tier: 'short', label: '2-day trip', summary: '2 meeting(s) · ROI 1.10', days: 2, stopCount: 2,
        roiScore: 1.1, overBudget: false, recommended: false, contactIds: ['C6', 'C29'], ok: true,
        itinerary: { accepted: [{ contactId: 'C6' }, { contactId: 'C29' }] }, tripMap: { k: 1 }, answer: null },
      { id: '5d', tier: 'extended', label: '5-day trip', summary: '5 meeting(s) · ROI 1.40', days: 5, stopCount: 5,
        roiScore: 1.4, overBudget: false, recommended: true, contactIds: ['C6', 'C29', 'C9', 'C30'], ok: true,
        itinerary: { accepted: [{ contactId: 'C6' }] }, tripMap: { k: 2 }, answer: null },
    ],
    recommendedOptionId: '5d', redactedCount: 0, rejected: false,
  } as any;

  const pr = optionsToPlanResult(base, opts, null);
  assert.equal(pr.stage, 'options');
  assert.equal(pr.clarify, null);
  assert.equal(pr.leaderId, 'L1');
  assert.equal(pr.event, null);
  assert.equal(pr.options?.length, 2);
  assert.equal(pr.recommendedOptionId, '5d');
  assert.match(pr.answer ?? '', /Central Texas/);
  assert.match(pr.answer ?? '', /2 itinerary option\(s\)/);
  // The recommended option's finished itinerary/map are surfaced as the headline plan.
  assert.equal(pr.tripMap, opts.options[1].tripMap);
  assert.deepEqual(pr.menu, opts.options[1].itinerary.accepted);
});

test('defaultWindow returns an ISO start/end and honors the env override', () => {
  const d = defaultWindow();
  assert.match(d.start, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(d.end, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(d.start <= d.end);

  process.env.ENGAGEMENTS_PLAN_WINDOW = '2030-01-01..2030-01-10';
  try {
    assert.deepEqual(defaultWindow(), { start: '2030-01-01', end: '2030-01-10' });
  } finally {
    delete process.env.ENGAGEMENTS_PLAN_WINDOW;
  }
});

test('areaClarifyQuestion offers the known regions as chips', () => {
  const q = areaClarifyQuestion();
  assert.equal(q.id, 'area');
  assert.equal(q.kind, 'single');
  assert.ok(q.choices.some((c) => c.value === 'R-NCR'));
  assert.equal(q.choices.length, loadRegions().length);
});

// A minimal plan_options structuredContent fixture (mirrors the capability's view shape).
const PLAN_FIXTURE = {
  chosenLeaderId: 'L2',
  leaderOptions: [
    { leaderId: 'L2', name: 'MG Two', role: 'DCG', score: '0.81', distanceMi: 12, availableInWindow: true },
    { leaderId: 'L1', name: 'GEN One', role: 'CG', score: '0.64', distanceMi: 40, availableInWindow: false },
  ],
  durationOptions: [
    { tier: 'core', days: 3, stops: [{ contactId: 'C21' }, { contactId: 'C22' }], roiScore: '0.55', overBudget: false },
    { tier: 'extended', days: 5, stops: [{ contactId: 'C21' }, { contactId: 'C22' }, { contactId: 'C23' }], roiScore: '0.71', overBudget: true },
  ],
  extensionOptions: [
    { contactId: 'C24', name: 'Dr. Four', sector: 'academia', topicId: 'T4', topicName: 'Talent/STEM', extraDays: 1, marginalRoi: '0.18', overBudget: false, talkingPointsSource: 'approved-message' },
    { contactId: 'C25', name: 'Sen. Five', sector: 'political', topicId: 'T1', topicName: 'Industrial Base', extraDays: 2, marginalRoi: '0.09', overBudget: false, talkingPointsSource: 'coordinate' },
  ],
};

test('buildOptionQuestions surfaces leader/duration/extension menus with the top pick pre-selected', () => {
  const qs = buildOptionQuestions(PLAN_FIXTURE);
  assert.deepEqual(qs.map((q) => q.id), ['leader', 'duration', 'extensions']);

  const leader = qs.find((q) => q.id === 'leader')!;
  assert.equal(leader.kind, 'single');
  assert.ok(leader.choices.find((c) => c.value === 'L2')!.selected, 'chosen leader is pre-selected');
  assert.ok(leader.choices.find((c) => c.value === 'L1')!.detail!.includes('not free in window'));

  const duration = qs.find((q) => q.id === 'duration')!;
  assert.equal(duration.choices[0].value, 'core');
  assert.ok(duration.choices[0].selected);
  assert.ok(duration.choices.find((c) => c.value === 'extended')!.detail!.includes('OVER BUDGET'));

  const ext = qs.find((q) => q.id === 'extensions')!;
  assert.equal(ext.kind, 'multi');
  assert.ok(ext.choices.every((c) => c.selected === false));
  assert.ok(ext.choices.find((c) => c.value === 'C24')!.detail!.includes('approved talking points'));
});

test('selectedContactIds combines the chosen duration tier stops with toggled extensions (deduped)', () => {
  assert.deepEqual(selectedContactIds(PLAN_FIXTURE, {}), ['C21', 'C22']); // core by default
  assert.deepEqual(selectedContactIds(PLAN_FIXTURE, { durationTier: 'extended' }), ['C21', 'C22', 'C23']);
  assert.deepEqual(
    selectedContactIds(PLAN_FIXTURE, { durationTier: 'core', extensionContactIds: ['C24', 'C22'] }),
    ['C21', 'C22', 'C24'],
  );
});

// ── Feature: ask WHO first + offer multiple full itinerary options ──────────

test('leaderClarifyQuestion asks WHICH senior leader with the ranked roster (top pick recommended)', () => {
  const q = leaderClarifyQuestion(PLAN_FIXTURE.leaderOptions, PLAN_FIXTURE.chosenLeaderId);
  assert.equal(q.id, 'leader');
  assert.equal(q.kind, 'single');
  assert.match(q.prompt, /which senior leader/i);
  const l2 = q.choices.find((c) => c.value === 'L2')!;
  assert.ok(l2.selected && l2.recommended, 'the recommended top pick is pre-selected');
  const l1 = q.choices.find((c) => c.value === 'L1')!;
  assert.equal(l1.selected, false);
  assert.ok(l1.detail!.includes('not free in window'));
});

test('itineraryLengthTargets spreads DISTINCT, ascending trip lengths across the stop pool', () => {
  // NCR-sized pool (13 stops, 2/day) → a short visit, a mid trip, and the full regional tour.
  const ncr = itineraryLengthTargets({ availableStops: 13, meetingsPerDay: 2 });
  assert.deepEqual(ncr, [2, 5, 7]);
  assert.equal(new Set(ncr).size, ncr.length, 'lengths are all different');
  assert.deepEqual([...ncr].sort((a, b) => a - b), ncr, 'lengths are ascending');
});

test('itineraryLengthTargets caps at maxDays and never exceeds what the pool can fill', () => {
  // Only enough stops for 3 days → offers 1/2/3-day trips, not a padded week.
  assert.deepEqual(itineraryLengthTargets({ availableStops: 6, meetingsPerDay: 2 }), [1, 2, 3]);
  // Huge pool but maxDays=4 → capped, still distinct.
  const capped = itineraryLengthTargets({ availableStops: 99, meetingsPerDay: 2, maxDays: 4 });
  assert.equal(Math.max(...capped), 4);
  assert.equal(new Set(capped).size, capped.length);
});

test('itineraryLengthTargets honours an explicit targetDays list (deduped + sorted) and count=1', () => {
  assert.deepEqual(itineraryLengthTargets({ availableStops: 99, targetDays: [3, 3, 1, 10] }), [1, 3, 10]);
  assert.deepEqual(itineraryLengthTargets({ availableStops: 13, meetingsPerDay: 2, count: 1 }), [7]);
  // A pool too small to differentiate collapses to a single 1-day option.
  assert.deepEqual(itineraryLengthTargets({ availableStops: 1, meetingsPerDay: 2 }), [1]);
});

// ── Hot topics — topic-first entry point (persona-trimmed footprint ranking) ─

const HT_TOPICS = [
  { id: 'T1', name: 'Industrial Base', smeAreas: [], approvedMessageId: 'M-T1' },
  { id: 'T2', name: 'Cyber', smeAreas: [], approvedMessageId: 'M-T2' },
  { id: 'T3', name: 'Innovation', smeAreas: [], approvedMessageId: null },
  { id: 'T4', name: 'Talent', smeAreas: [], approvedMessageId: 'M-T4' },
];

test('rankHotTopics ranks by live footprint (active + upcoming events) hottest-first', () => {
  const contacts = [
    { topicIds: ['T2'], status: 'active' },
    { topicIds: ['T2'], status: 'active' },
    { topicIds: ['T2'], status: 'prospect' },
    { topicIds: ['T1'], status: 'active' },
  ];
  const events = [
    { topicIds: ['T2'], start: '2025-10-20' }, // upcoming
    { topicIds: ['T1'], start: '2025-01-01' }, // past
  ];
  const ranked = rankHotTopics(contacts, events, HT_TOPICS as any, '2025-10-06');

  // T2: 2 active + 1 prospect + 1 upcoming event + approved msg => hottest.
  assert.equal(ranked[0].topicId, 'T2');
  assert.equal(ranked[0].activeCount, 2);
  assert.equal(ranked[0].upcomingEventCount, 1);
  assert.ok(ranked[0].hasApprovedMessage);
  // Ranked descending by score.
  for (let i = 1; i < ranked.length; i++) assert.ok(Number(ranked[i - 1].score) >= Number(ranked[i].score));
  // Zero-footprint topics (T3, T4) are not "hot" and are dropped.
  assert.ok(!ranked.some((t) => t.topicId === 'T3' || t.topicId === 'T4'));
});

test('rankHotTopics returns [] when the caller sees nothing', () => {
  assert.deepEqual(rankHotTopics([], [], HT_TOPICS as any, '2025-10-06'), []);
});

test('hotTopicQuestion is a free-form ask naming the topic', () => {
  const q = hotTopicQuestion('Cyber / zero-trust modernization');
  assert.ok(q.includes('Cyber / zero-trust modernization'));
  assert.ok(/who should we meet/i.test(q));
});
