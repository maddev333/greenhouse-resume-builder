/**
 * Minimal, zero-dependency .env loader for the capability agent.
 *
 * The agent runs as a standalone Node process (CLI or embedded by an HTTP host), so it must
 * load the repo-root `.env` itself to pick up Azure OpenAI + On-Behalf-Of settings. We avoid a
 * dotenv dependency here to keep the capability independently deployable (IL5 posture).
 *
 * Precedence matches dotenv: values already present in process.env win over `.env` (so shell /
 * platform app settings override), and `.env.local` overrides `.env`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let _loaded = false;

function parseEnvFile(path: string, override: boolean): void {
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** Walk up from `start` (inclusive) to the nearest ancestor directory containing a `.env` file. */
function findEnvDir(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(resolve(dir, '.env'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Load the repo-root `.env` (then `.env.local`) into process.env. Idempotent. */
export function loadAgentEnv(): void {
  if (_loaded) return;
  _loaded = true;
  const root = findEnvDir(__dirname);
  if (!root) return;
  parseEnvFile(resolve(root, '.env'), false);
  const local = resolve(root, '.env.local');
  if (existsSync(local)) parseEnvFile(local, true);
}
