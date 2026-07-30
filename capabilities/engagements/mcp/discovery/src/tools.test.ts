/**
 * Capability tests — a real MCP Client talks to the server over an in-memory transport while
 * `globalThis.fetch` is stubbed, so the tool contract and the Azure Maps request/response mapping are
 * proven without touching the network (and without needing a real key).
 */

import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

interface RecordedCall {
  url: URL;
  headers: Record<string, string>;
}

let calls: RecordedCall[] = [];
let realFetch: typeof globalThis.fetch;
let realKey: string | undefined;

const GEOCODE_BODY = {
  results: [
    {
      position: { lat: 34.7304, lon: -86.5861 },
      address: { freeformAddress: "Huntsville, AL" },
    },
  ],
};

const POI_BODY = {
  results: [
    {
      id: "poi-far",
      dist: 4828.03, // 3.0 mi
      position: { lat: 34.75, lon: -86.6 },
      address: {
        freeformAddress: "100 Far St",
        municipality: "Huntsville",
        countrySubdivision: "AL",
        postalCode: "35801",
      },
      poi: {
        name: "Far Robotics",
        categories: ["company"],
        phone: "+1 256-555-0100",
        url: "farrobotics.example",
      },
    },
    {
      id: "poi-near",
      dist: 1609.344, // 1.0 mi
      position: { lat: 34.735, lon: -86.59 },
      address: {
        freeformAddress: "1 Near Ave",
        municipality: "Huntsville",
        countrySubdivision: "AL",
        postalCode: "35802",
      },
      poi: {
        name: "Near Defense Systems",
        categories: ["company", "defense"],
        brands: [{ name: "NDS" }],
      },
    },
    {
      // Geocoder-style hit with no `poi` block — must be dropped, it is not a business.
      id: "addr-only",
      position: { lat: 34.7, lon: -86.5 },
      address: { freeformAddress: "Some Street" },
    },
  ],
};

type FetchArgs = Parameters<typeof globalThis.fetch>;

function stubFetch(): void {
  globalThis.fetch = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const body = url.pathname.includes("search/address")
      ? GEOCODE_BODY
      : POI_BODY;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  realKey = process.env.AZURE_MAPS_KEY;
  process.env.AZURE_MAPS_KEY = "test-key";
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.AZURE_MAPS_KEY;
  else process.env.AZURE_MAPS_KEY = realKey;
});

async function connect(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "discovery-test", version: "0.0.0" });
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
  args: Record<string, unknown>,
): Promise<any> {
  return client.callTool({ name: "search_businesses", arguments: args });
}

test("tools/list exposes only search_businesses", async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["search_businesses"],
    );
  } finally {
    await close();
  }
});

test("city/state anchor geocodes, then POI-searches, and normalizes results nearest-first", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, {
      city: "Huntsville",
      state: "AL",
      query: "defense",
      radiusMi: 5,
    });
    const { anchor, businesses, count, query } = res.structuredContent;

    assert.equal(count, 2, "the address-only hit is dropped");
    assert.equal(query, "defense");
    assert.deepEqual(anchor, {
      lat: 34.7304,
      lng: -86.5861,
      label: "Huntsville, AL",
      radiusMi: 5,
    });
    assert.deepEqual(
      businesses.map((b: { name: string }) => b.name),
      ["Near Defense Systems", "Far Robotics"],
    );

    const [nearest] = businesses;
    assert.equal(nearest.distanceMi, 1);
    assert.equal(nearest.city, "Huntsville");
    assert.equal(nearest.state, "AL");
    assert.equal(nearest.category, "company");
    assert.equal(nearest.brand, "NDS");

    assert.deepEqual(
      calls.map((c) => c.url.pathname),
      ["/search/address/json", "/search/poi/json"],
    );
  } finally {
    await close();
  }
});

test("lat/lng anchor skips geocoding; an empty query uses the nearby sweep", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, { lat: 34.7304, lng: -86.5861 });
    assert.equal(res.structuredContent.query, null);
    assert.deepEqual(
      calls.map((c) => c.url.pathname),
      ["/search/nearby/json"],
    );
  } finally {
    await close();
  }
});

