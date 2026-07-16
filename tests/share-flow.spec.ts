import { expect, test, type Page } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';

type Chat = {
  id: string;
  name: string;
  ts: number;
  messages: Array<{ id: string; type: 'user' | 'agent'; content: string; agentId?: string; ts: number }>;
  agentSessions: Record<string, string>;
};

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder('Admin username').fill('admin');
  await page.getByPlaceholder('Password').fill('admin123');
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('.chatHistoryItem')).toBeVisible({ timeout: 30_000 });
}

test('creates, copies, closes, renders, and continues a shared conversation', async ({ page, context }) => {
  const source: Chat = {
    id: 'share-source',
    name: 'Deterministic shared chat',
    ts: 500,
    messages: [
      { id: 'share-user', type: 'user', content: 'Please preserve this question.', ts: 501 },
      { id: 'share-agent', type: 'agent', agentId: 'share-agent', content: 'Preserved answer.', ts: 502 },
    ],
    agentSessions: {},
  };
  const chats = new Map<string, Chat>([[source.id, source]]);
  let lastChatId = source.id;
  const shareRequests: Record<string, unknown>[] = [];
  const shareId = 'share-e2e-fixed';

  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action === 'list-agents') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          agents: [{ id: 'share-agent', name: 'Share Agent', relay: true, canTalk: true, models: [] }],
        }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/orchestrations**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }),
  );
  await page.route('**/api/chats**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      const id = url.searchParams.get('id');
      const chat = id ? chats.get(id) : undefined;
      await route.fulfill({
        contentType: 'application/json',
        status: id && !chat ? 404 : 200,
        body: JSON.stringify(id
          ? (chat ? { ok: true, chat } : { ok: false, error: 'not_found' })
          : {
              ok: true,
              chats: [...chats.values()].map(({ id: chatId, name, ts }) => ({ id: chatId, name, ts })),
              lastChatId,
            }),
      });
      return;
    }
    const body = request.postDataJSON();
    if (body?.action === 'set-last-chat') lastChatId = body.chatId;
    if (body?.chat) chats.set(body.chat.id, body.chat);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/share**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          chat: {
            shareId,
            sharedBy: 'admin@local',
            sharedAt: 1_700_000_000_000,
            name: source.name,
            messages: source.messages,
          },
        }),
      });
      return;
    }
    const body = request.postDataJSON();
    shareRequests.push(body);
    if (body?.action === 'import') {
      const imported: Chat = {
        ...source,
        id: 'shared-import-fixed',
        ts: 600,
        agentSessions: {},
      };
      chats.set(imported.id, imported);
      lastChatId = imported.id;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, chatId: imported.id }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, shareId, url: `/share/${shareId}` }),
    });
  });

  await login(page);
  const row = page.locator('.chatHistoryRow', { hasText: source.name });
  await row.hover();
  await row.locator('.chatMoreBtn').click();
  await page.getByRole('menuitem', { name: 'Share' }).click();

  const dialog = page.getByRole('dialog', { name: 'Share this conversation' });
  await expect(dialog).toBeVisible();
  const expectedUrl = `${new URL(BASE).origin}/share/${shareId}`;
  await expect(dialog.locator('.shareLinkInput')).toHaveValue(expectedUrl);
  expect(shareRequests[0]).toEqual({ chatId: source.id });

  await dialog.getByRole('button', { name: 'Copy' }).click();
  await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect(dialog.getByText('Copied to clipboard.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedUrl);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();

  await page.goto(expectedUrl);
  await expect(page.getByRole('heading', { name: `🤖 ${source.name}` })).toBeVisible();
  await expect(page.locator('.shareMsg.user')).toContainText('Please preserve this question.');
  await expect(page.locator('.shareMsg.agent')).toContainText('Preserved answer.');

  await page.getByRole('button', { name: '💬 Continue this conversation' }).click();
  await expect(page).toHaveURL(new URL('/', BASE).toString());
  await expect(page.locator('.message.user')).toContainText('Please preserve this question.');
  await expect(page.locator('.message.agent')).toContainText('Preserved answer.');
  expect(shareRequests.at(-1)).toEqual({ action: 'import', shareId });
});
