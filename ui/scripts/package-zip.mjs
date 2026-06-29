#!/usr/bin/env node
/**
 * Builds a self-contained, ready-to-upload deployment zip for the UI.
 *
 * The UI is a static Vite single-page app: the production build emits plain
 * HTML/CSS/JS into ui/dist with no server-side code or node_modules. This
 * script runs that build and zips the dist *contents* at the zip root so the
 * archive can be uploaded directly via Kudu ZipDeploy / `az webapp deploy
 * --type zip` / the Azure Portal, with no build step on the server.
 *
 * Build-time configuration (VITE_*):
 *   Vite bakes VITE_* values into the bundle at build time. It reads them from
 *   (in order of precedence) the current process environment, then ui/.env*
 *   files (.env, .env.production, .env.local, ...). For a production upload,
 *   export the production values before running, e.g.:
 *
 *     VITE_API_BASE_URL=https://ghresume-api-...azurewebsites.net/api/v1 \
 *     VITE_AZURE_AD_CLIENT_ID=<spa-client-id> \
 *     npm run package:zip --workspace ui
 *
 *   ...or put them in ui/.env.production. This script prints which VITE_*
 *   values it detected so you can confirm before uploading.
 *
 * Output zip layout (contents at the zip root):
 *   index.html
 *   assets/...
 *   ...
 *
 * Usage:
 *   npm run package:zip --workspace ui
 *   npm run package:zip --workspace ui -- --out C:\path\to\out.zip
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const uiDir = path.join(repoRoot, 'ui');
const isWin = process.platform === 'win32';

function log(msg) {
  console.log(`[package:zip] ${msg}`);
}

function run(args, cwd) {
  log(`npm ${args.join(' ')}  (cwd: ${cwd})`);
  const res = spawnSync('npm', args, { cwd, stdio: 'inherit', shell: isWin });
  if (res.status !== 0) {
    throw new Error(`\`npm ${args.join(' ')}\` failed with exit code ${res.status}`);
  }
}

function parseOutArg() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  const positional = argv.find((a) => !a.startsWith('-'));
  if (positional) return path.resolve(positional);
  return path.join(repoRoot, '.deploy', 'ghresume-ui-deploy.zip');
}

/**
 * Reports which VITE_* keys Vite will bake into the bundle, so the operator can
 * confirm the build is configured for the intended environment before upload.
 * Does not print values (they may be environment-specific) — only key names and
 * their source. Reads process.env plus the ui/.env* files Vite loads.
 */
function reportViteConfig() {
  const sources = [];

  const fromProcess = Object.keys(process.env).filter((k) => k.startsWith('VITE_'));
  if (fromProcess.length) sources.push(`process env (${fromProcess.sort().join(', ')})`);

  // Vite (production mode) loads these in increasing precedence.
  const envFiles = ['.env', '.env.production', '.env.local', '.env.production.local'];
  const keysFromFiles = new Set();
  for (const f of envFiles) {
    const p = path.join(uiDir, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(VITE_[A-Z0-9_]+)\s*=/.exec(line);
      if (m) keysFromFiles.add(m[1]);
    }
    sources.push(`ui/${f}`);
  }
  if (keysFromFiles.size) {
    sources.push(`.env keys (${[...keysFromFiles].sort().join(', ')})`);
  }

  if (!sources.length) {
    log(
      'WARNING: no VITE_* configuration detected in the environment or ui/.env* files. ' +
        'The bundle will fall back to built-in defaults (e.g. API base URL "/api/v1", ' +
        'no Entra sign-in gate). Export production VITE_* values before packaging if that is not intended.',
    );
    return;
  }
  log(`VITE_* configuration sources: ${sources.join('; ')}`);
}

function zipDir(srcDir, outZip) {
  const require = createRequire(import.meta.url);
  let archiver;
  try {
    archiver = require('archiver');
  } catch {
    throw new Error(
      "Missing dependency 'archiver'. Install it with: npm install --save-dev --workspace ui archiver",
    );
  }
  fs.mkdirSync(path.dirname(outZip), { recursive: true });
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outZip);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(archive.pointer()));
    archive.on('warning', (err) => (err.code === 'ENOENT' ? console.warn(err) : reject(err)));
    archive.on('error', reject);
    archive.pipe(output);
    // `false` => archive the directory's *contents* at the zip root (no wrapper folder).
    archive.directory(srcDir, false);
    archive.finalize();
  });
}

async function main() {
  const outZip = parseOutArg();

  reportViteConfig();

  log('building ui workspace...');
  run(['run', 'build', '--workspace', 'ui'], repoRoot);

  const dist = path.join(uiDir, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new Error('ui build did not produce dist/index.html');
  }

  log(`creating zip: ${outZip}`);
  fs.rmSync(outZip, { force: true });
  const bytes = await zipDir(dist, outZip);
  const mb = (bytes / 1024 / 1024).toFixed(2);
  log(`done -> ${outZip} (${mb} MB)`);
}

main().catch((err) => {
  console.error(`[package:zip] ERROR: ${err.message}`);
  process.exit(1);
});
