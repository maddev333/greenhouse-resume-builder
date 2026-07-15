/**
 * Filesystem anchors for the planner engine.
 *
 * Resolved from this file's directory (via `import.meta.url`, since this now lives in an ESM
 * package) so it works both under `tsx` (src/planner) and after `tsc` compilation (dist/planner).
 * This module lives at `capabilities/engagements/mcp/engagements/src/planner`, so six parents up
 * is the repo root.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The staged seed directory (`engagement-intelligence/seed`). */
export const SEED_DIR = resolve(here, '../../../../../../engagement-intelligence/seed');
