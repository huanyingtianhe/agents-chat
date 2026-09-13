import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  createVerifiedBackup,
  inspectProtectedDatabases,
  loadDatabaseRegistry,
  restoreVerifiedBackup,
  validateBackupBatch,
} from '../scripts/lib/database-backup.mjs';
import {
  acquireOperationLease,
  releaseOperationLease,
} from '../scripts/lib/runtime-safety.mjs';

const workRoot = path.join(process.cwd(), 'tests', '.database-backup-work');

before(() => {
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
});

after(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

function createRoot(name) {
  const projectRoot = path.join(workRoot, name);
  mkdirSync(path.join(projectRoot, 'app'), { recursive: true });
  writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'agents-chat', private: true }),
  );
  return projectRoot;
}

function createDatabase(projectRoot, file, table, value) {
  const dataPath = path.join(projectRoot, '.data');
  mkdirSync(dataPath, { recursive: true });
  const database = new Database(path.join(dataPath, file));
  database.pragma('journal_mode = WAL');
  database.exec(`CREATE TABLE ${table} (value TEXT NOT NULL)`);
  database.prepare(`INSERT INTO ${table} (value) VALUES (?)`).run(value);
  return database;
}

function createProtectedDatabases(projectRoot, suffix = '') {
  const chats = createDatabase(projectRoot, 'chats.db', 'chats', `chat${suffix}`);
  chats.exec(`
    ALTER TABLE chats ADD COLUMN user_id TEXT;
    ALTER TABLE chats ADD COLUMN chat_id TEXT;
    ALTER TABLE chats ADD COLUMN messages TEXT;
    ALTER TABLE chats ADD COLUMN agent_sessions TEXT;
    ALTER TABLE chats ADD COLUMN git_context TEXT;
    CREATE TABLE user_prefs (value TEXT, user_id TEXT, last_chat_id TEXT)
  `);
  const config = createDatabase(projectRoot, 'config.db', 'agents', `config${suffix}`);
  config.exec(`
    ALTER TABLE agents ADD COLUMN id TEXT;
    ALTER TABLE agents ADD COLUMN name TEXT;
    ALTER TABLE agents ADD COLUMN command TEXT;
    ALTER TABLE agents ADD COLUMN args TEXT;
    ALTER TABLE agents ADD COLUMN cwd TEXT;
    ALTER TABLE agents ADD COLUMN models TEXT;
    ALTER TABLE agents ADD COLUMN owner TEXT;
    CREATE TABLE nodes (value TEXT, name TEXT, label TEXT, owner TEXT)
  `);
  writeFileSync(
    path.join(projectRoot, '.agents-chat-storage.json'),
    `${JSON.stringify({
      version: 1,
      expectedDatabases: ['chats.db', 'config.db'],
    })}\n`,
  );
  return { chats, config };
}

function readValue(databasePath, table) {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database.prepare(`SELECT value FROM ${table}`).pluck().get();
  } finally {
    database.close();
  }
}

async function withLease(projectRoot, callback) {
  const lease = acquireOperationLease(projectRoot, 'database-test', process.pid);
  try {
    return await callback(lease.operationId);
  } finally {
    releaseOperationLease(projectRoot, lease.operationId);
  }
}

test('backs up committed WAL rows and publishes a validated complete batch', async () => {
  const projectRoot = createRoot('wal');
  const sources = createProtectedDatabases(projectRoot, '-in-wal');

  try {
    const batch = await withLease(projectRoot, (operationId) =>
      createVerifiedBackup({ projectRoot, operationId, retain: 10 }));

    assert.equal(batch.databases.length, 2);
    assert.equal(readValue(batch.paths['chats.db'], 'chats'), 'chat-in-wal');
    assert.equal(readValue(batch.paths['config.db'], 'agents'), 'config-in-wal');
    assert.equal(validateBackupBatch(batch.path).databases.length, 2);
    assert.deepEqual(
      readdirSync(batch.path).sort(),
      ['chats.db', 'config.db', 'manifest.json'],
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(batch.path, 'manifest.json'), 'utf8'))
        .operationId,
      batch.operationId,
    );
    if (process.platform !== 'win32') {
      assert.equal(statSync(batch.path).mode & 0o777, 0o700);
      assert.equal(statSync(batch.paths['chats.db']).mode & 0o777, 0o600);
      assert.equal(
        statSync(path.join(batch.path, 'manifest.json')).mode & 0o777,
        0o600,
      );
    }
  } finally {
    sources.chats.close();
    sources.config.close();
  }
});

