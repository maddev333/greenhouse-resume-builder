/**
 * Load the repo-root `.env` so runtime configuration/secrets (`AZURE_SEARCH_*`, `RETRIEVAL_BACKEND`,
 * `ENGAGEMENTS_*`) are available to the capability without exporting them by hand. Imported FIRST by
 * every entry point. Never overrides variables already set in the shell (dotenv default), so
 * `cross-env RETRIEVAL_BACKEND=search ...` still wins.
 *
 * `.env` lives five levels up: capabilities/engagements/mcp/engagements/src → repo root.
 */
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

loadDotenv({ path: resolve(import.meta.dirname, '..', '..', '..', '..', '..', '.env') });
