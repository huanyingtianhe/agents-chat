import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { packageRelease } from '../scripts/package-release.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const standaloneRoot = path.join(projectRoot, '.next', 'standalone');
const target = 'task9-runtime-smoke';
const releaseRoot = path.join(projectRoot, 'dist', 'release', `agents-chat-${target}`);
const injected = [
  '.data/chats.db',
  '.data/chats.db-wal',
  '.data/backups/stale/chats.db',
  '.data/restore-recovery/stale/chats.db',
  '.env.local',
  '.agents-chat-storage.json',
  '.agents-chat-operation.json',
  '.service-stop-request.json',
  'logs/private.log',
];
const snapshots = new Map();

function walkFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(root, entry.name);
      return entry.isDirectory() ? walkFiles(entryPath) : [entryPath];
    });
}

function snapshot(filePath) {
  return existsSync(filePath)
    ? { contents: readFileSync(filePath), mode: statSync(filePath).mode }
    : null;
}

function restore(filePath, saved) {
  if (saved) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, saved.contents);
    chmodSync(filePath, saved.mode);
  } else {
    rmSync(filePath, { force: true });
  }
}

function bundleDigest(root) {
  const hash = createHash('sha256');
  for (const filePath of walkFiles(root).sort()) {
    const relativePath = path.relative(root, filePath).replaceAll(path.sep, '/');
    const stats = lstatSync(filePath);
    hash.update(`${relativePath}\0${stats.mode & 0o777}\0`);
    hash.update(stats.isSymbolicLink() ? readlinkSync(filePath) : readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function assertBefore(source, first, second) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing ${first}`);
  assert.notEqual(secondIndex, -1, `missing ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} must precede ${second}`);
}

function findFreePort() {
  const script = [
    "const net=require('node:net');",
    "const server=net.createServer();",
    "server.listen(0,'127.0.0.1',()=>{",
    "console.log(server.address().port);",
    'server.close();',
    '});',
  ].join('');
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim());
}

async function waitForStorageHealth(port, child, token) {
  const deadline = Date.now() + 30_000;
  let lastResponse = 'no response';
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'release server exited before becoming healthy');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health/storage`, {
        headers: { cookie: `next-auth.session-token=${token}` },
      });
      const body = await response.text();
      lastResponse = `${response.status} ${body}`;
      try {
        const health = JSON.parse(body);
        if (typeof health.ok === 'boolean') return health;
      } catch {
        // Retry malformed startup responses.
      }
    } catch {
      // Retry until the server accepts connections.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`release server did not become storage-healthy: ${lastResponse}`);
}

before(() => {
  assert.equal(
    existsSync(path.join(standaloneRoot, 'server.js')),
    true,
    'run npm run build before the release smoke test',
  );
  for (const relativePath of injected) {
    const filePath = path.join(standaloneRoot, relativePath);
    snapshots.set(filePath, snapshot(filePath));
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `task9-private:${relativePath}\n`);
  }
});

after(() => {
  rmSync(releaseRoot, { recursive: true, force: true });
  for (const [filePath, saved] of snapshots) {
    restore(filePath, saved);
  }
});

