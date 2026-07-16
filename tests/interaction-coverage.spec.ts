import { expect, Page, test } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';

const alphaAgent = {
  id: 'alpha',
  name: 'Alpha Agent',
  command: 'mock',
  args: ['--acp'],
  cwd: '/tmp',
  running: true,
  canTalk: true,
  canModify: true,
  public: true,
  models: [],
};

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.locator('input[placeholder="Admin username"]').fill('admin');
  await page.locator('input[placeholder="Password"]').fill('admin123');
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 30000 });
  await page.waitForTimeout(500);
}

async function createFreshChat(page: Page) {
  await page.locator('button.emptyHomepageNewChat').click();
  await page.waitForSelector('.chatContainer', { timeout: 10000 });
}

test.beforeEach(async ({ page }) => {
  const chats = new Map<string, any>();
  let lastChatId = '';
  await page.route('**/api/chats**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      const id = url.searchParams.get('id');
      if (id) {
        const chat = chats.get(id);
        await route.fulfill({
          status: chat ? 200 : 404,
          contentType: 'application/json',
          body: JSON.stringify(chat ? { ok: true, chat } : { ok: false, error: 'not_found' }),
        });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          chats: [...chats.values()].map(({ id: chatId, name, ts }) => ({ id: chatId, name, ts })),
          lastChatId,
        }),
      });
      return;
    }
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      if (body?.chat) chats.set(body.chat.id, body.chat);
      if (body?.action === 'set-last-chat') lastChatId = body.chatId || '';
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    if (request.method() === 'DELETE') {
      chats.delete(url.searchParams.get('id') || '');
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ status: 405, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
  });
  await page.route('**/api/orchestrations**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }),
  );
});

test('slash command palette filters and inserts an advertised command', async ({ page }) => {
  const slashRequests: any[] = [];
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    if (body?.action === 'list-agents') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, agents: [alphaAgent] }) });
      return;
    }
    if (body?.action === 'get-slash-commands') {
      slashRequests.push(body);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          commands: [
            { name: 'review', description: 'Review the current changes', hint: '<scope>' },
            { name: 'test', description: 'Run tests' },
          ],
        }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await login(page);
  await createFreshChat(page);
  const textarea = page.locator('textarea.composerTextarea');
  await textarea.fill('/rev');

  const palette = page.getByRole('listbox', { name: 'Slash commands' });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('option')).toHaveCount(1);
  await expect(palette).toContainText('/review <scope>');
  await palette.getByRole('option').click();

  await expect(textarea).toHaveValue('/review ');
  expect(slashRequests.some((request) => request.agentId === 'alpha' && /^chat-/.test(request.chatId))).toBe(true);
});

test('agent authentication control submits the selected ACP method', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const authRequests: any[] = [];
  const authAgent = {
    ...alphaAgent,
    needsAuth: true,
    authMethods: [{ id: 'github', name: 'GitHub', description: 'Sign in with GitHub' }],
  };
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    if (body?.action === 'list-agents') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, agents: [authAgent] }) });
      return;
    }
    if (body?.action === 'acp-authenticate') {
      authRequests.push(body);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await login(page);
  await page.locator('button[title="Agents"]').click();
  await expect(page.locator('.agentsSidebar')).toBeVisible();
  await page.getByTitle('Alpha Agent needs authentication').click();
  const authMenu = page.getByRole('menu');
  await expect(authMenu).toContainText('Authenticate Alpha Agent');
  await authMenu.getByRole('menuitem', { name: /GitHub/ }).click();

  await expect.poll(() => authRequests).toEqual([
    expect.objectContaining({ action: 'acp-authenticate', agentId: 'alpha', methodId: 'github' }),
  ]);
  await expect(page.locator('.agentAuthSuccess')).toHaveText('✓ Authenticated');
});

test('multi-agent composer exposes and switches orchestration modes', async ({ page }) => {
  const betaAgent = { ...alphaAgent, id: 'beta', name: 'Beta Agent' };
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    if (body?.action === 'list-agents') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, agents: [alphaAgent, betaAgent] }) });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await login(page);
  await createFreshChat(page);
  await page.locator('textarea.composerTextarea').fill('@alpha @beta compare approaches');

  const auto = page.getByRole('button', { name: /Auto/ });
  const pipeline = page.getByRole('button', { name: /Pipeline/ });
  await expect(auto).toBeVisible();
  await expect(pipeline).toBeVisible();
  await expect(page.getByRole('button', { name: /workflow/i })).toBeVisible();
  await pipeline.click();
  await expect(pipeline).toHaveClass(/orchPillActive/);
  await expect(auto).not.toHaveClass(/orchPillActive/);
});

