import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import Database from 'better-sqlite3';

import { getDb } from '@/lib/chatStore';
import { getConfigDb } from '@/lib/configStore';
import databaseRegistry from '@/lib/storage/databases.json';
import { getStorageErrorCode, type StorageErrorCode } from '@/lib/storage/storageErrors';
import { getStoragePaths } from '@/lib/storage/storagePaths';

type StorageHealthResult =
  | { ok: true }
  | { ok: false; code: StorageErrorCode };

type StorageState = {
  version: 1;
  expectedDatabases: string[];
};

type DatabaseEntry = {
  file: string;
  requiredTables: Record<string, string[]>;
};

const registry = databaseRegistry.databases as unknown as DatabaseEntry[];

function storageFailure(code: StorageErrorCode): Error & { code: StorageErrorCode } {
  return Object.assign(new Error(code), { code });
}

function readState(statePath: string): StorageState | null {
  if (!existsSync(statePath)) return null;
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<StorageState>;
    if (
      state.version !== 1
      || !Array.isArray(state.expectedDatabases)
      || state.expectedDatabases.some((file) =>
        typeof file !== 'string' || !registry.some((entry) => entry.file === file))
    ) {
      throw new Error('invalid storage state');
    }
    return {
      version: 1,
      expectedDatabases: [...new Set(state.expectedDatabases)],
    };
  } catch {
    throw storageFailure('DATABASE_MISSING');
  }
}

function writeState(statePath: string, expectedDatabases: string[]): void {
  const partialPath = `${statePath}.${randomUUID()}.partial`;
  try {
    writeFileSync(partialPath, `${JSON.stringify({
      version: 1,
      expectedDatabases,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    renameSync(partialPath, statePath);
    if (process.platform !== 'win32') chmodSync(statePath, 0o600);
  } finally {
    rmSync(partialPath, { force: true });
  }
}

function checkRequiredTables(database: Database.Database, entry: DatabaseEntry): void {
  try {
    for (const [table, requiredColumns] of Object.entries(entry.requiredTables)) {
      const columns = new Set(
        database.prepare(`PRAGMA table_info("${table}")`).all()
          .map((column) => (column as { name: string }).name),
      );
      if (columns.size === 0 || requiredColumns.some((column) => !columns.has(column))) {
        throw storageFailure('DATABASE_INTEGRITY_FAILED');
      }
    }
  } catch (error) {
    const code = getStorageErrorCode(error);
    if (code === 'DATABASE_BUSY') throw storageFailure('DATABASE_BUSY');
    throw storageFailure('DATABASE_INTEGRITY_FAILED');
  }
}

function checkDatabase(databasePath: string, entry: DatabaseEntry): void {
  let database: Database.Database | null = null;
  try {
    database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 1_000,
    });
    checkRequiredTables(database, entry);
  } catch (error) {
    const code = getStorageErrorCode(error);
    if (code === 'DATABASE_BUSY') throw storageFailure('DATABASE_BUSY');
    throw storageFailure('DATABASE_INTEGRITY_FAILED');
  } finally {
    database?.close();
  }
}

export async function checkStorageHealth({
  projectRoot = process.cwd(),
  initialize = false,
}: {
  projectRoot?: string;
  initialize?: boolean;
} = {}): Promise<StorageHealthResult> {
  const paths = getStoragePaths(projectRoot);
  try {
    const state = readState(paths.statePath);
    const databasePaths = new Map([
      ['chats.db', paths.chatDbPath],
      ['config.db', paths.configDbPath],
    ]);

    for (const expected of state?.expectedDatabases ?? []) {
      const databasePath = databasePaths.get(expected);
      if (!databasePath || !existsSync(databasePath)) {
        throw storageFailure('DATABASE_MISSING');
      }
    }

    const existing = registry.filter((entry) => {
      const databasePath = databasePaths.get(entry.file);
      return databasePath ? existsSync(databasePath) : false;
    });

    for (const entry of existing) {
      checkDatabase(databasePaths.get(entry.file)!, entry);
    }

    if (!initialize) {
      if (existing.length === 0) throw storageFailure('DATABASE_MISSING');
      return { ok: true };
    }

    mkdirSync(paths.dataPath, { recursive: true });
    getDb(paths.projectRoot);
    getConfigDb(paths.projectRoot);

    for (const entry of registry) {
      const databasePath = databasePaths.get(entry.file);
      if (!databasePath || !existsSync(databasePath)) {
        throw storageFailure('DATABASE_MISSING');
      }
      checkDatabase(databasePath, entry);
    }

    const expectedDatabases = registry.map((entry) => entry.file);
    if (
      !state
      || state.expectedDatabases.length !== expectedDatabases.length
      || expectedDatabases.some((file) => !state.expectedDatabases.includes(file))
    ) {
      writeState(paths.statePath, expectedDatabases);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: getStorageErrorCode(error) ?? 'STORAGE_UNAVAILABLE',
    };
  }
}
