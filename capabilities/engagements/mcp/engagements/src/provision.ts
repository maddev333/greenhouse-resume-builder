/**
 * Provisioning + reindex CLI for the Azure AI Search backend (M4). Loads the staged seed, bakes the
 * governance envelope, then creates/updates the `engagements` index and upserts every contact + event.
 * This is the local stand-in for the ETL that would normally land per-source blobs and run the indexer.
 *
 * Usage (from repo root):
 *   npm run provision:search -w @greenhouse-resume-builder/cap-engagements-mcp-engagements            # reindex (ensure + sync)
 *   npm run provision:search -w ... -- ensure                                                         # create/update index only
 *   npm run provision:search -w ... -- sync                                                           # upsert docs only
 *   npm run provision:search -w ... -- delete contact C4                                              # delete one record (demo beat)
 *
 * Auth: uses AZURE_SEARCH_API_KEY when set (see repo-root .env), else DefaultAzureCredential (az login).
 */
import './load-env.js';
import {
  applyLabels,
  loadDataset,
  isSearchConfigured,
  ensureEngagementIndex,
  syncEngagementDocs,
  deleteEngagementDoc,
} from './engine.js';

async function main(): Promise<void> {
  if (!isSearchConfigured()) {
    throw new Error('AZURE_SEARCH_SERVICE is not set — add it to the repo-root .env (and AZURE_SEARCH_API_KEY or use az login).');
  }

  const [cmd = 'reindex', kind, id] = process.argv.slice(2);

  switch (cmd) {
    case 'ensure': {
      const name = await ensureEngagementIndex();
      console.log(`[provision] index ready: ${name}`);
      break;
    }
    case 'sync': {
      const { contacts, events } = await syncEngagementDocs(applyLabels(loadDataset()));
      console.log(`[provision] upserted ${contacts} contact(s) + ${events} event(s)`);
      break;
    }
    case 'reindex': {
      const name = await ensureEngagementIndex();
      const { contacts, events } = await syncEngagementDocs(applyLabels(loadDataset()));
      console.log(`[provision] index '${name}' ready; upserted ${contacts} contact(s) + ${events} event(s)`);
      break;
    }
    case 'delete': {
      if (kind !== 'contact' && kind !== 'event') {
        throw new Error(`delete requires a kind of 'contact' or 'event' (got '${kind ?? ''}')`);
      }
      if (!id) throw new Error('delete requires a record id, e.g. `delete contact C4`');
      await deleteEngagementDoc(kind, id);
      console.log(`[provision] deleted ${kind} '${id}' (reindex to restore from seed)`);
      break;
    }
    default:
      throw new Error(`Unknown command '${cmd}'. Use: reindex | ensure | sync | delete <contact|event> <id>`);
  }
}

main().catch((e: unknown) => {
  console.error('[provision] failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
