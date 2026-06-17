/**
 * Loads .env files from the monorepo root into process.env.
 * Must be imported BEFORE any module that reads process.env at module-load time.
 *
 * Supports both:
 * - tsx dev execution from api/src
 * - compiled commonjs execution from api/dist
 */

import { resolve } from 'path';
import { config as loadDotenv } from 'dotenv';

const repoRoot = resolve(__dirname, '..', '..');

// Load base env first, then allow local overrides.
loadDotenv({ path: resolve(repoRoot, '.env') });
loadDotenv({ path: resolve(repoRoot, '.env.local'), override: true });
