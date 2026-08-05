/**
 * Provisioning + reindex CLI for the Azure AI Search backend (M4). Loads the staged seed, bakes the
 * provenance envelope, then creates/updates every declared index and upserts every contact + event.
 * This is the local stand-in for the ETL that would normally land per-source blobs and run the indexer.
 *
 * Usage (from repo root):
 *   npm run provision:search -w @greenhouse-resume-builder/cap-engagements-mcp-engagements            # reindex (ensure + sync)
 *   npm run provision:search -w ... -- validate                                                       # check every declaration only (no Azure calls)
 *   npm run provision:search -w ... -- ensure                                                         # create/update indexes only
 *   npm run provision:search -w ... -- sync                                                           # upsert docs only
 *   npm run provision:search -w ... -- delete contact C4                                              # delete one record (demo beat)
 *
 * The index shapes come from the schema REGISTRY: ENGAGEMENTS_INDEX_SCHEMAS (files and/or
 * directories) wins, then ENGAGEMENTS_INDEX_SCHEMA (one file), then the checked-in default for the
 * backend — config/rag-index.json under RETRIEVAL_BACKEND=grounding, else index-schema.json.
 *
 * Auth: uses AZURE_SEARCH_API_KEY when set (see repo-root .env), else DefaultAzureCredential (az login).
 */
import "./load-env.js";
import {
  applyLabels,
  loadDataset,
  isSearchConfigured,
  ensureEngagementIndex,
  syncEngagementDocs,
  deleteEngagementDoc,
  loadIndexRegistry,
  entityKinds,
  indexName,
} from "./engine.js";

async function main(): Promise<void> {
  const [cmd = "reindex", kind, id] = process.argv.slice(2);

  // `validate` is deliberately offline so a bad declaration is caught before any Azure call.
  if (cmd === "validate") {
    const registry = loadIndexRegistry();
    console.log(`[provision] registry OK: ${registry.length} declaration(s)`);
    for (const schema of registry) {
      const filterable = schema.fields
        .filter((f) => f.filterable)
        .map((f) => f.name);
      const searchable = schema.fields
        .filter((f) => f.searchable)
        .map((f) => f.name);
      console.log(`[provision] ${schema.id}`);
      console.log(`[provision]   file:       ${schema.sourcePath}`);
      console.log(`[provision]   index:      ${indexName(schema)}`);
      console.log(`[provision]   fields:     ${schema.fields.length}`);
      console.log(
        `[provision]   filterable: ${filterable.join(", ") || "(none)"}`,
      );
      console.log(
        `[provision]   searchable: ${searchable.join(", ") || "(none)"}`,
      );
      console.log(
        `[provision]   payload:    ${schema.mapping.payload ?? "(none)"}`,
      );
      console.log(
        `[provision]   grounding:  ${schema.mapping.grounding?.content ?? "(none)"}`,
      );
      console.log(
        `[provision]   kinds:      ${entityKinds(schema).join(", ") || "(none)"}`,
      );
    }
    return;
  }

  if (!isSearchConfigured()) {
    throw new Error(
      "AZURE_SEARCH_SERVICE is not set — add it to the repo-root .env (and AZURE_SEARCH_API_KEY or use az login).",
    );
  }

  switch (cmd) {
    case "ensure": {
      const name = await ensureEngagementIndex();
      console.log(`[provision] index ready: ${name}`);
      break;
    }
    case "sync": {
      const { contacts, events, reference } = await syncEngagementDocs(
        applyLabels(loadDataset()),
      );
      console.log(
        `[provision] upserted ${contacts} contact(s) + ${events} event(s) + ${reference} reference record(s)`,
      );
      break;
    }
    case "reindex": {
      const name = await ensureEngagementIndex();
      const { contacts, events, reference } = await syncEngagementDocs(
        applyLabels(loadDataset()),
      );
      console.log(
        `[provision] index '${name}' ready; upserted ${contacts} contact(s) + ${events} event(s) + ${reference} reference record(s)`,
      );
      break;
    }
    case "delete": {
      if (kind !== "contact" && kind !== "event") {
        throw new Error(
          `delete requires a kind of 'contact' or 'event' (got '${kind ?? ""}')`,
        );
      }
      if (!id)
        throw new Error(
          "delete requires a record id, e.g. `delete contact C4`",
        );
      await deleteEngagementDoc(kind, id);
      console.log(
        `[provision] deleted ${kind} '${id}' (reindex to restore from seed)`,
      );
      break;
    }
    default:
      throw new Error(
        `Unknown command '${cmd}'. Use: validate | reindex | ensure | sync | delete <contact|event> <id>`,
      );
  }
}

main().catch((e: unknown) => {
  console.error("[provision] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
