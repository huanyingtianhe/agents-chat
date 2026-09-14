import { expect, test, type Page, type Route } from '@playwright/test';
import { selectModelOption } from './model-picker-helpers';

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
  {
    id: 'storage-agent',
    name: 'Storage Agent',
    relay: true,
    canTalk: true,
    models: [
      { modelId: 'storage-default', name: 'Storage Default' },
      { modelId: 'storage-next', name: 'Storage Next' },
    ],
    defaultModelId: 'storage-default',
  },
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

async function submitLogin(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder('Admin username').fill('admin');
  await page.getByPlaceholder('Password').fill('admin123');
  await page.locator('button[type="submit"]').click();
}

test('treats non-JSON 503 responses as storage outages for chats and ACP', async ({ page }) => {
  let chatsUnavailable = true;
  let agentsUnavailable = false;

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action === 'list-agents' && agentsUnavailable) {
      return route.fulfill({ status: 503, contentType: 'text/html', body: '<h1>proxy unavailable</h1>' });
    }
    const response = body?.action === 'list-agents' ? { ok: true, agents } : { ok: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });
  await page.route('**/api/orchestrations**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }),
  );
  await page.route('**/api/chats**', async (route) => {
    if (chatsUnavailable) {
      return route.fulfill({ status: 503, contentType: 'text/plain', body: 'upstream unavailable' });
    }
    const id = new URL(route.request().url()).searchParams.get('id');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(id
        ? { ok: true, chat: chats[0] }
        : { ok: true, chats: chats.slice(0, 1), lastChatId: chats[0].id }),
    });
  });

  await submitLogin(page);
  const alert = page.locator('.storageUnavailableBanner');
  await expect(alert).toBeVisible({ timeout: 30_000 });

  chatsUnavailable = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('Keep this visible during the outage')).toBeVisible();
  await alert.getByRole('button', { name: 'Dismiss' }).click();
  await expect(alert).toBeHidden();

  agentsUnavailable = true;
  await page.reload();
  await expect(alert).toBeVisible();
  await expect(page.getByText('Keep this visible during the outage')).toBeVisible();
});

test('preserves loaded chat state across search, chat load, and save storage failures', async ({ page }) => {
  let writesUnavailable = false;
  let chatRequests = 0;
  const successfulChatWrites: any[] = [];

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
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      const body = request.postDataJSON();
      if (writesUnavailable) return storageUnavailable(route);
      successfulChatWrites.push(body);
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
  successfulChatWrites.length = 0;

  writesUnavailable = true;
  const composer = page.locator('textarea.composerTextarea');
  await composer.fill('Keep this unsaved message in memory');
  await composer.press('Enter');
  const alert = page.locator('.storageUnavailableBanner');
  await expect(alert).toHaveAttribute('role', 'alert');
  await expect(alert).toContainText('Stored chats and agent configuration are temporarily unavailable');
  await expect(page.getByText('Previously loaded chat')).toBeVisible();
  await expect(page.getByText('Keep this visible during the outage')).toBeVisible();

  await page.getByLabel('Search chat history').fill('chat');
  await expect(alert).toBeVisible();
  await expect(page.getByText('Keep this visible during the outage')).toBeVisible();
  await expect(page.getByText('Keep this unsaved message in memory')).toBeVisible();

  const requestsBeforeRetry = chatRequests;
  writesUnavailable = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => chatRequests).toBeGreaterThan(requestsBeforeRetry);
  await expect(alert).toBeHidden();
  await expect(page.getByText('Keep this unsaved message in memory')).toBeVisible();
  await expect.poll(() => successfulChatWrites.filter((body) => body.chat?.id === 'loaded-chat').length).toBe(1);
  expect(successfulChatWrites[0]?.chat?.messages)
    .toEqual(expect.arrayContaining([expect.objectContaining({ content: 'Keep this unsaved message in memory' })]));
  expect(successfulChatWrites[1]).toEqual(expect.objectContaining({ action: 'set-last-chat', chatId: 'loaded-chat' }));
});

test('surfaces failed preference writes, keeps optimistic state, and retries them in order', async ({ page }) => {
  let writesUnavailable = false;
  const successfulWrites: any[] = [];

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON();
    const isPreferenceWrite = ['set-model-pref', 'set-last-used-agent', 'set-user-setting'].includes(body?.action);
    if (isPreferenceWrite && writesUnavailable) {
      return route.fulfill({ status: 503, contentType: 'text/plain', body: 'proxy unavailable' });
    }
    if (isPreferenceWrite) successfulWrites.push(body);
    if (body?.action === 'list-agents') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, agents }) });
    }
    if (body?.action === 'get-user-settings') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, settings: { last_used_agent_scope: 'chat' } }),
      });
    }
    if (body?.action === 'get-model-prefs') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, prefs: {} }) });
    }
    if (body?.action === 'get-chat-last-used-agents') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, map: {} }) });
    }
    if (body?.action === 'get-last-used-agent') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, agentId: '' }) });
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/orchestrations**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }),
  );
  await page.route('**/api/chats**', async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    const id = new URL(request.url()).searchParams.get('id');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(id
        ? { ok: true, chat: chats[0] }
        : { ok: true, chats: chats.slice(0, 1), lastChatId: chats[0].id }),
    });
  });

  await login(page);
  writesUnavailable = true;

  const composer = page.locator('textarea.composerTextarea');
  await composer.fill('@storage-agent retain optimistic preferences');
  await selectModelOption(page, 'storage-agent', 'Storage Next');
  await expect(page.getByRole('button', { name: 'Model for storage-agent' })).toContainText('Storage Next');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('menu', { name: 'Settings' }).getByRole('menuitemradio', { name: 'Per user' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('menu', { name: 'Settings' }).getByRole('menuitemradio', { name: 'Per user' }))
    .toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  await composer.press('Enter');
  const alert = page.locator('.storageUnavailableBanner');
  await expect(alert).toBeVisible();
  await expect(page.getByText('retain optimistic preferences')).toBeVisible();

  writesUnavailable = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(alert).toBeHidden();
  await expect.poll(() => successfulWrites.map((body) => body.action)).toEqual([
    'set-model-pref',
    'set-user-setting',
    'set-last-used-agent',
  ]);
  expect(successfulWrites).toEqual([
    expect.objectContaining({ action: 'set-model-pref', agentId: 'storage-agent', modelId: 'storage-next' }),
    expect.objectContaining({ action: 'set-user-setting', key: 'last_used_agent_scope', value: 'user' }),
    expect.objectContaining({ action: 'set-last-used-agent', agentId: 'storage-agent' }),
  ]);
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
