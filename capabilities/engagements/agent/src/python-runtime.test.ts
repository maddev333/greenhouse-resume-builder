import { test } from "node:test";
import assert from "node:assert/strict";

import {
  callGovernedTool,
  isGovernanceDenial,
  PythonRuntimeRequestError,
} from "./python-runtime.js";

test("callGovernedTool preserves the Python capture contract", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.name, "search_contacts");
    assert.deepEqual(body.args, { query: "cyber" });
    assert.equal(body.traceId, "trace-ts");
    return new Response(
      JSON.stringify({
        name: "search_contacts",
        args: body.args,
        result: { contacts: [] },
        text: "No contacts.",
        modelResult: { contacts: [] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const result = await callGovernedTool({
    mcpUrl: "http://mcp.test/mcp",
    traceId: "trace-ts",
    name: "search_contacts",
    args: { query: "cyber" },
  });

  assert.deepEqual(result.modelResult, { contacts: [] });
});

test("Python runtime HTTP status is preserved for the gateway", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ detail: "Denied by governance." }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  await assert.rejects(
    callGovernedTool({
      mcpUrl: "http://mcp.test/mcp",
      traceId: "trace-denied",
      name: "search_contacts",
      args: { query: "blocked" },
    }),
    (error: unknown) =>
      error instanceof PythonRuntimeRequestError && error.status === 403,
  );
});

test("governance denials are not eligible for deterministic fallback", () => {
  assert.equal(
    isGovernanceDenial(
      new PythonRuntimeRequestError(403, "/run", "Denied by governance."),
    ),
    true,
  );
  assert.equal(
    isGovernanceDenial(
      new PythonRuntimeRequestError(503, "/run", "Model unavailable."),
    ),
    false,
  );
});
