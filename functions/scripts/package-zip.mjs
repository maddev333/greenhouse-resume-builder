#!/usr/bin/env node
/**
 * Builds a self-contained, ready-to-upload deployment zip for the Azure
 * Functions app (Durable Functions, Node v4 programming model).
 *
 * Why this exists: like the API, this repo is an npm *workspaces* monorepo, so
 * the function app's runtime dependencies (@azure/functions, durable-functions,
 * @azure/storage-blob, @azure/ai-form-recognizer, pg, jose, ...) and the
 * @greenhouse-resume-builder/shared package are hoisted to the ROOT
 * node_modules, not functions/node_modules. Copying functions/node_modules
 * alone produces an incomplete tree that fails to load at runtime. This script
 * assembles an isolated, production-only package (shared shipped as a local
 * tarball) so the zip carries a complete node_modules and runs with no build
 * step on the server.
 *
 * Output zip layout (contents at the zip root, ready for
 * `az functionapp deployment source config-zip` / Kudu ZipDeploy):
 *   host.json
 *   function-app.json        (if present)
 *   package.json             (main: dist/**\/*.js  -> v4 function registration)
 *   dist/...                 (compiled activities, pipeline, services, ...)
 *   node_modules/...
 *
 * local.settings.json is intentionally excluded — it holds local-only values.
 * In Azure, configure these as Function App application settings instead:
 *   FUNCTIONS_EXTENSION_VERSION=~4
 *   FUNCTIONS_WORKER_RUNTIME=node
 *   AzureWebJobsStorage=<real storage account connection string>  (Durable
 *       Functions state cannot use the local "UseDevelopmentStorage=true")
 *   plus the app's own env (PG*, AZURE_*, jose secrets, ...).
 * If you deploy with run-from-package, also set WEBSITE_RUN_FROM_PACKAGE=1.
 *
 * Usage:
 *   npm run package:zip --workspace functions
 *   npm run package:zip --workspace functions -- --out C:\path\to\out.zip
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const fnDir = path.join(repoRoot, 'functions');
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
  return path.join(repoRoot, '.deploy', 'ghresume-functions-deploy.zip');
}

/**
 * Returns a short staging directory. Deep node_modules trees can exceed
 * Windows' 260-char MAX_PATH, so prefer a short path on the system drive and
 * fall back to the OS temp dir elsewhere.
 */
function makeStagingDir() {
  if (isWin) {
    const drive = process.env.SystemDrive || 'C:';
    const candidate = path.join(`${drive}\\`, `ghz${process.pid}`);
    try {
      fs.rmSync(candidate, { recursive: true, force: true });
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      // fall through to os.tmpdir()
    }
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ghz-'));
}

function hasJsFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (hasJsFiles(p)) return true;
    } else if (entry.name.endsWith('.js')) {
      return true;
    }
  }
  return false;
}

function zipDir(srcDir, outZip) {
  const require = createRequire(import.meta.url);
  let archiver;
  try {
    archiver = require('archiver');
  } catch {
    throw new Error(
      "Missing dependency 'archiver'. Install it with: npm install --save-dev --workspace functions archiver",
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

  log('building shared + functions workspaces...');
  run(['run', 'build', '--workspace', 'shared'], repoRoot);
  run(['run', 'build', '--workspace', 'functions'], repoRoot);
  const distDir = path.join(fnDir, 'dist');
  if (!fs.existsSync(distDir) || !hasJsFiles(distDir)) {
    throw new Error('functions build did not produce any dist/*.js files');
  }

  const staging = makeStagingDir();
  try {
    const vendor = path.join(staging, 'vendor');
    fs.mkdirSync(vendor, { recursive: true });

    log('packing shared as a local tarball...');
    run(['pack', '--workspace', 'shared', '--pack-destination', vendor], repoRoot);
    const tgz = fs.readdirSync(vendor).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error('npm pack did not produce a shared tarball');

    log('assembling deployment package...');
    fs.cpSync(distDir, path.join(staging, 'dist'), { recursive: true });

    // Host config (required) + optional app-level config; never ship local.settings.json.
    fs.copyFileSync(path.join(fnDir, 'host.json'), path.join(staging, 'host.json'));
    const fnAppJson = path.join(fnDir, 'function-app.json');
    if (fs.existsSync(fnAppJson)) {
      fs.copyFileSync(fnAppJson, path.join(staging, 'function-app.json'));
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(fnDir, 'package.json'), 'utf8'));
    pkg.dependencies['@greenhouse-resume-builder/shared'] = `file:vendor/${tgz}`;
    fs.writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

    log('installing production dependencies (isolated)...');
    run(['install', '--omit=dev', '--no-audit', '--no-fund'], staging);

    log(`creating zip: ${outZip}`);
    fs.rmSync(outZip, { force: true });
    const bytes = await zipDir(staging, outZip);
    const mb = (bytes / 1024 / 1024).toFixed(2);
    log(`done -> ${outZip} (${mb} MB)`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[package:zip] ERROR: ${err.message}`);
  process.exit(1);
});
