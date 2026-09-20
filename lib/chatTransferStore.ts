import { createHash } from 'node:crypto';
import { getDb } from './chatStore';
import { ChatSyncError, isRecord, MAX_TRANSFER_BYTES, TRANSFER_CHUNK_BYTES } from './chatSyncProtocol';

type Purpose = 'chat' | 'acp';
type Chunk = {
  id: string; chatId: string; purpose: Purpose; index: number; total: number;
  bytes: number; digest: string; data: string;
};
type Transfer = {
  chat_id: string; purpose: Purpose; total: number; bytes: number; digest: string; created_at: number;
};
const UPLOAD_TTL = 24 * 60 * 60 * 1000;

function database() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS chat_transfers (
    user_id TEXT NOT NULL, id TEXT NOT NULL, chat_id TEXT NOT NULL, purpose TEXT NOT NULL,
    total INTEGER NOT NULL, bytes INTEGER NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, id)
  );
  CREATE TABLE IF NOT EXISTS chat_transfer_chunks (
    user_id TEXT NOT NULL, transfer_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, data BLOB NOT NULL,
    PRIMARY KEY(user_id, transfer_id, chunk_index),
    FOREIGN KEY(user_id, transfer_id) REFERENCES chat_transfers(user_id, id) ON DELETE CASCADE
  );`);
  db.prepare('DELETE FROM chat_transfers WHERE created_at < ?').run(Date.now() - UPLOAD_TTL);
  return db;
}

export function putTransferChunk(userId: string, value: unknown): void {
  if (isRecord(value) && value.userId !== undefined && value.userId !== userId) throw new ChatSyncError('account_changed', 403);
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[\w-]{1,128}$/.test(value.id)
    || typeof value.chatId !== 'string' || !value.chatId
    || (value.purpose !== 'chat' && value.purpose !== 'acp')
    || !Number.isSafeInteger(value.index) || !Number.isSafeInteger(value.total)
    || !Number.isSafeInteger(value.bytes) || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)
    || typeof value.data !== 'string' || value.data.length > Math.ceil(TRANSFER_CHUNK_BYTES / 3) * 4) {
    throw new ChatSyncError('invalid_upload_chunk', 400);
  }
  const chunk = value as Chunk;
  if (chunk.bytes <= 0 || chunk.bytes > MAX_TRANSFER_BYTES || chunk.total !== Math.ceil(chunk.bytes / TRANSFER_CHUNK_BYTES)
    || chunk.index < 0 || chunk.index >= chunk.total) throw new ChatSyncError('upload_size_invalid', 413);
  const data = Buffer.from(chunk.data, 'base64');
  if (data.toString('base64') !== chunk.data) throw new ChatSyncError('invalid_upload_encoding', 400);
  const db = database();
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM chat_tombstones WHERE user_id = ? AND chat_id = ?').get(userId, chunk.chatId)) {
      throw new ChatSyncError('chat_deleted', 410);
    }
    const existing = db.prepare('SELECT * FROM chat_transfers WHERE user_id = ? AND id = ?')
      .get(userId, chunk.id) as Transfer | undefined;
    if (existing && (existing.chat_id !== chunk.chatId || existing.purpose !== chunk.purpose
      || existing.total !== chunk.total || existing.bytes !== chunk.bytes || existing.digest !== chunk.digest)) {
      throw new ChatSyncError('upload_conflict');
    }
    if (!existing) {
      const usage = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM chat_transfers WHERE user_id = ?')
        .get(userId) as { bytes: number; count: number };
      if (usage.bytes + chunk.bytes > 256 * 1024 * 1024 || usage.count >= 128) throw new ChatSyncError('upload_quota_exceeded', 429);
      db.prepare('INSERT INTO chat_transfers VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(userId, chunk.id, chunk.chatId, chunk.purpose, chunk.total, chunk.bytes, chunk.digest, Date.now());
    }
    const previous = db.prepare('SELECT data FROM chat_transfer_chunks WHERE user_id = ? AND transfer_id = ? AND chunk_index = ?')
      .get(userId, chunk.id, chunk.index) as { data: Buffer } | undefined;
    if (previous && !previous.data.equals(data)) throw new ChatSyncError('chunk_conflict');
    const expectedSize = chunk.index === chunk.total - 1
      ? chunk.bytes - chunk.index * TRANSFER_CHUNK_BYTES : TRANSFER_CHUNK_BYTES;
    if (data.length !== expectedSize) throw new ChatSyncError('invalid_chunk_size', 400);
    if (!previous) db.prepare('INSERT INTO chat_transfer_chunks VALUES (?, ?, ?, ?)')
      .run(userId, chunk.id, chunk.index, data);
  })();
}

export function readTransfer(userId: string, id: string, chatId: string, purpose: Purpose): unknown {
  const db = database();
  const transfer = db.prepare('SELECT * FROM chat_transfers WHERE user_id = ? AND id = ? AND chat_id = ? AND purpose = ?')
    .get(userId, id, chatId, purpose) as Transfer | undefined;
  if (!transfer) throw new ChatSyncError('upload_not_found', 404);
  const chunks = db.prepare('SELECT data FROM chat_transfer_chunks WHERE user_id = ? AND transfer_id = ? ORDER BY chunk_index')
    .all(userId, id) as { data: Buffer }[];
  if (chunks.length !== transfer.total) throw new ChatSyncError('upload_incomplete');
  const bytes = Buffer.concat(chunks.map(chunk => chunk.data));
  if (bytes.length !== transfer.bytes || createHash('sha256').update(bytes).digest('hex') !== transfer.digest) {
    throw new ChatSyncError('upload_checksum_mismatch');
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ChatSyncError('invalid_upload_json', 400);
  }
}

export function deleteTransfer(userId: string, id: string): void {
  database().prepare('DELETE FROM chat_transfers WHERE user_id = ? AND id = ?').run(userId, id);
}

export function transferStatus(userId: string, id: string): number[] {
  return (database().prepare('SELECT chunk_index FROM chat_transfer_chunks WHERE user_id = ? AND transfer_id = ?')
    .all(userId, id) as { chunk_index: number }[]).map(row => row.chunk_index);
}
