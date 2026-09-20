import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';
import type { ChatMessage } from '../app/features/chat/chatTypes';

type TestChat = {
  id: string;
  name: string;
  ts: number;
  agentSessions: Record<string, string>;
  messages: ChatMessage[];
};

async function installPersistenceFixture(page: Page) {
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
  await page.goto('about:blank');
  const request = page.context().request;
  const chat: TestChat = {
    id: `persistence-${randomUUID()}`, name: 'Large saved conversation', ts: Date.now(),
    agentSessions: {},
    messages: [
      { id: 'old-user', type: 'user', content: 'Historical question', ts: 1 },
      {
        id: 'old-agent', type: 'agent', agentId: 'alpha', content: 'Historical answer', ts: 2,
        parts: [{ kind: 'tool', toolName: 'read', result: 'x'.repeat(5 * 1024 * 1024), done: true }],
      },
    ],
  };
  expect((await request.post('/api/chats', { data: { chat } })).ok()).toBeTruthy();
  expect((await request.post('/api/chats', {
    data: { action: 'set-last-chat', chatId: chat.id },
  })).ok()).toBeTruthy();
  await page.unroute('**/api/chats**');

  const saveSizes: number[] = [];
  const sent: string[] = [];
  const savedBeforeSend: boolean[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  let failure: '413' | 'network' | null = null;
  let saveGate: Promise<void> | null = null;
  let activeReply = '';
  const toolOutput = 'z'.repeat(2 * 1024 * 1024);
  const loadStored = async (): Promise<TestChat> =>
    (await (await request.get(`/api/chats?id=${chat.id}`)).json()).chat;

  await page.route('**/api/chats**', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const bytes = Buffer.byteLength(route.request().postData() || '');
    const body = route.request().postDataJSON();
    if (body?.action === 'save-delta') {
      saveSizes.push(bytes);
      if (saveGate) await saveGate;
      if (failure === 'network') return route.abort('connectionrefused');
    }
    if (bytes > 1024 * 1024 || (body?.action === 'save-delta' && failure === '413')) {
      return route.fulfill({ status: 413, contentType: 'text/html', body: '<h1>Request Entity Too Large</h1>' });
    }
    return route.continue();
  });
  await page.route('**/api/acp', async route => {
    const body = route.request().postDataJSON();
    if (body?.action === 'send') {
      sent.push(body.text);
      const stored = await loadStored();
      savedBeforeSend.push(stored.messages.some(message => message.type === 'user' && message.content === body.text));
      activeReply = `Saved reply ${sent.length}`;
      const message: ChatMessage = {
        id: body.messageId, agentId: 'alpha', type: 'agent', ts: Date.now(),
        content: activeReply, pending: false,
        parts: [
          { kind: 'tool', toolName: 'read', result: toolOutput, done: true },
          { kind: 'text', text: activeReply },
        ],
      };
      // Simulate the backend's direct snapshot write, outside the browser proxy.
      expect((await request.post('/api/chats', {
        data: { action: 'save-delta', chat: { ...chat, messages: [message] } },
      })).ok()).toBeTruthy();
      return route.fulfill({ json: { ok: true, sessionId: 'fixture-session', turn: { id: 'turn' } } });
    }
    if (body?.action === 'poll') {
      return route.fulfill({ json: {
        ok: true, activeTurn: {
          done: true, phase: 'done', fullText: activeReply,
          events: [
            { type: 'tool_start', toolName: 'read', toolCallId: 'tool-1' },
            { type: 'tool_complete', toolCallId: 'tool-1', toolResult: toolOutput },
            { type: 'text_chunk', text: activeReply },
          ],
        },
      } });
    }
    if (body?.action === 'resume-session') return route.fulfill({ json: { ok: true, loaded: true } });
    return route.fallback();
  });
  await page.goto('/');
  await expect(page.getByText('Historical question', { exact: true })).toBeVisible();
  return {
    chat, saveSizes, sent, savedBeforeSend, pageErrors, loadStored,
    fail(value: typeof failure) { failure = value; },
    holdSave() {
      let release!: () => void;
      saveGate = new Promise<void>(resolve => { release = resolve; });
      return () => { saveGate = null; release(); };
    },
  };
}

async function send(page: Page, text: string) {
  await page.locator('textarea.composerTextarea').fill(text);
  await page.locator('textarea.composerTextarea').press('Enter');
}

