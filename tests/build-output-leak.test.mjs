import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

const projectRoot = process.cwd();
const nextRoot = path.join(projectRoot, '.next');
const standaloneRoot = path.join(nextRoot, 'standalone');
const releaseTarget = 'task6-leak-test';
const releaseRoot = path.join(
  projectRoot,
  'dist',
  'release',
  `agents-chat-${releaseTarget}`,
);
const marker = ['TASK6', 'BUILD', 'SECRET', '7b66fc162aef'].join('_');
const markerBuffer = Buffer.from(marker);

const sentinelFiles = [
  '.data/task6-build-secret.db',
  '.data/task6-build-secret.db-wal',
  '.data/task6-build-secret.db-shm',
  '.data/backups/task6-build-secret/backup.db',
  '.data/backups/task6-build-secret.partial/backup.db.partial',
  '.data/restore-recovery/task6-build-secret/chats.db.pre-restore',
  '.data/task6-build-secret.db.restore-original',
  '.data/task6-build-secret.db.restore-partial',
  '.agents-chat-storage.json',
  '.agents-chat-storage.json.task6.partial',
  '.agents-chat-operation.json',
  '.agents-chat-operation.json.reclaim',
];

const rootStateFiles = new Set(sentinelFiles.filter((relativePath) =>
  relativePath.startsWith('.agents-chat-')));
const sentinelDirectories = [
  '.data/backups/task6-build-secret',
  '.data/backups/task6-build-secret.partial',
  '.data/restore-recovery/task6-build-secret',
];

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function snapshotFile(filePath) {
  if (!existsSync(filePath)) return null;
  return {
    contents: readFileSync(filePath),
    mode: statSync(filePath).mode,
  };
}

function restoreFile(filePath, snapshot) {
  if (snapshot) {
    writeFileSync(filePath, snapshot.contents);
    chmodSync(filePath, snapshot.mode);
  } else {
    rmSync(filePath, { force: true });
  }
}

function isExcludedProjectPath(relativePath) {
  const normalized = relativePath.replaceAll(path.sep, '/');
  return normalized === '.data'
    || normalized.startsWith('.data/')
    || /^\.agents-chat-storage\.json(?:\.|$)/.test(normalized)
    || /^\.agents-chat-operation\.json(?:\.|$)/.test(normalized);
}

function assertNoSentinelContent(root) {
  for (const filePath of walkFiles(root)) {
    assert.equal(
      readFileSync(filePath).includes(markerBuffer),
      false,
      `sentinel content leaked into ${path.relative(projectRoot, filePath)}`,
    );
  }
}

function assertNoExcludedFiles(root) {
  for (const filePath of walkFiles(root)) {
    const relativePath = path.relative(root, filePath);
    assert.equal(
      isExcludedProjectPath(relativePath),
      false,
      `excluded runtime path was bundled: ${relativePath}`,
    );
  }
}

function assertNftManifestsAreClean(root) {
  const manifests = walkFiles(root).filter((filePath) =>
    filePath.endsWith('.nft.json'));
  assert.ok(manifests.length > 0, 'production build emitted no NFT manifests');

  for (const manifestPath of manifests) {
    const contents = readFileSync(manifestPath);
    assert.equal(
      contents.includes(markerBuffer),
      false,
      `sentinel content leaked into ${path.relative(projectRoot, manifestPath)}`,
    );
    const manifest = JSON.parse(contents.toString('utf8'));
    for (const tracedFile of manifest.files ?? []) {
      const resolved = path.resolve(path.dirname(manifestPath), tracedFile);
      const relativePath = path.relative(projectRoot, resolved);
      const standaloneRelativePath = path.relative(standaloneRoot, resolved);
      assert.equal(
        isExcludedProjectPath(relativePath)
          || isExcludedProjectPath(standaloneRelativePath),
        false,
        `excluded path ${relativePath} (${standaloneRelativePath}) leaked into ${
          path.relative(projectRoot, manifestPath)
        }`,
      );
    }
  }
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ...env },
  });
  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join('\n'),
  );
}

test('production artifacts exclude live data and safety operation state', {
  timeout: 10 * 60 * 1000,
}, () => {
  const snapshots = new Map();

  try {
    for (const relativePath of sentinelFiles) {
      const filePath = path.join(projectRoot, relativePath);
      if (rootStateFiles.has(relativePath)) {
        snapshots.set(filePath, snapshotFile(filePath));
      }
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${marker}:${relativePath}\n`);
    }

    run(process.execPath, [path.join(projectRoot, 'scripts', 'build-production.mjs')]);

    assertNoExcludedFiles(standaloneRoot);
    assertNoSentinelContent(standaloneRoot);
    assertNftManifestsAreClean(nextRoot);

    for (const requiredSource of [
      'scripts/runtime-preflight.mjs',
      'scripts/lib/runtime-safety.mjs',
      'scripts/lib/database-backup.mjs',
      'scripts/lib/safety-errors.mjs',
    ]) {
      assert.equal(
        existsSync(path.join(standaloneRoot, requiredSource)),
        true,
        `required runtime safety source was excluded: ${requiredSource}`,
      );
    }

    for (const relativePath of sentinelFiles) {
      const stalePath = path.join(standaloneRoot, relativePath);
      mkdirSync(path.dirname(stalePath), { recursive: true });
      writeFileSync(stalePath, `${marker}:stale:${relativePath}\n`);
    }

    run(process.execPath, [path.join(projectRoot, 'scripts', 'package-release.mjs')], {
      RELEASE_TARGET: releaseTarget,
    });
    assertNoExcludedFiles(releaseRoot);
    assertNoSentinelContent(releaseRoot);
  } finally {
    rmSync(releaseRoot, { recursive: true, force: true });
    for (const relativePath of sentinelFiles) {
      const filePath = path.join(projectRoot, relativePath);
      if (rootStateFiles.has(relativePath)) {
        restoreFile(filePath, snapshots.get(filePath));
      } else {
        rmSync(filePath, { force: true, recursive: true });
      }
      rmSync(path.join(standaloneRoot, relativePath), {
        force: true,
        recursive: true,
      });
    }
    for (const relativePath of sentinelDirectories) {
      rmSync(path.join(projectRoot, relativePath), { force: true, recursive: true });
    }
  }
});
