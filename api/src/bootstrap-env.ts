// Must be imported first in server.ts — before any other imports.
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';

// Load from project root (resolve relative to this file: api/src/bootstrap-env.ts -> ../../)
const projectRoot = resolve(__dirname, '..', '..');
loadDotenv({ path: resolve(projectRoot, '.env') });
loadDotenv({ path: resolve(projectRoot, '.env.local') });
console.error('[bootstrap-env] ALLOW_DEV_AUTH_BYPASS=', process.env.ALLOW_DEV_AUTH_BYPASS);