test('saves and reloads user messages with over 5 MB of history and large ACP tools', async ({ page }) => {
  const fixture = await installPersistenceFixture(page);
  try {
    await send(page, 'New question after a large history');
    await expect.poll(() => fixture.sent.length).toBe(1);
    await expect(page.getByText('Saved reply 1', { exact: true })).toBeVisible();
    await expect.poll(async () => (await fixture.loadStored()).messages.length).toBe(4);
    const stored = await fixture.loadStored();
    expect(stored.messages[1].parts).toEqual(fixture.chat.messages[1].parts);
    expect(JSON.stringify(stored.messages[3].parts).length).toBeGreaterThan(2 * 1024 * 1024);
    await page.reload();
    await expect(page.getByText('New question after a large history', { exact: true })).toBeVisible();
    await expect(page.getByText('Saved reply 1', { exact: true })).toBeVisible();
    expect(fixture.savedBeforeSend).toEqual([true]);
    expect(fixture.saveSizes.length).toBeGreaterThan(0);
    expect(Math.max(...fixture.saveSizes)).toBeLessThan(1024 * 1024);
    expect(fixture.pageErrors).toEqual([]);
  } finally {
    await page.goto('about:blank');
    await page.context().request.delete(`/api/chats?id=${fixture.chat.id}`);
  }
});

for (const failure of ['413', 'network'] as const) {
  test(`blocks dispatch on ${failure} save failure and retries without losing the user message`, async ({ page }) => {
    const fixture = await installPersistenceFixture(page);
    try {
      fixture.fail(failure);
      await send(page, 'Keep my unsaved question');
      await expect(page.locator('.userSendFailureCard')).toBeVisible();
      if (failure === '413') await expect(page.locator('.userSendFailureCard')).toContainText('HTTP 413');
      await expect(page.getByText('Keep my unsaved question', { exact: true })).toBeVisible();
      expect(fixture.sent).toEqual([]);
      expect((await fixture.loadStored()).messages.filter(message => message.type === 'user')).toHaveLength(1);
      fixture.fail(null);
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(page.getByText('Saved reply 1', { exact: true })).toBeVisible();
      await expect(page.locator('.userSendFailureCard')).toHaveCount(0);
      await page.reload();
      await expect(page.getByText('Keep my unsaved question', { exact: true })).toBeVisible();
      expect(fixture.sent).toEqual(['Keep my unsaved question']);
      expect(fixture.savedBeforeSend).toEqual([true]);
      expect(fixture.pageErrors).toEqual([]);
    } finally {
      await page.goto('about:blank');
      await page.context().request.delete(`/api/chats?id=${fixture.chat.id}`);
    }
  });
}

test('waits for a confirmed save before sending to the agent', async ({ page }) => {
  const fixture = await installPersistenceFixture(page);
  const release = fixture.holdSave();
  try {
    await send(page, 'Wait until durable');
    await expect.poll(() => fixture.saveSizes.length).toBeGreaterThan(0);
    expect(fixture.sent).toEqual([]);
    release();
    await expect.poll(() => fixture.sent.length).toBe(1);
    expect(fixture.savedBeforeSend).toEqual([true]);
  } finally {
    release();
    await page.goto('about:blank');
    await page.context().request.delete(`/api/chats?id=${fixture.chat.id}`);
  }
});

test('delta API preserves other clients and rejects malformed messages', async ({ page }) => {
  const fixture = await installPersistenceFixture(page);
  await page.goto('about:blank');
  const request = page.context().request;
  try {
    const responses = await Promise.all(['client-a', 'client-b'].map((id, index) =>
      request.post('/api/chats', { data: {
        action: 'save-delta',
        chat: { ...fixture.chat, messages: [{ id, type: 'user', content: id, ts: index + 10 }] },
      } })));
    for (const response of responses) expect(response.status()).toBe(200);
    const stored = await fixture.loadStored();
    expect(stored.messages.map(message => message.id)).toEqual(['old-user', 'old-agent', 'client-a', 'client-b']);
    expect(stored.messages[1].parts).toEqual(fixture.chat.messages[1].parts);
    const invalid = await request.post('/api/chats', { data: {
      action: 'save-delta', chat: { ...fixture.chat, messages: [{ id: 'bad', type: 'unknown', content: 42 }] },
    } });
    expect(invalid.status()).toBe(400);
    expect((await fixture.loadStored()).messages).toEqual(stored.messages);
  } finally {
    await request.delete(`/api/chats?id=${fixture.chat.id}`);
  }
});
