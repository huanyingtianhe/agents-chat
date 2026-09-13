import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { safetyError, SafetyError } from './safety-errors.mjs';
import {
  assertOperationLease,
  validateProjectRoot,
} from './runtime-safety.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.resolve(
  moduleDirectory,
  '..',
  '..',
  'lib',
  'storage',
  'databases.json',
);
const STORAGE_STATE_FILENAME = '.agents-chat-storage.json';
const BACKUP_DIRECTORY = 'backups';
const RESTORE_RECOVERY_DIRECTORY = 'restore-recovery';

function failure(code, stage, details = {}, backupBatch = null) {
  return safetyError(code, {
    stage,
    serviceState: 'running',
    dataState: 'unchanged',
    backupBatch,
    details,
  });
}

function restoreFailure(stage, details = {}, backupBatch = null) {
  return safetyError('RESTORE_PRECONDITION_FAILED', {
    stage,
    serviceState: 'stopped',
    dataState: 'unchanged',
    backupBatch,
    details,
  });
}

export function loadDatabaseRegistry() {
  const parsed = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (!Array.isArray(parsed.databases) || parsed.databases.length === 0) {
    throw new TypeError('Protected database registry is empty');
  }

  const seen = new Set();
  return Object.freeze(parsed.databases.map((entry) => {
    if (
      typeof entry?.file !== 'string'
      || path.basename(entry.file) !== entry.file
      || !entry.file.endsWith('.db')
      || seen.has(entry.file)
      || !Array.isArray(entry.requiredTables)
      || entry.requiredTables.length === 0
      || entry.requiredTables.some((table) =>
        typeof table !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table))
    ) {
      throw new TypeError('Protected database registry is invalid');
    }
    seen.add(entry.file);
    return Object.freeze({
      file: entry.file,
      requiredTables: Object.freeze([...entry.requiredTables]),
    });
  }));
}

function storagePaths(projectRoot) {
  const validated = validateProjectRoot(projectRoot, { release: true });
  const dataPath = path.resolve(validated.projectRoot, '.data');
  if (
    path.dirname(dataPath) !== validated.projectRoot
    || path.basename(dataPath) !== '.data'
  ) {
    throw failure('INVALID_PROJECT_ROOT', 'data-path', {
      projectRoot: validated.projectRoot,
    });
  }
  return {
    projectRoot: validated.projectRoot,
    dataPath,
    backupsPath: path.join(dataPath, BACKUP_DIRECTORY),
    statePath: path.join(validated.projectRoot, STORAGE_STATE_FILENAME),
  };
}

function readStorageState(statePath, registry) {
  if (!existsSync(statePath)) {
    return { exists: false, expectedDatabases: null };
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    if (
      parsed?.version !== 1
      || !Array.isArray(parsed.expectedDatabases)
      || parsed.expectedDatabases.some((file) =>
        typeof file !== 'string'
        || !registry.some((entry) => entry.file === file))
    ) {
      throw new Error('invalid storage state');
    }
    return {
      exists: true,
      expectedDatabases: [...new Set(parsed.expectedDatabases)],
    };
  } catch {
    throw failure('DATABASE_MISSING', 'storage-state', {
      reason: 'storage-state-unreadable',
    });
  }
}

