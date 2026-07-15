import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
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

const INPUT = process.env.INPUT;
if (!INPUT) {
  throw new Error('INPUT environment variable is not set (e.g. INPUT=trip-map.html vite build)');
}

const isDev = process.env.NODE_ENV === 'development';

// Builds the trip-map App into a single self-contained HTML file (dist/trip-map.html) that the MCP
// server serves as the ui://trip-map resource. The Azure Maps subscription key is baked from the
// repo-root AZURE_MAPS_KEY (local dev only — production should use Azure Maps AAD anonymous auth).
export default defineConfig(() => {
  const mapsKey = process.env.VITE_AZURE_MAPS_KEY || nearestEnvValue('AZURE_MAPS_KEY') || '';
  return {
    plugins: [react(), viteSingleFile()],
    define: {
      'import.meta.env.VITE_AZURE_MAPS_KEY': JSON.stringify(mapsKey),
    },
    build: {
      sourcemap: isDev ? 'inline' : undefined,
      cssMinify: !isDev,
      minify: !isDev,
      rollupOptions: { input: INPUT },
      outDir: 'dist',
      emptyOutDir: false,
    },
  };
});
