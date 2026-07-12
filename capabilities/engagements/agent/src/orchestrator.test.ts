/**
 * Unit tests for the orchestrator's pure helpers — the grounding catalog, topic mapping, anchor
 * extraction, and the tool surface. These do NOT need a live MCP server or Azure OpenAI (the
 * end-to-end LLM/deterministic paths are exercised against a running capability, see README).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadLeaders, loadRegions, loadTopics, defaultWindow, regionChoices, resolveAreaInput, resolveDefaultLeaderId, rosterForPrompt, topicIdsFromText, topicsForPrompt } from './catalog.js';
import { AGENT_TOOLS } from './tools.js';
import { anchorGuess, areaClarifyQuestion, buildOptionQuestions, buildSystemPrompt, selectedContactIds } from './orchestrator.js';

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

test('AGENT_TOOLS expose the 4 engagements tools with required fields', () => {
  assert.deepEqual(
    AGENT_TOOLS.map((t) => t.name),
    ['search_contacts', 'search_events', 'suggest_candidates', 'build_itinerary'],
  );
  const suggest = AGENT_TOOLS.find((t) => t.name === 'suggest_candidates')!;
  assert.deepEqual((suggest.parameters as any).required, ['leaderId']);
  const build = AGENT_TOOLS.find((t) => t.name === 'build_itinerary')!;
  assert.deepEqual((build.parameters as any).required, ['leaderId', 'acceptedContactIds']);
});

test('anchorGuess extracts the AUSA acronym from the canonical demo question', () => {
  assert.equal(anchorGuess("I'm planning a trip to AUSA, who should I meet on UAS/drone?"), 'AUSA');
});

test('anchorGuess falls back to the phrase after a preposition', () => {
  assert.equal(anchorGuess('planning a visit to Fort Bragg next week'), 'Fort Bragg');
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

test('resolveAreaInput falls back to a city after a locative preposition', () => {
  assert.deepEqual(resolveAreaInput('any reason to travel to Huntsville next month?'), { city: 'Huntsville' });
});

test('resolveAreaInput returns null when nothing anchors an area', () => {
  assert.equal(resolveAreaInput('what should i have for lunch'), null);
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
    { leaderId: 'L2', name: 'MG Two', role: 'DCG', score: '0.81', distanceKm: 12, availableInWindow: true },
    { leaderId: 'L1', name: 'GEN One', role: 'CG', score: '0.64', distanceKm: 40, availableInWindow: false },
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
