import archiver from 'archiver';
import { build } from 'esbuild';
import { createWriteStream } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_DIR = join(REPO_ROOT, '.deploy');
const STAGING_DIR = join(DEPLOY_DIR, '.webapps-staging');
const SEED_DIR = join(REPO_ROOT, 'engagement-intelligence', 'seed');
const PYTHON_PROJECT_DIR = join(
  REPO_ROOT,
  'capabilities',
  'engagements',
  'agent',
);
const MCP_PROJECT_DIR = join(
  REPO_ROOT,
  'capabilities',
  'engagements',
  'mcp',
  'engagements',
);
const SHARED_ENTRY = join(REPO_ROOT, 'shared', 'src', 'index.ts');
const ZIP_DATE = new Date('2000-01-01T00:00:00.000Z');

const artifacts = {
  gateway: {
    zip: 'engagements-agent-gateway.zip',
    stage: 'gateway',
  },
  runtime: {
    zip: 'engagements-agent-runtime.zip',
    stage: 'runtime',
  },
  mcp: {
    zip: 'engagements-mcp.zip',
    stage: 'mcp',
  },
};

function selectedArtifacts() {
  const requested = process.argv.slice(2);
  const names = requested.length > 0 ? requested : Object.keys(artifacts);
  const unknown = names.filter((name) => !(name in artifacts));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown Web App artifact(s): ${unknown.join(', ')}. Expected gateway, runtime, or mcp.`,
    );
  }
  return [...new Set(names)];
}

async function run(command, args, cwd = REPO_ROOT) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed ${
            signal ? `with signal ${signal}` : `with exit code ${code}`
          }.`,
        ),
      );
    });
  });
}

async function copyTree(source, destination, include = () => true) {
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') continue;
      await copyTree(sourcePath, destinationPath, include);
      continue;
    }
    if (!entry.isFile() || !include(sourcePath)) continue;
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function bundleNodeService(entryPoint, outfile) {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    absWorkingDir: REPO_ROOT,
    alias: {
      '@greenhouse-resume-builder/shared': SHARED_ENTRY,
    },
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    bundle: true,
    entryPoints: [entryPoint],
    format: 'esm',
    legalComments: 'none',
    logLevel: 'warning',
    minify: false,
    outfile,
    platform: 'node',
    target: 'node20',
  });
}

async function copySeedData(stage) {
  await copyTree(
    SEED_DIR,
    join(stage, 'engagement-intelligence', 'seed'),
    (path) => path.endsWith('.json'),
  );
}

async function buildGateway(stage) {
  const bundlePath = join(
    stage,
    'capabilities',
    'engagements',
    'agent',
    'src',
    'main.mjs',
  );
  await bundleNodeService(
    join(PYTHON_PROJECT_DIR, 'src', 'main.ts'),
    bundlePath,
  );
  await copySeedData(stage);
  await writeJson(join(stage, 'package.json'), {
    name: 'engagements-agent-gateway-webapp',
    private: true,
    type: 'module',
    engines: { node: '>=20.11' },
    scripts: {
      start: 'node capabilities/engagements/agent/src/main.mjs --serve',
    },
  });
}

function parsePythonDependencies(pyproject) {
  const projectSection = pyproject.match(
    /\[project\][\s\S]*?\ndependencies\s*=\s*\[([\s\S]*?)\]/,
  );
  if (!projectSection) {
    throw new Error('Could not find [project].dependencies in pyproject.toml.');
  }
  const dependencies = [
    ...projectSection[1].matchAll(/^\s*"([^"]+)"\s*,?\s*$/gm),
  ].map((match) => match[1]);
  if (dependencies.length === 0) {
    throw new Error('Python dependency list is empty.');
  }
  return dependencies;
}