test('does not create databases or a backup batch on a fresh install', async () => {
  const projectRoot = createRoot('fresh');

  const batch = await withLease(projectRoot, (operationId) =>
    createVerifiedBackup({ projectRoot, operationId }));

  assert.equal(batch.path, null);
  assert.deepEqual(batch.databases, []);
  assert.equal(existsSync(path.join(projectRoot, '.data', 'chats.db')), false);
  assert.equal(existsSync(path.join(projectRoot, '.data', 'config.db')), false);
});

test('fails when an initialized database is missing', async () => {
  const projectRoot = createRoot('missing');
  mkdirSync(path.join(projectRoot, '.data'), { recursive: true });
  writeFileSync(
    path.join(projectRoot, '.agents-chat-storage.json'),
    JSON.stringify({
      version: 1,
      expectedDatabases: ['chats.db', 'config.db'],
    }),
  );

  await assert.rejects(
    withLease(projectRoot, (operationId) =>
      createVerifiedBackup({ projectRoot, operationId })),
    /DATABASE_MISSING/,
  );
});

test('rejects corrupt source databases without publishing a batch', async () => {
  const projectRoot = createRoot('corrupt');
  const dataPath = path.join(projectRoot, '.data');
  mkdirSync(dataPath, { recursive: true });
  writeFileSync(path.join(dataPath, 'chats.db'), 'not sqlite');
  writeFileSync(
    path.join(projectRoot, '.agents-chat-storage.json'),
    JSON.stringify({ version: 1, expectedDatabases: ['chats.db'] }),
  );

  await assert.rejects(
    withLease(projectRoot, (operationId) =>
      createVerifiedBackup({ projectRoot, operationId })),
    /DATABASE_INTEGRITY_FAILED/,
  );
  assert.equal(existsSync(path.join(dataPath, 'backups')), false);
});

test('removes partial output and never publishes an incomplete batch', async () => {
  const projectRoot = createRoot('partial');
  const sources = createProtectedDatabases(projectRoot);
  let calls = 0;

  try {
    await assert.rejects(
      withLease(projectRoot, (operationId) =>
        createVerifiedBackup({
          projectRoot,
          operationId,
          hooks: {
            async backup(source, destination) {
              calls += 1;
              if (calls === 2) {
                const error = new Error('injected partial failure');
                error.code = 'EIO';
                throw error;
              }
              await source.backup(destination);
            },
          },
        })),
      /BACKUP_VALIDATION_FAILED/,
    );
    const backupsPath = path.join(projectRoot, '.data', 'backups');
    assert.deepEqual(
      existsSync(backupsPath) ? readdirSync(backupsPath) : [],
      [],
    );
  } finally {
    sources.chats.close();
    sources.config.close();
  }
});

test('retains only the newest ten complete batches', async () => {
  const projectRoot = createRoot('retention');
  const sources = createProtectedDatabases(projectRoot);

  try {
    await withLease(projectRoot, async (operationId) => {
      for (let index = 0; index < 12; index += 1) {
        await createVerifiedBackup({
          projectRoot,
          operationId,
          retain: 10,
          now: new Date(Date.UTC(2026, 8, 13, 15, 0, index)),
        });
      }
    });

    const batches = readdirSync(path.join(projectRoot, '.data', 'backups'));
    assert.equal(batches.length, 10);
    assert.equal(batches.some((name) => name.includes('150000')), false);
    assert.equal(batches.some((name) => name.includes('150001')), false);
  } finally {
    sources.chats.close();
    sources.config.close();
  }
});

