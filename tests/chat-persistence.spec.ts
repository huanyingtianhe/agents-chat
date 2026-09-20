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

async function installPersistenceFixture(page: Page, interruptGitContext = false) {
  await installMobileChatFixture(page);
  // Do not create mock-chat recovery drafts before switching to the real persistence API.
  await page.route('**/api/chats**', route => route.fulfill({ json: { ok: true, chats: [], lastChatId: '' } }));
  await loginMobileFixture(page, { emptyHistory: true });
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
  let reloading = false;
  const apiUrl = new URL('/api/chats', process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010').href;
  page.on('pageerror', error => {
    // WebKit forwards JavaScript-source console diagnostics as pageerror, even for caught fetch failures.
    if (reloading && page.context().browser()?.browserType().name() === 'webkit'
      && error.stack?.startsWith(`Fetch API cannot load ${apiUrl} due to access control checks.\n`)) return;
    pageErrors.push(error.message);
  });
  page.on('console', message => {
    if (message.text().startsWith('persistence-uncaught:')) pageErrors.push(message.text());
  });
  await page.addInitScript(() => {
    window.addEventListener('error', event => console.error('persistence-uncaught:', event.message));
    window.addEventListener('unhandledrejection', event => console.error('persistence-uncaught:', String(event.reason)));
  });
  let failure: '413' | 'network' | 'lost-response' | 'conflict' | null = null;
  let saveGate: Promise<void> | null = null;
  let activeReply = '';
  let chatDetailRequests = 0;
  const toolOutput = 'z'.repeat(2 * 1024 * 1024);
  const uploads = new Map<string, Map<number, Buffer>>();
  const loadStored = async (): Promise<TestChat> =>
    (await (await request.get(`/api/chats?id=${chat.id}`)).json()).chat;

  await page.route('**/api/chats**', async route => {
    if (route.request().method() === 'GET' && new URL(route.request().url()).searchParams.get('id') === chat.id) {
      chatDetailRequests++;
      if (interruptGitContext && chatDetailRequests === 2) return route.abort('connectionrefused');
    }
    if (route.request().method() !== 'POST') return route.continue();
    const bytes = Buffer.byteLength(route.request().postData() || '');
    const body = route.request().postDataJSON();
    if (body?.action === 'save-sync') {
      saveSizes.push(bytes);
      if (saveGate) await saveGate;
      if (failure === 'network') return route.abort('connectionrefused');
      if (failure === 'lost-response') {
        const committed = await route.fetch();
        if (!committed.ok()) return route.fulfill({ response: committed });
        failure = null;
        return route.abort('connectionrefused');
      }
      if (failure === 'conflict') {
        failure = null;
        const operation = body.operation;
        const first = operation.chat.messages.find((message: ChatMessage) => message.type === 'user');
        const remote = await request.post('/api/chats', { data: {
          action: 'save-sync', operation: {
            operationId: randomUUID(), expectedVersions: { [first.id]: null },
            chat: { ...operation.chat, messages: [{ ...first, content: 'Version saved by another device' }] },
          },
        } });
        expect(remote.ok()).toBeTruthy();
      }
    }
    if (bytes > 1024 * 1024 || (body?.action === 'save-sync' && failure === '413')) {
      return route.fulfill({ status: 413, contentType: 'text/html', body: '<h1>Request Entity Too Large</h1>' });
    }
    return route.continue();
  });
  await page.route('**/api/chat-transfers', async route => {
    const bytes = Buffer.byteLength(route.request().postData() || '');
    saveSizes.push(bytes);
    if (bytes > 1024 * 1024) return route.fulfill({ status: 413, body: 'Too large' });
    const body = route.request().postDataJSON();
    if (typeof body.index === 'number') {
      const chunks = uploads.get(body.id) || new Map<number, Buffer>();
      chunks.set(body.index, Buffer.from(body.data, 'base64'));
      uploads.set(body.id, chunks);
    }
    return route.continue();
  });
  await page.route('**/api/acp', async route => {
    const bytes = Buffer.byteLength(route.request().postData() || '');
    if (bytes > 1024 * 1024) return route.fulfill({ status: 413, body: 'Too large' });
    let body = route.request().postDataJSON();
    if (body.payloadRef) {
      const chunks = uploads.get(body.payloadRef);
      if (!chunks) return route.fulfill({ status: 404, json: { ok: false, error: 'upload_not_found' } });
      body = JSON.parse(Buffer.concat([...chunks.entries()].sort(([a], [b]) => a - b).map(([, buffer]) => buffer)).toString());
    }
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
    async reload() {
      reloading = true;
      try { await page.reload({ waitUntil: 'domcontentloaded' }); }
      finally { reloading = false; }
    },
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

async function holdOutboxWrites(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('agents-chat-outbox', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('operations', 'readwrite');
      const store = transaction.objectStore('operations');
      let holding = true;
      window.addEventListener('release-outbox-writes', () => { holding = false; }, { once: true });
      const keepAlive = () => {
        const request = store.get(['test-gate', 'test-gate']);
        request.onsuccess = () => { if (holding) keepAlive(); };
      };
      transaction.oncomplete = () => database.close();
      transaction.onabort = () => { database.close(); reject(transaction.error); };
      keepAlive();
      resolve();
    };
  }));
  return () => page.evaluate(() => window.dispatchEvent(new Event('release-outbox-writes')));
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
    await fixture.reload();
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
      await expect(page.getByRole('main').getByText('Keep my unsaved question', { exact: true })).toBeVisible();
      expect(fixture.sent).toEqual([]);
      expect((await fixture.loadStored()).messages.filter(message => message.type === 'user')).toHaveLength(1);
      fixture.fail(null);
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect.poll(() => fixture.sent.length, { timeout: 15_000 }).toBe(1);
      await expect(page.getByText('Saved reply 1', { exact: true })).toBeVisible();
      await expect(page.locator('.userSendFailureCard')).toHaveCount(0);
      await fixture.reload();
      await expect(page.getByRole('main').getByText('Keep my unsaved question', { exact: true })).toBeVisible();
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
    await expect.poll(() => fixture.savedBeforeSend).toEqual([true]);
  } finally {
    release();
    await page.goto('about:blank');
    await page.context().request.delete(`/api/chats?id=${fixture.chat.id}`);
  }
});

