#!/usr/bin/env node
/**
 * Builds a self-contained, ready-to-upload deployment zip for the API.
 *
 * Why this exists: the repo is an npm *workspaces* monorepo, so the API's
 * runtime dependencies (pg, helmet, cors, jose, jsonwebtoken, dotenv, @azure/*)
 * and the @greenhouse-resume-builder/shared package are hoisted to the ROOT
 * node_modules, not api/node_modules. Copying api/node_modules alone produces an
 * incomplete tree that crashes at startup. This script assembles an isolated,
 * production-only package (shared shipped as a local tarball) so the zip carries
 * a complete node_modules and runs without any build step on Azure App Service.
 *
 * Output zip layout (contents at the zip root, ready for Kudu ZipDeploy /
 * `az webapp deploy --type zip`):
 *   server.js            (shim -> dist/server.js)
 *   web.config           (IIS/iisnode routing for Azure App Service on Windows)
 *   package.json
 *   dist/...
 *   node_modules/...
 *
 * Usage:
 *   npm run package:zip --workspace api
 *   npm run package:zip --workspace api -- --out C:\path\to\out.zip
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
const apiDir = path.join(repoRoot, 'api');
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
  return path.join(repoRoot, '.deploy', 'ghresume-api-deploy.zip');
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

function zipDir(srcDir, outZip) {
  const require = createRequire(import.meta.url);
  let archiver;
  try {
    archiver = require('archiver');
  } catch {
    throw new Error(
      "Missing dependency 'archiver'. Install it with: npm install --save-dev --workspace api archiver",
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

  log('building shared + api workspaces...');
  run(['run', 'build', '--workspace', 'shared'], repoRoot);
  run(['run', 'build', '--workspace', 'api'], repoRoot);
  if (!fs.existsSync(path.join(apiDir, 'dist', 'server.js'))) {
    throw new Error('api build did not produce dist/server.js');
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
    fs.cpSync(path.join(apiDir, 'dist'), path.join(staging, 'dist'), { recursive: true });
    // web.config is required for Azure App Service on Windows (IIS + iisnode) to
    // route HTTP requests to the Node app; without it IIS 404s every route.
    fs.copyFileSync(path.join(apiDir, 'web.config'), path.join(staging, 'web.config'));
    const pkg = JSON.parse(fs.readFileSync(path.join(apiDir, 'package.json'), 'utf8'));
    pkg.dependencies['@greenhouse-resume-builder/shared'] = `file:vendor/${tgz}`;
    fs.writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

    log('installing production dependencies (isolated)...');
    run(['install', '--omit=dev', '--no-audit', '--no-fund'], staging);

    // Root entry shim for Azure App Service startup detection.
    fs.writeFileSync(path.join(staging, 'server.js'), "require('./dist/server.js');\n");

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
