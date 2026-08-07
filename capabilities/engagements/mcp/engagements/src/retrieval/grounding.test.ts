import { test } from "node:test";
import assert from "node:assert/strict";
import { selectGroundingHits, type GroundingHit } from "./grounding.js";

function hit(id: string, score: number, parentId: string): GroundingHit {
  return { id, score, parentId, content: id };
}

test("grounding selection keeps one passage per parent by default", () => {
  const selected = selectGroundingHits(
    [
      hit("contacts-1", 5, "contacts.json"),
      hit("contacts-2", 4, "contacts.json"),
      hit("event-1", 3, "events.json"),
    ],
    3,
  );

  assert.deepEqual(
    selected.map(({ id }) => id),
    ["contacts-1", "event-1"],
  );
});

test("grounding selection can retain several record chunks from one parent", () => {
  const selected = selectGroundingHits(
    [
      hit("contacts-1", 5, "contacts.json"),
      hit("contacts-2", 4, "contacts.json"),
      hit("contacts-3", 3, "contacts.json"),
      hit("event-1", 2, "events.json"),
    ],
    4,
    3,
  );

  assert.deepEqual(
    selected.map(({ id }) => id),
    ["contacts-1", "contacts-2", "contacts-3", "event-1"],
  );
});