test('reports a failed auxiliary chat read without an unhandled rejection', async ({ page }) => {
  const fixture = await installPersistenceFixture(page, true);
  try {
    await expect(page.locator('.composerGitContextStatus')).toContainText('Failed to load git context');
    await send(page, 'Continue after a failed context read');
    await expect(page.getByText('Saved reply 1', { exact: true })).toBeVisible();
    await fixture.reload();
    await expect(page.getByText('Continue after a failed context read', { exact: true })).toBeVisible();
    expect(fixture.pageErrors).toEqual([]);
  } finally {
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

test('saves an individual oversized Unicode message and attachments, then sends a small ACP reference', async ({ page }) => {
  const fixture = await installPersistenceFixture(page);
  try {
    const text = '文'.repeat(360_000);
    await send(page, text);
    await expect.poll(() => fixture.sent.length).toBe(1);
    expect(fixture.sent[0]).toBe(text);
    await expect(page.getByText('Saved reply 1', { exact: true })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'large-note.txt', mimeType: 'text/plain', buffer: Buffer.alloc(900_000, 65),
    });
    await send(page, 'Review the large attachment');
    await expect.poll(() => fixture.sent.length).toBe(2);
    const stored = await fixture.loadStored();
    expect(stored.messages.find(message => message.content === text)?.type).toBe('user');
    const attachment = stored.messages.find(message => message.content === 'Review the large attachment')?.attachments?.[0];
    expect(attachment?.size).toBe(900_000);
    expect(attachment?.dataUrl.length).toBeGreaterThan(1024 * 1024);
    expect(Math.max(...fixture.saveSizes)).toBeLessThan(1024 * 1024);
    expect(fixture.savedBeforeSend).toEqual([true, true]);
  } finally {
    await page.goto('about:blank');
    await page.context().request.delete(`/api/chats?id=${fixture.chat.id}`);
  }
});

test('recovers an offline draft after reload without automatically executing it', async ({ page }) => {
  const fixture = await installPersistenceFixture(page);
  try {
    fixture.fail('network');
    await send(page, 'Recover this draft after reload');
    await expect(page.locator('.userSendFailureCard')).toBeVisible();
    await expect(page.getByTestId('chat-outbox')).toBeVisible();
    fixture.fail(null);
    await fixture.reload();
    await expect.poll(async () => (await fixture.loadStored()).messages.some(message => message.content === 'Recover this draft after reload')).toBe(true);
    expect(fixture.sent).toEqual([]);
    await expect(page.getByText('Recover this draft after reload', { exact: true })).toBeVisible();
  } finally {
    await page.goto('about:blank');
    await page.context().request.delete(`/api/chats?id=${fixture.chat.id}`);
  }
});

test('lost commit acknowledgement can be retried without duplicating or automatically sending a message', async ({ page }) => {
  const fixture = await installPersistenceFixture(page);
  try {
    fixture.fail('lost-response');
    await send(page, 'Saved once despite a lost response');
    await expect(page.locator('.userSendFailureCard')).toBeVisible();
    expect(fixture.sent).toEqual([]);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => fixture.sent.length).toBe(1);
    expect((await fixture.loadStored()).messages.filter(message => message.content === 'Saved once despite a lost response')).toHaveLength(1);
  } finally {
    await page.goto('about:blank');
    await page.context().request.delete(`/api/chats?id=${fixture.chat.id}`);
  }
});

test('conflicting drafts preserve both versions and can be saved as a new message without execution', async ({ page }) => {
  const fixture = await installPersistenceFixture(page);
  try {
    fixture.fail('conflict');
    await send(page, 'Keep my local version');
    const panel = page.getByTestId('chat-outbox');
    await expect(page.locator('.userSendFailureCard')).toBeVisible();
    await panel.locator('summary').first().click();
    await expect(panel).toContainText('message_conflict');
    const draft = panel.locator('article').filter({ has: page.getByText(fixture.chat.name, { exact: true }) });
    await draft.getByRole('button', { name: 'View server version' }).click();
    await expect(draft).toContainText('Version saved by another device');
    await draft.getByRole('button', { name: 'Save as new message' }).click();
    await expect.poll(async () => (await fixture.loadStored()).messages.filter(message =>
      message.content === 'Keep my local version' || message.content === 'Version saved by another device').length).toBe(2);
    expect(fixture.sent).toEqual([]);
    const versions = (await fixture.loadStored()).messages.filter(message =>
      message.content === 'Keep my local version' || message.content === 'Version saved by another device');
    expect(new Set(versions.map(message => message.id)).size).toBe(2);
  } finally {
    await page.goto('about:blank');
    await page.context().request.delete(`/api/chats?id=${fixture.chat.id}`);
  }
});

for (const workflowReply of [false, true]) test(`refresh during an in-flight save preserves an existing-session draft and allows explicit retry (workflow reply: ${workflowReply})`, async ({ page }) => {
  test.setTimeout(100_000);
  const fixture = await installPersistenceFixture(page);
  fixture.chat.agentSessions.alpha = 'existing-session';
  if (workflowReply) {
    fixture.chat.messages[1].content = 'Which option should I use?';
    fixture.chat.messages[1].relation = 'Workflow node first';
  }
  expect((await page.context().request.post('/api/chats', {
    data: { action: 'save-delta', chat: { ...fixture.chat, messages: workflowReply ? [fixture.chat.messages[1]] : [] } },
  })).ok()).toBeTruthy();
  await fixture.reload();
  const release = fixture.holdSave();
  try {
    if (workflowReply) {
      await page.locator('.workflowFollowUpCardInput').fill('Keep the in-flight draft');
      await page.getByRole('button', { name: 'Send reply', exact: true }).click();
    } else await send(page, 'Keep the in-flight draft');
    await expect.poll(() => fixture.saveSizes.length).toBeGreaterThan(0);
    expect(fixture.sent).toEqual([]);
    await fixture.reload();
    release();
    await expect.poll(async () => (await fixture.loadStored()).messages.some(message => message.content === 'Keep the in-flight draft'),
      { timeout: 80_000 }).toBe(true);
    expect(fixture.sent).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => fixture.sent).toEqual(['Keep the in-flight draft']);
  } finally {
    release();
    await page.goto('about:blank');
    await page.context().request.delete(`/api/chats?id=${fixture.chat.id}`);
  }
});

