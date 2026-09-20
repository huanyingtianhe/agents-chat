import assert from 'node:assert/strict';
import type { ChatOperation } from '../../lib/chatSyncStore';
import type { StoredChat } from '../../lib/chatStore';

type SaveBody = { action?: string; operation?: ChatOperation; chat?: StoredChat };

export function chatSaveAcknowledgement(body: SaveBody) {
  if (body.action !== 'save-sync') return { ok: true };
  assert.ok(body.operation, 'This UI fixture expects an inline save operation');
  const operation = body.operation;
  return {
    ok: true,
    versions: Object.fromEntries(operation.chat.messages.map(message =>
      [message.id, (operation.expectedVersions[message.id] || 0) + 1])),
  };
}

export function applyFixtureChatSave(body: SaveBody, existing?: StoredChat): StoredChat | undefined {
  const delta = body.operation?.chat || body.chat;
  if (!delta) return undefined;
  const versions = chatSaveAcknowledgement(body).versions;
  const messages = new Map((existing?.messages || []).map(message => [message.id, message]));
  for (const id of body.operation?.chat.removedMessageIds || []) {
    if (messages.get(id)?.type !== 'user') messages.delete(id);
  }
  for (const message of delta.messages) {
    const saved = messages.get(message.id);
    messages.set(message.id, {
      ...message,
      ...(versions ? { version: versions[message.id] } : {}),
      ...(saved?.parts && !message.parts ? { parts: saved.parts } : {}),
    });
  }
  return { ...existing, ...delta, messages: [...messages.values()].sort((a, b) => a.ts - b.ts) };
}
