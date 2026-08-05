/**
 * Declarative index schema REGISTRY — the ONE place the Azure AI Search index shapes are described.
 *
 * A customer rarely has a single index. Typically there is one "basic RAG" index of mixed
 * structured + unstructured content that `search_grounding` answers questions from, plus one or
 * more indexes of structured records (contacts, events, leaders, topics, messages, regions) — maybe
 * one index for all of them, maybe one index per kind. So this module loads a REGISTRY of
 * declarations rather than a single one.
 *
 * Each config file holds exactly ONE declaration (`indexName`, `fields`, `mapping`, optional `id`),
 * so a new index is added by dropping in a new file. Each declaration serves two jobs:
 *
 *   1. PROVISIONING — `toSearchIndex()` turns a declaration into a `SearchIndex` for
 *      `createOrUpdateIndex`, so the index definition is no longer hard-coded in TypeScript.
 *   2. QUERY GUARDING — the query builders resolve field names through `mapping` and assert the
 *      field is declared `filterable` BEFORE composing an OData `$filter`. Azure rejects a filter
 *      over an unknown or non-filterable field with an opaque HTTP 400; this turns that into a
 *      readable configuration error naming the field and the file.
 *
 * Discovery, in precedence order:
 *   1. `ENGAGEMENTS_INDEX_SCHEMAS` — comma/semicolon-separated FILE and/or DIRECTORY paths. A
 *      directory contributes every `*.json` inside it, sorted by filename for a deterministic
 *      order. Files whose basename ends with `.example.json` are skipped, so the shipped examples
 *      are never loaded by accident.
 *   2. `ENGAGEMENTS_INDEX_SCHEMA` — a single file (the original single-index knob).
 *   3. The packaged/source `index-schema.json`.
 *
 * Pointing at a customer's EXISTING index therefore means describing that index in a config file —
 * not re-provisioning over it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SearchField, SearchIndex } from "@azure/search-documents";

/** Shipped examples are documentation, not configuration — never auto-loaded from a directory. */
const EXAMPLE_SUFFIX = ".example.json";

/** The checked-in declaration, resolved relative to this module. */
function sourceSchemaPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../index-schema.json",
  );
}

/**
 * Location of the single-file declaration (`ENGAGEMENTS_INDEX_SCHEMA` wins, then packaged, then
 * source). Every path is resolved lazily on each call so the environment variable AND the working
 * directory are honoured whenever they are set, not just at import.
 */
export function indexSchemaPath(): string {
  const override = process.env.ENGAGEMENTS_INDEX_SCHEMA?.trim();
  if (override) return resolve(override);
  const packaged = resolve(process.cwd(), "index-schema.json");
  return existsSync(packaged) ? packaged : sourceSchemaPath();
}

/** Expand one `ENGAGEMENTS_INDEX_SCHEMAS` entry (a file or a directory) into config file paths. */
function expandSchemaSource(entry: string): string[] {
  const path = resolve(entry);
  if (!existsSync(path)) {
    throw new Error(
      `ENGAGEMENTS_INDEX_SCHEMAS names "${entry}", which does not exist (resolved to ${path}).`,
    );
  }
  if (!statSync(path).isDirectory()) {
    return basename(path).endsWith(EXAMPLE_SUFFIX) ? [] : [path];
  }
  return readdirSync(path)
    .filter((f) => extname(f) === ".json" && !f.endsWith(EXAMPLE_SUFFIX))
    .sort()
    .map((f) => join(path, f));
}

/** Every config file the registry loads, in declaration order. Resolved lazily on each call. */
export function indexSchemaPaths(): string[] {
  const multi = process.env.ENGAGEMENTS_INDEX_SCHEMAS?.trim();
  if (!multi) return [indexSchemaPath()];
  const paths = multi.split(/[,;]/).flatMap((entry) => {
    const trimmed = entry.trim();
    return trimmed ? expandSchemaSource(trimmed) : [];
  });
  return [...new Set(paths)];
}