test('a deleted conversation cannot be resurrected and its draft can be copied to a new chat', async ({ page }) => {
  const fixture = await installPersistenceFixture(page);
  const request = page.context().request;
  const before = await (await request.get('/api/chats')).json();
  const existingIds = new Set(before.chats.map((chat: { id: string }) => chat.id));
  let recoveredId = '';
  try {
    fixture.fail('network');
    await send(page, 'Keep this draft after remote deletion');
    await expect(page.locator('.userSendFailureCard')).toBeVisible();
    expect((await request.delete(`/api/chats?id=${fixture.chat.id}`)).ok()).toBeTruthy();
    fixture.fail(null);
    const panel = page.getByTestId('chat-outbox');
    await panel.locator('summary').first().click();
    await panel.getByRole('button', { name: 'Retry saving drafts' }).click();
    await expect(panel).toContainText('chat_deleted');
    expect((await request.get(`/api/chats?id=${fixture.chat.id}`)).status()).toBe(404);
    await panel.getByRole('button', { name: 'Save as new message' }).first().click();
    await expect.poll(async () => {
      const data = await (await request.get('/api/chats')).json();
      recoveredId = data.chats.find((chat: { id: string; name: string }) =>
        !existingIds.has(chat.id) && chat.name === 'Recovered drafts')?.id || '';
      return recoveredId;
    }).not.toBe('');
    const restored = await (await request.get(`/api/chats?id=${recoveredId}`)).json();
    expect(restored.chat.messages.filter((message: ChatMessage) =>
      message.content === 'Keep this draft after remote deletion')).toHaveLength(1);
    expect(fixture.sent).toEqual([]);
    expect((await request.get(`/api/chats?id=${fixture.chat.id}`)).status()).toBe(404);
  } finally {
    await page.goto('about:blank');
    await request.delete(`/api/chats?id=${fixture.chat.id}`);
    if (recoveredId) await request.delete(`/api/chats?id=${recoveredId}`);
  }
});