test("the subscription key travels as a header and never in the URL", async () => {
  const { client, close } = await connect();
  try {
    await call(client, { city: "Huntsville", state: "AL" });
    for (const c of calls) {
      assert.equal(c.headers["subscription-key"], "test-key");
      assert.equal(c.url.searchParams.get("subscription-key"), null);
      assert.ok(
        !c.url.href.includes("test-key"),
        "key must not appear anywhere in the URL",
      );
    }
  } finally {
    await close();
  }
});

test("radius is clamped to the Azure Maps 50km ceiling", async () => {
  const { client, close } = await connect();
  try {
    await call(client, { lat: 34.7304, lng: -86.5861, radiusMi: 9999 });
    const radius = Number(calls[0].url.searchParams.get("radius"));
    assert.equal(
      radius,
      49890,
      "31 mi clamp -> 49890 m, under the 50000 m cap",
    );
  } finally {
    await close();
  }
});

test("focus groups map to a deduped Azure Maps categorySet; no focus sends none", async () => {
  const { client, close } = await connect();
  try {
    await call(client, {
      lat: 34.7304,
      lng: -86.5861,
      focus: ["academia", "research"],
    });
    assert.equal(calls[0].url.searchParams.get("categorySet"), "7377,9157");

    calls = [];
    await call(client, { lat: 34.7304, lng: -86.5861 });
    assert.equal(calls[0].url.searchParams.get("categorySet"), null);
  } finally {
    await close();
  }
});

test("focus groups beyond the 10-category ceiling are dropped whole and reported", async () => {
  const { client, close } = await connect();
  try {
    // All seven groups resolve to 14 ids; Azure Maps answers HTTP 400 above 10.
    const res = await call(client, {
      lat: 34.7304,
      lng: -86.5861,
      focus: [
        "industry",
        "technology",
        "manufacturing",
        "research",
        "academia",
        "government",
        "venues",
      ],
    });

    const sent = calls[0].url.searchParams.get("categorySet")!.split(",");
    assert.ok(
      sent.length <= 10,
      `expected <=10 categories, sent ${sent.length}`,
    );

    // industry(3) + technology(4) + manufacturing(3) fills the budget exactly; the rest drop out.
    assert.deepEqual(res.structuredContent.focus, [
      "industry",
      "technology",
      "manufacturing",
    ]);
    assert.deepEqual(res.structuredContent.focusDropped, [
      "research",
      "academia",
      "government",
      "venues",
    ]);

    // A dropped group must never be described as if it had been searched.
    assert.ok(!res.content[0].text.includes("venues"));
  } finally {
    await close();
  }
});

test("an unknown focus value is rejected before any upstream call", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, {
      lat: 34.7304,
      lng: -86.5861,
      focus: ["nightlife"],
    });
    assert.equal(res.isError, true);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test("a missing anchor is a tool error, not a crash", async () => {
  const { client, close } = await connect();
  try {
    const res = await call(client, { query: "defense" });
    assert.equal(res.isError, true);
    assert.match(res.structuredContent.error, /Provide an anchor/);
    assert.equal(calls.length, 0, "no upstream call is made without an anchor");
  } finally {
    await close();
  }
});

test("a missing AZURE_MAPS_KEY is reported as a tool error", async () => {
  delete process.env.AZURE_MAPS_KEY;
  const { client, close } = await connect();
  try {
    const res = await call(client, { city: "Huntsville", state: "AL" });
    assert.equal(res.isError, true);
    assert.match(res.structuredContent.error, /AZURE_MAPS_KEY/);
  } finally {
    await close();
  }
});

test("an upstream failure surfaces the status without leaking the key or the body", async () => {
  globalThis.fetch = (async () =>
    new Response('{"error":{"message":"key test-key rejected"}}', {
      status: 401,
    })) as typeof globalThis.fetch;

  const { client, close } = await connect();
  try {
    const res = await call(client, { lat: 34.7304, lng: -86.5861 });
    assert.equal(res.isError, true);
    assert.match(res.structuredContent.error, /HTTP 401/);
    assert.ok(
      !res.structuredContent.error.includes("test-key"),
      "upstream body must not be echoed",
    );
  } finally {
    await close();
  }
});
