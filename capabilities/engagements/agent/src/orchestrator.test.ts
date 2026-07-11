/**
 * Unit tests for the orchestrator's pure helpers — the grounding catalog, topic mapping, anchor
 * extraction, and the tool surface. These do NOT need a live MCP server or Azure OpenAI (the
 * end-to-end LLM/deterministic paths are exercised against a running capability, see README).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadLeaders, loadTopics, resolveDefaultLeaderId, rosterForPrompt, topicIdsFromText, topicsForPrompt } from './catalog.js';
import { AGENT_TOOLS } from './tools.js';
import { anchorGuess, buildSystemPrompt } from './orchestrator.js';

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