test('local staging only clears the submitted revision and attachments', async ({ page }) => {
  const fixture = await installPersistenceFixture(page);
  const release = await holdOutboxWrites(page);
  try {
    await page.locator('input[type="file"]').setInputFiles({
      name: 'submitted.txt', mimeType: 'text/plain', buffer: Buffer.from('submitted'),
    });

    await send(page, 'Submitted revision');
    await page.locator('textarea.composerTextarea').fill('Next unsent revision');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'next.txt', mimeType: 'text/plain', buffer: Buffer.from('keep me'),
    });
    await release();
    await expect.poll(() => fixture.sent.length).toBe(1);
    await expect(page.locator('textarea.composerTextarea')).toHaveValue('Next unsent revision');
    await expect(page.getByText('next.txt', { exact: true })).toBeVisible();
    const stored = await fixture.loadStored();
    expect(stored.messages.some(message => message.content === 'Next unsent revision')).toBe(false);
    const submitted = stored.messages.find(message => message.content === 'Submitted revision');
    expect(submitted?.attachments?.map(attachment => attachment.name)).toEqual(['submitted.txt']);
  } finally {
    await release();
    await page.goto('about:blank');
    await page.context().request.delete(`/api/chats?id=${fixture.chat.id}`);
  }
});

test('IndexedDB write failure retains the composer text and attachment and never dispatches', async ({ page }) => {
  const fixture = await installPersistenceFixture(page);
  try {
    await page.locator('input[type="file"]').setInputFiles({
      name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('keep the attachment'),
    });
    await page.evaluate(() => {
      IDBObjectStore.prototype.add = function () { throw new DOMException('Storage is full', 'QuotaExceededError'); };
    });
    await send(page, 'Keep the unsaved composer');
    await expect(page.getByRole('main')).toContainText('QuotaExceededError');
    await expect(page.locator('textarea.composerTextarea')).toHaveValue('Keep the unsaved composer');
    await expect(page.locator('.composerShell').getByText('keep.txt', { exact: true })).toBeVisible();
    expect(fixture.sent).toEqual([]);
    expect((await fixture.loadStored()).messages.some(message => message.content === 'Keep the unsaved composer')).toBe(false);
  } finally {
    await page.goto('about:blank');
    await page.context().request.delete(`/api/chats?id=${fixture.chat.id}`);
  }
});

test('an attachment-only conflict copy can be explicitly sent with its fallback prompt', async ({ page }) => {
  const fixture = await installPersistenceFixture(page);
  try {
    fixture.fail('conflict');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'attachment-only.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment-only content'),
    });
    await page.locator('textarea.composerTextarea').press('Enter');
    await expect(page.locator('.userSendFailureCard')).toBeVisible();
    const panel = page.getByTestId('chat-outbox');
    await panel.locator('summary').first().click();
    await panel.getByRole('button', { name: 'Save as new message' }).first().click();
    await expect(panel).toHaveCount(0);
    const copy = page.locator('.message.user').filter({ hasText: 'Recovered draft saved' });
    await copy.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => fixture.sent).toEqual(['Please review the attached file(s).']);
    const stored = await fixture.loadStored();
    expect(stored.messages.filter(message => message.type === 'user' && message.content === '').at(-1)?.attachments?.[0].name)
      .toBe('attachment-only.txt');
  } finally {
    await page.goto('about:blank');
    await page.context().request.delete(`/api/chats?id=${fixture.chat.id}`);
  }
});