function writeStorageState(statePath, expectedDatabases) {
  const partialPath = `${statePath}.${randomUUID()}.partial`;
  try {
    writeFileSync(
      partialPath,
      `${JSON.stringify({
        version: 1,
        expectedDatabases,
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(partialPath, statePath);
    if (process.platform !== 'win32') {
      chmodSync(statePath, 0o600);
    }
  } finally {
    rmSync(partialPath, { force: true });
  }
}

function quickCheck(database, file, code = 'DATABASE_INTEGRITY_FAILED') {
  let rows;
  try {
    rows = database.pragma('quick_check', { simple: false });
  } catch (error) {
    throw failure(code, 'database-quick-check', {
      database: file,
      sqliteCode: error?.code,
    });
  }
  const results = rows.map((row) => String(Object.values(row)[0]));
  if (results.length !== 1 || results[0].toLowerCase() !== 'ok') {
    throw failure(code, 'database-quick-check', {
      database: file,
      result: results.slice(0, 5),
    });
  }
  return 'ok';
}

function requiredTables(database, entry, code = 'DATABASE_INTEGRITY_FAILED') {
  const existing = new Set(
    database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).pluck().all(),
  );
  const missing = entry.requiredTables.filter((table) => !existing.has(table));
  if (missing.length > 0) {
    throw failure(code, 'database-schema', {
      database: entry.file,
      missingTables: missing,
    });
  }
}

function removeSidecars(databasePath) {
  for (const suffix of ['-wal', '-shm']) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

function validateDatabaseFile(databasePath, entry, code, { cleanupSidecars = false } = {}) {
  let database;
  try {
    database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 1_000,
    });
    quickCheck(database, entry.file, code);
    requiredTables(database, entry, code);
    return {
      file: entry.file,
      size: statSync(databasePath).size,
      quickCheck: 'ok',
      requiredTables: [...entry.requiredTables],
    };
  } catch (error) {
    if (error instanceof SafetyError) {
      throw error;
    }
    if (isBusyError(error)) {
      throw failure('DATABASE_BUSY', 'database-validation', {
        database: entry.file,
        sqliteCode: error?.code,
      });
    }
    throw failure(code, 'database-open', {
      database: entry.file,
      sqliteCode: error?.code,
    });
  } finally {
    database?.close();
    if (cleanupSidecars) {
      removeSidecars(databasePath);
    }
  }
}

export function inspectProtectedDatabases({ projectRoot }) {
  const paths = storagePaths(projectRoot);
  const registry = loadDatabaseRegistry();
  const state = readStorageState(paths.statePath, registry);
  const existing = registry.filter((entry) =>
    existsSync(path.join(paths.dataPath, entry.file)));
  const expected = state.expectedDatabases ?? existing.map((entry) => entry.file);

  for (const file of expected) {
    if (!existsSync(path.join(paths.dataPath, file))) {
      throw failure('DATABASE_MISSING', 'database-presence', { database: file });
    }
  }

  const databases = existing.map((entry) =>
    validateDatabaseFile(
      path.join(paths.dataPath, entry.file),
      entry,
      'DATABASE_INTEGRITY_FAILED',
    ));

  return Object.freeze({
    ...paths,
    fresh: existing.length === 0 && expected.length === 0,
    stateExists: state.exists,
    expectedDatabases: Object.freeze([...expected]),
    databases: Object.freeze(databases),
    registry,
  });
}

function availableBytes(statfs) {
  return Number(statfs.bavail) * Number(statfs.bsize);
}

function timestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function isBusyError(error) {
  return error?.code === 'SQLITE_BUSY'
    || error?.code === 'SQLITE_LOCKED'
    || /\b(?:busy|locked)\b/i.test(String(error?.message));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function backupWithRetries({
  source,
  destination,
  backup,
  busyRetries,
  retryDelayMs,
}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await backup(source, destination);
      return;
    } catch (error) {
      if (!isBusyError(error)) {
        throw error;
      }
      if (attempt >= busyRetries) {
        throw failure('DATABASE_BUSY', 'database-backup', {
          attempts: attempt + 1,
          sqliteCode: error?.code,
        });
      }
      await delay(retryDelayMs * (attempt + 1));
    }
  }
}

function secureDirectory(directoryPath) {
  if (process.platform !== 'win32') {
    chmodSync(directoryPath, 0o700);
  }
}

function secureFile(filePath) {
  if (process.platform !== 'win32') {
    chmodSync(filePath, 0o600);
  }
}

function manifestFor({
  operationId,
  createdAt,
  databases,
}) {
  return {
    version: 1,
    operationId,
    createdAt: createdAt.toISOString(),
    runtime: {
      node: process.versions.node,
      modules: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
    },
    databases,
  };
}

function manifestEntries(manifest, registry) {
  if (
    manifest?.version !== 1
    || typeof manifest.operationId !== 'string'
    || !Number.isFinite(Date.parse(manifest.createdAt))
    || !Array.isArray(manifest.databases)
    || manifest.databases.length === 0
  ) {
    throw failure('BACKUP_VALIDATION_FAILED', 'backup-manifest');
  }
  const registryByFile = new Map(registry.map((entry) => [entry.file, entry]));
  const files = new Set();
  for (const database of manifest.databases) {
    if (
      typeof database?.file !== 'string'
      || files.has(database.file)
      || !registryByFile.has(database.file)
      || database.quickCheck !== 'ok'
      || !Number.isInteger(database.size)
      || database.size < 0
    ) {
      throw failure('BACKUP_VALIDATION_FAILED', 'backup-manifest');
    }
    files.add(database.file);
  }
  return manifest.databases.map((database) => ({
    manifest: database,
    registry: registryByFile.get(database.file),
  }));
}

export function validateBackupBatch(batchPath) {
  const resolved = path.resolve(batchPath);
  const registry = loadDatabaseRegistry();
  let realBatchPath;
  try {
    realBatchPath = realpathSync(resolved);
    if (realBatchPath !== resolved || !statSync(resolved).isDirectory()) {
      throw new Error('backup batch must be a real directory');
    }
  } catch {
    throw failure('BACKUP_VALIDATION_FAILED', 'backup-path', {}, resolved);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(resolved, 'manifest.json'), 'utf8'));
  } catch {
    throw failure('BACKUP_VALIDATION_FAILED', 'backup-manifest', {}, resolved);
  }

  const entries = manifestEntries(manifest, registry);
  for (const { registry: entry } of entries) {
    removeSidecars(path.join(resolved, entry.file));
  }
  const expectedFiles = [
    ...entries.map(({ registry: entry }) => entry.file),
    'manifest.json',
  ].sort();
  const actualFiles = readdirSync(resolved).sort();
  if (
    actualFiles.length !== expectedFiles.length
    || actualFiles.some((file, index) => file !== expectedFiles[index])
  ) {
    throw failure('BACKUP_VALIDATION_FAILED', 'backup-contents', {}, resolved);
  }
  const databases = entries.map(({ manifest: expected, registry: entry }) => {
    const databasePath = path.join(resolved, entry.file);
    const validated = validateDatabaseFile(
      databasePath,
      entry,
      'BACKUP_VALIDATION_FAILED',
      { cleanupSidecars: true },
    );
    if (validated.size !== expected.size) {
      throw failure(
        'BACKUP_VALIDATION_FAILED',
        'backup-size',
        { database: entry.file },
        resolved,
      );
    }
    return validated;
  });

  return Object.freeze({
    path: resolved,
    operationId: manifest.operationId,
    createdAt: manifest.createdAt,
    databases: Object.freeze(databases),
    paths: Object.freeze(Object.fromEntries(
      databases.map(({ file }) => [file, path.join(resolved, file)]),
    )),
    manifest: Object.freeze(manifest),
  });
}

function completeBatches(backupsPath) {
  if (!existsSync(backupsPath)) {
    return [];
  }
  return readdirSync(backupsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith('.partial'))
    .map((entry) => path.join(backupsPath, entry.name))
    .filter((batchPath) => existsSync(path.join(batchPath, 'manifest.json')))
    .flatMap((batchPath) => {
      try {
        return [validateBackupBatch(batchPath)];
      } catch {
        return [];
      }
    })
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
      || left.path.localeCompare(right.path));
}

function applyRetention(backupsPath, retain) {
  const batches = completeBatches(backupsPath);
  for (const batch of batches.slice(0, Math.max(0, batches.length - retain))) {
    rmSync(batch.path, { recursive: true, force: true });
  }
}

function mapBackupError(error, stage) {
  if (error instanceof SafetyError) {
    return error;
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EROFS') {
    return failure('BACKUP_PERMISSION_DENIED', stage, {
      osCode: error.code,
    });
  }
  if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') {
    return failure('BACKUP_NO_SPACE', stage, { osCode: error.code });
  }
  if (isBusyError(error)) {
    return failure('DATABASE_BUSY', stage, { sqliteCode: error?.code });
  }
  return failure('BACKUP_VALIDATION_FAILED', stage, {
    osCode: error?.code,
  });
}

export async function createVerifiedBackup({
  projectRoot,
  operationId,
  retain = 10,
  busyRetries = 4,
  retryDelayMs = 100,
  now = new Date(),
  hooks = {},
}) {
  const lease = assertOperationLease(projectRoot, operationId);
  const inspection = inspectProtectedDatabases({ projectRoot });
  if (!Number.isInteger(retain) || retain < 1) {
    throw new TypeError('retain must be a positive integer');
  }
  if (inspection.databases.length === 0) {
    if (!inspection.stateExists) {
      writeStorageState(inspection.statePath, []);
    }
    return Object.freeze({
      path: null,
      operationId: lease.operationId,
      databases: Object.freeze([]),
      paths: Object.freeze({}),
      fresh: true,
    });
  }

  const mkdir = hooks.mkdir ?? ((directoryPath) =>
    mkdirSync(directoryPath, { recursive: true, mode: 0o700 }));
  const statfs = hooks.statfs ?? statfsSync;
  const backup = hooks.backup ?? ((source, destination) =>
    source.backup(destination));
  const id = `${timestamp(now)}-${randomUUID()}`;
  const finalPath = path.join(inspection.backupsPath, id);
  const partialPath = `${finalPath}.partial`;
  let publishedAndValidated = false;

  try {
    mkdir(inspection.dataPath);
    secureDirectory(inspection.dataPath);
    const requiredBytes = Math.ceil(
      inspection.databases.reduce((sum, database) => {
        const sourcePath = path.join(inspection.dataPath, database.file);
        return sum + ['', '-wal', '-shm'].reduce((fileSum, suffix) => {
          try {
            return fileSum + statSync(`${sourcePath}${suffix}`).size;
          } catch {
            return fileSum;
          }
        }, 0);
      }, 0)
        * 1.25,
    );
    const available = availableBytes(statfs(inspection.dataPath));
    if (!Number.isFinite(available) || available < requiredBytes) {
      throw failure('BACKUP_NO_SPACE', 'backup-space', {
        requiredBytes,
        availableBytes: available,
      });
    }

    mkdir(inspection.backupsPath);
    secureDirectory(inspection.backupsPath);
    mkdir(partialPath);
    secureDirectory(partialPath);

    const registryByFile = new Map(
      inspection.registry.map((entry) => [entry.file, entry]),
    );
    const manifestDatabases = [];
    for (const sourceInfo of inspection.databases) {
      const entry = registryByFile.get(sourceInfo.file);
      const sourcePath = path.join(inspection.dataPath, entry.file);
      const candidatePartial = path.join(partialPath, `${entry.file}.partial`);
      let source;
      try {
        source = new Database(sourcePath, {
          readonly: true,
          fileMustExist: true,
          timeout: 1_000,
        });
        await backupWithRetries({
          source,
          destination: candidatePartial,
          backup,
          busyRetries,
          retryDelayMs,
        });
      } finally {
        source?.close();
      }
      secureFile(candidatePartial);
      const validated = validateDatabaseFile(
        candidatePartial,
        entry,
        'BACKUP_VALIDATION_FAILED',
        { cleanupSidecars: true },
      );
      const candidate = path.join(partialPath, entry.file);
      renameSync(candidatePartial, candidate);
      secureFile(candidate);
      manifestDatabases.push(validated);
    }

    const manifestPartial = path.join(partialPath, 'manifest.json.partial');
    writeFileSync(
      manifestPartial,
      `${JSON.stringify(manifestFor({
        operationId: lease.operationId,
        createdAt: now,
        databases: manifestDatabases,
      }), null, 2)}\n`,
      { mode: 0o600 },
    );
    const manifestPath = path.join(partialPath, 'manifest.json');
    renameSync(manifestPartial, manifestPath);
    secureFile(manifestPath);
    renameSync(partialPath, finalPath);
    secureDirectory(finalPath);

    const validatedBatch = validateBackupBatch(finalPath);
    publishedAndValidated = true;
    applyRetention(inspection.backupsPath, retain);
    const expectedDatabases = [
      ...new Set([
        ...inspection.expectedDatabases,
        ...inspection.databases.map(({ file }) => file),
      ]),
    ];
    if (
      !inspection.stateExists
      || expectedDatabases.length !== inspection.expectedDatabases.length
    ) {
      writeStorageState(
        inspection.statePath,
        expectedDatabases,
      );
    }
    return validatedBatch;
  } catch (error) {
    rmSync(partialPath, { recursive: true, force: true });
    if (!publishedAndValidated && existsSync(finalPath)) {
      rmSync(finalPath, { recursive: true, force: true });
    }
    if (publishedAndValidated) {
      const mapped = mapBackupError(error, 'backup-retention');
      throw safetyError(mapped.code, {
        ...mapped.failure,
        backupBatch: finalPath,
      });
    }
    throw mapBackupError(error, 'database-backup');
  }
}

function restoreRename(hooks, from, to) {
  const rename = hooks.rename;
  if (rename) {
    rename(from, to, renameSync);
  } else {
    renameSync(from, to);
  }
}

export async function restoreVerifiedBackup({
  projectRoot,
  operationId,
  batchPath,
  serviceStopped,
  hooks = {},
}) {
  assertOperationLease(projectRoot, operationId);
  if (serviceStopped !== true) {
    throw restoreFailure('restore-service-state', {}, batchPath);
  }

  const paths = storagePaths(projectRoot);
  const resolvedBatch = path.resolve(batchPath);
  let realBackupsPath;
  let realBatchPath;
  try {
    realBackupsPath = realpathSync(paths.backupsPath);
    realBatchPath = realpathSync(resolvedBatch);
  } catch {
    throw restoreFailure('restore-batch-path', {}, resolvedBatch);
  }
  if (
    path.dirname(realBatchPath) !== realBackupsPath
    || realBatchPath !== resolvedBatch
    || !existsSync(resolvedBatch)
  ) {
    throw restoreFailure('restore-batch-path', {}, resolvedBatch);
  }

  let batch;
  try {
    batch = validateBackupBatch(resolvedBatch);
  } catch (error) {
    if (error instanceof SafetyError) {
      throw restoreFailure('restore-batch-validation', {
        validationCode: error.code,
      }, resolvedBatch);
    }
    throw error;
  }

  const registry = loadDatabaseRegistry();
  const state = readStorageState(paths.statePath, registry);
  const expected = state.expectedDatabases
    ?? registry
      .filter((entry) => existsSync(path.join(paths.dataPath, entry.file)))
      .map((entry) => entry.file);
  const backupFiles = batch.databases.map(({ file }) => file);
  if (
    expected.length !== backupFiles.length
    || expected.some((file) => !backupFiles.includes(file))
  ) {
    throw restoreFailure('restore-batch-databases', {
      expectedDatabases: expected,
      backupDatabases: backupFiles,
    }, resolvedBatch);
  }

  const recoveryRoot = path.join(paths.dataPath, RESTORE_RECOVERY_DIRECTORY);
  const recoveryPath = path.join(
    recoveryRoot,
    `${timestamp(new Date())}-${randomUUID()}`,
  );
  const originals = new Map();
  const candidates = new Map();
  const replaced = [];

  try {
    mkdirSync(recoveryPath, { recursive: true, mode: 0o700 });
    secureDirectory(recoveryRoot);
    secureDirectory(recoveryPath);

    for (const database of batch.databases) {
      const livePath = path.join(paths.dataPath, database.file);
      if (existsSync(livePath)) {
        copyFileSync(livePath, path.join(recoveryPath, database.file));
      }
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${livePath}${suffix}`;
        if (existsSync(sidecar)) {
          copyFileSync(
            sidecar,
            path.join(recoveryPath, `${database.file}${suffix}`),
          );
          unlinkSync(sidecar);
        }
      }
      const originalPath = `${livePath}.restore-original`;
      const candidatePath = `${livePath}.restore-partial`;
      rmSync(originalPath, { force: true });
      rmSync(candidatePath, { force: true });
      copyFileSync(batch.paths[database.file], candidatePath);
      secureFile(candidatePath);
      validateDatabaseFile(
        candidatePath,
        loadDatabaseRegistry().find((entry) => entry.file === database.file),
        'BACKUP_VALIDATION_FAILED',
        { cleanupSidecars: true },
      );
      originals.set(database.file, originalPath);
      candidates.set(database.file, candidatePath);
    }

    for (const database of batch.databases) {
      const livePath = path.join(paths.dataPath, database.file);
      const originalPath = originals.get(database.file);
      if (existsSync(livePath)) {
        restoreRename(hooks, livePath, originalPath);
      }
      try {
        restoreRename(hooks, candidates.get(database.file), livePath);
        replaced.push(database.file);
      } catch (error) {
        if (existsSync(originalPath) && !existsSync(livePath)) {
          renameSync(originalPath, livePath);
        }
        throw error;
      }
    }

    for (const database of batch.databases) {
      validateDatabaseFile(
        path.join(paths.dataPath, database.file),
        registry.find((entry) => entry.file === database.file),
        'DATABASE_INTEGRITY_FAILED',
        { cleanupSidecars: true },
      );
      const originalPath = originals.get(database.file);
      if (existsSync(originalPath)) {
        renameSync(
          originalPath,
          path.join(recoveryPath, `${database.file}.pre-restore`),
        );
      }
    }
    return Object.freeze({
      restored: Object.freeze(batch.databases.map(({ file }) => file)),
      batchPath: batch.path,
      recoveryPath,
    });
  } catch (error) {
    for (const file of [...replaced].reverse()) {
      const livePath = path.join(paths.dataPath, file);
      const originalPath = originals.get(file);
      rmSync(livePath, { force: true });
      if (existsSync(originalPath)) {
        renameSync(originalPath, livePath);
      }
    }
    for (const [file, originalPath] of originals) {
      const livePath = path.join(paths.dataPath, file);
      if (!existsSync(livePath) && existsSync(originalPath)) {
        renameSync(originalPath, livePath);
      }
    }
    for (const candidatePath of candidates.values()) {
      rmSync(candidatePath, { force: true });
    }
    throw restoreFailure('restore-replace', {
      osCode: error?.code,
    }, resolvedBatch);
  }
}
