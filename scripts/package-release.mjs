import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultProjectDir = resolve(scriptDir, '..');
const standaloneEntries = new Set([
  '.next',
  'app',
  'instrumentation.ts',
  'lib',
  'next.config.ts',
  'node_modules',
  'package.json',
  'server.js',
]);
const requiredRuntimeFiles = [
  'scripts/runtime-preflight.mjs',
  'scripts/lib/runtime-safety.mjs',
  'scripts/lib/database-backup.mjs',
  'scripts/lib/safety-errors.mjs',
  'lib/storage/databases.json',
];
const publicMetadataFiles = ['.env.example', 'README.md'];

function normalized(relativePath) {
  return relativePath.split(sep).join('/');
}

export function isReleasePrivateArtifact(relativePath) {
  const value = normalized(relativePath);
  const segments = value.split('/');
  return segments.includes('.data')
    || segments.includes('logs')
    || segments.some((segment) => /^\.env(?:\.|$)/.test(segment) && segment !== '.env.example')
    || segments.some((segment) => /^\.agents-chat-(?:storage|operation)\.json(?:\.|$)/.test(segment))
    || segments.some((segment) => /^\.service-(?:stop|watchdog|child)(?:\.|$)/.test(segment))
    || segments.some((segment) => /\.restore-(?:original|partial)$/.test(segment))
    || segments.includes('restore-recovery')
    || segments.includes('backups');
}

function resetDir(directoryPath) {
  rmSync(directoryPath, { force: true, recursive: true });
  mkdirSync(directoryPath, { recursive: true });
}

function copyRequired(projectDir, relativePath, bundleDir) {
  const source = join(projectDir, relativePath);
  if (!existsSync(source)) {
    throw new Error(`Required release file is missing: ${relativePath}`);
  }
  const destination = join(bundleDir, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function copyStandalone(standaloneDir, bundleDir) {
  if (!existsSync(join(standaloneDir, 'server.js'))) {
    throw new Error(`Next.js standalone output is missing: ${standaloneDir}`);
  }
  cpSync(standaloneDir, bundleDir, {
    recursive: true,
    filter(source) {
      const relativePath = relative(standaloneDir, source);
      if (relativePath === '') return true;
      if (isReleasePrivateArtifact(relativePath)) return false;
      return standaloneEntries.has(relativePath.split(sep)[0]);
    },
  });
}

function makeStandaloneConfigPortable(projectDir, bundleDir) {
  const serverPath = join(bundleDir, 'server.js');
  const escapedProjectDir = JSON.stringify(resolve(projectDir)).slice(1, -1);
  const contents = readFileSync(serverPath, 'utf8')
    .replaceAll(escapedProjectDir, '.')
    .replaceAll(resolve(projectDir), '.');
  writeFileSync(serverPath, contents, 'utf8');
}

function writeLaunchers(bundleDir) {
  const launcherDir = join(bundleDir, 'scripts');
  mkdirSync(launcherDir, { recursive: true });

  const shellLauncher = join(launcherDir, 'start-release.sh');
  writeFileSync(
    shellLauncher,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '',
      'script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'project_dir="$(cd "$script_dir/.." && pwd)"',
      'port="${PORT:-3010}"',
      '',
      'cd "$project_dir"',
      'node -e \'if (process.versions.node.split(".")[0] !== "24") { console.error("Agents Chat requires Node.js 24.x"); process.exit(1) }\';',
      'node scripts/runtime-preflight.mjs check-only --project-root "$project_dir"',
      'export AGENTS_CHAT_STDOUT_LOGGING=1',
      'exec node server.js --port "$port"',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(shellLauncher, 0o755);

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
      "$nodeMajor = & node -p \"process.versions.node.split('.')[0]\"",
      "if ($LASTEXITCODE -ne 0 -or $nodeMajor -ne '24') {",
      "    throw 'Agents Chat requires Node.js 24.x'",
      '}',
      '& node .\\scripts\\runtime-preflight.mjs check-only --project-root $ProjectDir',
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      "$env:AGENTS_CHAT_STDOUT_LOGGING = '1'",
      '& node .\\server.js --port $Port',
      'exit $LASTEXITCODE',
      '',
    ].join('\n'),
    'utf8',
  );
}

export function packageRelease({
  projectDir = defaultProjectDir,
  target = process.env.RELEASE_TARGET || `${process.platform}-${process.arch}`,
  outputDir = join(projectDir, 'dist', 'release'),
  standaloneDir = join(projectDir, '.next', 'standalone'),
} = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(target)) {
    throw new TypeError(`Invalid release target: ${target}`);
  }

  const bundleDir = join(outputDir, `agents-chat-${target}`);
  resetDir(bundleDir);
  copyStandalone(standaloneDir, bundleDir);
  makeStandaloneConfigPortable(projectDir, bundleDir);

  copyRequired(projectDir, '.next/static', bundleDir);
  copyRequired(projectDir, 'public', bundleDir);
  for (const relativePath of [...requiredRuntimeFiles, ...publicMetadataFiles]) {
    copyRequired(projectDir, relativePath, bundleDir);
  }
  writeLaunchers(bundleDir);
  writeFileSync(
    join(bundleDir, 'RELEASE.txt'),
    `Agents Chat release bundle

Contents:
- Next.js standalone server bundle
- static and public assets
- storage safety preflight
- Node.js 24 guarded startup scripts

Quick start:
- Linux/macOS: PORT=3010 ./scripts/start-release.sh
- Windows: powershell -ExecutionPolicy Bypass -File .\\scripts\\start-release.ps1

Before starting, create .env.local from .env.example and fill in the required values.
`,
    'utf8',
  );

  return bundleDir;
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const bundleDir = packageRelease();
  console.log(`Prepared release bundle: ${bundleDir}`);
}
