// This module loads dotenv BEFORE any other module imports process.env.
// Import this FIRST in server.ts (before all other imports).
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

// Hydrate process.env from the nearest .env up the tree (the repo root), so local config reaches the
// API regardless of OS or where the process is launched. Cross-platform (no hardcoded path) and a
// no-op in deployment, where App Service settings / managed identity supply configuration — so a
// missing .env must NOT throw.
(function loadNearestEnv() {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const envPath = resolve(dir, '.env');
    if (existsSync(envPath)) {
      loadDotenv({ path: envPath });
      loadDotenv({ path: resolve(dir, '.env.local') });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
})();

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
