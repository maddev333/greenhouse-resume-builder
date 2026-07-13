/**
 * End-to-end capability tests — a real MCP Client talks to the server over an in-memory transport and
 * calls the registered tools, proving (a) the tool surface, (b) the canonical AUSA/UAS trace through
 * the tool contract, and (c) that the security trim is enforced BY PERSONA at the tool boundary
 * (EA_G8 sees C4; EA_BASIC does not; NO_TENANT is rejected).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server.js';
import { resolveSecurityContext, type HeaderBag } from './context.js';

async function connect(persona: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(() => resolveSecurityContext({ 'x-demo-persona': persona } as HeaderBag));
  const client = new Client({ name: 'engagements-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  return res;
}

test('tools/list exposes the eight engagement tools', async () => {
  const { client, close } = await connect('EA_G8');
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'build_itinerary',
      'plan_options',
      'plan_radius',
      'search_contacts',
      'search_events',
      'suggest_candidates',
      'suggest_leaders',
      'survey_area',
    ]);
  } finally {
    await close();
  }
});

test('suggest_candidates: EA_G8 gets the full AUSA/UAS menu [P2, C4, C3]', async () => {
  const { client, close } = await connect('EA_G8');
  try {
    const res = await call(client, 'suggest_candidates', { leaderId: 'L1', eventQuery: 'AUSA', topicIds: ['T3'] });
    const ids = res.structuredContent.candidates.map((c: { contactId: string }) => c.contactId);
    assert.deepEqual(ids, ['P2', 'C4', 'C3']);
    assert.equal(res.structuredContent.rejected, false);
  } finally {
    await close();
  }
});

test('suggest_candidates: EA_BASIC cannot see G8-restricted C4 → [P2, C3] and a redaction', async () => {
  const { client, close } = await connect('EA_BASIC');
  try {
    const res = await call(client, 'suggest_candidates', { leaderId: 'L1', eventQuery: 'AUSA', topicIds: ['T3'] });
    const ids = res.structuredContent.candidates.map((c: { contactId: string }) => c.contactId);
    assert.deepEqual(ids, ['P2', 'C3']);
    assert.ok(res.structuredContent.redactedCount >= 1, 'at least C4 should be redacted');
  } finally {
    await close();
  }
});

test('suggest_candidates: NO_TENANT is rejected fail-closed (empty menu)', async () => {
  const { client, close } = await connect('NO_TENANT');
  try {
    const res = await call(client, 'suggest_candidates', { leaderId: 'L1', eventQuery: 'AUSA', topicIds: ['T3'] });
    assert.equal(res.structuredContent.rejected, true);
    assert.equal(res.structuredContent.candidates.length, 0);
  } finally {
    await close();
  }
});

test('search_contacts: T3 recall shows C4 for EA_G8 but not EA_BASIC', async () => {
  const g8 = await connect('EA_G8');
  try {
    const res = await call(g8.client, 'search_contacts', { topicIds: ['T3'] });
    const ids = res.structuredContent.contacts.map((c: { id: string }) => c.id);
    assert.ok(ids.includes('C4'), 'EA_G8 should see C4');
  } finally {
    await g8.close();
  }

  const basic = await connect('EA_BASIC');
  try {
    const res = await call(basic.client, 'search_contacts', { topicIds: ['T3'] });
    const ids = res.structuredContent.contacts.map((c: { id: string }) => c.id);
    assert.ok(!ids.includes('C4'), 'EA_BASIC must NOT see G8-restricted C4');
    assert.ok(res.structuredContent.redactedCount >= 1);
  } finally {
    await basic.close();
  }
});

test('search_events: AUSA resolves to E-AUSA for an authorized caller', async () => {
  const { client, close } = await connect('EA_BASIC');
  try {
    const res = await call(client, 'search_events', { query: 'AUSA' });
    const ids = res.structuredContent.events.map((e: { id: string }) => e.id);
    assert.ok(ids.includes('E-AUSA'));
  } finally {
    await close();
  }
});

test('build_itinerary: EA_G8 accepts [P2, C4, C3] → routed stops, ROI and no over-budget', async () => {
  const { client, close } = await connect('EA_G8');
  try {
    const res = await call(client, 'build_itinerary', {
      leaderId: 'L1',
      eventQuery: 'AUSA',
      topicIds: ['T3'],
      acceptedContactIds: ['P2', 'C4', 'C3'],
    });
    assert.equal(res.structuredContent.accepted.length, 3);
    assert.equal(res.structuredContent.route.order.length, 3);
    assert.equal(typeof res.structuredContent.roi.roiScore, 'number');
    assert.equal(res.structuredContent.roi.overBudget, false);
  } finally {
    await close();
  }
});

test('build_itinerary: EA_BASIC cannot route through C4 (not in its authorized set)', async () => {
  const { client, close } = await connect('EA_BASIC');
  try {
    const res = await call(client, 'build_itinerary', {
      leaderId: 'L1',
      eventQuery: 'AUSA',
      topicIds: ['T3'],
      acceptedContactIds: ['P2', 'C4', 'C3'],
    });
    const acceptedIds = res.structuredContent.accepted.map((c: { contactId: string }) => c.contactId).sort();
    assert.deepEqual(acceptedIds, ['C3', 'P2']);
    assert.deepEqual(res.structuredContent.notMatched, ['C4']);
  } finally {
    await close();
  }
});

test('survey_area: EA_G8 anchors on the NCR and sees the area topics with an approved-message badge', async () => {
  const { client, close } = await connect('EA_G8');
  try {
    const res = await call(client, 'survey_area', { region: 'NCR' });
    assert.equal(res.structuredContent.rejected, false);
    assert.equal(res.structuredContent.area.id, 'R-NCR');
    const ids = res.structuredContent.topics.map((t: { topicId: string }) => t.topicId);
    assert.ok(ids.includes('T1'), 'NCR has a T1 footprint');
    const t1 = res.structuredContent.topics.find((t: { topicId: string }) => t.topicId === 'T1');
    assert.equal(t1.hasApprovedMessage, true);
  } finally {
    await close();
  }
});

test('survey_area: NO_TENANT is rejected fail-closed (no topics leak)', async () => {
  const { client, close } = await connect('NO_TENANT');
  try {
    const res = await call(client, 'survey_area', { region: 'NCR' });
    assert.equal(res.structuredContent.rejected, true);
    assert.equal(res.structuredContent.topics.length, 0);
  } finally {
    await close();
  }
});

test('suggest_leaders: returns a ranked menu of every leader as an option for the NCR', async () => {
  const { client, close } = await connect('EA_G8');
  try {
    const res = await call(client, 'suggest_leaders', {
      region: 'NCR',
      window: { start: '2025-11-03', end: '2025-11-07' },
    });
    assert.equal(res.structuredContent.rejected, false);
    assert.equal(res.structuredContent.area.id, 'R-NCR');
    const leaders = res.structuredContent.leaders as Array<{ leaderId: string; score: number }>;
    assert.ok(leaders.length >= 2, 'always offers options');
    assert.ok(res.structuredContent.topicIds.length >= 1, 'defaults to the area topics');
    for (let i = 1; i < leaders.length; i++) {
      assert.ok(leaders[i - 1].score >= leaders[i].score, 'options are ranked by score');
    }
  } finally {
    await close();
  }
});

test('plan_options: NCR in AUSA week returns survey + leader + duration + extension menus', async () => {
  const { client, close } = await connect('EA_G8');
  try {
    const res = await call(client, 'plan_options', {
      region: 'NCR',
      window: { start: '2025-10-13', end: '2025-10-17' },
    });
    const sc = res.structuredContent;
    assert.equal(sc.rejected, false);
    assert.equal(sc.area.id, 'R-NCR');
    // survey + leader options
    assert.ok(sc.areaSurvey.some((t: { topicId: string }) => t.topicId === 'T1'), 'NCR has a T1 footprint');
    assert.ok(sc.leaderOptions.length >= 2, 'a ranked leader menu');
    assert.equal(sc.chosenLeaderId, sc.leaderOptions[0].leaderId, 'top option chosen by default');
    // event auto-absorption + stop-derived duration
    assert.ok(sc.absorbedEventIds.includes('E-AUSA'), 'AUSA is pulled in as an in-area anchor');
    assert.equal(sc.durationOptions[0].tier, 'core');
    assert.ok(sc.durationOptions[0].days >= 4, 'on-site conference days recovered');
    // extensions always carry talking points
    assert.ok(Array.isArray(sc.extensionOptions));
    for (const e of sc.extensionOptions) {
      assert.ok(Array.isArray(e.talkingPoints) && e.talkingPoints.length >= 1);
      assert.ok(e.talkingPointsSource === 'approved-message' || e.talkingPointsSource === 'coordinate');
    }
  } finally {
    await close();
  }
});

test('plan_options: NO_TENANT is rejected fail-closed (no plan leaks)', async () => {
  const { client, close } = await connect('NO_TENANT');
  try {
    const res = await call(client, 'plan_options', {
      region: 'NCR',
      window: { start: '2025-10-13', end: '2025-10-17' },
    });
    assert.equal(res.structuredContent.rejected, true);
    assert.equal(res.structuredContent.durationOptions.length, 0);
    assert.equal(res.structuredContent.extensionOptions.length, 0);
  } finally {
    await close();
  }
});

test('plan_radius: anchor on a company for a fixed 3 days fills the trip (anchor first) + offers extensions', async () => {
  const { client, close } = await connect('EA_G8');
  try {
    const res = await call(client, 'plan_radius', {
      company: 'Meridian Robotics',
      radiusMi: 80,
      days: 3,
      window: { start: '2025-10-13', end: '2025-10-15' },
    });
    const sc = res.structuredContent;
    assert.equal(sc.rejected, false);
    assert.equal(sc.anchor.contactId, 'C3', 'the named company is the anchor');
    assert.equal(sc.area.resolvedVia, 'coords', 'a company anchor resolves to its HQ coordinate');
    assert.equal(sc.capacity, 6, '3 days × 2 meetings/day');
    assert.ok(sc.stops.length >= 1 && sc.stops.length <= sc.capacity, 'fills up to (not beyond) capacity');
    assert.equal(sc.stops[0].contactId, 'C3', 'the must-meet company is stop #1');
    assert.equal(sc.stops[0].placement, 'on-site', 'the anchor is met on-site at its HQ');
    assert.ok(sc.leaderOptions.length >= 1, 'a ranked leader menu is offered');
    assert.equal(sc.chosenLeaderId, sc.leaderOptions[0].leaderId, 'top option chosen by default');
    assert.ok(Array.isArray(sc.extensionOptions), 'always offers extension options');
  } finally {
    await close();
  }
});

test('plan_radius: raw coordinate + radius anchors without a must-meet company', async () => {
  const { client, close } = await connect('EA_G8');
  try {
    const res = await call(client, 'plan_radius', {
      lat: 38.9586,
      lng: -77.357,
      radiusMi: 60,
      days: 2,
      window: { start: '2025-10-13', end: '2025-10-14' },
    });
    const sc = res.structuredContent;
    assert.equal(sc.rejected, false);
    assert.equal(sc.anchor, null, 'a raw coordinate has no mandatory company stop');
    assert.equal(sc.area.resolvedVia, 'coords');
    assert.equal(sc.area.radiusMi, 60, "the user's radius bounds the trip");
    for (const s of sc.stops) assert.ok(s.distanceMi <= 60 + 1, 'every stop is within the requested radius');
  } finally {
    await close();
  }
});

test('build_itinerary: event-less radius build renders a company-anchored map, ROI over the fixed days', async () => {
  const { client, close } = await connect('EA_G8');
  try {
    const res = await call(client, 'build_itinerary', {
      leaderId: 'L1',
      anchorContactId: 'C3',
      radiusMi: 80,
      days: 3,
      window: { start: '2025-10-13', end: '2025-10-15' },
    });
    const sc = res.structuredContent;
    assert.equal(sc.anchor.contactId, 'C3');
    assert.equal(sc.days, 3, 'ROI is costed against the FIXED day count');
    assert.ok(sc.accepted.length >= 1);
    assert.equal(sc.accepted[0].contactId, 'C3', 'the anchor leads the route');
    assert.ok(sc.tripMap, 'a trip map is produced for the event-less build');
    assert.equal(sc.tripMap.origin.id, 'contact:C3', 'the map origin pin is the company HQ');
    assert.ok(!('event' in sc), 'no anchor event in an event-less build');
  } finally {
    await close();
  }
});

test('plan_radius: NO_TENANT is rejected fail-closed (no stops leak)', async () => {
  const { client, close } = await connect('NO_TENANT');
  try {
    const res = await call(client, 'plan_radius', {
      company: 'Meridian Robotics',
      days: 3,
      window: { start: '2025-10-13', end: '2025-10-15' },
    });
    assert.equal(res.structuredContent.rejected, true);
    assert.equal(res.structuredContent.stops.length, 0);
    assert.equal(res.structuredContent.extensionOptions.length, 0);
  } finally {
    await close();
  }
});
