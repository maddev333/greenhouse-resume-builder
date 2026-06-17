/**
 * Environment loader for Azure Functions.
 * Import this at the top of function entry points.
 */

import { config } from 'dotenv';
import { resolve, dirname, parse } from 'path';
import { existsSync } from 'fs';

let _loaded = false;

/** Walk up from a starting directory to find the nearest one containing a `.env`. */
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  const { root } = parse(dir);
  for (;;) {
    if (existsSync(resolve(dir, '.env'))) return dir;
    if (dir === root) break;
    dir = dirname(dir);
  }
  // Fallback: repo root relative to this file when compiled to functions/dist.
  return resolve(startDir, '..', '..');
}

export function loadFunctionEnvironment(): void {
  if (_loaded) {
    return;
  }

  // Locate the repo-root `.env` by searching upward. Using a search (rather than a
  // fixed number of '..') keeps this correct whether running from src (ts) or
  // dist (compiled), regardless of nesting depth.
  const projectRoot = findProjectRoot(__dirname);

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
