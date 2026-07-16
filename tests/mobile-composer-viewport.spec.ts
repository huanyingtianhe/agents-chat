import { expect, Page, test } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.locator('input[placeholder="Admin username"]').fill(process.env.ADMIN_USERNAME || 'admin');
  await page.locator('input[placeholder="Password"]').fill(process.env.ADMIN_PASSWORD || 'admin123');
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 30000 });
  await page.waitForTimeout(500);
}

test('keeps composer controls above iPhone browser chrome and keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 926 });
  await page.addInitScript(() => {
    let height = 926;
    let offsetTop = 0;
    const listeners = new Map<string, Set<EventListener>>();
    const visualViewport = {
      get height() { return height; },
      get width() { return 428; },
      get offsetTop() { return offsetTop; },
      get offsetLeft() { return 0; },
      get pageTop() { return offsetTop; },
      get pageLeft() { return 0; },
      get scale() { return 1; },
      addEventListener(type: string, listener: EventListener) {
        const handlers = listeners.get(type) || new Set<EventListener>();
        handlers.add(listener);
        listeners.set(type, handlers);
      },
      removeEventListener(type: string, listener: EventListener) {
        listeners.get(type)?.delete(listener);
      },
    };

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    });
    (window as typeof window & { setTestVisualViewport: (nextHeight: number, nextOffsetTop: number) => void })
      .setTestVisualViewport = (nextHeight, nextOffsetTop) => {
        height = nextHeight;
        offsetTop = nextOffsetTop;
        for (const listener of listeners.get('resize') || []) listener(new Event('resize'));
        for (const listener of listeners.get('scroll') || []) listener(new Event('scroll'));
      };
  });

  const chats = new Map<string, Record<string, unknown>>();
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
          chats: [...chats.values()].map((chat) => ({
            id: chat.id,
            name: chat.name,
            ts: chat.ts,
          })),
          lastChatId,
        }),
      });
      return;
    }
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      if (body?.chat) chats.set(body.chat.id, body.chat);
      if (body?.action === 'set-last-chat') lastChatId = body.chatId || '';
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/orchestrations**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }),
  );
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action === 'list-agents') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          agents: [{
            id: 'alpha',
            name: 'Alpha Agent',
            command: 'mock',
            args: [],
            cwd: '/tmp',
            running: true,
            canTalk: true,
            canModify: true,
            public: true,
            models: [
              { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
              { modelId: 'gpt-5.4', name: 'GPT-5.4' },
            ],
            defaultModelId: 'claude-sonnet-4.6',
          }],
        }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await login(page);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    'content',
    /width=device-width.*initial-scale=1.*interactive-widget=resizes-content/,
  );
  await page.locator('button.emptyHomepageNewChat').click();
  const textarea = page.locator('textarea.composerTextarea');
  await expect(textarea).toBeVisible({ timeout: 10000 });
  await textarea.fill('@alpha mobile viewport');

  await page.evaluate(() => {
    (window as typeof window & { setTestVisualViewport: (height: number, offsetTop: number) => void })
      .setTestVisualViewport(430, 24);
  });

  const app = page.locator('.chatPageRoot .page');
  await expect.poll(() => app.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), height: Math.round(rect.height) };
  })).toEqual({ top: 24, height: 430 });

  const sendButton = page.getByRole('button', { name: 'Send message' });
  const modelButton = page.getByRole('button', { name: 'Model for alpha' });
  await expect(sendButton).toBeVisible();
  await expect(modelButton).toBeVisible();

  for (const locator of [page.locator('.chatInputDock'), sendButton, modelButton]) {
    const [controlBox, appBox] = await Promise.all([locator.boundingBox(), app.boundingBox()]);
    expect(controlBox).not.toBeNull();
    expect(appBox).not.toBeNull();
    expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(appBox!.y + appBox!.height + 1);
  }

  await modelButton.click();
  const modelMenu = page.getByRole('listbox', { name: 'Model for alpha' });
  await expect(modelMenu).toBeVisible();
  const [menuRect, appRect] = await Promise.all([
    modelMenu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }),
    app.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }),
  ]);
  expect(menuRect.top).toBeGreaterThanOrEqual(appRect.top);
  expect(menuRect.bottom).toBeLessThanOrEqual(appRect.bottom);

  await modelButton.click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Chats' }).click();
  const mobileSidebar = page.locator('.participantsSidebar');
  const backdrop = page.locator('.mobilePanelBackdrop');
  await expect(mobileSidebar).toBeVisible();
  await expect(backdrop).toBeVisible();
  for (const locator of [mobileSidebar, backdrop]) {
    await expect.poll(() => locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: Math.round(rect.top), height: Math.round(rect.height) };
    })).toEqual({ top: 24, height: 430 });
  }
  await backdrop.click({ position: { x: 420, y: 200 } });

  await page.evaluate(() => {
    (window as typeof window & { setTestVisualViewport: (height: number, offsetTop: number) => void })
      .setTestVisualViewport(926, 0);
  });
  await expect.poll(() => app.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), height: Math.round(rect.height) };
  })).toEqual({ top: 0, height: 926 });
  await expect(sendButton).toBeVisible();
});