/** Field types this capability understands (a subset of the Azure AI Search EDM set). */
export const FIELD_TYPES = [
  "Edm.String",
  "Edm.Int32",
  "Edm.Int64",
  "Edm.Double",
  "Edm.Boolean",
  "Edm.DateTimeOffset",
  "Edm.GeographyPoint",
  "Collection(Edm.String)",
  "Collection(Edm.Single)",
] as const;

/**
 * Record kinds a declaration can carry. `contact`/`event` are required by the planner; the rest are
 * reference data. Each kind may be claimed by AT MOST ONE declaration in the registry.
 */
export const ENTITY_KINDS = [
  "contact",
  "event",
  "leader",
  "topic",
  "message",
  "region",
] as const;

const fieldSchema = z.object({
  name: z.string().min(1),
  type: z.enum(FIELD_TYPES),
  key: z.boolean().optional(),
  filterable: z.boolean().optional(),
  searchable: z.boolean().optional(),
  sortable: z.boolean().optional(),
  facetable: z.boolean().optional(),
  retrievable: z.boolean().optional(),
});

const mappingSchema = z.object({
  key: z.string().min(1),
  // PLANNER mapping. Omit it entirely for a plain document/chunk RAG index that carries no
  // structured contact/event records — that declaration then serves grounding only.
  entityType: z
    .object({
      field: z.string().min(1),
      // contact + event must both be STATED so splitting records across indexes is a deliberate
      // act, but either may be `null` meaning "this index does not hold that kind" — that is what
      // lets one declaration own contacts and another own events. The reference kinds are fully
      // optional; omit one (or set it null) and that record set reads back EMPTY.
      contact: z.string().min(1).nullable(),
      event: z.string().min(1).nullable(),
      leader: z.string().min(1).nullable().optional(),
      topic: z.string().min(1).nullable().optional(),
      message: z.string().min(1).nullable().optional(),
      region: z.string().min(1).nullable().optional(),
    })
    .optional(),
  topicIds: z.string().min(1).nullable().optional(),
  status: z.string().min(1).nullable().optional(),
  payload: z.string().min(1).nullable().optional(),
  // GROUNDING mapping — the fields a RAG answer is built from. `content` is the passage text;
  // `title`/`url` are citation metadata; `vector` enables hybrid recall; `semanticConfiguration`
  // enables the L2 reranker. At most ONE declaration in the registry may carry this block.
  grounding: z
    .object({
      content: z.string().min(1),
      title: z.string().min(1).nullable().optional(),
      url: z.string().min(1).nullable().optional(),
      parentId: z.string().min(1).nullable().optional(),
      vector: z.string().min(1).nullable().optional(),
      semanticConfiguration: z.string().min(1).nullable().optional(),
    })
    .optional(),
});

const indexSchemaSchema = z.object({
  // Stable handle for this declaration; defaults to the config file's basename without extension.
  id: z.string().min(1).optional(),
  indexName: z.string().min(1),
  fields: z.array(fieldSchema).min(1),
  mapping: mappingSchema,
});

export type IndexFieldDeclaration = z.infer<typeof fieldSchema>;
export type IndexFieldType = (typeof FIELD_TYPES)[number];
export type IndexMapping = z.infer<typeof mappingSchema>;

/** One validated declaration, bound to the config file it was loaded from. */
export type IndexSchema = Omit<z.infer<typeof indexSchemaSchema>, "id"> & {
  id: string;
  /** Absolute path of the config file this declaration came from. */
  sourcePath: string;
};

/** Every logical role the query layer can resolve to a physical field. */
export type FieldRole =
  | "key"
  | "entityType"
  | "topicIds"
  | "status"
  | "payload";

export type IndexEntityKind = (typeof ENTITY_KINDS)[number];

function fail(message: string, path: string): never {
  throw new Error(`${message}\n  (index schema: ${path})`);
}

