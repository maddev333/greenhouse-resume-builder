import test from "node:test";
import assert from "node:assert/strict";
import type { Contact } from "@greenhouse-resume-builder/shared";
import {
  valueNorm,
  stalenessNorm,
  topicRelevance,
  suggestionScore,
} from "./score";

const baseContact = (over: Partial<Contact>): Contact => ({
  id: "C",
  createdAt: "2025-10-06",
  name: "Test",
  type: "company",
  domain: "non-technical",
  smeAreas: [],
  topicIds: ["T3"],
  location: { city: "X", lat: 0, lng: 0 },
  relationshipOwnerLeaderIds: [],
  strategicValue: 4,
  status: "active",
  lastInteractionDate: "2025-02-10",
  ...over,
});

test("valueNorm maps 1–5 → 0.2–1.0", () => {
  assert.equal(valueNorm(5), 1);
  assert.equal(valueNorm(4), 0.8);
  assert.equal(valueNorm(1), 0.2);
});

test("stalenessNorm: no history → 0; same day → 0; older is more stale", () => {
  assert.equal(stalenessNorm(undefined, "2025-10-06"), 0);
  assert.equal(stalenessNorm("2025-10-06", "2025-10-06"), 0);
  const older = stalenessNorm("2024-11-15", "2025-10-06");
  const newer = stalenessNorm("2025-08-01", "2025-10-06");
  assert.ok(older > newer, `older ${older} should exceed newer ${newer}`);
  assert.ok(older > 0 && older <= 1);
});

test("topicRelevance: hit=1.0, miss=0.2, no-target=0.5", () => {
  assert.equal(topicRelevance(["T3"], ["T3"]), 1.0);
  assert.equal(topicRelevance(["T1"], ["T3"]), 0.2);
  assert.equal(topicRelevance(["T1"], undefined), 0.5);
  assert.equal(topicRelevance(["T1", "T3"], ["T3"]), 1.0);
});

test("suggestionScore(active) = staleness × value × topic", () => {
  const c = baseContact({
    strategicValue: 4,
    topicIds: ["T3"],
    lastInteractionDate: "2024-11-15",
  });
  const { score, factors } = suggestionScore(c, ["T3"], "2025-10-06");
  assert.ok(factors.stalenessNorm > 0);
  assert.equal(factors.valueNorm, 0.8);
  assert.equal(factors.topicRelevance, 1.0);
  assert.ok(Math.abs(score - factors.stalenessNorm * 0.8 * 1.0) < 1e-9);
});

test("suggestionScore(prospect) omits staleness (initiate path)", () => {
  const p = baseContact({
    status: "prospect",
    strategicValue: 4,
    topicIds: ["T3"],
    lastInteractionDate: undefined,
  });
  const { score, factors } = suggestionScore(p, ["T3"], "2025-10-06");
  assert.equal(factors.stalenessNorm, 0);
  assert.ok(Math.abs(score - 0.8 * 1.0) < 1e-9);
});

test("a very stale, high-value, on-topic active contact outranks a fresh one", () => {
  const stale = baseContact({
    lastInteractionDate: "2024-11-15",
    strategicValue: 4,
  });
  const fresh = baseContact({
    lastInteractionDate: "2025-09-20",
    strategicValue: 4,
  });
  const s = suggestionScore(stale, ["T3"], "2025-10-06").score;
  const f = suggestionScore(fresh, ["T3"], "2025-10-06").score;
  assert.ok(s > f);
});
