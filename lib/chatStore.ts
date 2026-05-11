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
  userRequest?: unknown;
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

export type FileComment = {
  id: string;
  agentId: string;
  filePath: string;
  rangeStartLine: number | null;
  rangeEndLine: number | null;
  rangeStartChar: number | null;
  rangeEndChar: number | null;
  content: string;
  authorType: 'agent' | 'user';
  authorName: string | null;
  status: 'active' | 'queued' | 'processing' | 'resolved';
  linkedChatId: string | null;
  createdAt: string;
  updatedAt: string;
  replies: FileCommentReply[];
};

export type FileCommentReply = {
  id: string;
  commentId: string;
  content: string;
  authorType: 'agent' | 'user';
  authorName: string | null;
  createdAt: string;
};

export type CommentApprovalResult = {
  comment: FileComment;
  status: 'processing' | 'queued' | 'resolved';
  alreadyApproved: boolean;
};

export type StartQueuedCommentResult = {
  comment: FileComment;
  chat: StoredChat;
  message: StoredMessage;
} | null;

export type ResolveCommentResult =
  | { ok: true; comment: FileComment }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_processing'; comment: FileComment }
  | { ok: false; reason: 'missing_linked_chat'; comment: FileComment }
  | { ok: false; reason: 'review_chat_not_found'; comment: FileComment };

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

    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id       TEXT PRIMARY KEY,
      last_chat_id  TEXT,
      updated_at    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS file_comments (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      range_start_line INTEGER,
      range_end_line INTEGER,
      range_start_char INTEGER,
      range_end_char INTEGER,
      content TEXT NOT NULL,
      author_type TEXT NOT NULL,
      author_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      linked_chat_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_file_comments_agent_file ON file_comments(agent_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_file_comments_linked_chat_status ON file_comments(linked_chat_id, status);

    CREATE TABLE IF NOT EXISTS file_comment_replies (
      id TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL REFERENCES file_comments(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      author_type TEXT NOT NULL,
      author_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_file_comment_replies_comment ON file_comment_replies(comment_id);
  `);

  return _db;
}

/* ─────────── Chat CRUD ─────────── */

/** List all chats for a user (metadata only, no messages). */
export async function listChats(userId: string): Promise<{ id: string; name: string; ts: number }[]> {
  const db = getDb();
  const rows = db.prepare('SELECT chat_id, name, ts FROM chats WHERE user_id = ? ORDER BY ts DESC, chat_id DESC').all(userId) as any[];
  return rows.map(r => ({ id: r.chat_id, name: r.name, ts: r.ts }));
}

/** Get a single chat with full messages. */
export async function getChat(userId: string, chatId: string): Promise<StoredChat | null> {
  const db = getDb();
  return getChatWithDb(db, userId, chatId);
}

/** Save (create or update) a chat. */
export async function saveChat(userId: string, chat: StoredChat): Promise<void> {
  const db = getDb();
  saveChatWithDb(db, userId, chat);
}

function mapStoredChatRow(row: any): StoredChat {
  return {
    id: row.chat_id,
    name: row.name,
    ts: row.ts,
    messages: JSON.parse(row.messages || '[]'),
    agentSessions: JSON.parse(row.agent_sessions || '{}'),
  };
}

function getChatWithDb(db: Database.Database, userId: string, chatId: string): StoredChat | null {
  const row = db.prepare('SELECT * FROM chats WHERE user_id = ? AND chat_id = ?').get(userId, chatId) as any;
  return row ? mapStoredChatRow(row) : null;
}

function saveChatWithDb(db: Database.Database, userId: string, chat: StoredChat): void {
  // ACP session updates are written by updateChatAgentSession; chat saves may
  // carry stale client session maps, so conflict updates preserve DB sessions.
  db.prepare(`
    INSERT INTO chats (user_id, chat_id, name, ts, messages, agent_sessions)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, chat_id) DO UPDATE SET
      name = excluded.name,
      ts = excluded.ts,
      messages = excluded.messages
  `).run(
    userId,
    chat.id,
    chat.name,
    chat.ts,
    JSON.stringify(chat.messages),
    JSON.stringify(chat.agentSessions || {}),
  );
}

function appendMessageToChatWithDb(db: Database.Database, userId: string, chat: Pick<StoredChat, 'id' | 'name'>, message: StoredMessage): StoredChat {
  const existing = getChatWithDb(db, userId, chat.id);
  const now = Date.now();
  const next: StoredChat = existing
    ? {
        ...existing,
        name: existing.name || chat.name,
        messages: [...existing.messages, message],
      }
    : {
        id: chat.id,
        name: chat.name,
        ts: now,
        messages: [message],
        agentSessions: {},
      };

  saveChatWithDb(db, userId, next);
  return next;
}

function ensureChatWithDb(db: Database.Database, userId: string, chat: Pick<StoredChat, 'id' | 'name'>): StoredChat {
  const existing = getChatWithDb(db, userId, chat.id);
  if (existing) return existing;
  const next: StoredChat = { id: chat.id, name: chat.name, ts: Date.now(), messages: [], agentSessions: {} };
  saveChatWithDb(db, userId, next);
  return next;
}

export async function appendMessageToChat(userId: string, chat: Pick<StoredChat, 'id' | 'name'>, message: StoredMessage): Promise<StoredChat> {
  const db = getDb();
  const append = db.transaction(() => appendMessageToChatWithDb(db, userId, chat, message));
  return append();
}

export async function ensureChat(userId: string, chat: Pick<StoredChat, 'id' | 'name'>): Promise<StoredChat> {
  const db = getDb();
  const ensure = db.transaction(() => ensureChatWithDb(db, userId, chat));
  return ensure();
}

/** Update a single agent's sessionId in an existing chat. */
export async function updateChatAgentSession(userId: string, chatId: string, agentId: string, sessionId: string): Promise<void> {
  const db = getDb();
  const row = db.prepare('SELECT agent_sessions FROM chats WHERE user_id = ? AND chat_id = ?').get(userId, chatId) as any;
  if (!row) return;
  const sessions = JSON.parse(row.agent_sessions || '{}');
  // Store as append-only list; last element is current session
  const list: string[] = Array.isArray(sessions[agentId]) ? sessions[agentId] : (sessions[agentId] ? [sessions[agentId]] : []);
  if (list[list.length - 1] !== sessionId) list.push(sessionId);
  sessions[agentId] = list;
  db.prepare('UPDATE chats SET agent_sessions = ? WHERE user_id = ? AND chat_id = ?').run(JSON.stringify(sessions), userId, chatId);
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

/* ─────────── User preferences ─────────── */

/** Get last active chat ID for a user. */
export async function getLastChatId(userId: string): Promise<string | null> {
  const db = getDb();
  const row = db.prepare('SELECT last_chat_id FROM user_prefs WHERE user_id = ?').get(userId) as any;
  return row?.last_chat_id || null;
}

/** Save last active chat ID for a user. */
export async function setLastChatId(userId: string, chatId: string): Promise<void> {
  const db = getDb();
  db.prepare(`
    INSERT INTO user_prefs (user_id, last_chat_id, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET last_chat_id = excluded.last_chat_id, updated_at = excluded.updated_at
  `).run(userId, chatId, Date.now());
}

/* ─────────── File comments ─────────── */

/** List all comments for a given agent + file, with replies. */
export async function listFileComments(agentId: string, filePath: string): Promise<FileComment[]> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM file_comments WHERE agent_id = ? AND file_path = ? ORDER BY range_start_line ASC, created_at ASC'
  ).all(agentId, filePath) as any[];

  const replyStmt = db.prepare(
    'SELECT * FROM file_comment_replies WHERE comment_id = ? ORDER BY created_at ASC'
  );

  return rows.map(r => mapFileCommentRow(r, (replyStmt.all(r.id) as any[]).map(rp => ({
      id: rp.id,
      commentId: rp.comment_id,
      content: rp.content,
      authorType: rp.author_type,
      authorName: rp.author_name,
      createdAt: rp.created_at,
  }))));
}

/** Create a new file comment. Returns the created comment ID. */
export async function createFileComment(comment: {
  agentId: string;
  filePath: string;
  rangeStartLine?: number;
  rangeEndLine?: number;
  rangeStartChar?: number;
  rangeEndChar?: number;
  content: string;
  authorType: 'agent' | 'user';
  authorName?: string;
}): Promise<string> {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO file_comments (id, agent_id, file_path, range_start_line, range_end_line, range_start_char, range_end_char, content, author_type, author_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    comment.agentId,
    comment.filePath,
    comment.rangeStartLine ?? null,
    comment.rangeEndLine ?? null,
    comment.rangeStartChar ?? null,
    comment.rangeEndChar ?? null,
    comment.content,
    comment.authorType,
    comment.authorName ?? null,
  );
  return id;
}

/** Add a reply to a comment. Returns the reply ID. */
export async function addFileCommentReply(reply: {
  commentId: string;
  content: string;
  authorType: 'agent' | 'user';
  authorName?: string;
}): Promise<string> {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO file_comment_replies (id, comment_id, content, author_type, author_name)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, reply.commentId, reply.content, reply.authorType, reply.authorName ?? null);
  db.prepare("UPDATE file_comments SET updated_at = datetime('now') WHERE id = ?").run(reply.commentId);
  return id;
}

/** Update a comment's status and optionally set linked_chat_id. */
export async function updateFileCommentStatus(
  commentId: string,
  status: 'active' | 'queued' | 'processing' | 'resolved',
  linkedChatId?: string | null,
): Promise<void> {
  const db = getDb();
  if (linkedChatId !== undefined) {
    db.prepare("UPDATE file_comments SET status = ?, linked_chat_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, linkedChatId, commentId);
  } else {
    db.prepare("UPDATE file_comments SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, commentId);
  }
}

// Queue lookups intentionally omit replies; they only need comment metadata/content.
function mapFileCommentRow(r: any, replies: FileCommentReply[] = []): FileComment {
  return {
    id: r.id,
    agentId: r.agent_id,
    filePath: r.file_path,
    rangeStartLine: r.range_start_line,
    rangeEndLine: r.range_end_line,
    rangeStartChar: r.range_start_char,
    rangeEndChar: r.range_end_char,
    content: r.content,
    authorType: r.author_type,
    authorName: r.author_name,
    status: r.status,
    linkedChatId: r.linked_chat_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    replies,
  };
}

export async function getProcessingCommentForChat(chatId: string): Promise<FileComment | null> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM file_comments WHERE linked_chat_id = ? AND status = 'processing' ORDER BY updated_at ASC LIMIT 1").get(chatId) as any;
  return row ? mapFileCommentRow(row) : null;
}

export async function getOldestQueuedCommentForChat(chatId: string): Promise<FileComment | null> {
  const db = getDb();
  // updated_at is set when a comment enters queued, so this preserves approval order.
  const row = db.prepare("SELECT * FROM file_comments WHERE linked_chat_id = ? AND status = 'queued' ORDER BY updated_at ASC, created_at ASC LIMIT 1").get(chatId) as any;
  return row ? mapFileCommentRow(row) : null;
}

export async function approveCommentForReviewChat(
  userId: string,
  commentId: string,
  chat: Pick<StoredChat, 'id' | 'name'>,
  message: StoredMessage,
): Promise<CommentApprovalResult | null> {
  const db = getDb();
  const approve = db.transaction((): CommentApprovalResult | null => {
    const row = db.prepare('SELECT * FROM file_comments WHERE id = ?').get(commentId) as any;
    if (!row) return null;

    const current = mapFileCommentRow(row);
    if (current.status === 'processing' || current.status === 'queued') {
      return { comment: current, status: current.status, alreadyApproved: true };
    }
    if (current.status === 'resolved') {
      return { comment: current, status: 'resolved', alreadyApproved: true };
    }

    const processingUpdate = db.prepare(`
      UPDATE file_comments
      SET status = 'processing', linked_chat_id = ?, updated_at = datetime('now')
      WHERE id = ?
        AND status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM file_comments
          WHERE linked_chat_id = ? AND status = 'processing'
        )
    `).run(chat.id, commentId, chat.id);
    if (processingUpdate.changes === 1) {
      appendMessageToChatWithDb(db, userId, chat, message);
      const updatedRow = db.prepare('SELECT * FROM file_comments WHERE id = ?').get(commentId) as any;
      return { comment: mapFileCommentRow(updatedRow), status: 'processing', alreadyApproved: false };
    }

    const queueUpdate = db.prepare(
      "UPDATE file_comments SET status = 'queued', linked_chat_id = ?, updated_at = datetime('now') WHERE id = ? AND status = 'active'"
    ).run(chat.id, commentId);
    if (queueUpdate.changes === 1) {
      ensureChatWithDb(db, userId, chat);
      const updatedRow = db.prepare('SELECT * FROM file_comments WHERE id = ?').get(commentId) as any;
      return { comment: mapFileCommentRow(updatedRow), status: 'queued', alreadyApproved: false };
    }

    const updatedRow = db.prepare('SELECT * FROM file_comments WHERE id = ?').get(commentId) as any;
    if (!updatedRow) return null;
    const updated = mapFileCommentRow(updatedRow);
    if (updated.status === 'processing' || updated.status === 'queued' || updated.status === 'resolved') {
      return { comment: updated, status: updated.status, alreadyApproved: true };
    }
    return null;
  });

  return approve.immediate();
}

export async function startNextQueuedCommentForReviewChat(
  userId: string,
  chat: Pick<StoredChat, 'id' | 'name'>,
  messageFactory: (comment: FileComment) => StoredMessage,
): Promise<StartQueuedCommentResult> {
  const db = getDb();
  const start = db.transaction((): StartQueuedCommentResult => {
    const existingChat = getChatWithDb(db, userId, chat.id);
    if (!existingChat) return null;

    const queuedRow = db.prepare(
      "SELECT * FROM file_comments WHERE linked_chat_id = ? AND status = 'queued' ORDER BY updated_at ASC, created_at ASC LIMIT 1"
    ).get(chat.id) as any;
    if (!queuedRow) return null;

    const updateResult = db.prepare(
      "UPDATE file_comments SET status = 'processing', linked_chat_id = ?, updated_at = datetime('now') WHERE id = ? AND status = 'queued'"
    ).run(chat.id, queuedRow.id);
    if (updateResult.changes !== 1) return null;

    const updatedRow = db.prepare('SELECT * FROM file_comments WHERE id = ?').get(queuedRow.id) as any;
    const comment = mapFileCommentRow(updatedRow);
    const message = messageFactory(comment);
    const updatedChat = appendMessageToChatWithDb(db, userId, { id: existingChat.id, name: existingChat.name || chat.name }, message);
    return { comment, chat: updatedChat, message };
  });

  return start.immediate();
}

export async function resolveProcessingCommentForReviewChat(
  userId: string,
  commentId: string,
): Promise<ResolveCommentResult> {
  const db = getDb();
  const resolve = db.transaction((): ResolveCommentResult => {
    const row = db.prepare('SELECT * FROM file_comments WHERE id = ?').get(commentId) as any;
    if (!row) return { ok: false, reason: 'not_found' };

    const comment = mapFileCommentRow(row);
    if (comment.status !== 'processing') {
      return { ok: false, reason: 'not_processing', comment };
    }
    if (!comment.linkedChatId) {
      return { ok: false, reason: 'missing_linked_chat', comment };
    }
    if (!getChatWithDb(db, userId, comment.linkedChatId)) {
      return { ok: false, reason: 'review_chat_not_found', comment };
    }

    const updateResult = db.prepare(
      "UPDATE file_comments SET status = 'resolved', updated_at = datetime('now') WHERE id = ? AND status = 'processing' AND linked_chat_id = ?"
    ).run(commentId, comment.linkedChatId);
    if (updateResult.changes !== 1) {
      const updatedRow = db.prepare('SELECT * FROM file_comments WHERE id = ?').get(commentId) as any;
      if (!updatedRow) return { ok: false, reason: 'not_found' };
      return { ok: false, reason: 'not_processing', comment: mapFileCommentRow(updatedRow) };
    }

    const updatedRow = db.prepare('SELECT * FROM file_comments WHERE id = ?').get(commentId) as any;
    return { ok: true, comment: mapFileCommentRow(updatedRow) };
  });

  return resolve.immediate();
}

/** Get a single comment by ID (with replies). */
export async function getFileComment(commentId: string): Promise<FileComment | null> {
  const db = getDb();
  const r = db.prepare('SELECT * FROM file_comments WHERE id = ?').get(commentId) as any;
  if (!r) return null;
  const replies = (db.prepare('SELECT * FROM file_comment_replies WHERE comment_id = ? ORDER BY created_at ASC').all(commentId) as any[])
    .map(rp => ({
      id: rp.id, commentId: rp.comment_id, content: rp.content,
      authorType: rp.author_type, authorName: rp.author_name, createdAt: rp.created_at,
    }));
  return mapFileCommentRow(r, replies);
}

/** Delete a comment and all its replies. */
export async function deleteFileComment(commentId: string): Promise<void> {
  const db = getDb();
  db.prepare('DELETE FROM file_comment_replies WHERE comment_id = ?').run(commentId);
  db.prepare('DELETE FROM file_comments WHERE id = ?').run(commentId);
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
