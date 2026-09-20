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
    const { getDb, getChat, deleteChat, ensureChat, updateChatMessage, saveChatDelta } = await import('../lib/chatStore');
    const { commitChatOperation } = await import('../lib/chatSyncStore');
    const { putTransferChunk, readTransfer, transferStatus } = await import('../lib/chatTransferStore');
    const { resolvePreparedPrompt } = await import('../lib/acp/preparedPrompt');
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
    commitChatOperation('alice', {
      operationId: 'parallel-new-id', chat: { ...chat, messages: [{ ...user, id: 'other', content: 'Other device question' }] },
      expectedVersions: { other: null },
    });
    assert.equal((await getChat('alice', 'chat'))?.messages.length, 2);
    assert.throws(() => commitChatOperation('alice', { ...operation, userId: 'bob' }), /account_changed/);
    assert.throws(() => commitChatOperation('alice', {
      operationId: 'unconfirmed-dependent', chat: { ...chat, messages: [{ ...user, content: 'Dependent' }] },
      expectedVersions: { user: 2 }, dependencies: { user: 'uncommitted-parent' },
    }), /dependency_pending/);
    await updateChatMessage('alice', 'chat', {
      id: 'server-agent', type: 'agent', content: 'Server answer', ts: 2,
      parts: [{ kind: 'tool', result: 'Important output' }], pending: false,
    });
    commitChatOperation('alice', {
      operationId: 'stale-agent', chat: { ...chat, messages: [{
        id: 'server-agent', type: 'agent', content: 'Old browser answer', pending: true, ts: 2, relation: 'worker',
      }] }, expectedVersions: { 'server-agent': null },
    });
    const agent = (await getChat('alice', 'chat'))?.messages.find(message => message.id === 'server-agent');
    assert.equal(agent?.content, 'Server answer');
    assert.equal(agent?.relation, 'worker');
    assert.equal(agent?.pending, false);
    assert.equal(agent?.parts?.length, 1);
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
    const prompt = Buffer.from(JSON.stringify({ action: 'send', agentId: 'alpha', chatId: 'chat', text: 'Prepared prompt' }));
    const promptChunk = {
      id: 'prompt', chatId: 'chat', purpose: 'acp' as const, index: 0, total: 1,
      bytes: prompt.length, digest: createHash('sha256').update(prompt).digest('hex'), data: prompt.toString('base64'),
    };
    putTransferChunk('alice', promptChunk);
    assert.deepEqual(resolvePreparedPrompt('alice', { payloadRef: 'prompt', chatId: 'chat', agentId: 'alpha' }), JSON.parse(prompt.toString()));
    assert.throws(() => resolvePreparedPrompt('alice', { payloadRef: 'prompt', chatId: 'chat', agentId: 'other-agent' }), /invalid_prompt_reference/);
    assert.throws(() => putTransferChunk('alice', { ...promptChunk, userId: 'bob' }), /account_changed/);
    putTransferChunk('alice', { ...promptChunk, id: 'corrupt', digest: '0'.repeat(64) });
    assert.throws(() => readTransfer('alice', 'corrupt', 'chat', 'acp'), /upload_checksum_mismatch/);
    assert.throws(() => putTransferChunk('alice', { ...promptChunk, index: 1 }), /upload_size_invalid/);
    assert.throws(() => putTransferChunk('alice', { ...promptChunk, id: 'bad-size', data: Buffer.from('x').toString('base64') }), /invalid_chunk_size/);
    const reservation = {
      ...promptChunk, total: 256, bytes: 64 * 1024 * 1024, data: Buffer.alloc(262144).toString('base64'),
    };
    for (let index = 0; index < 4; index++) putTransferChunk('quota-user', { ...reservation, id: `reserved-${index}` });
    assert.throws(() => putTransferChunk('quota-user', { ...reservation, id: 'over-quota' }), /upload_quota_exceeded/);
    getDb().prepare('UPDATE chat_transfers SET created_at = 0 WHERE user_id = ?').run('quota-user');
    assert.deepEqual(transferStatus('quota-user', 'reserved-0'), []);
    assert.throws(() => readTransfer('quota-user', 'reserved-0', 'chat', 'acp'), /upload_not_found/);
    putTransferChunk('quota-user', { ...reservation, id: 'after-expiry' });
    await deleteChat('alice', 'chat');
    assert.throws(() => commitChatOperation('alice', {
      operationId: 'late-save', chat: { ...chat, messages: [user] }, expectedVersions: { user: null },
    }), /chat_deleted/);
    assert.throws(() => commitChatOperation('alice', operation), /chat_deleted/);
    await assert.rejects(ensureChat('alice', { id: 'chat', name: 'Late server creation' }), /chat_deleted/);
    await assert.rejects(saveChatDelta('alice', { ...chat, messages: [user] }), /chat_deleted/);
    assert.throws(() => putTransferChunk('alice', { ...promptChunk, id: 'late-upload' }), /chat_deleted/);
    assert.equal(await getChat('alice', 'chat'), null);
    getDb().close();
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  }
}
void main();
