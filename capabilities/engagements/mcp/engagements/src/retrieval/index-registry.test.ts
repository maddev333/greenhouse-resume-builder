/**
 * Multi-index registry behaviour.
 *
 * A customer has SEVERAL indexes whose shapes we cannot know in advance: one basic RAG index the
 * `search_grounding` tool answers from, plus one or more indexes of structured records. Each is
 * declared in its own config file, so adding an index is dropping in a file. These tests pin the
 * discovery order, the per-kind resolution, and the cross-declaration errors — the ones that would
 * otherwise surface as a query silently hitting the wrong index.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  declarationForKind,
  entityKinds,
  groundingDeclaration,
  indexSchemaPaths,
  loadIndexRegistry,
  reloadIndexRegistry,
} from "./index-schema.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A plain document/chunk RAG index: grounding only, no structured records. */
const RAG = {
  id: "rag",
  indexName: "customer-rag",
  fields: [
    { name: "chunk_id", type: "Edm.String", key: true, filterable: true },
    { name: "parent_id", type: "Edm.String", filterable: true },
    { name: "chunk", type: "Edm.String", searchable: true },
  ],
  mapping: {
    key: "chunk_id",
    grounding: { content: "chunk", parentId: "parent_id" },
  },
};

/** One index holding every structured record kind. */
const RECORDS = {
  id: "records",
  indexName: "customer-records",
  fields: [
    { name: "record_id", type: "Edm.String", key: true, filterable: true },
    { name: "record_type", type: "Edm.String", filterable: true },
    { name: "display_name", type: "Edm.String", searchable: true },
    { name: "payload_json", type: "Edm.String" },
  ],
  mapping: {
    key: "record_id",
    entityType: {
      field: "record_type",
      contact: "person",
      event: "gathering",
      leader: "leader",
      topic: "topic",
      message: "message",
      region: "region",
    },
    payload: "payload_json",
  },
};

/** Contacts only — `event: null` hands events to another declaration. */
const CONTACTS_ONLY = {
  id: "people",
  indexName: "customer-people",
  fields: [
    { name: "record_id", type: "Edm.String", key: true, filterable: true },
    { name: "record_type", type: "Edm.String", filterable: true },
    { name: "payload_json", type: "Edm.String" },
  ],
  mapping: {
    key: "record_id",
    entityType: { field: "record_type", contact: "person", event: null },
    payload: "payload_json",
  },
};

/** Events only — the mirror image. */
const EVENTS_ONLY = {
  id: "gatherings",
  indexName: "customer-events",
  fields: [
    { name: "evt_id", type: "Edm.String", key: true, filterable: true },
    { name: "evt_kind", type: "Edm.String", filterable: true },
    { name: "evt_json", type: "Edm.String" },
  ],
  mapping: {
    key: "evt_id",
    entityType: { field: "evt_kind", contact: null, event: "gathering" },
    payload: "evt_json",
  },
};

/** Write a throwaway config directory and return its path. */
function fixtureDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "engagements-index-registry-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(body, null, 2), "utf8");
  }
  return dir;
}

/**
 * Run `fn` with `ENGAGEMENTS_INDEX_SCHEMAS` set, then restore the variable AND the cached registry
 * so the default declaration is back in place for whatever runs next.
 */
function withRegistry(spec: string, fn: () => void): void {
  const saved = process.env.ENGAGEMENTS_INDEX_SCHEMAS;
  process.env.ENGAGEMENTS_INDEX_SCHEMAS = spec;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.ENGAGEMENTS_INDEX_SCHEMAS;
    else process.env.ENGAGEMENTS_INDEX_SCHEMAS = saved;
    reloadIndexRegistry();
  }
}

