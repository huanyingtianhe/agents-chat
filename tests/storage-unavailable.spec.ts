import { expect, test, type Page, type Route } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';

const chats = [
  {
    id: 'loaded-chat',
    name: 'Previously loaded chat',
    ts: 200,
    messages: [{ id: 'loaded-message', type: 'user', content: 'Keep this visible during the outage', ts: 201 }],
    agentSessions: {},
  },
  {
    id: 'other-chat',
    name: 'Other stored chat',
    ts: 100,
    messages: [{ id: 'other-message', type: 'agent', content: 'Other stored message', ts: 101 }],
    agentSessions: {},
  },
];

const agents = [
  { id: 'storage-agent', name: 'Storage Agent', relay: true, canTalk: true, models: [] },
];

function storageUnavailable(route: Route) {
  return route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: 'storage_unavailable' }),
  });
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder('Admin username').fill('admin');
  await page.getByPlaceholder('Password').fill('admin123');
  await page.locator('button[type="submit"]').click();
  await expect(page.getByText('Keep this visible during the outage')).toBeVisible({ timeout: 30_000 });
}

test('preserves loaded chat state across search, chat load, and save storage failures', async ({ page }) => {
  let chatsUnavailable = false;
  let chatRequests = 0;

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON();
    const response = body?.action === 'list-agents' ? { ok: true, agents } : { ok: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });
  await page.route('**/api/orchestrations**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }),
  );
  await page.route('**/api/chats**', async (route) => {
    chatRequests += 1;
    if (chatsUnavailable) return storageUnavailable(route);
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    const id = url.searchParams.get('id');
    if (id) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, chat: chats.find((chat) => chat.id === id) }),
      });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        chats: chats.map(({ id: chatId, name, ts }) => ({ id: chatId, name, ts })),
        lastChatId: chats[0].id,
      }),
    });
  });

  await login(page);
  await expect(page.getByText('Previously loaded chat')).toBeVisible();

  chatsUnavailable = true;
  await page.getByLabel('Search chat history').fill('chat');

  const alert = page.locator('.storageUnavailableBanner');
  await expect(alert).toHaveAttribute('role', 'alert');
  await expect(alert).toContainText('Stored chats and agent configuration are temporarily unavailable');
  await expect(page.getByText('Previously loaded chat')).toBeVisible();
  await expect(page.getByText('Keep this visible during the outage')).toBeVisible();

  await page.getByText('Other stored chat').click();
  await expect(page.getByText('Keep this visible during the outage')).toBeVisible();

  const composer = page.locator('textarea.composerTextarea');
  await composer.fill('Keep this unsaved message in memory');
  await composer.press('Enter');
  await expect(page.getByText('Keep this unsaved message in memory')).toBeVisible();
  await expect(alert).toBeVisible();

  const requestsBeforeRetry = chatRequests;
  chatsUnavailable = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => chatRequests).toBeGreaterThan(requestsBeforeRetry);
  await expect(alert).toBeHidden();
  await expect(page.getByText('Keep this unsaved message in memory')).toBeVisible();
});

test('preserves loaded messages while the agent registry is unavailable and retries without reload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let agentsUnavailable = false;
  let chatsUnavailable = false;
  let listAgentRequests = 0;

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action === 'list-agents') {
      listAgentRequests += 1;
      if (agentsUnavailable) return storageUnavailable(route);
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, agents }),
      });
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/orchestrations**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }),
  );
  await page.route('**/api/chats**', async (route) => {
    if (chatsUnavailable) return storageUnavailable(route);
    const url = new URL(route.request().url());
    const id = url.searchParams.get('id');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(id
        ? { ok: true, chat: chats[0] }
        : { ok: true, chats: chats.slice(0, 1), lastChatId: chats[0].id }),
    });
  });

  await login(page);
  await expect(page.getByText('1 agent configured')).toBeVisible();

  chatsUnavailable = true;
  await page.getByLabel('Search chat history').fill('loaded');
  const alert = page.locator('.storageUnavailableBanner');
  await expect(alert).toHaveAttribute('role', 'alert');
  await expect(alert).toContainText('Your existing data has not been replaced');
  await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  await expect(page.getByText('Keep this visible during the outage')).toBeVisible();

  const requestsBeforeRetry = listAgentRequests;
  chatsUnavailable = false;
  agentsUnavailable = true;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => listAgentRequests).toBeGreaterThan(requestsBeforeRetry);
  await expect(alert).toBeVisible();
  await expect(page.getByText('1 agent configured')).toBeVisible();

  agentsUnavailable = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(alert).toBeHidden();
  await expect(page.getByText('1 agent configured')).toBeVisible();
});
