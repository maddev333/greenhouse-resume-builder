/**
 * Filesystem anchors for the planner engine.
 *
 * Source runs resolve from this module's directory. Deployment bundles collapse modules into one
 * file, so they instead find the packaged seed directory beneath the Web App working directory.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sourceSeedDir = resolve(here, '../../../../../../engagement-intelligence/seed');
const packagedSeedDir = resolve(process.cwd(), 'engagement-intelligence', 'seed');

/** The staged seed directory (`engagement-intelligence/seed`). */
export const SEED_DIR = process.env.ENGAGEMENTS_SEED_DIR
  ? resolve(process.env.ENGAGEMENTS_SEED_DIR)
  : existsSync(packagedSeedDir)
    ? packagedSeedDir
    : sourceSeedDir;
