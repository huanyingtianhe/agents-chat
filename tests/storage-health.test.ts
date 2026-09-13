import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { isStorageError, toStorageErrorResponse } from '../lib/storage/storageErrors';
import { checkStorageHealth } from '../lib/storage/storageHealth';
import { getStoragePaths } from '../lib/storage/storagePaths';

const roots: string[] = [];

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), '.storage-health-test-'));
  roots.push(root);
  return root;
}

test.after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test('fresh initialization creates canonical schemas and project-root instance state', async () => {
  const projectRoot = await createProjectRoot();
  const paths = getStoragePaths(projectRoot);

  assert.equal((await checkStorageHealth({ projectRoot, initialize: true })).ok, true);

  const state = JSON.parse(await readFile(paths.statePath, 'utf8'));
  assert.deepEqual(state.expectedDatabases, ['chats.db', 'config.db']);
  assert.equal(path.dirname(paths.statePath), projectRoot);
  assert.notEqual(path.dirname(paths.statePath), paths.dataPath);

  for (const databasePath of [paths.chatDbPath, paths.configDbPath]) {
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    assert.equal(db.prepare('SELECT 1').pluck().get(), 1);
    db.close();
  }
});

test('an established initialized instance remains healthy', async () => {
  const projectRoot = await createProjectRoot();
  await checkStorageHealth({ projectRoot, initialize: true });

  assert.deepEqual(await checkStorageHealth({ projectRoot, initialize: false }), { ok: true });
});

test('check-only health does not initialize a missing instance', async () => {
  const projectRoot = await createProjectRoot();
  const result = await checkStorageHealth({ projectRoot, initialize: false });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'DATABASE_MISSING');
});

test('a missing expected database is rejected without recreation', async () => {
  const projectRoot = await createProjectRoot();
  const paths = getStoragePaths(projectRoot);
  await checkStorageHealth({ projectRoot, initialize: true });
  await unlink(paths.chatDbPath);

  const result = await checkStorageHealth({ projectRoot, initialize: true });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'DATABASE_MISSING');
  await assert.rejects(readFile(paths.chatDbPath));
});

test('wrong schemas and corrupt files are unhealthy', async () => {
  const wrongSchemaRoot = await createProjectRoot();
  const wrongSchemaPaths = getStoragePaths(wrongSchemaRoot);
  await mkdir(wrongSchemaPaths.dataPath, { recursive: true });
  const wrongSchemaDb = new Database(wrongSchemaPaths.chatDbPath);
  wrongSchemaDb.exec('CREATE TABLE unrelated (id TEXT)');
  wrongSchemaDb.close();

  const wrongSchema = await checkStorageHealth({ projectRoot: wrongSchemaRoot, initialize: false });
  assert.equal(wrongSchema.ok, false);
  if (!wrongSchema.ok) assert.equal(wrongSchema.code, 'DATABASE_INTEGRITY_FAILED');

  const corruptRoot = await createProjectRoot();
  const corruptPaths = getStoragePaths(corruptRoot);
  await mkdir(corruptPaths.dataPath, { recursive: true });
  await writeFile(corruptPaths.chatDbPath, 'not a sqlite database');

  const corrupt = await checkStorageHealth({ projectRoot: corruptRoot, initialize: false });
  assert.equal(corrupt.ok, false);
  if (!corrupt.ok) assert.equal(corrupt.code, 'DATABASE_INTEGRITY_FAILED');
});

test('storage errors map to a generic 503 without changing application errors', async () => {
  const malformed = new Error('database disk image is malformed');
  const response = toStorageErrorResponse(malformed);

  assert.equal(isStorageError(malformed), true);
  assert.equal(response?.status, 503);
  assert.deepEqual(await response?.json(), { ok: false, error: 'storage_unavailable' });
  assert.equal(isStorageError(new Error('validation failed')), false);
  assert.equal(toStorageErrorResponse(new Error('validation failed')), null);
  assert.equal(isStorageError(Object.assign(new Error('unique constraint failed'), { code: 'SQLITE_CONSTRAINT' })), false);
  assert.equal(isStorageError(new Error('The module was compiled against a different Node.js version')), true);
});