/** Set up a config directory, run the body, and always clean the directory up. */
function withFixture(
  files: Record<string, unknown>,
  fn: (dir: string) => void,
): void {
  const dir = fixtureDir(files);
  try {
    withRegistry(dir, () => fn(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Discovery ──────────────────────────────────────────────────────────────

test("a directory contributes every declaration, ordered by filename", () => {
  withFixture({ "b-records.json": RECORDS, "a-rag.json": RAG }, () => {
    assert.deepEqual(
      reloadIndexRegistry().map((d) => d.id),
      ["rag", "records"],
      "declarations must load in filename order for a deterministic registry",
    );
  });
});

test("*.example.json is skipped so the shipped examples are never loaded", () => {
  // `broken.example.json` would fail validation if it were loaded at all.
  withFixture(
    { "a-rag.json": RAG, "broken.example.json": { nope: true } },
    (dir) => {
      assert.deepEqual(indexSchemaPaths(), [join(dir, "a-rag.json")]);
      assert.deepEqual(
        reloadIndexRegistry().map((d) => d.id),
        ["rag"],
      );
    },
  );
});

test("a comma-separated list of files loads each one in order", () => {
  const dir = fixtureDir({ "one.json": RECORDS, "two.json": RAG });
  try {
    withRegistry(`${join(dir, "two.json")}, ${join(dir, "one.json")}`, () => {
      assert.deepEqual(
        reloadIndexRegistry().map((d) => d.id),
        ["rag", "records"],
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an id defaults to the config file's basename", () => {
  const { id: _dropped, ...anonymous } = RECORDS;
  withFixture({ "customer-people.json": anonymous }, () => {
    assert.deepEqual(
      reloadIndexRegistry().map((d) => d.id),
      ["customer-people"],
    );
  });
});

test("a registry with no config files is rejected", () => {
  withFixture({ "only.example.json": RAG }, () => {
    assert.throws(
      () => reloadIndexRegistry(),
      /No index schema declarations found/,
    );
  });
});

// ── Per-kind / grounding resolution ────────────────────────────────────────

test("grounding resolves to the RAG declaration, not simply the first one", () => {
  withFixture({ "a-records.json": RECORDS, "b-rag.json": RAG }, () => {
    const registry = reloadIndexRegistry();
    assert.equal(registry[0].id, "records", "records must sort first");

    const grounding = groundingDeclaration();
    assert.equal(grounding?.id, "rag");
    assert.equal(grounding?.indexName, "customer-rag");
    assert.equal(grounding?.mapping.grounding?.content, "chunk");
    assert.deepEqual(
      entityKinds(grounding!),
      [],
      "a RAG declaration carries no structured record kinds",
    );
  });
});

test("contacts and events resolve to DIFFERENT declarations and indexes", () => {
  withFixture(
    { "a-people.json": CONTACTS_ONLY, "b-events.json": EVENTS_ONLY },
    () => {
      reloadIndexRegistry();
      const contacts = declarationForKind("contact");
      const events = declarationForKind("event");

      assert.equal(contacts?.id, "people");
      assert.equal(contacts?.indexName, "customer-people");
      assert.equal(events?.id, "gatherings");
      assert.equal(events?.indexName, "customer-events");
      assert.notEqual(
        contacts?.indexName,
        events?.indexName,
        "the two kinds must not collapse onto one index",
      );

      // Each declaration names its own key/discriminator/payload fields.
      assert.equal(contacts?.mapping.key, "record_id");
      assert.equal(events?.mapping.key, "evt_id");
      assert.equal(events?.mapping.entityType?.field, "evt_kind");
      assert.deepEqual(entityKinds(contacts!), ["contact"]);
      assert.deepEqual(entityKinds(events!), ["event"]);
    },
  );
});

test("a kind no declaration carries resolves to undefined, never a guess", () => {
  withFixture({ "a-people.json": CONTACTS_ONLY }, () => {
    reloadIndexRegistry();
    assert.equal(declarationForKind("contact")?.id, "people");
    assert.equal(declarationForKind("leader"), undefined);
    assert.equal(declarationForKind("region"), undefined);
  });
});

// ── Cross-declaration validation ───────────────────────────────────────────

test("a duplicate id is rejected, naming both files", () => {
  withFixture(
    { "a-rag.json": RAG, "b-rag.json": { ...RECORDS, id: "rag" } },
    (dir) => {
      assert.throws(
        () => reloadIndexRegistry(),
        (err: unknown) => {
          const msg = (err as Error).message;
          assert.match(msg, /share the id "rag"/);
          assert.ok(
            msg.includes(join(dir, "a-rag.json")),
            "names the first file",
          );
          assert.ok(
            msg.includes(join(dir, "b-rag.json")),
            "names the second file",
          );
          return true;
        },
      );
    },
  );
});

test("two grounding blocks are rejected, naming both files", () => {
  withFixture(
    { "a-rag.json": RAG, "b-rag2.json": { ...RAG, id: "rag2" } },
    (dir) => {
      assert.throws(
        () => reloadIndexRegistry(),
        (err: unknown) => {
          const msg = (err as Error).message;
          assert.match(msg, /More than one index declaration carries/);
          assert.ok(msg.includes(join(dir, "a-rag.json")));
          assert.ok(msg.includes(join(dir, "b-rag2.json")));
          return true;
        },
      );
    },
  );
});

test("the same entity kind claimed twice is rejected, naming both files", () => {
  withFixture(
    { "a-people.json": CONTACTS_ONLY, "b-records.json": RECORDS },
    (dir) => {
      assert.throws(
        () => reloadIndexRegistry(),
        (err: unknown) => {
          const msg = (err as Error).message;
          assert.match(msg, /claim the "contact" record kind/);
          assert.ok(msg.includes(join(dir, "a-people.json")));
          assert.ok(msg.includes(join(dir, "b-records.json")));
          return true;
        },
      );
    },
  );
});

// ── Single-index compatibility ─────────────────────────────────────────────

test("with no registry configured the packaged declaration still loads alone", () => {
  const registry = loadIndexRegistry();
  assert.equal(registry.length, 1);
  assert.equal(registry[0].id, "engagements");
  assert.equal(declarationForKind("contact")?.id, "engagements");
  assert.equal(declarationForKind("event")?.id, "engagements");
});
