import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRuntimeDataArtifact } from './lib/build-data-safety.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(__dirname, '..');
const outputDir = join(projectDir, 'dist', 'release');
const target = process.env.RELEASE_TARGET || `${process.platform}-${process.arch}`;
const bundleDir = join(outputDir, `agents-chat-${target}`);
const standaloneDir = join(projectDir, '.next', 'standalone');

function resetDir(dir) {
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });
}

function copyIfExists(source, destination) {
  if (!existsSync(source)) return;
  cpSync(source, destination, { recursive: true });
}

resetDir(bundleDir);
mkdirSync(join(bundleDir, '.next'), { recursive: true });

if (existsSync(standaloneDir)) {
  cpSync(standaloneDir, bundleDir, {
    recursive: true,
    filter: (source) =>
      !isRuntimeDataArtifact(relative(standaloneDir, source)),
  });
}
copyIfExists(join(projectDir, '.next', 'static'), join(bundleDir, '.next', 'static'));
copyIfExists(join(projectDir, 'public'), join(bundleDir, 'public'));
copyIfExists(join(projectDir, '.env.example'), join(bundleDir, '.env.example'));
copyIfExists(join(projectDir, 'README.md'), join(bundleDir, 'README.md'));

for (const path of ['.git', 'dist']) {
  rmSync(join(bundleDir, path), { force: true, recursive: true });
}

const launcherDir = join(bundleDir, 'scripts');
mkdirSync(launcherDir, { recursive: true });

writeFileSync(
  join(launcherDir, 'start-release.sh'),
  [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'project_dir="$(cd "$script_dir/.." && pwd)"',
    'port="${PORT:-3010}"',
    '',
    'cd "$project_dir"',
    'exec node server.js --port "$port"',
    '',
  ].join('\n'),
  'utf8',
);
chmodSync(join(launcherDir, 'start-release.sh'), 0o755);

writeFileSync(
  join(launcherDir, 'start-release.ps1'),
  [
    'param(',
    '    [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 3010 })',
    ')',
    '',
    "$ErrorActionPreference = 'Stop'",
    '$ProjectDir = Split-Path -Parent $PSScriptRoot',
    'Set-Location $ProjectDir',
    'node .\\server.js --port $Port',
    '',
  ].join('\n'),
  'utf8',
);

writeFileSync(
  join(bundleDir, 'RELEASE.txt'),
  `Agents Chat release bundle

Contents:
- Next.js standalone server bundle
- static assets from .next/static
- public assets
- startup scripts in scripts/

Quick start:
- Linux/macOS: PORT=3010 ./scripts/start-release.sh
- Windows: powershell -ExecutionPolicy Bypass -File .\\scripts\\start-release.ps1

Before starting, create .env.local from .env.example and fill in the required values.
`,
  'utf8',
);

console.log(`Prepared release bundle: ${bundleDir}`);
