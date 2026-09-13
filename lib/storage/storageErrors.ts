import { NextResponse } from 'next/server';

export type StorageErrorCode =
  | 'DATABASE_MISSING'
  | 'DATABASE_INTEGRITY_FAILED'
  | 'DATABASE_BUSY'
  | 'STORAGE_UNAVAILABLE';

const SQLITE_STORAGE_CODES = new Set([
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_CANTOPEN',
  'SQLITE_CORRUPT',
  'SQLITE_IOERR',
  'SQLITE_NOTADB',
  'SQLITE_READONLY',
  'SQLITE_FULL',
  'SQLITE_PERM',
]);

const STORAGE_MESSAGE_PATTERN =
  /better-sqlite3|could not locate the bindings file|invalid elf header|node_module_version|compiled against a different node\.js|database disk image is malformed|file is not a database|unable to open database file|database is locked|database is busy|disk i\/o error|readonly database|read-only database|no such table|no such column|has no column named|malformed database schema|database schema has changed|sqlite_(?:busy|locked|cantopen|corrupt|ioerr|notadb|readonly|full|perm)/i;

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

export function getStorageErrorCode(error: unknown): StorageErrorCode | null {
  const code = errorCode(error);
  if (
    code === 'DATABASE_MISSING'
    || code === 'DATABASE_INTEGRITY_FAILED'
    || code === 'DATABASE_BUSY'
    || code === 'STORAGE_UNAVAILABLE'
  ) {
    return code;
  }
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    return 'DATABASE_BUSY';
  }
  if (SQLITE_STORAGE_CODES.has(code) || STORAGE_MESSAGE_PATTERN.test(errorMessage(error))) {
    return 'STORAGE_UNAVAILABLE';
  }
  return null;
}

export function isStorageError(error: unknown): boolean {
  return getStorageErrorCode(error) !== null;
}

export function rethrowStorageError(error: unknown): void {
  if (isStorageError(error)) throw error;
}

export function toStorageErrorResponse(error: unknown): NextResponse | null {
  if (!isStorageError(error)) return null;
  return NextResponse.json(
    { ok: false, error: 'storage_unavailable' },
    { status: 503 },
  );
}
