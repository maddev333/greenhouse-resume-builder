/**
 * Seed-isolation guard for the Azure AI Search backend.
 *
 * The `search` backend must never fall back to `engagement-intelligence/seed`. A silent fallback
 * would serve the demo dataset while looking perfectly healthy — the worst possible failure mode
 * when the capability is pointed at a customer index. These tests pin that contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readmodelSource = readFileSync(join(here, "readmodel.ts"), "utf8");

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("RETRIEVAL_BACKEND=search without a configured service THROWS (never falls back to seed)", async () => {
  const { resolveBackend } = await import("./readmodel.js");
  withEnv(
    { RETRIEVAL_BACKEND: "search", AZURE_SEARCH_SERVICE: undefined },
    () => {
      assert.throws(
        () => resolveBackend(),
        /Refusing to fall back to the in-memory seed/,
        "search mode must fail loudly rather than quietly serving demo data",
      );
    },
  );
});

test("RETRIEVAL_BACKEND=search with a configured service selects search", async () => {
  const { resolveBackend } = await import("./readmodel.js");
  withEnv(
    {
      RETRIEVAL_BACKEND: "search",
      AZURE_SEARCH_SERVICE: "https://example.search.windows.net",
    },
    () => {
      assert.equal(resolveBackend(), "search");
    },
  );
});

test("the default backend is memory, which may use the seed", async () => {
  const { resolveBackend } = await import("./readmodel.js");
  withEnv(
    { RETRIEVAL_BACKEND: undefined, AZURE_SEARCH_SERVICE: undefined },
    () => {
      assert.equal(resolveBackend(), "memory");
    },
  );
});

test("readmodel does not import the seed loader at all", () => {
  // `loadDataset` / `applyLabels` read engagement-intelligence/seed. The search branch must not be
  // able to reach them, so the module should not import them in the first place.
  assert.doesNotMatch(
    readmodelSource,
    /\bloadDataset\b/,
    "readmodel must not import loadDataset — the search path would then be able to read the seed",
  );
  assert.doesNotMatch(
    readmodelSource,
    /\bapplyLabels\b/,
    "readmodel must not import applyLabels — it labels seed records",
  );
});

test("the search branch sources every record set from the index, not the seed", () => {
  const searchBranch = readmodelSource.slice(
    readmodelSource.indexOf('if (backend === "search")'),
    readmodelSource.indexOf("const idx = EngagementIndex.load()"),
  );
  assert.ok(searchBranch.length > 0, "expected to find the search branch");

  for (const kind of ["leader", "topic", "message", "region"]) {
    // `[^(]+` rather than `[^>]+` so nested generics like `<Labeled<Leader>>` still match.
    assert.match(
      searchBranch,
      new RegExp(`searchEngagementRecords<[^(]+>\\("${kind}"\\)`),
      `search branch must read ${kind}s from the index`,
    );
  }
  assert.match(
    searchBranch,
    /today: todayIso\(\)/,
    "search must use the real clock, not demoToday",
  );
  assert.doesNotMatch(
    searchBranch,
    /EngagementIndex/,
    "search must not construct the seed index",
  );
});