async function buildRuntime(stage) {
  const packageDestination = join(
    stage,
    'capabilities',
    'engagements',
    'agent',
    'engagements_agent',
  );
  await copyTree(
    join(PYTHON_PROJECT_DIR, 'engagements_agent'),
    packageDestination,
    (path) => path.endsWith('.py'),
  );
  await mkdir(join(stage, 'governance'), { recursive: true });
  await copyFile(
    join(REPO_ROOT, 'governance', 'policy.yaml'),
    join(stage, 'governance', 'policy.yaml'),
  );

  const pyproject = await readFile(
    join(PYTHON_PROJECT_DIR, 'pyproject.toml'),
    'utf8',
  );
  const requirements = parsePythonDependencies(pyproject);
  await writeFile(
    join(stage, 'requirements.txt'),
    `${requirements.join('\n')}\n`,
    'utf8',
  );
  await writeFile(
    join(stage, 'startup.sh'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'exec python -m uvicorn engagements_agent.app:app \\',
      '  --app-dir capabilities/engagements/agent \\',
      '  --host 0.0.0.0 \\',
      '  --port "${PORT:-${SERVER_PORT:-8000}}" \\',
      '  --proxy-headers \\',
      '  --forwarded-allow-ips "*"',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function buildMcp(stage) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error('npm_execpath is unavailable; run this packager through an npm script.');
  }
  await run(process.execPath, [
    npmCli,
    'run',
    'build:app',
    '--workspace',
    '@greenhouse-resume-builder/cap-engagements-mcp-engagements',
  ]);

  const bundlePath = join(
    stage,
    'capabilities',
    'engagements',
    'mcp',
    'engagements',
    'src',
    'main.mjs',
  );
  await bundleNodeService(join(MCP_PROJECT_DIR, 'src', 'main.ts'), bundlePath);
  await copySeedData(stage);
  await copyTree(
    join(MCP_PROJECT_DIR, 'dist'),
    join(
      stage,
      'capabilities',
      'engagements',
      'mcp',
      'engagements',
      'dist',
    ),
  );
  await writeJson(join(stage, 'package.json'), {
    name: 'engagements-mcp-webapp',
    private: true,
    type: 'module',
    engines: { node: '>=20.11' },
    scripts: {
      start:
        'node capabilities/engagements/mcp/engagements/src/main.mjs',
    },
  });
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else if (entry.isFile()) {
      files.push({
        absolute: path,
        archive: relative(root, path).split(sep).join('/'),
      });
    }
  }
  return files;
}

async function createZip(stage, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });
  const files = await listFiles(stage);
  if (files.length === 0) {
    throw new Error(`Refusing to create an empty archive from ${stage}.`);
  }

  const output = createWriteStream(outputPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const complete = new Promise((resolvePromise, reject) => {
    output.once('close', resolvePromise);
    output.once('error', reject);
    archive.once('error', reject);
    archive.on('warning', (warning) => {
      if (warning.code === 'ENOENT') {
        console.warn(warning.message);
      } else {
        reject(warning);
      }
    });
  });

  archive.pipe(output);
  for (const file of files) {
    archive.file(file.absolute, {
      name: file.archive,
      date: ZIP_DATE,
      mode: file.archive.endsWith('.sh') ? 0o755 : 0o644,
    });
  }
  await archive.finalize();
  await complete;
}

async function requireFiles(stage, paths) {
  for (const path of paths) {
    await access(join(stage, path));
  }
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function packageArtifact(name) {
  const artifact = artifacts[name];
  const stage = join(STAGING_DIR, artifact.stage);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  if (name === 'gateway') {
    await buildGateway(stage);
    await requireFiles(stage, [
      'package.json',
      'capabilities/engagements/agent/src/main.mjs',
      'engagement-intelligence/seed/config.json',
    ]);
  } else if (name === 'runtime') {
    await buildRuntime(stage);
    await requireFiles(stage, [
      'requirements.txt',
      'startup.sh',
      'governance/policy.yaml',
      'capabilities/engagements/agent/engagements_agent/app.py',
    ]);
  } else {
    await buildMcp(stage);
    await requireFiles(stage, [
      'package.json',
      'capabilities/engagements/mcp/engagements/src/main.mjs',
      'capabilities/engagements/mcp/engagements/dist/trip-map.html',
      'engagement-intelligence/seed/config.json',
    ]);
  }

  const outputPath = join(DEPLOY_DIR, artifact.zip);
  await createZip(stage, outputPath);
  const { size } = await stat(outputPath);
  console.log(`Created ${relative(REPO_ROOT, outputPath)} (${formatSize(size)})`);
}

async function main() {
  const selected = selectedArtifacts();
  await mkdir(DEPLOY_DIR, { recursive: true });
  await rm(STAGING_DIR, { recursive: true, force: true });
  try {
    for (const name of selected) {
      await packageArtifact(name);
    }
  } finally {
    await rm(STAGING_DIR, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
