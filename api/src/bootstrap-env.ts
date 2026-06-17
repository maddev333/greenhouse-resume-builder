// Must be imported first in server.ts — before any other imports.
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: '/Users/nick/repos/greenhouse-resume-builder/.env' });
console.error('[bootstrap-env] ALLOW_DEV_AUTH_BYPASS=', process.env.ALLOW_DEV_AUTH_BYPASS);
