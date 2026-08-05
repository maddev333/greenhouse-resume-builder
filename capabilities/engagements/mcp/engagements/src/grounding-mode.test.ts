/**
 * Grounding-only mode: a plain document/chunk RAG index carries no structured records, so the
 * deterministic planner must be unavailable and the seed must stay untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

const GROUNDING_SCHEMA = resolve(
  import.meta.dirname,
  "../index-schema.grounding.example.json",
);

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return (async () => fn())().finally(restore);
}

const GROUNDING_ENV = {
  RETRIEVAL_BACKEND: "grounding",
  AZURE_SEARCH_SERVICE: "https://example.search.windows.net",
  ENGAGEMENTS_INDEX_SCHEMA: GROUNDING_SCHEMA,
};

/** Minimal stand-in capturing tool names; ext-apps also registers a UI resource. */
function fakeServer(registered: string[]) {
  return {
    registerTool(name: string) {
      registered.push(name);
    },
    registerResource() {},
    registerPrompt() {},
    server: { registerCapabilities() {} },
  } as unknown as Parameters<
    typeof import("./tools.js").registerEngagementTools
  >[0];
}

test("a grounding-only declaration validates without entityType or payload", async () => {
  const { reloadIndexSchema, isGroundingConfigured, isPlannerConfigured } =
    await import("./retrieval/index-schema.js");

  await withEnv({ ENGAGEMENTS_INDEX_SCHEMA: GROUNDING_SCHEMA }, () => {
    const schema = reloadIndexSchema();
    assert.equal(isGroundingConfigured(schema), true);
    assert.equal(isPlannerConfigured(schema), false, "planner must be off");
    assert.equal(schema.mapping.payload ?? null, null);
    assert.equal(schema.mapping.grounding?.content, "chunk");
  });
  const { reloadIndexSchema: reload } =
    await import("./retrieval/index-schema.js");
  reload(); // restore the default declaration for other tests
});

test("RETRIEVAL_BACKEND=grounding resolves and refuses the planner read model", async () => {
  const { resolveBackend, getReadModel } = await import("./readmodel.js");

  await withEnv(GROUNDING_ENV, async () => {
    assert.equal(resolveBackend(), "grounding");
    await assert.rejects(
      () => getReadModel(),
      /deterministic planner cannot run/,
      "grounding mode must not hand back a planner read model",
    );
  });
});

test("an unrecognised RETRIEVAL_BACKEND is rejected", async () => {
  const { resolveBackend } = await import("./readmodel.js");
  await withEnv({ RETRIEVAL_BACKEND: "nonsense" }, () => {
    assert.throws(() => resolveBackend(), /is not recognised/);
  });
});

test("grounding mode registers ONLY search_grounding", async () => {
  const { registerEngagementTools } = await import("./tools.js");

  await withEnv(GROUNDING_ENV, () => {
    const registered: string[] = [];
    registerEngagementTools(fakeServer(registered));
    assert.deepEqual(registered, ["search_grounding"]);
  });
});

test("memory mode registers the planner tools and no grounding tool", async () => {
  const { registerEngagementTools } = await import("./tools.js");

  await withEnv(
    { RETRIEVAL_BACKEND: "memory", ENGAGEMENTS_INDEX_SCHEMA: undefined },
    () => {
      const registered: string[] = [];
      registerEngagementTools(fakeServer(registered));
      assert.ok(
        registered.includes("search_contacts"),
        "planner tools expected",
      );
      assert.ok(registered.length > 1);
      assert.ok(!registered.includes("search_grounding"));
    },
  );
});