test('retrying a recovery copy after its acknowledgement is lost creates only one copy', async ({ page }) => {
  const fixture = await installPersistenceFixture(page);
  try {
    fixture.fail('conflict');
    await send(page, 'One recovered copy');
    await expect(page.locator('.userSendFailureCard')).toBeVisible();
    const panel = page.getByTestId('chat-outbox');
    await panel.locator('summary').first().click();
    fixture.fail('lost-response');
    await panel.getByRole('button', { name: 'Save as new message' }).first().click();
    await expect(panel.getByRole('button', { name: 'Save as new message' }).first()).toBeEnabled();
    await expect.poll(async () => (await fixture.loadStored()).messages.filter(message => message.content === 'One recovered copy').length).toBe(1);
    await panel.getByRole('button', { name: 'Save as new message' }).first().click();
    await expect(panel).toHaveCount(0);
    expect((await fixture.loadStored()).messages.filter(message => message.content === 'One recovered copy')).toHaveLength(1);
    expect(fixture.sent).toEqual([]);
  } finally {
    await page.goto('about:blank');
    await page.context().request.delete(`/api/chats?id=${fixture.chat.id}`);
  }
});

test('resumes a partially uploaded draft after reload without reuploading confirmed chunks or dispatching', async ({ page }) => {
  const fixture = await installPersistenceFixture(page);
  const firstChunks = new Map<string, number>();
  let interrupt = true;
  await page.route('**/api/chat-transfers', route => {
    const body = route.request().postDataJSON();
    if (body.index === 0) firstChunks.set(body.id, (firstChunks.get(body.id) || 0) + 1);
    if (body.index === 1 && interrupt) return route.abort('connectionrefused');
    return route.fallback();
  });
  try {
    const text = '文'.repeat(360_000);
    await send(page, text);
    await expect(page.locator('.userSendFailureCard')).toBeVisible();
    await expect(page.getByTestId('chat-outbox')).toBeVisible();
    expect(firstChunks.size).toBeGreaterThan(0);
    interrupt = false;
    await fixture.reload();
    await expect.poll(async () => (await fixture.loadStored()).messages.some(message => message.content === text)).toBe(true);
    await expect(page.getByTestId('chat-outbox')).toHaveCount(0);
    expect([...firstChunks.values()].every(count => count === 1)).toBe(true);
    expect(fixture.sent).toEqual([]);
  } finally {
    await page.goto('about:blank');
    await page.context().request.delete(`/api/chats?id=${fixture.chat.id}`);
  }
});

test('downloads a complete conflict draft and discards it without changing the server version', async ({ page }) => {
  const fixture = await installPersistenceFixture(page);
  const content = 'Download this private draft';
  const attachmentText = 'Full attachment content';
  try {
    fixture.fail('conflict');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'download.txt', mimeType: 'text/plain', buffer: Buffer.from(attachmentText),
    });
    await send(page, content);
    await expect(page.locator('.userSendFailureCard')).toBeVisible();
    const storedBefore = await fixture.loadStored();
    const panel = page.getByTestId('chat-outbox');
    await panel.locator('summary').first().click();
    const downloadEvent = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download' }).first().click();
    const stream = await (await downloadEvent).createReadStream();
    if (!stream) throw new Error('Missing draft download stream');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const downloaded = JSON.parse(Buffer.concat(chunks).toString());
    const message = downloaded.messages.find((item: ChatMessage) => item.content === content);
    expect(message.attachments[0]).toMatchObject({
      name: 'download.txt', dataUrl: `data:text/plain;base64,${Buffer.from(attachmentText).toString('base64')}`,
    });
    await panel.getByRole('button', { name: 'Discard' }).first().click();
    await expect(panel).toHaveCount(0);
    expect((await fixture.loadStored()).messages).toEqual(storedBefore.messages);
    expect(fixture.sent).toEqual([]);
  } finally {
    await page.goto('about:blank');
    await page.context().request.delete(`/api/chats?id=${fixture.chat.id}`);
  }
});
