import { expect, Page, test } from '@playwright/test';
import {
  installTestVisualViewport,
  setTestVisualViewport,
} from './helpers/visualViewport';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await expect(page.locator('form')).toHaveAttribute('data-hydrated', 'true', { timeout: 30000 });
  await page.locator('input[placeholder="Admin username"]').fill(process.env.ADMIN_USERNAME || 'admin');
  await page.locator('input[placeholder="Password"]').fill(process.env.ADMIN_PASSWORD || 'admin123');
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 30000 });
  await page.waitForTimeout(500);
}

test('keeps composer controls above iPhone browser chrome and keyboard', async ({ page }) => {
  await installTestVisualViewport(page);

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
  let generationActive = false;
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action === 'list-agents') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          agents: ['alpha', 'beta', 'gamma', 'delta'].map((id) => ({
            id,
            name: `${id[0].toUpperCase()}${id.slice(1)} Agent`,
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
          })),
        }),
      });
      return;
    }
    if (body?.action === 'send') {
      generationActive = true;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          sessionId: 'mobile-viewport-session',
          turn: { id: 'mobile-viewport-turn' },
        }),
      });
      return;
    }
    if (body?.action === 'poll' && generationActive) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          activeTurn: {
            id: 'mobile-viewport-turn',
            fullText: '',
            done: false,
            phase: 'thinking',
            statusText: 'Thinking',
            events: [],
          },
        }),
      });
      return;
    }
    if (body?.action === 'interrupt') {
      generationActive = false;
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
  await textarea.fill('@alpha @beta @gamma @delta mobile viewport');

  await setTestVisualViewport(page, 430, 24);

  const app = page.locator('.chatPageRoot .page');
  await expect.poll(() => app.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), height: Math.round(rect.height) };
  })).toEqual({ top: 24, height: 430 });

  const sendButton = page.getByRole('button', { name: 'Send message' });
  const modelButton = page.getByRole('button', { name: 'Model for alpha' });
  const targetPills = page.locator('.targetPills');
  await expect(sendButton).toBeVisible();
  await expect(modelButton).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start voice input' })).toHaveCount(0);
  await expect(targetPills).toHaveCSS('overflow-x', 'auto');
  await expect.poll(() => targetPills.evaluate(
    (element) => element.scrollWidth > element.clientWidth,
  )).toBe(true);
  await expect.poll(() => targetPills.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return element.scrollLeft;
  })).toBeGreaterThan(0);

  for (const locator of [page.locator('.chatInputDock'), sendButton, modelButton]) {
    const [controlBox, appBox] = await Promise.all([locator.boundingBox(), app.boundingBox()]);
    expect(controlBox).not.toBeNull();
    expect(appBox).not.toBeNull();
    expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(appBox!.y + appBox!.height + 1);
  }

  await textarea.fill('@alpha mobile viewport');
  await sendButton.click();
  const stopButton = page.getByRole('button', { name: 'Stop generation' });
  await expect(stopButton).toBeVisible();
  const [stopBox, compressedAppBox] = await Promise.all([stopButton.boundingBox(), app.boundingBox()]);
  expect(stopBox).not.toBeNull();
  expect(compressedAppBox).not.toBeNull();
  expect(stopBox!.x + stopBox!.width).toBeLessThanOrEqual(compressedAppBox!.x + compressedAppBox!.width + 1);
  expect(stopBox!.y + stopBox!.height).toBeLessThanOrEqual(compressedAppBox!.y + compressedAppBox!.height + 1);
  await stopButton.click();
  await expect(sendButton).toBeVisible();

  await modelButton.click();
  const modelMenu = page.getByRole('listbox', { name: 'Model for alpha' });
  await expect(modelMenu).toBeVisible();
  await expect.poll(async () => {
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
    return menuRect.top >= appRect.top && menuRect.bottom <= appRect.bottom;
  }).toBe(true);

  await modelButton.click();
  await page.getByRole('button', { name: 'Open navigation' }).click();
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
  const backdropBox = await backdrop.boundingBox();
  expect(backdropBox).not.toBeNull();
  await backdrop.click({ position: { x: backdropBox!.width - 4, y: 200 } });

  await setTestVisualViewport(page, 926, 0);
  await expect.poll(() => app.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), height: Math.round(rect.height) };
  })).toEqual({ top: 0, height: 926 });
  await expect(sendButton).toBeVisible();
});