test('release contents are deterministic, minimal, and contain no local state', () => {
  packageRelease({ projectDir: projectRoot, target });
  const firstDigest = bundleDigest(releaseRoot);
  packageRelease({ projectDir: projectRoot, target });
  const secondDigest = bundleDigest(releaseRoot);
  assert.equal(secondDigest, firstDigest);

  const files = walkFiles(releaseRoot)
    .map((filePath) => path.relative(releaseRoot, filePath).replaceAll(path.sep, '/'));
  for (const required of [
    'scripts/runtime-preflight.mjs',
    'scripts/lib/runtime-safety.mjs',
    'scripts/lib/database-backup.mjs',
    'scripts/lib/safety-errors.mjs',
    'lib/storage/databases.json',
    'scripts/start-release.sh',
    'scripts/start-release.ps1',
    '.env.example',
    'README.md',
    'RELEASE.txt',
  ]) {
    assert.ok(files.includes(required), `missing release runtime file: ${required}`);
  }
  for (const relativePath of files) {
    assert.doesNotMatch(
      relativePath,
      /(^|\/)(?:\.data|\.env\.local|logs)(?:\/|$)|(^|\/)\.(?:agents-chat-(?:storage|operation)|service-(?:stop|watchdog|child))/,
    );
  }
  assert.equal(files.includes('agents.json'), false);
  assert.equal(files.includes('cookie.txt'), false);
  assert.equal(
    readFileSync(path.join(releaseRoot, 'server.js'), 'utf8').includes(projectRoot),
    false,
    'standalone server configuration must not retain the build machine path',
  );

  const shellLauncher = readFileSync(
    path.join(releaseRoot, 'scripts', 'start-release.sh'),
    'utf8',
  );
  const powerShellLauncher = readFileSync(
    path.join(releaseRoot, 'scripts', 'start-release.ps1'),
    'utf8',
  );
  assert.match(shellLauncher, /Node\.js 24/);
  assert.match(shellLauncher, /runtime-preflight\.mjs.*check-only/);
  assert.match(shellLauncher, /AGENTS_CHAT_STDOUT_LOGGING=1/);
  assert.match(shellLauncher, /export PORT="\$port"/);
  assert.doesNotMatch(shellLauncher, /server\.js --port/);
  assertBefore(shellLauncher, 'check-only', 'server.js');
  assertBefore(shellLauncher, 'export PORT="$port"', 'server.js');
  assert.match(powerShellLauncher, /Node\.js 24/);
  assert.match(powerShellLauncher, /runtime-preflight\.mjs.*check-only/);
  assert.match(powerShellLauncher, /\$PSBoundParameters\.ContainsKey\('Port'\)/);
  assert.match(powerShellLauncher, /elseif \(\$env:PORT\)/);
  assert.match(powerShellLauncher, /\$env:PORT = "\$ResolvedPort"/);
  assert.doesNotMatch(powerShellLauncher, /server\.js --port/);
  assertBefore(
    powerShellLauncher,
    "if ($PSBoundParameters.ContainsKey('Port'))",
    'elseif ($env:PORT)',
  );
  assertBefore(powerShellLauncher, 'check-only', 'server.js');
  assertBefore(powerShellLauncher, '$env:PORT = "$ResolvedPort"', 'server.js');
});

test('release workflow inspects and smoke-tests both OS archives', () => {
  const workflow = readFileSync(
    path.join(projectRoot, '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  assert.match(workflow, /Smoke test archived release \(Linux\)/);
  assert.match(workflow, /tar -xzf/);
  assert.match(workflow, /Smoke test archived release \(Windows\)/);
  assert.match(workflow, /Expand-Archive/);
  assert.match(workflow, /runtime-preflight\.mjs" check-only/);
  assert.match(workflow, /api\/health\/storage/);
  assert.match(workflow, /kill "\$server_pid"/);
  assert.match(workflow, /\$env:PORT = "\$port"/);
  assert.match(workflow, /\$serverId = \$server\.Id/);
  assert.match(workflow, /Stop-Process -Id \$serverId/);
  assert.doesNotMatch(workflow, /Stop-Process -Id \$server\.Id/);
  assertBefore(workflow, '$env:PORT = "$port"', 'Start-Process node');
  assertBefore(workflow, '$serverId = $server.Id', 'Stop-Process -Id $serverId');
  const windowsPoll = workflow.slice(workflow.indexOf('Smoke test archived release (Windows)'));
  assert.match(
    windowsPoll,
    /for \(\$attempt = 0; \$attempt -lt 60; \$attempt\+\+\) \{[\s\S]*?try \{[\s\S]*?\} catch \{[\s\S]*?\}[\s\S]*?Start-Sleep -Milliseconds 500[\s\S]*?\}/,
  );
  assert.match(workflow, /agents-chat-\(storage\|operation\)/);
  assert.match(workflow, /restore-recovery/);
});

test('packaged release passes preflight and serves storage health', {
  timeout: 45_000,
}, async () => {
  packageRelease({ projectDir: projectRoot, target });
  const preflight = spawnSync(
    process.execPath,
    ['scripts/runtime-preflight.mjs', 'check-only', '--project-root', releaseRoot],
    { cwd: releaseRoot, encoding: 'utf8' },
  );
  assert.equal(preflight.status, 0, preflight.stderr);

  const port = findFreePort();
  const secret = 'task9-release-smoke-only';
  const { encode } = await import('next-auth/jwt');
  const token = await encode({ token: { sub: 'release-smoke' }, secret });
  const child = spawn(
    path.join(releaseRoot, 'scripts', 'start-release.sh'),
    [],
    {
      cwd: releaseRoot,
      env: {
        ...process.env,
        PORT: String(port),
        NEXTAUTH_SECRET: secret,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    const health = await waitForStorageHealth(port, child, token);
    assert.equal(health.ok, true);
  } catch (error) {
    throw new Error(`${error.message}\n${stderr.slice(0, 4000)}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  assert.ok(
    child.signalCode === 'SIGTERM' || child.exitCode === 0 || child.exitCode === 143,
    `exitCode=${child.exitCode} signalCode=${child.signalCode}\n${stderr}`,
  );
});
