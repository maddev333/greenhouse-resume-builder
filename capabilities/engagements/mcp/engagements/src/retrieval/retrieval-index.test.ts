import test from "node:test";
import assert from "node:assert/strict";
import { EngagementIndex } from "./retrieval-index";
import { suggest } from "../planner/suggest";
import { anchorFromEvent } from "../planner/seed-loader";

const idx = EngagementIndex.load();
const ids = <T extends { id: string }>(rows: T[]): string[] =>
  rows.map((r) => r.id).sort();

test("searchContacts with no filters returns the whole staged contact set", () => {
  const rows = idx.searchContacts({});
  assert.equal(rows.length, 39);
  assert.ok(ids(rows).includes("C4"));
});

test("free-text query matches a contact by city/state, not just name/org (geo lookup)", () => {
  // A location-first ask ("who's in Austin TX?") must find contacts physically there even when the
  // city name never appears in their name/org — the haystack includes location.city + state.
  const austin = idx.searchContacts({ query: "Austin TX" });
  assert.deepEqual(ids(austin), ["C29", "C30", "C6", "P3"]);

  const sanAntonio = idx.searchContacts({ query: "San Antonio" });
  assert.deepEqual(ids(sanAntonio), ["C9"]);
});

test("canonical AUSA/UAS trace: recall feeds suggest() and ranks [P2, C4, C3]", () => {
  const ds = idx.labeled;
  const event = ds.events.find((e) => e.id === "E-AUSA")!;
  const leader = ds.leaders.find((l) => l.id === "L1")!;
  const contacts = idx.searchContacts({});
  const anchor = { ...anchorFromEvent(event), topicIds: ["T3"] };
  const trace = suggest({
    leader,
    anchor,
    contacts,
    event,
    requireTopicMatch: true,
  }).map((c) => c.contactId);
  assert.deepEqual(trace, ["P2", "C4", "C3"]); // matches the M0 canonical trace
});

test('findEvent resolves "AUSA" to the AUSA anchor', () => {
  assert.equal(idx.findEvent("AUSA")?.id, "E-AUSA");
});

test("preferences NARROW recall (doNotMeet drops C4; seniorityFloor gates value)", () => {
  const dropped = idx.searchContacts({ preferences: { doNotMeet: ["C4"] } });
  assert.ok(!ids(dropped).includes("C4"));

  const floored = idx.searchContacts({ preferences: { seniorityFloor: 5 } });
  assert.ok(floored.every((c) => c.strategicValue >= 5));
});
