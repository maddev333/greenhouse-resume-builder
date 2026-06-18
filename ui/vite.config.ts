import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { parse as parseDotenv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Read one key from the nearest .env up the tree (the repo root) without mutating process.env. */
function nearestEnvValue(key: string): string | undefined {
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const envPath = resolve(dir, '.env');
    if (existsSync(envPath)) {
      const parsed = parseDotenv(readFileSync(envPath));
      if (parsed[key]) return parsed[key];
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export default defineConfig(({ mode }) => {
  // Prefer an explicit ui-level VITE_AZURE_MAPS_KEY; otherwise reuse the repo-root AZURE_MAPS_KEY so the
  // candidate map needs no separate key file. Local dev only — this bakes a subscription key into the
  // client bundle. In production use Azure Maps AAD (anonymous auth + a token endpoint), never a key.
  const uiEnv = loadEnv(mode, here, 'VITE_');
  const mapsKey = uiEnv.VITE_AZURE_MAPS_KEY || nearestEnvValue('AZURE_MAPS_KEY') || '';

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': resolve(here, 'src') },
    },
    server: { port: 5173, proxy: { '/api/v1': 'http://localhost:3001' } },
    define: {
      'import.meta.env.VITE_AZURE_MAPS_KEY': JSON.stringify(mapsKey),
    },
  };
});
