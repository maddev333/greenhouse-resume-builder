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

test('tools/list exposes the four engagement tools', async () => {
  const { client, close } = await connect('EA_G8');
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['build_itinerary', 'search_contacts', 'search_events', 'suggest_candidates']);
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
