/**
 * End-to-end capability tests — a real MCP Client talks to the server over an in-memory transport and
 * calls the registered tools, proving (a) the tool surface and (b) the canonical AUSA/UAS trace
 * through the tool contract.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

async function connect(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "engagements-test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  return res;
}

test("tools/list exposes the nine engagement tools", async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "build_itinerary",
      "nearby_leaders",
      "plan_options",
      "plan_radius",
      "search_contacts",
      "search_events",
      "suggest_candidates",
      "suggest_leaders",
      "survey_area",
    ]);
  } finally {
    await close();
  }
});

test("suggest_candidates: the AUSA/UAS menu ranks [P2, C4, C3]", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, "suggest_candidates", {
      leaderId: "L1",
      eventQuery: "AUSA",
      topicIds: ["T3"],
    });
    const ids = res.structuredContent.candidates.map(
      (c: { contactId: string }) => c.contactId,
    );
    assert.deepEqual(ids, ["P2", "C4", "C3"]);
  } finally {
    await close();
  }
});

test("search_contacts: T3 recall includes C4", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, "search_contacts", { topicIds: ["T3"] });
    const ids = res.structuredContent.contacts.map((c: { id: string }) => c.id);
    assert.ok(ids.includes("C4"));
  } finally {
    await close();
  }
});

test("search_events: AUSA resolves to E-AUSA", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, "search_events", { query: "AUSA" });
    const ids = res.structuredContent.events.map((e: { id: string }) => e.id);
    assert.ok(ids.includes("E-AUSA"));
  } finally {
    await close();
  }
});

test("search_events: an event id resolves directly for grounded follow-ups", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, "search_events", { query: "E-AUSA" });
    assert.deepEqual(
      res.structuredContent.events.map((e: { id: string }) => e.id),
      ["E-AUSA"],
    );
  } finally {
    await close();
  }
});

test("build_itinerary: accepting [P2, C4, C3] → routed stops, ROI and no over-budget", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, "build_itinerary", {
      leaderId: "L1",
      eventQuery: "AUSA",
      topicIds: ["T3"],
      acceptedContactIds: ["P2", "C4", "C3"],
    });
    assert.equal(res.structuredContent.accepted.length, 3);
    assert.equal(res.structuredContent.route.order.length, 3);
    assert.equal(typeof res.structuredContent.roi.roiScore, "number");
    assert.equal(res.structuredContent.roi.overBudget, false);
  } finally {
    await close();
  }
});

test("build_itinerary: additionalContactIds adds a regional swing (keeps on-site attendees, adds days)", async () => {
  const { client, close } = await connect();
  try {
    const core = await call(client, "build_itinerary", {
      leaderId: "L1",
      eventQuery: "AUSA",
      topicIds: ["T3"],
      acceptedContactIds: ["P2", "C4", "C3"],
    });
    const swing = await call(client, "build_itinerary", {
      leaderId: "L1",
      eventQuery: "AUSA",
      topicIds: ["T3"],
      acceptedContactIds: ["P2", "C4", "C3"],
      additionalContactIds: ["C11", "C29"], // Boston + Austin — far T3 stops beyond the nearby pool
    });
    const swingIds = swing.structuredContent.accepted.map(
      (c: { contactId: string }) => c.contactId,
    );
    // on-site attendee (P2) is retained AND the far stops are appended
    assert.ok(swingIds.includes("P2"), "keeps the on-site AUSA attendee P2");
    assert.ok(
      swingIds.includes("C11") && swingIds.includes("C29"),
      "adds the far regional-swing stops",
    );
    assert.equal(swing.structuredContent.accepted.length, 5);
    // a real cross-country swing genuinely lengthens the trip
    assert.ok(
      swing.structuredContent.duration.days >
        core.structuredContent.duration.days,
      `swing (${swing.structuredContent.duration.days}d) should be longer than core (${core.structuredContent.duration.days}d)`,
    );
  } finally {
    await close();
  }
});

test("build_itinerary: an unknown contact id is reported as notMatched, never routed", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, "build_itinerary", {
      leaderId: "L1",
      eventQuery: "AUSA",
      topicIds: ["T3"],
      acceptedContactIds: ["P2", "C3"],
      additionalContactIds: ["C-NOPE"],
    });
    const acceptedIds = res.structuredContent.accepted.map(
      (c: { contactId: string }) => c.contactId,
    );
    assert.ok(!acceptedIds.includes("C-NOPE"));
    assert.ok(res.structuredContent.notMatched.includes("C-NOPE"));
  } finally {
    await close();
  }
});

test("survey_area: anchoring on the NCR shows the area topics with an approved-message badge", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, "survey_area", { region: "NCR" });
    assert.equal(res.structuredContent.area.id, "R-NCR");
    const ids = res.structuredContent.topics.map(
      (t: { topicId: string }) => t.topicId,
    );
    assert.ok(ids.includes("T1"), "NCR has a T1 footprint");
    const t1 = res.structuredContent.topics.find(
      (t: { topicId: string }) => t.topicId === "T1",
    );
    assert.equal(t1.hasApprovedMessage, true);
  } finally {
    await close();
  }
});

test("suggest_leaders: returns a ranked menu of every leader as an option for the NCR", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, "suggest_leaders", {
      region: "NCR",
      window: { start: "2025-11-03", end: "2025-11-07" },
    });
    assert.equal(res.structuredContent.area.id, "R-NCR");
    const leaders = res.structuredContent.leaders as Array<{
      leaderId: string;
      score: number;
    }>;
    assert.ok(leaders.length >= 2, "always offers options");
    assert.ok(
      res.structuredContent.topicIds.length >= 1,
      "defaults to the area topics",
    );
    for (let i = 1; i < leaders.length; i++) {
      assert.ok(
        leaders[i - 1].score >= leaders[i].score,
        "options are ranked by score",
      );
    }
  } finally {
    await close();
  }
});

test("plan_options: NCR in AUSA week returns survey + leader + duration + extension menus", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, "plan_options", {
      region: "NCR",
      window: { start: "2025-10-13", end: "2025-10-17" },
    });
    const sc = res.structuredContent;
    assert.equal(sc.area.id, "R-NCR");
    // survey + leader options
    assert.ok(
      sc.areaSurvey.some((t: { topicId: string }) => t.topicId === "T1"),
      "NCR has a T1 footprint",
    );
    assert.ok(
      sc.areaSurvey.every(
        (t: { reason?: string }) => typeof t.reason === "string",
      ),
      "each hot topic carries a why",
    );
    // area intelligence: stale relationships to re-engage + event freshness, each with a why
    assert.ok(Array.isArray(sc.staleContacts), "stale-contact list is present");
    for (const c of sc.staleContacts) {
      assert.ok(
        c.overdueDays >= 0 && typeof c.reason === "string",
        "stale contact carries overdue + why",
      );
    }
    assert.ok(
      Array.isArray(sc.areaEvents),
      "area-event freshness list is present",
    );
    for (const e of sc.areaEvents) {
      assert.ok(
        ["lapsed", "in-window", "upcoming"].includes(e.status),
        "event carries a freshness verdict",
      );
      assert.ok(typeof e.reason === "string", "event carries a why");
    }
    assert.ok(sc.leaderOptions.length >= 2, "a ranked leader menu");
    assert.equal(
      sc.chosenLeaderId,
      sc.leaderOptions[0].leaderId,
      "top option chosen by default",
    );
    // event auto-absorption + stop-derived duration
    assert.ok(
      sc.absorbedEventIds.includes("E-AUSA"),
      "AUSA is pulled in as an in-area anchor",
    );
    assert.equal(sc.durationOptions[0].tier, "core");
    assert.ok(
      sc.durationOptions[0].days >= 4,
      "on-site conference days recovered",
    );
    // extensions always carry talking points
    assert.ok(Array.isArray(sc.extensionOptions));
    for (const e of sc.extensionOptions) {
      assert.ok(Array.isArray(e.talkingPoints) && e.talkingPoints.length >= 1);
      assert.ok(
        e.talkingPointsSource === "approved-message" ||
          e.talkingPointsSource === "coordinate",
      );
    }
  } finally {
    await close();
  }
});

test("plan_radius: anchor on a company for a fixed 3 days fills the trip (anchor first) + offers extensions", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, "plan_radius", {
      company: "Meridian Robotics",
      radiusMi: 80,
      days: 3,
      window: { start: "2025-10-13", end: "2025-10-15" },
    });
    const sc = res.structuredContent;
    assert.equal(sc.anchor.contactId, "C3", "the named company is the anchor");
    assert.equal(
      sc.area.resolvedVia,
      "coords",
      "a company anchor resolves to its HQ coordinate",
    );
    assert.equal(sc.capacity, 6, "3 days × 2 meetings/day");
    assert.ok(
      sc.stops.length >= 1 && sc.stops.length <= sc.capacity,
      "fills up to (not beyond) capacity",
    );
    assert.equal(
      sc.stops[0].contactId,
      "C3",
      "the must-meet company is stop #1",
    );
    assert.equal(
      sc.stops[0].placement,
      "on-site",
      "the anchor is met on-site at its HQ",
    );
    assert.ok(sc.leaderOptions.length >= 1, "a ranked leader menu is offered");
    assert.equal(
      sc.chosenLeaderId,
      sc.leaderOptions[0].leaderId,
      "top option chosen by default",
    );
    assert.ok(
      Array.isArray(sc.extensionOptions),
      "always offers extension options",
    );
  } finally {
    await close();
  }
});

test("plan_radius: raw coordinate + radius anchors without a must-meet company", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, "plan_radius", {
      lat: 38.9586,
      lng: -77.357,
      radiusMi: 60,
      days: 2,
      window: { start: "2025-10-13", end: "2025-10-14" },
    });
    const sc = res.structuredContent;
    assert.equal(
      sc.anchor,
      null,
      "a raw coordinate has no mandatory company stop",
    );
    assert.equal(sc.area.resolvedVia, "coords");
    assert.equal(sc.area.radiusMi, 60, "the user's radius bounds the trip");
    for (const s of sc.stops)
      assert.ok(
        s.distanceMi <= 60 + 1,
        "every stop is within the requested radius",
      );
  } finally {
    await close();
  }
});

test("build_itinerary: event-less radius build renders a company-anchored map, ROI over the fixed days", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, "build_itinerary", {
      leaderId: "L1",
      anchorContactId: "C3",
      radiusMi: 80,
      days: 3,
      window: { start: "2025-10-13", end: "2025-10-15" },
    });
    const sc = res.structuredContent;
    assert.equal(sc.anchor.contactId, "C3");
    assert.equal(sc.days, 3, "ROI is costed against the FIXED day count");
    assert.ok(sc.accepted.length >= 1);
    assert.equal(sc.accepted[0].contactId, "C3", "the anchor leads the route");
    assert.ok(sc.tripMap, "a trip map is produced for the event-less build");
    assert.equal(
      sc.tripMap.origin.id,
      "contact:C3",
      "the map origin pin is the company HQ",
    );
    assert.ok(!("event" in sc), "no anchor event in an event-less build");
  } finally {
    await close();
  }
});

test("nearby_leaders: event mode flags the other senior leaders at the same event (planning leader excluded)", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, "nearby_leaders", {
      leaderId: "L1",
      eventQuery: "AUSA",
    });
    const sc = res.structuredContent;
    assert.equal(sc.anchor.kind, "event");
    assert.equal(sc.anchor.id, "E-AUSA");
    const ids = sc.nearbyLeaders.map((n: { leaderId: string }) => n.leaderId);
    assert.ok(!ids.includes("L1"), "the planning leader is excluded");
    assert.ok(ids.includes("L5"), "L5 owns an AUSA attendee (same-event)");
    const l5 = sc.nearbyLeaders.find(
      (n: { leaderId: string }) => n.leaderId === "L5",
    );
    assert.ok(
      l5.reasons.some((r: { type: string }) => r.type === "same-event"),
    );
  } finally {
    await close();
  }
});

test("build_itinerary: event build carries nearby-leader awareness for the same event", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, "build_itinerary", {
      leaderId: "L1",
      eventQuery: "AUSA",
      topicIds: ["T3"],
      acceptedContactIds: ["P2", "C3"],
    });
    const sc = res.structuredContent;
    assert.ok(
      Array.isArray(sc.nearbyLeaders),
      "awareness is attached to the itinerary",
    );
    const ids = sc.nearbyLeaders.map((n: { leaderId: string }) => n.leaderId);
    assert.ok(!ids.includes("L1"), "the trip owner is not listed as nearby");
    assert.ok(ids.includes("L5"), "L5 is flagged as engaged at the same event");
  } finally {
    await close();
  }
});

test("build_itinerary: event-less radius build also carries nearby-leader awareness", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, "build_itinerary", {
      leaderId: "L1",
      anchorContactId: "C3",
      radiusMi: 80,
      days: 3,
      window: { start: "2025-10-13", end: "2025-10-15" },
    });
    const sc = res.structuredContent;
    assert.ok(
      Array.isArray(sc.nearbyLeaders),
      "radius build attaches awareness",
    );
    assert.ok(
      sc.nearbyLeaders.every((n: { leaderId: string }) => n.leaderId !== "L1"),
      "planning leader excluded",
    );
  } finally {
    await close();
  }
});
