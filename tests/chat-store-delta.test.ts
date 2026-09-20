import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isStoredChatDelta } from '../lib/chatDeltaValidation';

async function main() {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'agents-chat-delta-'));
  try {
    process.chdir(dir);
    const { saveChat, saveChatDelta, updateChatMessage, getChat, getDb } = await import('../lib/chatStore');
    const parts = [{ kind: 'tool', toolName: 'read', result: 'x'.repeat(5 * 1024 * 1024), done: true }];
    const user = { id: 'u1', type: 'user' as const, content: 'Question', ts: 1 };
    const agent = { id: 'a1', type: 'agent' as const, content: 'Answer', ts: 2, parts, pending: false };
    const chat = { id: 'chat', name: 'Large chat', ts: 1, messages: [user, agent], agentSessions: { alpha: 'session' } };
    assert.equal(isStoredChatDelta(chat), true);
    for (const invalid of [
      { ...chat, ts: '1' },
      { ...chat, messages: [{ ...user, type: ['user'] }] },
      { ...chat, messages: [{ ...user, content: null }] },
      { ...chat, messages: [{ ...user, attachments: [{}] }] },
      { ...chat, removedMessageIds: [null] },
    ]) assert.equal(isStoredChatDelta(invalid), false);
    await saveChat('owner', chat);
    const nextUser = { ...user, id: 'u2', ts: 3, content: 'New question' };
    await saveChatDelta('owner', { ...chat, messages: [nextUser], agentSessions: {} });
    assert.deepEqual((await getChat('owner', 'chat'))?.messages, [user, agent, nextUser]);
    assert.deepEqual((await getChat('owner', 'chat'))?.agentSessions, { alpha: 'session' });
    await saveChatDelta('owner', { ...chat, messages: [{ ...agent, parts: undefined, relation: 'worker' }] });
    assert.deepEqual((await getChat('owner', 'chat'))?.messages[1].parts, parts);

    await Promise.all([
      saveChatDelta('owner', { ...chat, messages: [{ ...nextUser, id: 'u3', ts: 4 }] }),
      updateChatMessage('owner', 'chat', { ...agent, content: 'Updated answer' }),
    ]);
    const saved = await getChat('owner', 'chat');
    assert.equal(saved?.messages.length, 4);
    assert.equal(saved?.messages[1].content, 'Updated answer');
    assert.equal(saved?.messages[1].relation, 'worker');
    assert.deepEqual(saved?.messages[1].parts, parts);
    await saveChatDelta('owner', { ...chat, messages: [{ ...agent, pending: true, content: '' }] });
    assert.equal((await getChat('owner', 'chat'))?.messages[1].content, 'Updated answer');
    await saveChatDelta('owner', { ...chat, messages: [], removedMessageIds: ['u1', 'a1'] });
    assert.deepEqual((await getChat('owner', 'chat'))?.messages.map(message => message.id), ['u1', 'u2', 'u3']);
    assert.equal(await getChat('other-user', 'chat'), null);
    getDb().close();
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true });
  }
  console.log('chat store delta tests passed');
}

void main();
