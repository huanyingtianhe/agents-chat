import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

async function main() {
  const cwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'chat-sync-'));
  try {
    process.chdir(dir);
    const { getDb, getChat, deleteChat } = await import('../lib/chatStore');
    const { commitChatOperation } = await import('../lib/chatSyncStore');
    const { putTransferChunk, readTransfer } = await import('../lib/chatTransferStore');
    const chat = { id: 'chat', name: 'Chat', ts: 1, agentSessions: {}, messages: [] };
    const user = { id: 'user', type: 'user' as const, content: 'original', ts: 1 };
    const operation = {
      operationId: 'create-operation', chat: { ...chat, messages: [user] },
      expectedVersions: { user: null },
    };
    const saved = commitChatOperation('alice', operation);
    assert.equal(saved.versions.user, 1);
    assert.deepEqual(commitChatOperation('alice', operation), saved, 'lost response retries are idempotent');
    assert.equal((await getChat('alice', 'chat'))?.messages.length, 1);
    assert.throws(() => commitChatOperation('alice', {
      ...operation, chat: { ...chat, messages: [{ ...user, content: 'reuse operation with different data' }] },
    }), /operation_reused/);
    commitChatOperation('alice', {
      operationId: 'edit-a', chat: { ...chat, messages: [{ ...user, content: 'edit from A' }] },
      expectedVersions: { user: 1 },
    });
    assert.throws(() => commitChatOperation('alice', {
      operationId: 'edit-b', chat: { ...chat, messages: [{ ...user, content: 'edit from B' }] },
      expectedVersions: { user: 1 },
    }), /message_conflict/);
    assert.equal((await getChat('alice', 'chat'))?.messages[0].content, 'edit from A');
    const payload = Buffer.from(JSON.stringify({ content: '文'.repeat(450_000) }));
    const digest = createHash('sha256').update(payload).digest('hex');
    const pieces = Array.from({ length: Math.ceil(payload.length / 262144) }, (_, index) =>
      payload.subarray(index * 262144, (index + 1) * 262144));
    for (let index = 0; index < pieces.length; index++) {
      const chunk = {
        id: 'large-upload', chatId: 'chat', purpose: 'chat' as const, index,
        total: pieces.length, bytes: payload.length, digest, data: pieces[index].toString('base64'),
      };
      putTransferChunk('alice', chunk);
      putTransferChunk('alice', chunk);
      if (index === 0) {
        assert.throws(() => readTransfer('alice', 'large-upload', 'chat', 'chat'), /upload_incomplete/);
        assert.throws(() => putTransferChunk('alice', { ...chunk, data: Buffer.from('different').toString('base64') }), /chunk_conflict/);
      }
    }
    assert.deepEqual(readTransfer('alice', 'large-upload', 'chat', 'chat'), JSON.parse(payload.toString()));
    assert.throws(() => readTransfer('bob', 'large-upload', 'chat', 'chat'), /upload_not_found/);
    assert.throws(() => readTransfer('alice', 'large-upload', 'chat', 'acp'), /upload_not_found/);
    await deleteChat('alice', 'chat');
    assert.throws(() => commitChatOperation('alice', {
      operationId: 'late-save', chat: { ...chat, messages: [user] }, expectedVersions: { user: null },
    }), /chat_deleted/);
    assert.throws(() => commitChatOperation('alice', operation), /chat_deleted/);
    assert.equal(await getChat('alice', 'chat'), null);
    getDb().close();
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  }
}
void main();
