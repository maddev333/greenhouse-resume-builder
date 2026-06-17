/**
 * Environment loader for Azure Functions.
 * Import this at the top of function entry points.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

let _loaded = false;

export function loadFunctionEnvironment(): void {
  if (_loaded) {
    return;
  }

  // Find project root (functions are typically in a /dist folder when built)
  const projectRoot = resolve(__dirname, '..', '..', '..');
  
  // Load .env from project root
  const envPath = resolve(projectRoot, '.env');
  if (existsSync(envPath)) {
    config({ path: envPath });
    console.log('[functions-env] Loaded', envPath);
  }

  // Load .env.local (overrides)
  const envLocalPath = resolve(projectRoot, '.env.local');
  if (existsSync(envLocalPath)) {
    config({ path: envLocalPath, override: true });
    console.log('[functions-env] Loaded', envLocalPath);
  }

  _loaded = true;
}

// Auto-load
loadFunctionEnvironment();
