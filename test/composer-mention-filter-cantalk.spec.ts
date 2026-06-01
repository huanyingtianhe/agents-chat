import { test, expect, Page } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

test.use({
  video: 'on',
  viewport: { width: 1280, height: 900 },
  ignoreHTTPSErrors: true,
});

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.locator('input[placeholder="Admin username"]').fill(ADMIN_USER);
  await page.locator('input[placeholder="Password"]').fill(ADMIN_PASS);
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 30000 });
}

async function ensureActiveChat(page: Page) {
  const isEmpty = await page.locator('.emptyHomepage').isVisible({ timeout: 3000 }).catch(() => false);
  if (isEmpty) {
    await page.locator('button.newChatButton, button.emptyHomepageNewChat').first().click();
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
  }
}

test('composer @-mention dropdown hides agents the user cannot talk to', async ({ page }) => {
  const agents = [
    { id: 'talkable', name: 'Talkable Agent', command: 'mock', args: [], cwd: 'Q:\\repos\\demo', running: true, canTalk: true, canModify: true, public: true },
    { id: 'locked', name: 'Locked Agent', command: 'mock', args: [], cwd: 'Q:\\repos\\demo', running: true, canTalk: false, canModify: false, public: false },
  ];

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    if (body?.action === 'list-agents') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, agents }) });
      return;
    }
    if (body?.action === 'get-model-prefs') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, prefs: {} }) });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await login(page);
  await ensureActiveChat(page);
  await page.waitForTimeout(500);

  const textarea = page.locator('textarea[placeholder^="Message Agents Chat"]');
  await textarea.click();
  await textarea.fill('@');

  const dropdown = page.locator('.mentionDropdown');
  await expect(dropdown).toBeVisible();
  await expect(dropdown.locator('.mentionItem')).toHaveCount(1);
  await expect(dropdown.locator('.mentionId')).toHaveText('@talkable');
  await expect(dropdown).not.toContainText('locked');
});
