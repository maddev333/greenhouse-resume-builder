/**
 * Filesystem anchors for the planner engine.
 *
 * Resolved from this file's directory so it works both under `tsx` (src/planner) and after
 * `tsc` compilation (dist/planner) — in both layouts three parents up is the repo root.
 */
import { resolve } from 'node:path';

/** The staged seed directory (`engagement-intelligence/seed`). */
export const SEED_DIR = resolve(__dirname, '../../../engagement-intelligence/seed');