test('pipeline orchestration runs agents sequentially and summarizes their results', async ({ page }) => {
  const betaAgent = { ...alphaAgent, id: 'beta', name: 'Beta Agent' };
  const sends: any[] = [];
  const activeTurns = new Map<string, { id: string; text: string }>();
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    if (body?.action === 'list-agents') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, agents: [alphaAgent, betaAgent] }) });
      return;
    }
    if (body?.action === 'send') {
      sends.push(body);
      const id = `turn-${body.agentId}-${sends.length}`;
      const text = body.agentId === 'beta' ? 'Beta builds on Alpha' : sends.length === 1 ? 'Alpha initial result' : 'Alpha final summary';
      activeTurns.set(body.agentId, { id, text });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, phase: 'thinking', sessionId: `session-${body.agentId}`, turn: { id } }),
      });
      return;
    }
    if (body?.action === 'poll') {
      const turn = activeTurns.get(body.agentId);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          phase: 'idle',
          ready: true,
          booting: false,
          activeTurn: turn ? {
            id: turn.id,
            fullText: turn.text,
            done: true,
            phase: 'done',
            events: [{ type: 'text_chunk', ts: Date.now(), text: turn.text }],
          } : null,
        }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await login(page);
  await createFreshChat(page);
  const textarea = page.locator('textarea.composerTextarea');
  await textarea.fill('@alpha @beta produce a joint answer');
  await page.getByRole('button', { name: /Pipeline/ }).click();
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect.poll(() => sends.map((request) => request.agentId), { timeout: 20000 })
    .toEqual(['alpha', 'beta', 'alpha']);
  expect(sends[0].text).toContain('produce a joint answer');
  expect(sends[1].text).toContain('Alpha initial result');
  expect(sends[2].text).toContain('Alpha initial result');
  expect(sends[2].text).toContain('Beta builds on Alpha');
  await expect(page.locator('.message.agent', { hasText: 'Alpha final summary' })).toBeVisible();
});

test('fullscreen control reflects browser fullscreen state', async ({ page }) => {
  await page.addInitScript(() => {
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: async () => {
        fullscreenElement = document.documentElement;
        document.dispatchEvent(new Event('fullscreenchange'));
      },
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: async () => {
        fullscreenElement = null;
        document.dispatchEvent(new Event('fullscreenchange'));
      },
    });
  });
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    const response = body?.action === 'list-agents' ? { ok: true, agents: [alphaAgent] } : { ok: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });

  await login(page);
  const enter = page.getByRole('button', { name: 'Enter full screen' });
  await expect(enter).toBeVisible();
  await enter.click();
  const exit = page.getByRole('button', { name: 'Exit full screen' });
  await expect(exit).toHaveAttribute('aria-pressed', 'true');
  await exit.click();
  await expect(page.getByRole('button', { name: 'Enter full screen' })).toHaveAttribute('aria-pressed', 'false');
});

test('mobile header exposes primary panels through the overflow menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    const response = body?.action === 'list-agents' ? { ok: true, agents: [alphaAgent] } : { ok: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });

  await login(page);
  await page.getByRole('button', { name: 'More actions' }).click();
  const menu = page.getByRole('menu', { name: 'Header actions' });
  await expect(menu.getByRole('menuitem', { name: 'Chats' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Agents' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Nodes' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Schedules' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Agents' }).click();
  await expect(page.locator('.agentsSidebar')).toBeVisible();
});

test('settings persist the remembered agent scope per chat', async ({ page }) => {
  let scope = 'user';
  const settingRequests: any[] = [];
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    if (body?.action === 'list-agents') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, agents: [alphaAgent] }) });
      return;
    }
    if (body?.action === 'get-user-settings') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, settings: { last_used_agent_scope: scope } }),
      });
      return;
    }
    if (body?.action === 'set-user-setting') {
      settingRequests.push(body);
      scope = body.value;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await login(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  const menu = page.getByRole('menu', { name: 'Settings' });
  await menu.getByRole('menuitemradio', { name: 'Per chat' }).click();
  await expect.poll(() => settingRequests).toContainEqual(
    expect.objectContaining({ action: 'set-user-setting', key: 'last_used_agent_scope', value: 'chat' }),
  );

  await page.reload();
  await page.waitForSelector('.emptyHomepage, .chatContainer', { timeout: 30000 });
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('menu', { name: 'Settings' }).getByRole('menuitemradio', { name: 'Per chat' }))
    .toHaveAttribute('aria-checked', 'true');
});

test('dragging a file onto the composer queues it as an attachment', async ({ page }) => {
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    const response = body?.action === 'list-agents' ? { ok: true, agents: [alphaAgent] } : { ok: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });

  await login(page);
  await createFreshChat(page);
  await page.locator('.composerShell').evaluate((composer) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['dragged content'], 'dragged.txt', { type: 'text/plain' }));
    composer.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    composer.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.locator('.attachmentChip', { hasText: 'dragged.txt' })).toBeVisible();
});

test('file endpoint enforces auth, blocks sensitive paths, and report validates its path', async ({ page, request }) => {
  const unauthorized = await request.get(`${BASE}/api/file`);
  expect(unauthorized.status()).toBe(401);

  await login(page);
  const missing = await page.request.get(`${BASE}/api/file`);
  expect(missing.status()).toBe(400);
  await expect(missing.json()).resolves.toEqual({ error: 'missing path param' });

  const blocked = await page.request.get(`${BASE}/api/file?path=${encodeURIComponent('/etc/passwd')}`);
  expect(blocked.status()).toBe(403);
  await expect(blocked.json()).resolves.toEqual({ error: 'blocked path' });

  const absent = await page.request.get(`${BASE}/api/file?path=${encodeURIComponent('/tmp/agents-chat-does-not-exist.html')}`);
  expect(absent.status()).toBe(404);

  await page.goto(`${BASE}/report`);
  await expect(page.getByText('Missing')).toBeVisible();
  await expect(page.locator('code')).toHaveText('?path=');

  const safePath = `${process.cwd()}/package.json`;
  const allowed = await page.request.get(`${BASE}/api/file?path=${encodeURIComponent(safePath)}`);
  expect(allowed.status()).toBe(200);
  expect(allowed.headers()['content-type']).toContain('application/json');
  expect((await allowed.json()).name).toBe('agents-chat');

  await page.goto(`${BASE}/report?path=${encodeURIComponent(safePath)}`);
  await expect(page.getByTitle('Report')).toHaveAttribute('src', `/api/file?path=${encodeURIComponent(safePath)}`);
});
