import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';

/**
 * Server-side chat history storage — SQLite backend.
 * Single file: .data/chats.db
 */

const DATA_DIR = path.join(process.cwd(), '.data');
const DB_PATH = path.join(DATA_DIR, 'chats.db');

export type StoredMessage = {
  id: string;
  type: 'user' | 'agent' | 'system';
  content: string;
  agentId?: string;
  ts: number;
  round?: number;
  relation?: string;
  summary?: boolean;
  parts?: unknown[];
};

export type StoredChat = {
  id: string;
  name: string;
  ts: number;
  messages: StoredMessage[];
  /** Map of agentId → ACP sessionId so sessions can be resumed */
  agentSessions: Record<string, string>;
};

export type SharedChat = {
  shareId: string;
  sharedBy: string;
  sharedAt: number;
  name: string;
  messages: StoredMessage[];
};

/* ─────────── SQLite singleton ─────────── */

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  // Ensure .data/ dir exists (sync, runs once)
  const fsSync = require('fs');
  if (!fsSync.existsSync(DATA_DIR)) fsSync.mkdirSync(DATA_DIR, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      user_id   TEXT NOT NULL,
      chat_id   TEXT NOT NULL,
      name      TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      messages  TEXT NOT NULL DEFAULT '[]',
      agent_sessions TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (user_id, chat_id)
    );

    CREATE INDEX IF NOT EXISTS idx_chats_user_ts ON chats (user_id, ts DESC);

    CREATE TABLE IF NOT EXISTS shares (
      share_id   TEXT PRIMARY KEY,
      shared_by  TEXT NOT NULL,
      shared_at  INTEGER NOT NULL,
      name       TEXT NOT NULL,
      messages   TEXT NOT NULL DEFAULT '[]'
    );
  `);

  return _db;
}

/* ─────────── Chat CRUD ─────────── */

/** List all chats for a user (metadata only, no messages). */
export async function listChats(userId: string): Promise<{ id: string; name: string; ts: number }[]> {
  const db = getDb();
  const rows = db.prepare('SELECT chat_id, name, ts FROM chats WHERE user_id = ? ORDER BY ts DESC').all(userId) as any[];
  return rows.map(r => ({ id: r.chat_id, name: r.name, ts: r.ts }));
}

/** Get a single chat with full messages. */
export async function getChat(userId: string, chatId: string): Promise<StoredChat | null> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM chats WHERE user_id = ? AND chat_id = ?').get(userId, chatId) as any;
  if (!row) return null;
  return {
    id: row.chat_id,
    name: row.name,
    ts: row.ts,
    messages: JSON.parse(row.messages),
    agentSessions: JSON.parse(row.agent_sessions),
  };
}

/** Save (create or update) a chat. */
export async function saveChat(userId: string, chat: StoredChat): Promise<void> {
  const db = getDb();
  db.prepare(`
    INSERT INTO chats (user_id, chat_id, name, ts, messages, agent_sessions)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, chat_id) DO UPDATE SET
      name = excluded.name,
      ts = excluded.ts,
      messages = excluded.messages,
      agent_sessions = excluded.agent_sessions
  `).run(
    userId,
    chat.id,
    chat.name,
    chat.ts,
    JSON.stringify(chat.messages),
    JSON.stringify(chat.agentSessions || {}),
  );
}

/** Delete a chat. */
export async function deleteChat(userId: string, chatId: string): Promise<void> {
  const db = getDb();
  db.prepare('DELETE FROM chats WHERE user_id = ? AND chat_id = ?').run(userId, chatId);
}

/* ─────────── Shared chats ─────────── */

/** Create a read-only shared copy of a chat. Returns the share ID. */
export async function shareChat(userId: string, chat: StoredChat): Promise<string> {
  const db = getDb();
  const shareId = crypto.randomBytes(16).toString('hex');
  const filteredMessages = chat.messages.filter(m => !(m.type === 'system' && m.ts === 0));
  db.prepare(`
    INSERT INTO shares (share_id, shared_by, shared_at, name, messages)
    VALUES (?, ?, ?, ?, ?)
  `).run(shareId, userId, Date.now(), chat.name, JSON.stringify(filteredMessages));
  return shareId;
}

/** Get a shared chat by its share ID. */
export async function getSharedChat(shareId: string): Promise<SharedChat | null> {
  if (!/^[a-f0-9]+$/.test(shareId)) return null;
  const db = getDb();
  const row = db.prepare('SELECT * FROM shares WHERE share_id = ?').get(shareId) as any;
  if (!row) return null;
  return {
    shareId: row.share_id,
    sharedBy: row.shared_by,
    sharedAt: row.shared_at,
    name: row.name,
    messages: JSON.parse(row.messages),
  };
}

/* ─────────── Migration from JSON files ─────────── */

const OLD_CHATS_DIR = path.join(process.cwd(), '.data', 'chats');
const OLD_SHARES_DIR = path.join(process.cwd(), '.data', 'shares');

/** Migrate existing JSON file data into SQLite. Safe to run multiple times. */
export async function migrateFromJson(): Promise<{ chats: number; shares: number }> {
  const db = getDb();
  let chatCount = 0;
  let shareCount = 0;

  // Migrate per-user chats
  try {
    const userDirs = await fs.readdir(OLD_CHATS_DIR, { withFileTypes: true });
    const insertChat = db.prepare(`
      INSERT OR IGNORE INTO chats (user_id, chat_id, name, ts, messages, agent_sessions)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const entry of userDirs) {
      if (!entry.isDirectory()) continue;
      const userId = entry.name;
      const userPath = path.join(OLD_CHATS_DIR, userId);
      const files = await fs.readdir(userPath);

      for (const file of files) {
        if (file === '_index.json' || !file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(userPath, file), 'utf-8');
          const chat: StoredChat = JSON.parse(raw);
          insertChat.run(
            userId,
            chat.id,
            chat.name,
            chat.ts,
            JSON.stringify(chat.messages || []),
            JSON.stringify(chat.agentSessions || {}),
          );
          chatCount++;
        } catch { /* skip corrupt files */ }
      }
    }
  } catch { /* no old chats dir */ }

  // Migrate shares
  try {
    const shareFiles = await fs.readdir(OLD_SHARES_DIR);
    const insertShare = db.prepare(`
      INSERT OR IGNORE INTO shares (share_id, shared_by, shared_at, name, messages)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const file of shareFiles) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(OLD_SHARES_DIR, file), 'utf-8');
        const share: SharedChat = JSON.parse(raw);
        insertShare.run(
          share.shareId,
          share.sharedBy,
          share.sharedAt,
          share.name,
          JSON.stringify(share.messages || []),
        );
        shareCount++;
      } catch { /* skip corrupt files */ }
    }
  } catch { /* no old shares dir */ }

  return { chats: chatCount, shares: shareCount };
}