test('retention always preserves the current batch when its clock moves backward', async () => {
  const projectRoot = createRoot('retention-clock-rollback');
  const sources = createProtectedDatabases(projectRoot);

  try {
    await withLease(projectRoot, async (operationId) => {
      for (let index = 0; index < 10; index += 1) {
        await createVerifiedBackup({
          projectRoot,
          operationId,
          retain: 10,
          now: new Date(Date.UTC(2027, 0, 1, 0, 0, index)),
        });
      }
      const current = await createVerifiedBackup({
        projectRoot,
        operationId,
        retain: 10,
        now: new Date(Date.UTC(2026, 0, 1)),
      });

      assert.equal(existsSync(current.path), true);
      assert.equal(
        readdirSync(path.join(projectRoot, '.data', 'backups')).length,
        10,
      );
    });
  } finally {
    sources.chats.close();
    sources.config.close();
  }
});

test('maps exhausted SQLite busy retries to an actionable failure', async () => {
  const projectRoot = createRoot('busy');
  const sources = createProtectedDatabases(projectRoot);
  let attempts = 0;

  try {
    await assert.rejects(
      withLease(projectRoot, (operationId) =>
        createVerifiedBackup({
          projectRoot,
          operationId,
          busyRetries: 2,
          retryDelayMs: 1,
          hooks: {
            async backup() {
              attempts += 1;
              const error = new Error('database is locked');
              error.code = 'SQLITE_BUSY';
              throw error;
            },
          },
        })),
      /DATABASE_BUSY/,
    );
    assert.equal(attempts, 3);
  } finally {
    sources.chats.close();
    sources.config.close();
  }
});

test('reports disk and permission failures with stable safety codes', async () => {
  const noSpaceRoot = createRoot('no-space');
  const noSpaceSources = createProtectedDatabases(noSpaceRoot);
  try {
    await assert.rejects(
      withLease(noSpaceRoot, (operationId) =>
        createVerifiedBackup({
          projectRoot: noSpaceRoot,
          operationId,
          hooks: {
            statfs() {
              return { bavail: 0, bsize: 4096 };
            },
          },
        })),
      /BACKUP_NO_SPACE/,
    );
  } finally {
    noSpaceSources.chats.close();
    noSpaceSources.config.close();
  }

  const permissionRoot = createRoot('permission');
  const permissionSources = createProtectedDatabases(permissionRoot);
  try {
    await assert.rejects(
      withLease(permissionRoot, (operationId) =>
        createVerifiedBackup({
          projectRoot: permissionRoot,
          operationId,
          hooks: {
            mkdir() {
              const error = new Error('permission denied');
              error.code = 'EACCES';
              throw error;
            },
          },
        })),
      /BACKUP_PERMISSION_DENIED/,
    );
  } finally {
    permissionSources.chats.close();
    permissionSources.config.close();
  }
});

test('restores a verified batch and removes stale WAL and SHM sidecars', async () => {
  const projectRoot = createRoot('restore');
  let sources = createProtectedDatabases(projectRoot, '-backup');
  const batch = await withLease(projectRoot, (operationId) =>
    createVerifiedBackup({ projectRoot, operationId }));
  sources.chats.close();
  sources.config.close();

  rmSync(path.join(projectRoot, '.data', 'chats.db'));
  rmSync(path.join(projectRoot, '.data', 'config.db'));
  sources = createProtectedDatabases(projectRoot, '-live');
  sources.chats.close();
  sources.config.close();
  for (const file of ['chats.db-wal', 'chats.db-shm', 'config.db-wal', 'config.db-shm']) {
    writeFileSync(path.join(projectRoot, '.data', file), 'stale');
  }

  await withLease(projectRoot, (operationId) =>
    restoreVerifiedBackup({
      projectRoot,
      operationId,
      batchPath: batch.path,
      serviceStopped: true,
    }));

  assert.equal(existsSync(path.join(projectRoot, '.data', 'chats.db-wal')), false);
  assert.equal(existsSync(path.join(projectRoot, '.data', 'config.db-shm')), false);
  assert.equal(
    readValue(path.join(projectRoot, '.data', 'chats.db'), 'chats'),
    'chat-backup',
  );
  assert.equal(
    readValue(path.join(projectRoot, '.data', 'config.db'), 'agents'),
    'config-backup',
  );
  assert.equal(
    readdirSync(path.join(projectRoot, '.data', 'restore-recovery')).length,
    1,
  );
});

