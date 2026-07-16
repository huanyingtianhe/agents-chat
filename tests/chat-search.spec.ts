import { expect, test, type Page } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';

type Chat = {
  id: string;
  name: string;
  ts: number;
  messages: Array<{ id: string; type: 'user' | 'agent'; content: string; ts: number }>;
  agentSessions: Record<string, string>;
};

const chats: Chat[] = [
  {
    id: 'search-name',
    name: 'Quarterly roadmap',
    ts: 300,
    messages: [{ id: 'n1', type: 'user', content: 'Plan the next release', ts: 301 }],
    agentSessions: {},
  },
  {
    id: 'search-message',
    name: 'Support notes',
    ts: 200,
    messages: [{ id: 'm1', type: 'agent', content: 'The hidden keyword is nebula.', ts: 201 }],
    agentSessions: {},
  },
  {
    id: 'search-other',
    name: 'Lunch ideas',
    ts: 100,
    messages: [{ id: 'o1', type: 'user', content: 'Pick a restaurant', ts: 101 }],
    agentSessions: {},
  },
];

async function mockIsolatedApp(page: Page, searchRequests: string[]) {
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action === 'list-agents') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          agents: [{ id: 'search-agent', name: 'Search Agent', relay: true, canTalk: true, models: [] }],
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
    if (request.method() !== 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    const id = url.searchParams.get('id');
    if (id) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, chat: chats.find((chat) => chat.id === id) }),
      });
      return;
    }
    const search = url.searchParams.get('search');
    if (search !== null) {
      searchRequests.push(url.pathname + url.search);
      const needle = search.trim().toLowerCase();
      const results = chats
        .filter((chat) =>
          chat.name.toLowerCase().includes(needle)
          || chat.messages.some((message) => message.content.toLowerCase().includes(needle)),
        )
        .map(({ id: chatId, name, ts }) => ({ id: chatId, name, ts }));
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, chats: results }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        chats: chats.map(({ id: chatId, name, ts }) => ({ id: chatId, name, ts })),
        lastChatId: chats[0].id,
      }),
    });
  });
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder('Admin username').fill('admin');
  await page.getByPlaceholder('Password').fill('admin123');
  await page.locator('button[type="submit"]').click();
  await expect(page.getByLabel('Search chat history')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.message.user')).toBeVisible();
}

test.describe('chat sidebar keyword search', () => {
  test('matches a chat name and clear restores the complete history', async ({ page }) => {
    const requests: string[] = [];
    await mockIsolatedApp(page, requests);
    await login(page);

    const search = page.getByLabel('Search chat history');
    await search.fill('roadmap');

    await expect.poll(() => requests).toContain('/api/chats?search=roadmap');
    await expect(page.locator('.chatHistoryName')).toHaveText(['Quarterly roadmap']);

    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(search).toHaveValue('');
    await expect(page.locator('.chatHistoryName')).toHaveText([
      'Quarterly roadmap',
      'Support notes',
      'Lunch ideas',
    ]);
  });

  test('uses /api/chats?search and displays a message-content match', async ({ page }) => {
    const requests: string[] = [];
    await mockIsolatedApp(page, requests);
    await login(page);

    await page.getByLabel('Search chat history').fill('nebula');

    await expect.poll(() => requests).toContain('/api/chats?search=nebula');
    await expect(page.locator('.chatHistoryName')).toHaveText(['Support notes']);
    await expect(page.locator('.chatHistoryName')).not.toContainText('nebula');
  });

  test('shows the no-results state for an unmatched keyword', async ({ page }) => {
    const requests: string[] = [];
    await mockIsolatedApp(page, requests);
    await login(page);

    await page.getByLabel('Search chat history').fill('does-not-exist');

    await expect.poll(() => requests).toContain('/api/chats?search=does-not-exist');
    await expect(page.getByText('No chats found', { exact: true })).toBeVisible();
    await expect(page.locator('.chatHistoryItem')).toHaveCount(0);
  });
});

test('search API finds persisted message content and excludes unrelated chats', async ({ page }) => {
  const suffix = Date.now();
  const matchingId = `search-api-match-${suffix}`;
  const unrelatedId = `search-api-other-${suffix}`;
  const keyword = `quasar-${suffix}`;

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON();
    const response = body?.action === 'list-agents' ? { ok: true, agents: [] } : { ok: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder('Admin username').fill('admin');
  await page.getByPlaceholder('Password').fill('admin123');
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('.emptyHomepage, .chatContainer', { timeout: 30_000 });

  try {
    const result = await page.evaluate(async ({ matchingId, unrelatedId, keyword }) => {
      const save = async (chat: Record<string, unknown>) => {
        const response = await fetch('/api/chats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat }),
        });
        if (!response.ok) throw new Error(`save failed: ${response.status}`);
      };
      await save({
        id: matchingId,
        name: 'Opaque matching chat',
        ts: Date.now(),
        messages: [{ id: 'message-match', type: 'agent', content: `Stored content contains ${keyword}`, ts: Date.now() }],
        agentSessions: {},
      });
      await save({
        id: unrelatedId,
        name: 'Unrelated persisted chat',
        ts: Date.now() - 1,
        messages: [{ id: 'message-other', type: 'user', content: 'No matching content', ts: Date.now() }],
        agentSessions: {},
      });
      return fetch(`/api/chats?search=${encodeURIComponent(keyword)}`).then((response) => response.json());
    }, { matchingId, unrelatedId, keyword });

    expect(result.ok).toBe(true);
    expect(result.chats.map((chat: { id: string }) => chat.id)).toContain(matchingId);
    expect(result.chats.map((chat: { id: string }) => chat.id)).not.toContain(unrelatedId);
  } finally {
    await page.evaluate(async (ids) => {
      await Promise.all(ids.map((id) => fetch(`/api/chats?id=${encodeURIComponent(id)}`, { method: 'DELETE' })));
    }, [matchingId, unrelatedId]);
  }
});