function validate(raw: unknown, path: string): IndexSchema {
  const parsed = indexSchemaSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    fail(`Invalid index schema:\n${issues}`, path);
  }

  const schema: IndexSchema = {
    ...parsed.data,
    id: parsed.data.id ?? basename(path, extname(path)),
    sourcePath: path,
  };
  const byName = new Map(schema.fields.map((f) => [f.name, f]));
  if (byName.size !== schema.fields.length) {
    fail("Invalid index schema: duplicate field names in `fields`.", path);
  }

  const keys = schema.fields.filter((f) => f.key);
  if (keys.length !== 1) {
    fail(
      `Invalid index schema: exactly one field must have "key": true (found ${keys.length}).`,
      path,
    );
  }
  if (keys[0].name !== schema.mapping.key) {
    fail(
      `Invalid index schema: mapping.key is "${schema.mapping.key}" but the key field is "${keys[0].name}".`,
      path,
    );
  }

  // Every mapped role must name a declared field.
  const g = schema.mapping.grounding;
  const mapped: [string, string | null | undefined][] = [
    ["mapping.key", schema.mapping.key],
    ["mapping.entityType.field", schema.mapping.entityType?.field],
    ["mapping.topicIds", schema.mapping.topicIds],
    ["mapping.status", schema.mapping.status],
    ["mapping.payload", schema.mapping.payload],
    ["mapping.grounding.content", g?.content],
    ["mapping.grounding.title", g?.title],
    ["mapping.grounding.url", g?.url],
    ["mapping.grounding.parentId", g?.parentId],
    ["mapping.grounding.vector", g?.vector],
  ];
  for (const [label, name] of mapped) {
    if (name && !byName.has(name)) {
      fail(
        `Invalid index schema: ${label} names "${name}", which is not declared in \`fields\`.`,
        path,
      );
    }
  }

  if (!schema.mapping.entityType && !g) {
    fail(
      "Invalid index schema: declare `mapping.entityType` (structured planner records), " +
        "`mapping.grounding` (document/chunk RAG), or both. With neither there is nothing to read.",
      path,
    );
  }

  if (g) {
    const content = byName.get(g.content)!;
    if (!content.searchable) {
      fail(
        `Invalid index schema: mapping.grounding.content names "${g.content}", which must be ` +
          '"searchable": true to be retrievable as a grounding passage.',
        path,
      );
    }
    if (g.vector && byName.get(g.vector)!.type !== "Collection(Edm.Single)") {
      fail(
        `Invalid index schema: mapping.grounding.vector names "${g.vector}", which must be of ` +
          "type Collection(Edm.Single).",
        path,
      );
    }
    if (g.parentId && !byName.get(g.parentId)!.filterable) {
      fail(
        `Invalid index schema: mapping.grounding.parentId names "${g.parentId}", which must be ` +
          '"filterable": true to collapse chunks by parent.',
        path,
      );
    }
  }

  return schema;
}

/**
 * Registry-wide invariants. Each failure names the offending FILES: "duplicate id" is meaningless
 * when the operator has half a dozen config files sitting in a directory.
 */
