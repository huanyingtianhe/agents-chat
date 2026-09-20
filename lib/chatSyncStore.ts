import { createHash } from 'node:crypto';
import { getDb, getChatWithDb, saveChatWithDb, type StoredChatDelta, type StoredMessage } from './chatStore';
import { isStoredChatDelta } from './chatDeltaValidation';
import { ChatSyncError, isRecord } from './chatSyncProtocol';

export type ChatOperation = {
  userId?: string;
  operationId: string;
  chat: StoredChatDelta;
  expectedVersions: Record<string, number | null>;
  dependencies?: Record<string, string>;
};
export type ChatCommitResult = { ok: true; versions: Record<string, number> };

export function isChatOperation(value: unknown): value is ChatOperation {
  return isRecord(value) && typeof value.operationId === 'string'
    && /^[\w-]{1,128}$/.test(value.operationId) && isStoredChatDelta(value.chat)
    && isRecord(value.expectedVersions)
    && (value.dependencies === undefined || (isRecord(value.dependencies)
      && Object.values(value.dependencies).every(id => typeof id === 'string' && /^[\w-]{1,128}$/.test(id))))
    && Object.values(value.expectedVersions).every(version =>
      version === null || (Number.isSafeInteger(version) && Number(version) >= 0));
}

export function commitChatOperation(userId: string, operation: ChatOperation): ChatCommitResult {
  if (!isChatOperation(operation)) throw new ChatSyncError('invalid_chat_operation', 400);
  if (operation.userId !== undefined && operation.userId !== userId) throw new ChatSyncError('account_changed', 403);
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS chat_operations (
    user_id TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL,
    result TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, operation_id)
  )`);
  const digest = createHash('sha256').update(JSON.stringify(operation)).digest('hex');
  return db.transaction(() => {
    const { chat: delta } = operation;
    if (db.prepare('SELECT 1 FROM chat_tombstones WHERE user_id = ? AND chat_id = ?').get(userId, delta.id)) {
      throw new ChatSyncError('chat_deleted', 410);
    }
    const receipt = db.prepare('SELECT digest, result FROM chat_operations WHERE user_id = ? AND operation_id = ?')
      .get(userId, operation.operationId) as { digest: string; result: string } | undefined;
    if (receipt) {
      if (receipt.digest !== digest) throw new ChatSyncError('operation_reused');
      return JSON.parse(receipt.result) as ChatCommitResult;
    }
    const chat = getChatWithDb(db, userId, delta.id);
    const messages = new Map((chat?.messages || []).map(message => [message.id, message]));
    for (const dependency of Object.values(operation.dependencies || {})) {
      if (!db.prepare('SELECT 1 FROM chat_operations WHERE user_id = ? AND operation_id = ?').get(userId, dependency)) {
        throw new ChatSyncError('dependency_pending');
      }
    }
    const versions: Record<string, number> = {};
    for (const incoming of delta.messages) {
      const saved = messages.get(incoming.id);
      if (saved?.type === 'agent' && saved.serverManaged !== false) {
        // The browser owns presentation metadata, never ACP output or its tools.
        messages.set(saved.id, {
          ...saved, round: incoming.round ?? saved.round,
          relation: incoming.relation ?? saved.relation, summary: incoming.summary ?? saved.summary,
        });
        versions[saved.id] = saved.version || 0;
        continue;
      }
      if (!Object.hasOwn(operation.expectedVersions, incoming.id)
        || operation.expectedVersions[incoming.id] !== (saved ? saved.version || 0 : null)) {
        throw new ChatSyncError(`message_conflict:${incoming.id}`);
      }
      if (saved && saved.type !== incoming.type) throw new ChatSyncError(`message_conflict:${incoming.id}`);
      const version = (saved?.version || 0) + 1;
      const next: StoredMessage = { ...incoming, version, serverManaged: false };
      if (saved?.pending === false && incoming.pending === true) {
        versions[incoming.id] = saved.version || 0;
        continue;
      }
      if (saved?.parts && !next.parts) next.parts = saved.parts;
      messages.set(incoming.id, next);
      versions[incoming.id] = version;
    }
    for (const id of delta.removedMessageIds || []) {
      const saved = messages.get(id);
      if (!saved || saved.type === 'user') continue;
      if (!Object.hasOwn(operation.expectedVersions, id)
        || operation.expectedVersions[id] !== (saved.version || 0)) {
        throw new ChatSyncError(`message_conflict:${id}`);
      }
      messages.delete(id);
    }
    saveChatWithDb(db, userId, {
      ...delta, gitContext: chat?.gitContext,
      name: chat?.name && chat.name !== 'New Chat' ? chat.name : delta.name,
      messages: [...messages.values()].sort((a, b) => a.ts - b.ts),
    });
    const result: ChatCommitResult = { ok: true, versions };
    db.prepare('INSERT INTO chat_operations VALUES (?, ?, ?, ?, ?)')
      .run(userId, operation.operationId, digest, JSON.stringify(result), Date.now());
    return result;
  })();
}
