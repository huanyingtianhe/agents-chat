import { expect, test } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';

test('upload API resumes unordered chunks, validates commits, and rejects deletion races', async ({ page, request }) => {
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
  const api = page.context().request;
  const chatId = `sync-api-${randomUUID()}`;
  const operationId = randomUUID();
  const text = '文'.repeat(360_000);
  const operation = {
    operationId, expectedVersions: { question: null },
    chat: {
      id: chatId, name: 'Chunk API contract', ts: Date.now(), agentSessions: {},
      messages: [{ id: 'question', type: 'user', ts: 1, content: text }],
    },
  };
  const bytes = Buffer.from(JSON.stringify(operation));
  const total = Math.ceil(bytes.length / 262144);
  const manifest = {
    id: operationId, chatId, purpose: 'chat', total, bytes: bytes.length,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
  const chunk = (index: number) => ({
    ...manifest, index, data: bytes.subarray(index * 262144, (index + 1) * 262144).toString('base64'),
  });
  const commit = { action: 'save-sync', transferId: operationId, chatId };
  try {
    expect((await request.post('/api/chat-transfers', { data: chunk(0) })).status()).toBe(401);
    expect((await api.post('/api/chat-transfers', { data: { ...chunk(0), userId: 'another-account' } })).status()).toBe(403);
    expect((await api.post('/api/chat-transfers', { data: chunk(total - 1) })).status()).toBe(200);
    expect((await api.post('/api/chats', { data: commit })).status()).toBe(409);
    for (let index = total - 2; index >= 0; index--) {
      expect(Buffer.byteLength(JSON.stringify(chunk(index)))).toBeLessThan(1024 * 1024);
      expect((await api.post('/api/chat-transfers', { data: chunk(index) })).status()).toBe(200);
    }
    expect((await api.post('/api/chat-transfers', { data: chunk(0) })).status()).toBe(200);
    const corrupt = { ...chunk(0), data: Buffer.alloc(262144, 42).toString('base64') };
    expect((await api.post('/api/chat-transfers', { data: corrupt })).status()).toBe(409);
    const status = await (await api.post('/api/chat-transfers', {
      data: { action: 'status', id: operationId },
    })).json();
    expect(status.chunks).toHaveLength(total);
    const first = await api.post('/api/chats', { data: commit });
    expect(first.status()).toBe(200);
    const acknowledgement = await first.json();
    expect(await (await api.post('/api/chats', { data: commit })).json()).toEqual(acknowledgement);
    const stored = await (await api.get(`/api/chats?id=${chatId}`)).json();
    expect(stored.chat.messages).toHaveLength(1);
    expect(stored.chat.messages[0].content).toBe(text);
    expect((await api.post('/api/chats', { data: {
      action: 'save-sync', operation: { ...operation, operationId: randomUUID(), expectedVersions: { question: null } },
    } })).status()).toBe(409);
    await api.delete(`/api/chats?id=${chatId}`);
    expect((await api.post('/api/chats', { data: commit })).status()).toBe(410);
    expect((await api.post('/api/chat-transfers', { data: { ...chunk(0), id: randomUUID() } })).status()).toBe(410);
    expect((await api.post('/api/chats', { data: { chat: operation.chat } })).status()).toBe(410);
    expect((await api.get(`/api/chats?id=${chatId}`)).status()).toBe(404);
  } finally {
    await api.delete(`/api/chats?id=${chatId}`);
    await api.post('/api/chat-transfers', { data: { action: 'delete', id: operationId } });
  }
});
