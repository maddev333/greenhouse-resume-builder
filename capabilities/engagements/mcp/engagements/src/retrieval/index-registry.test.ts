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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  declarationForKind,
  entityKinds,
  groundingDeclaration,
  indexSchemaPath,
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

/**
 * A DEDICATED contacts index: no discriminator column at all, because every document in it is a
 * contact. This is the shape of a customer index we did not build.
 */
const DEDICATED_CONTACTS = {
  id: "people-only",
  indexName: "customer-contacts",
  fields: [
    { name: "record_id", type: "Edm.String", key: true, filterable: true },
    { name: "full_name", type: "Edm.String", searchable: true },
    { name: "payload_json", type: "Edm.String" },
  ],
  mapping: {
    key: "record_id",
    entityType: { contact: "contact", event: null },
    payload: "payload_json",
  },
};

/** Write the given config files into `dir`, creating it, and return it. */
function fixtureDirAt(dir: string, files: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(body, null, 2), "utf8");
  }
  return dir;
}

/**
 * A throwaway directory, in the CANONICAL form `process.cwd()` reports. Windows hands back an 8.3
 * short path from `tmpdir()`, which would not compare equal to a resolved config path.
 */
function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Write a throwaway config directory and return its path. */
function fixtureDir(files: Record<string, unknown>): string {
  return fixtureDirAt(tempDir("engagements-index-registry-"), files);
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

/** Run `fn` with the given variables set, restoring them AND the cached registry afterwards. */
function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved = new Map(
    Object.keys(vars).map((k) => [k, process.env[k]] as const),
  );
  for (const [k, v] of Object.entries(vars)) {
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
    reloadIndexRegistry();
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

test("grounding mode defaults to the ONE checked-in RAG declaration", () => {
  // Grounding answers from a single customer corpus. Defaulting it to the structured
  // `index-schema.json` (no `mapping.grounding`) would fail every query, so the default is
  // config/rag-index.json and no path has to be configured locally or on App Service.
  withEnv(
    {
      RETRIEVAL_BACKEND: "grounding",
      ENGAGEMENTS_INDEX_SCHEMA: undefined,
      ENGAGEMENTS_INDEX_SCHEMAS: undefined,
    },
    () => {
      const paths = indexSchemaPaths();
      assert.equal(paths.length, 1, "grounding reads exactly one declaration");
      assert.equal(paths[0], indexSchemaPath());
      assert.equal(
        paths[0].endsWith(join("config", "rag-index.json")),
        true,
        `expected the checked-in RAG config, got ${paths[0]}`,
      );

      const declaration = JSON.parse(readFileSync(paths[0], "utf8"));
      assert.equal(
        declaration.mapping.grounding.content,
        "chunk",
        "the default grounding declaration must map passage text",
      );
      assert.equal(
        declaration.mapping.entityType,
        undefined,
        "a RAG corpus carries no structured planner records",
      );
    },
  );
});

test("grounding mode still honours an explicit ENGAGEMENTS_INDEX_SCHEMA", () => {
  const dir = fixtureDir({ "other-rag.json": RAG });
  try {
    withEnv(
      {
        RETRIEVAL_BACKEND: "grounding",
        ENGAGEMENTS_INDEX_SCHEMA: join(dir, "other-rag.json"),
        ENGAGEMENTS_INDEX_SCHEMAS: undefined,
      },
      () => {
        assert.equal(indexSchemaPath(), join(dir, "other-rag.json"));
        assert.equal(reloadIndexRegistry()[0].id, "rag");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a relative ENGAGEMENTS_INDEX_SCHEMAS falls back to the project directory", () => {
  // The multi-index setting has to survive deployment. An absolute developer path cannot be an App
  // Service app setting, so `config` — the directory the ZIP unpacks at the site root — must
  // resolve wherever the process was started from, not only when the working directory happens to
  // be the project. Running from a temp directory is the case that used to find nothing.
  const elsewhere = tempDir("engagements-cwd-");
  const cwd = process.cwd();
  try {
    process.chdir(elsewhere);
    withRegistry("config", () => {
      const paths = indexSchemaPaths();
      assert.ok(
        paths.some((p) => p.endsWith(join("config", "rag-index.json"))),
        `expected the project's config/ declarations, got ${paths.join(", ")}`,
      );
      assert.ok(
        paths.every((p) => !p.startsWith(elsewhere)),
        "must not resolve against a working directory that has no config/",
      );
    });
  } finally {
    process.chdir(cwd);
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a relative path still prefers the working directory when one exists there", () => {
  // The deployed copy next to the process wins over the checked-in one, matching how
  // config/rag-index.json is already resolved.
  const parent = tempDir("engagements-cwd-");
  const cwd = process.cwd();
  try {
    fixtureDirAt(join(parent, "config"), { "a-rag.json": RAG });
    process.chdir(parent);
    withRegistry("config", () => {
      assert.deepEqual(indexSchemaPaths(), [
        join(parent, "config", "a-rag.json"),
      ]);
    });
  } finally {
    process.chdir(cwd);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an unedited <placeholder> indexName is rejected, naming the file", () => {
  // Otherwise the placeholder is sent to Azure verbatim and comes back as an opaque 404.
  withFixture(
    { "a-rag.json": { ...RAG, indexName: "<customer-index-name>" } },
    (dir) => {
      assert.throws(
        () => reloadIndexRegistry(),
        (err: unknown) => {
          const msg = (err as Error).message;
          assert.match(msg, /still the placeholder "<customer-index-name>"/);
          assert.ok(msg.includes(join(dir, "a-rag.json")), "names the file");
          return true;
        },
      );
    },
  );
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

test("a DEDICATED index needs no discriminator field", () => {
  // A customer's contacts index has no "kind" column — everything in it is a contact. Demanding
  // one would mean altering an index we do not own, so `field` may be omitted and the kind clause
  // is simply not emitted.
  withFixture({ "a-people.json": DEDICATED_CONTACTS }, () => {
    reloadIndexRegistry();
    const contacts = declarationForKind("contact");
    assert.equal(contacts?.id, "people-only");
    assert.equal(contacts?.mapping.entityType?.field, undefined);
    assert.deepEqual(entityKinds(contacts!), ["contact"]);
    assert.equal(declarationForKind("event"), undefined);
  });
});

test("no discriminator + several kinds is rejected — nothing could tell them apart", () => {
  withFixture(
    {
      "a-mixed.json": {
        ...DEDICATED_CONTACTS,
        mapping: {
          ...DEDICATED_CONTACTS.mapping,
          entityType: { contact: "contact", event: "event" },
        },
      },
    },
    () => {
      assert.throws(
        () => reloadIndexRegistry(),
        (err: unknown) => {
          const msg = (err as Error).message;
          assert.match(msg, /omits `field`/);
          assert.match(msg, /2 are claimed \(contact, event\)/);
          return true;
        },
      );
    },
  );
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