function validateRegistry(declarations: IndexSchema[]): IndexSchema[] {
  if (!declarations.length) {
    throw new Error(
      "No index schema declarations found. Point ENGAGEMENTS_INDEX_SCHEMAS at one or more config " +
        "files/directories, or ENGAGEMENTS_INDEX_SCHEMA at a single file. Note that files named " +
        `"*${EXAMPLE_SUFFIX}" are skipped.`,
    );
  }

  const byId = new Map<string, IndexSchema>();
  for (const d of declarations) {
    const clash = byId.get(d.id);
    if (clash) {
      throw new Error(
        `Two index declarations share the id "${d.id}":\n  ${clash.sourcePath}\n  ${d.sourcePath}\n` +
          'Give one of them a distinct "id".',
      );
    }
    byId.set(d.id, d);
  }

  const grounded = declarations.filter((d) => d.mapping.grounding);
  if (grounded.length > 1) {
    throw new Error(
      "More than one index declaration carries a `mapping.grounding` block, so grounded question " +
        "answering has no single corpus to read:\n" +
        grounded.map((d) => `  ${d.id}: ${d.sourcePath}`).join("\n") +
        "\nKeep `mapping.grounding` on exactly one declaration.",
    );
  }

  const owner = new Map<IndexEntityKind, IndexSchema>();
  for (const d of declarations) {
    for (const kind of ENTITY_KINDS) {
      if (!d.mapping.entityType?.[kind]) continue;
      const clash = owner.get(kind);
      if (clash) {
        throw new Error(
          `Two index declarations claim the "${kind}" record kind, so reads for it are ambiguous:\n` +
            `  ${clash.id}: ${clash.sourcePath}\n  ${d.id}: ${d.sourcePath}\n` +
            `Remove "${kind}" from \`mapping.entityType\` in one of them.`,
        );
      }
      owner.set(kind, d);
    }
  }

  return declarations;
}

let cached: IndexSchema[] | undefined;

/**
 * Load + validate EVERY declaration in the registry (cached; `reloadIndexRegistry()` clears it).
 * Order follows `indexSchemaPaths()`, which is deterministic for directory sources.
 */