test('restore requires stopped service and rolls back replacements on rename failure', async () => {
  const projectRoot = createRoot('restore-rollback');
  let sources = createProtectedDatabases(projectRoot, '-backup');
  const batch = await withLease(projectRoot, (operationId) =>
    createVerifiedBackup({ projectRoot, operationId }));
  sources.chats.close();
  sources.config.close();
  rmSync(path.join(projectRoot, '.data', 'chats.db'));
  rmSync(path.join(projectRoot, '.data', 'config.db'));
  sources = createProtectedDatabases(projectRoot, '-live');
  sources.chats.close();
  sources.config.close();
  writeFileSync(path.join(projectRoot, '.data', 'chats.db-wal'), 'chat-wal');
  writeFileSync(path.join(projectRoot, '.data', 'chats.db-shm'), 'chat-shm');
  writeFileSync(path.join(projectRoot, '.data', 'config.db-wal'), 'config-wal');
  writeFileSync(path.join(projectRoot, '.data', 'config.db-shm'), 'config-shm');

  await assert.rejects(
    withLease(projectRoot, (operationId) =>
      restoreVerifiedBackup({
        projectRoot,
        operationId,
        batchPath: batch.path,
        serviceStopped: false,
      })),
    /RESTORE_PRECONDITION_FAILED/,
  );

  let publishRenames = 0;
  await assert.rejects(
    withLease(projectRoot, (operationId) =>
      restoreVerifiedBackup({
        projectRoot,
        operationId,
        batchPath: batch.path,
        serviceStopped: true,
        hooks: {
          rename(from, to, rename) {
            if (from.endsWith('.restore-partial')) {
              publishRenames += 1;
              if (publishRenames === 2) {
                const error = new Error('injected second rename failure');
                error.code = 'EACCES';
                throw error;
              }
            }
            rename(from, to);
          },
        },
      })),
    (error) => {
      assert.equal(error.code, 'RESTORE_PRECONDITION_FAILED');
      assert.equal(error.failure.dataState, 'unchanged');
      return true;
    },
  );

  for (const [file, expected] of [
    ['chats.db-wal', 'chat-wal'],
    ['chats.db-shm', 'chat-shm'],
    ['config.db-wal', 'config-wal'],
    ['config.db-shm', 'config-shm'],
  ]) {
    assert.equal(
      readFileSync(path.join(projectRoot, '.data', file), 'utf8'),
      expected,
    );
  }
  assert.equal(
    readValue(path.join(projectRoot, '.data', 'chats.db'), 'chats'),
    'chat-live',
  );
  assert.equal(
    readValue(path.join(projectRoot, '.data', 'config.db'), 'agents'),
    'config-live',
  );
});

