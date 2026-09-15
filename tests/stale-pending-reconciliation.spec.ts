import { expect, test, type Page } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.locator('input[placeholder="Admin username"]').fill('admin');
  await page.locator('input[placeholder="Password"]').fill('admin123');
  await page.getByRole('button', { name: 'Sign in as Admin', exact: true }).click();
  await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 30_000 });
}

test('reconciles stale pending output after a successful session resume', async ({ page }) => {
  const chatId = `stale-pending-${Date.now()}`;
  const anchorChatId = `stale-pending-anchor-${Date.now()}`;
  const chatName = `Stale pending reconciliation ${chatId}`;
  let reconciliationSaves = 0;

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as { action?: string; sessionId?: string };
    if (body.action === 'list-agents') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
        }),
      });
      return;
    }
    if (body.action === 'resume-session') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          loaded: true,
          sessionId: body.sessionId,
          activeTurn: null,
          recoveredMessages: [],
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, activeTurn: null }),
    });
  });
  await page.route('**/api/chats**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { chat?: { id?: string } };
      if (body.chat?.id === chatId) reconciliationSaves++;
    }
    await route.continue();
  });

  await login(page);
  await page.evaluate(async ({ id, anchorId, name }) => {
    const existing = await fetch('/api/chats').then((response) => response.json());
    await Promise.all(
      (existing.chats || [])
        .filter((chat: { id: string }) => chat.id.startsWith('stale-pending-'))
        .map((chat: { id: string }) => fetch(`/api/chats?id=${encodeURIComponent(chat.id)}`, { method: 'DELETE' })),
    );
    const now = Date.now();
    await fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat: {
          id,
          name,
          ts: now,
          messages: [
            { id: 'user-1', type: 'user', content: 'Inspect the shell output', ts: now - 1 },
            {
              id: 'pending-1',
              type: 'agent',
              agentId: 'alpha',
              content: '',
              pending: true,
              statusText: 'Reading shell output',
              ts: now,
              parts: Array.from({ length: 1_734 }, (_, index) => ({
                kind: 'tool',
                toolName: index === 1_733 ? 'Reading shell output' : `historical_tool_${index}`,
                result: 'Preserved historical tool output '.repeat(60),
                done: index !== 1_733,
              })),
            },
          ],
          agentSessions: { alpha: 'missing-session' },
        },
      }),
    });
    await fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat: {
          id: anchorId,
          name: 'Reconciliation anchor chat',
          ts: now + 1,
          messages: [{ id: 'anchor-user', type: 'user', content: 'Anchor chat', ts: now + 1 }],
          agentSessions: {},
        },
      }),
    });
    await fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set-last-chat', chatId: anchorId }),
    });
  }, { id: chatId, anchorId: anchorChatId, name: chatName });
  reconciliationSaves = 0;

  await page.reload();
  await page.waitForSelector('.chatContainer', { timeout: 30_000 });
  await page.getByTitle(chatName, { exact: true }).click();
  const agentMessage = page.locator('.message.agent', { hasText: 'Interrupted shell output' });
  await expect(agentMessage).toBeVisible({ timeout: 30_000 });
  await expect(agentMessage.locator('.ptyStatusBadge')).toHaveText('Interrupted', { timeout: 30_000 });
  await expect(page.getByText('Reading shell output')).toHaveCount(0);
  await expect(agentMessage.locator('.toolCallName').filter({ hasText: /^Interrupted shell output$/ }))
    .toHaveText('Interrupted shell output');
  await expect.poll(() => reconciliationSaves).toBe(1);

  const persisted = await page.evaluate(async (id) => {
    const response = await fetch(`/api/chats?id=${encodeURIComponent(id)}`);
    return response.json();
  }, chatId);
  const reconciledMessage = persisted.chat.messages.find((message: { id: string }) => message.id === 'pending-1');
  expect(reconciledMessage).toMatchObject({
    pending: false,
    statusText: 'Interrupted',
    content: '⏹ Interrupted',
  });
  expect(reconciledMessage.parts).toHaveLength(1_734);
  expect(reconciledMessage.parts.at(-1)).toEqual({
    kind: 'tool',
    toolName: 'Reading shell output',
    result: 'Preserved historical tool output '.repeat(60),
    done: false,
  });

  await page.reload();
  await expect(page.locator('.message.agent .ptyStatusBadge')).toHaveText('Interrupted');
  await expect.poll(() => reconciliationSaves).toBe(1);

  await page.goto('about:blank');
  const response = await page.context().request.delete(`${BASE}/api/chats?id=${encodeURIComponent(chatId)}`);
  expect(response.ok()).toBeTruthy();
  const anchorResponse = await page.context().request.delete(`${BASE}/api/chats?id=${encodeURIComponent(anchorChatId)}`);
  expect(anchorResponse.ok()).toBeTruthy();
});