export function loadIndexRegistry(): IndexSchema[] {
  if (cached) return cached;
  const declarations = indexSchemaPaths().map((path) => {
    if (!existsSync(path)) fail("Index schema file not found.", path);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      fail(
        `Index schema is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        path,
      );
    }
    return validate(raw, path);
  });
  cached = validateRegistry(declarations);
  return cached;
}

/** Drop the cached registry (tests / long-running processes that rewrite the config files). */
export function reloadIndexRegistry(): IndexSchema[] {
  cached = undefined;
  return loadIndexRegistry();
}

/** The FIRST declaration — the single-index view kept for callers that only ever had one. */
export function loadIndexSchema(): IndexSchema {
  return loadIndexRegistry()[0];
}

/** Drop the cache, then hand back the first declaration again. */
export function reloadIndexSchema(): IndexSchema {
  return reloadIndexRegistry()[0];
}

/** The declaration carrying `mapping.grounding`, or `undefined` when no index is declared for RAG. */
export function groundingDeclaration(): IndexSchema | undefined {
  return loadIndexRegistry().find((d) => Boolean(d.mapping.grounding));
}

/** The declaration carrying a record kind, or `undefined` when no index in the registry holds it. */
export function declarationForKind(
  kind: IndexEntityKind,
): IndexSchema | undefined {
  return loadIndexRegistry().find((d) => Boolean(d.mapping.entityType?.[kind]));
}

/**
 * The index name for one declaration.
 *
 * `ENGAGEMENTS_SEARCH_INDEX` overrides it, but only for a single-declaration registry: applying one
 * name to several declarations would silently collapse distinct indexes onto one, so with a
 * multi-index registry the override is REJECTED rather than honoured or quietly ignored.
 */
export function indexName(schema: IndexSchema = loadIndexSchema()): string {
  const override = process.env.ENGAGEMENTS_SEARCH_INDEX?.trim();
  if (!override) return schema.indexName;
  const registry = loadIndexRegistry();
  if (registry.length > 1) {
    throw new Error(
      `ENGAGEMENTS_SEARCH_INDEX="${override}" cannot be applied to a registry of ` +
        `${registry.length} declarations — it would point them all at one index. Unset it and set ` +
        '"indexName" in each config file instead:\n' +
        registry.map((d) => `  ${d.id}: ${d.sourcePath}`).join("\n"),
    );
  }
  return override;
}

/** The declaration for one field, or `undefined` when it is not declared. */
export function field(
  name: string,
  schema: IndexSchema = loadIndexSchema(),
): IndexFieldDeclaration | undefined {
  return schema.fields.find((f) => f.name === name);
}

/** Every field declared `searchable` — the `searchFields` a free-text query should target. */
export function searchableFields(
  schema: IndexSchema = loadIndexSchema(),
): string[] {
  return schema.fields.filter((f) => f.searchable).map((f) => f.name);
}

/**
 * Resolve a logical role to its physical field name, asserting the field is declared `filterable`.
 * Returns `undefined` for roles the index does not carry (optional narrowing), and throws a readable
 * error when the field exists but cannot be filtered — the case Azure would reject with a bare 400.
 */
export function filterableField(
  role: Exclude<FieldRole, "payload">,
  schema: IndexSchema = loadIndexSchema(),
): string | undefined {
  const name =
    role === "entityType"
      ? schema.mapping.entityType?.field
      : schema.mapping[role];
  if (!name) return undefined;

  const declared = field(name, schema);
  if (!declared) {
    fail(
      `Field "${name}" (mapping.${role}) is not declared in \`fields\`.`,
      schema.sourcePath,
    );
  }
  if (!declared.filterable) {
    fail(
      `Field "${name}" (mapping.${role}) must be "filterable": true to be used in an OData $filter.`,
      schema.sourcePath,
    );
  }
  return name;
}

/** The field holding the full JSON record, or `undefined` when the index carries no payload field. */
export function payloadField(
  schema: IndexSchema = loadIndexSchema(),
): string | undefined {
  return schema.mapping.payload ?? undefined;
}

/**
 * The discriminator value for a record kind, or `undefined` when this declaration does not carry
 * that kind (including when it has no `mapping.entityType` at all — a grounding-only index).
 */
export function entityTypeValue(
  kind: IndexEntityKind,
  schema: IndexSchema = loadIndexSchema(),
): string | undefined {
  return schema.mapping.entityType?.[kind] ?? undefined;
}

/** Every record kind one declaration serves — what the index actually holds. */
export function entityKinds(
  schema: IndexSchema = loadIndexSchema(),
): IndexEntityKind[] {
  return ENTITY_KINDS.filter((k) => Boolean(schema.mapping.entityType?.[k]));
}

/** The grounding field mapping, or `undefined` when the index is not declared for RAG. */
export function groundingMapping(
  schema: IndexSchema = loadIndexSchema(),
): NonNullable<IndexMapping["grounding"]> | undefined {
  return schema.mapping.grounding ?? undefined;
}

/** True when the declaration supports grounded passage retrieval. */
export function isGroundingConfigured(
  schema: IndexSchema = loadIndexSchema(),
): boolean {
  return Boolean(schema.mapping.grounding);
}

/** True when the declaration supports the structured planner records. */
export function isPlannerConfigured(
  schema: IndexSchema = loadIndexSchema(),
): boolean {
  return Boolean(schema.mapping.entityType);
}

/**
 * Turn the declaration into a `SearchIndex` for `createOrUpdateIndex`.
 *
 * NOTE: vector fields (`Collection(Edm.Single)`) need a `vectorSearch` profile that this
 * declaration does not model — provision those in Azure directly and describe them here for
 * query guarding only.
 */
export function toSearchIndex(
  schema: IndexSchema = loadIndexSchema(),
): SearchIndex {
  // Runtime shape is proven against v13 `createOrUpdateIndex`; the literal -> union cast avoids the
  // SDK's discriminated-field friction.
  const fields = schema.fields.map((f) => ({
    name: f.name,
    type: f.type,
    ...(f.key ? { key: true } : {}),
    ...(f.filterable ? { filterable: true } : {}),
    ...(f.searchable ? { searchable: true } : {}),
    ...(f.sortable ? { sortable: true } : {}),
    ...(f.facetable ? { facetable: true } : {}),
    ...(f.retrievable === false ? { hidden: true } : {}),
  })) as unknown as SearchField[];

  return { name: indexName(schema), fields };
}