test('restore reports recovery-required when rollback cannot exactly recover sidecars', async () => {
  const projectRoot = createRoot('restore-inexact-rollback');
  let sources = createProtectedDatabases(projectRoot, '-backup');
  const batch = await withLease(projectRoot, (operationId) =>
    createVerifiedBackup({ projectRoot, operationId }));
  sources.chats.close();
  sources.config.close();
  rmSync(path.join(projectRoot, '.data', 'chats.db'));
  rmSync(path.join(projectRoot, '.data', 'config.db'));
  sources = createProtectedDatabases(projectRoot, '-live');
  sources.chats.close();
  sources.config.close();
  const blockedSidecar = path.join(projectRoot, '.data', 'chats.db-wal');
  writeFileSync(blockedSidecar, 'chat-wal');

  let publishRenames = 0;
  await assert.rejects(
    withLease(projectRoot, (operationId) =>
      restoreVerifiedBackup({
        projectRoot,
        operationId,
        batchPath: batch.path,
        serviceStopped: true,
        hooks: {
          rename(from, to, rename) {
            if (from.endsWith('.restore-partial')) {
              publishRenames += 1;
              if (publishRenames === 2) {
                mkdirSync(blockedSidecar);
                const error = new Error('injected publish failure');
                error.code = 'EACCES';
                throw error;
              }
            }
            rename(from, to);
          },
        },
      })),
    (error) => {
      assert.equal(error.failure.dataState, 'recovery-required');
      return true;
    },
  );
});

test('restore retries safely when restore-original is the only live copy', async () => {
  const projectRoot = createRoot('restore-crash-retry');
  let sources = createProtectedDatabases(projectRoot, '-backup');
  const batch = await withLease(projectRoot, (operationId) =>
    createVerifiedBackup({ projectRoot, operationId }));
  sources.chats.close();
  sources.config.close();
  rmSync(path.join(projectRoot, '.data', 'chats.db'));
  rmSync(path.join(projectRoot, '.data', 'config.db'));
  sources = createProtectedDatabases(projectRoot, '-live');
  sources.chats.close();
  sources.config.close();

  const chatsPath = path.join(projectRoot, '.data', 'chats.db');
  renameSync(chatsPath, `${chatsPath}.restore-original`);
  const result = await withLease(projectRoot, (operationId) =>
    restoreVerifiedBackup({
      projectRoot,
      operationId,
      batchPath: batch.path,
      serviceStopped: true,
    }));

  assert.equal(readValue(chatsPath, 'chats'), 'chat-backup');
  assert.equal(
    readValue(path.join(result.recoveryPath, 'chats.db.pre-restore'), 'chats'),
    'chat-live',
  );
  assert.equal(existsSync(`${chatsPath}.restore-original`), false);
});

test('rollback restores originals that were already archived to recovery', async () => {
  const projectRoot = createRoot('restore-archive-rollback');
  let sources = createProtectedDatabases(projectRoot, '-backup');
  const batch = await withLease(projectRoot, (operationId) =>
    createVerifiedBackup({ projectRoot, operationId }));
  sources.chats.close();
  sources.config.close();
  rmSync(path.join(projectRoot, '.data', 'chats.db'));
  rmSync(path.join(projectRoot, '.data', 'config.db'));
  sources = createProtectedDatabases(projectRoot, '-live');
  sources.chats.close();
  sources.config.close();

  await assert.rejects(
    withLease(projectRoot, (operationId) =>
      restoreVerifiedBackup({
        projectRoot,
        operationId,
        batchPath: batch.path,
        serviceStopped: true,
        hooks: {
          rename(from, to, rename) {
            if (to.endsWith('config.db.pre-restore')) {
              const error = new Error('injected archive failure');
              error.code = 'EACCES';
              throw error;
            }
            rename(from, to);
          },
        },
      })),
    /RESTORE_PRECONDITION_FAILED/,
  );

  assert.equal(
    readValue(path.join(projectRoot, '.data', 'chats.db'), 'chats'),
    'chat-live',
  );
  assert.equal(
    readValue(path.join(projectRoot, '.data', 'config.db'), 'agents'),
    'config-live',
  );
});

