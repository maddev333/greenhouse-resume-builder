/**
 * Engagement-CATEGORY coverage tests — the "identification across Congressional / Academia / Industry /
 * Army-internal" outcome. Confirms the four target audiences are ALWAYS reported (even at zero, so a gap
 * is explicit), `other` only when present, itinerary coverage is tracked, and the sector→category roll-up
 * is total. Mix of synthetic fixtures (deterministic math) and one real-seed NCR sanity check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Contact, GeoPoint } from "@greenhouse-resume-builder/shared";
import { categoryForSector } from "@greenhouse-resume-builder/shared";
import type { DemoConfig } from "./clock";
import { loadDataset } from "./seed-loader";
import { resolveArea } from "./area";
import {
  categoryBreakdown,
  categoryCountsForStops,
  summarizeCategoryCounts,
} from "./categories";

const env = { createdAt: "2025-01-01" };
const DC: GeoPoint = {
  city: "Washington",
  state: "DC",
  lat: 38.9072,
  lng: -77.0369,
};
const FAR: GeoPoint = {
  city: "Boston",
  state: "MA",
  lat: 42.3601,
  lng: -71.0589,
};
const CFG: DemoConfig = {
  today: "2025-10-06",
  staleCutoffDays: 180,
  shiftMonths: 0,
};

function contact(over: Partial<Contact> & Pick<Contact, "id">): Contact {
  return {
    ...env,
    id: over.id,
    name: over.name ?? over.id,
    type: "org",
    domain: "non-technical",
    smeAreas: [],
    topicIds: over.topicIds ?? ["T1"],
    location: over.location ?? DC,
    relationshipOwnerLeaderIds: [],
    strategicValue: over.strategicValue ?? 3,
    status: over.status ?? "active",
    ...over,
  } as Contact;
}

test("categoryForSector: every sector rolls up into a target audience (or other)", () => {
  assert.equal(categoryForSector("industry"), "industry");
  assert.equal(categoryForSector("academic"), "academia");
  assert.equal(categoryForSector("congressional"), "congressional");
  assert.equal(categoryForSector("political"), "congressional"); // policy sphere rolls up with Congress
  assert.equal(categoryForSector("army-internal"), "army-internal");
  assert.equal(categoryForSector("government"), "army-internal");
  assert.equal(categoryForSector("nonprofit"), "other");
  assert.equal(categoryForSector("international"), "other");
  assert.equal(categoryForSector(undefined), "other");
});

test("categoryBreakdown: always emits the four target audiences, even at zero (coverage gap is explicit)", () => {
  // Only an industry contact in-area → the other three targets still surface at zero.
  const breakdown = categoryBreakdown({
    centroid: DC,
    radiusMi: 75,
    contacts: [contact({ id: "X", sector: "industry" })],
    cfg: CFG,
  });
  const byCat = new Map(breakdown.map((c) => [c.category, c]));
  for (const cat of [
    "congressional",
    "academia",
    "industry",
    "army-internal",
  ] as const) {
    assert.ok(byCat.has(cat), `${cat} must always be reported`);
  }
  assert.ok(!byCat.has("other"), "`other` is omitted when empty");
  assert.equal(byCat.get("industry")!.total, 1);
  assert.equal(byCat.get("congressional")!.total, 0);
  assert.match(
    byCat.get("congressional")!.reason,
    /no Congressional engagements/,
  );
});

test("categoryBreakdown: buckets by audience, excludes out-of-radius, and flags stale", () => {
  const contacts = [
    contact({
      id: "HILL",
      sector: "congressional",
      lastInteractionDate: "2024-06-01",
    }), // stale
    contact({
      id: "UNI",
      sector: "academic",
      lastInteractionDate: "2025-09-20",
    }), // fresh
    contact({
      id: "PRIME",
      sector: "industry",
      lastInteractionDate: "2024-01-01",
    }), // stale
    contact({ id: "HQDA", sector: "army-internal", status: "prospect" }),
    contact({ id: "FARHILL", sector: "congressional", location: FAR }), // out of radius → excluded
  ];
  const breakdown = categoryBreakdown({
    centroid: DC,
    radiusMi: 75,
    contacts,
    cfg: CFG,
  });
  const byCat = new Map(breakdown.map((c) => [c.category, c]));
  assert.equal(
    byCat.get("congressional")!.total,
    1,
    "the far Hill contact is excluded",
  );
  assert.equal(byCat.get("congressional")!.staleCount, 1);
  assert.equal(
    byCat.get("academia")!.staleCount,
    0,
    "the fresh university is not stale",
  );
  assert.equal(byCat.get("army-internal")!.prospectCount, 1);
});

test("categoryBreakdown: itineraryContactIds drive coverage + the gap flag", () => {
  const contacts = [
    contact({ id: "HILL", sector: "congressional" }),
    contact({ id: "PRIME", sector: "industry" }),
  ];
  const breakdown = categoryBreakdown({
    centroid: DC,
    radiusMi: 75,
    contacts,
    itineraryContactIds: ["PRIME"], // only industry is on the trip
    cfg: CFG,
  });
  const byCat = new Map(breakdown.map((c) => [c.category, c]));
  assert.equal(byCat.get("industry")!.covered, true);
  assert.equal(byCat.get("industry")!.onItineraryCount, 1);
  assert.equal(
    byCat.get("congressional")!.covered,
    false,
    "congressional is present but unreached → gap",
  );
  assert.match(byCat.get("congressional")!.reason, /coverage gap/);
});

test("categoryCountsForStops + summarizeCategoryCounts: audience mix for a stop set", () => {
  const byId = new Map<string, Contact>([
    ["A", contact({ id: "A", sector: "industry" })],
    ["B", contact({ id: "B", sector: "industry" })],
    ["C", contact({ id: "C", sector: "academic" })],
  ]);
  const counts = categoryCountsForStops(
    [{ contactId: "A" }, { contactId: "B" }, { contactId: "C" }],
    byId,
  );
  assert.equal(counts.industry, 2);
  assert.equal(counts.academia, 1);
  assert.equal(summarizeCategoryCounts(counts), "Academia×1 · Industry×2"); // report order
});

test("categoryBreakdown: the real-seed NCR identifies engagements across all four audiences", () => {
  const ds = loadDataset();
  const area = resolveArea({ regionId: "R-NCR" }, ds.regions)!;
  const breakdown = categoryBreakdown({
    centroid: area.centroid,
    radiusMi: area.radiusMi,
    contacts: ds.contacts,
    cfg: ds.cfg,
  });
  const byCat = new Map(breakdown.map((c) => [c.category, c]));
  assert.ok(
    (byCat.get("congressional")?.total ?? 0) >= 2,
    "C31/C32 give the NCR a Congressional footprint",
  );
  assert.ok(
    (byCat.get("army-internal")?.total ?? 0) >= 2,
    "C33/C34 (+APG) give an Army-internal footprint",
  );
  assert.ok(
    (byCat.get("industry")?.total ?? 0) >= 1,
    "the NCR has Industry engagements",
  );
  assert.ok(byCat.has("academia"), "academia is always reported, even if thin");
});
