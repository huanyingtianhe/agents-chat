import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { buildPromptParts, normalizePromptAttachments } from '../lib/acp/attachments';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';
import { TRANSFER_CHUNK_BYTES } from '../lib/chatSyncProtocol';

test('real ACP send expands an authenticated upload reference and persists the agent snapshot', async ({ page }) => {
  await installMobileChatFixture(page);
  await page.route('**/api/chats**', route => route.fulfill({ json: { ok: true, chats: [], lastChatId: '' } }));
  await loginMobileFixture(page, { emptyHistory: true });
  await page.goto('about:blank');
  const api = page.context().request;
  const agentId = `persistence-agent-${randomUUID()}`;
  const chatId = `persistence-acp-${randomUUID()}`;
  const transferId = randomUUID();
  const messageId = randomUUID();
  const text = 'Reference prompt 文'.repeat(80_000);
  const attachments = [{
    id: 'attachment', name: 'reference.txt', mimeType: 'text/plain', kind: 'file', size: 12,
    dataUrl: `data:text/plain;base64,${Buffer.from('fixture data').toString('base64')}`,
  }];
  const payload = { action: 'send', agentId, chatId, messageId, text, attachments };
  const bytes = Buffer.from(JSON.stringify(payload));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const total = Math.ceil(bytes.length / TRANSFER_CHUNK_BYTES);
  try {
    expect((await api.post('/api/acp', { data: {
      action: 'create-agent', agent: {
        id: agentId, command: process.execPath, args: [path.resolve('tests/fixtures/persistence-acp-agent.mjs')],
        cwd: process.cwd(), yolo: false,
      },
    } })).ok()).toBeTruthy();
    expect((await api.post('/api/chats', { data: {
      action: 'save-sync', operation: {
        operationId: randomUUID(), expectedVersions: { question: null },
        chat: {
          id: chatId, name: 'Actual ACP reference', ts: 1, agentSessions: {},
          messages: [{ id: 'question', type: 'user', content: 'Reference integration', ts: 1 }],
        },
      },
    } })).ok()).toBeTruthy();
    for (let index = 0; index < total; index++) {
      const chunk = {
        id: transferId, chatId, purpose: 'acp', total, index, bytes: bytes.length, digest,
        data: bytes.subarray(index * TRANSFER_CHUNK_BYTES, (index + 1) * TRANSFER_CHUNK_BYTES).toString('base64'),
      };
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(1024 * 1024);
      expect((await api.post('/api/chat-transfers', { data: chunk })).ok()).toBeTruthy();
    }
    const reference = { action: 'send', agentId, chatId, payloadRef: transferId };
    expect(Buffer.byteLength(JSON.stringify(reference))).toBeLessThan(1024);
    const invalid = await api.post('/api/acp', { data: { ...reference, chatId: 'wrong-chat' } });
    expect(invalid.status()).toBe(404);
    const response = await api.post('/api/acp', { data: reference });
    expect(await response.json()).toMatchObject({ ok: true });
    const expectedDigest = createHash('sha256').update(JSON.stringify(
      buildPromptParts(text, normalizePromptAttachments(attachments)),
    )).digest('hex');
    await expect.poll(async () => {
      const stored = await (await api.get(`/api/chats?id=${chatId}`)).json();
      return stored.chat.messages.find((message: { id: string }) => message.id === messageId);
    }, { timeout: 15_000 }).toMatchObject({
      type: 'agent', content: `Prompt digest: ${expectedDigest}`, pending: false, serverManaged: true,
    });
    expect((await api.delete(`/api/chats?id=${chatId}`)).ok()).toBeTruthy();
    expect((await api.post('/api/acp', { data: reference })).status()).toBe(410);
  } finally {
    await api.post('/api/acp', { data: { action: 'delete-agent', agentId } });
    await api.delete(`/api/chats?id=${chatId}`);
    await api.post('/api/chat-transfers', { data: { action: 'delete', id: transferId } });
  }
});