test('inspection validates schemas and expected state without modifying data', () => {
  const projectRoot = createRoot('inspect');
  const sources = createProtectedDatabases(projectRoot);
  try {
    const result = inspectProtectedDatabases({ projectRoot });
    assert.equal(result.fresh, false);
    assert.deepEqual(
      result.databases.map(({ file }) => file),
      ['chats.db', 'config.db'],
    );
  } finally {
    sources.chats.close();
    sources.config.close();
  }
});

test('inspection rejects a registered table missing a required column', () => {
  const projectRoot = createRoot('inspect-missing-column');
  const sources = createProtectedDatabases(projectRoot);
  try {
    sources.chats.exec(`
      ALTER TABLE chats RENAME TO chats_complete;
      CREATE TABLE chats (
        value TEXT,
        user_id TEXT,
        chat_id TEXT,
        messages TEXT,
        agent_sessions TEXT
      )
    `);
    assert.throws(
      () => inspectProtectedDatabases({ projectRoot }),
      (error) => error?.failure?.code === 'DATABASE_INTEGRITY_FAILED',
    );
  } finally {
    sources.chats.close();
    sources.config.close();
  }
});

test('registry protects every SQLite filename referenced by production stores', () => {
  const protectedFiles = new Set(loadDatabaseRegistry().map(({ file }) => file));
  assert.deepEqual(protectedFiles, new Set(['chats.db', 'config.db']));

  const storeFiles = [
    'lib/chatStore.ts',
    'lib/configStore.ts',
    'lib/scheduler/scheduleStore.ts',
    'lib/workflowStore.ts',
  ];
  const referenced = new Set();
  for (const storeFile of storeFiles) {
    const source = readFileSync(path.join(process.cwd(), storeFile), 'utf8');
    for (const match of source.matchAll(/['"]([^'"]+\.db)['"]/g)) {
      referenced.add(path.basename(match[1]));
    }
  }
  for (const file of referenced) {
    assert.equal(protectedFiles.has(file), true, `${file} is not protected`);
  }
});

test('preflight CLI carries a long-lived owner PID through all lease commands', () => {
  const projectRoot = createRoot('preflight-cli');
  const sources = createProtectedDatabases(projectRoot, '-cli');
  sources.chats.close();
  sources.config.close();
  const cli = path.join(process.cwd(), 'scripts', 'runtime-preflight.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  const acquired = run(
    'acquire',
    '--project-root',
    projectRoot,
    '--owner',
    'test-wrapper',
    '--owner-pid',
    String(process.pid),
  );
  assert.equal(acquired.status, 0, acquired.stderr);
  const lease = JSON.parse(acquired.stdout).lease;
  assert.equal(lease.pid, process.pid);

  const prepared = run(
    'prepare',
    '--project-root',
    projectRoot,
    '--operation-id',
    lease.operationId,
  );
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(JSON.parse(prepared.stdout).backup.databases.length, 2);

  for (const command of ['check-only', 'diagnose']) {
    const checked = run(command, '--project-root', projectRoot);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).checked.storage.databases.length, 2);
  }

  const wrongRelease = run(
    'release',
    '--project-root',
    projectRoot,
    '--operation-id',
    'wrong-operation',
  );
  assert.equal(wrongRelease.status, 1);
  assert.match(wrongRelease.stderr, /"code":"OPERATION_IN_PROGRESS"/);

  const released = run(
    'release',
    '--project-root',
    projectRoot,
    '--operation-id',
    lease.operationId,
  );
  assert.equal(released.status, 0, released.stderr);
});

test('restore CLI refuses to act without explicit stopped-service confirmation', () => {
  const projectRoot = createRoot('restore-cli-guard');
  const cli = path.join(process.cwd(), 'scripts', 'restore-databases.mjs');
  const result = spawnSync(process.execPath, [
    cli,
    '--project-root',
    projectRoot,
    '--from',
    path.join(projectRoot, '.data', 'backups', 'missing'),
    '--operation-id',
    'missing',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /"code":"RESTORE_PRECONDITION_FAILED"/);
  assert.match(result.stderr, /service-stopped/i);
});
