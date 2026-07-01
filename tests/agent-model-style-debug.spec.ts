import { test, expect, Page } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.locator('input[placeholder="Admin username"]').fill('admin');
  await page.locator('input[placeholder="Password"]').fill('admin123');
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

test.use({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });

test('debug model select computed styles', async ({ page }) => {
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    if (body?.action === 'list-agents') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, agents: [
          { id: 'scheduler', name: 'Scheduler', command: 'mock', args: [], cwd: '', running: true, canTalk: true, canModify: true },
          { id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true, canTalk: true, canModify: true, models: [
            { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
            { modelId: 'gpt-5.2', name: 'GPT-5.2' },
          ], defaultModelId: 'claude-sonnet-4.6' },
        ] }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await login(page);
  await ensureActiveChat(page);
  await page.locator('textarea[placeholder="Message Agents Chat"]').fill('@alpha compare models');
  await expect(page.locator('[data-testid="agent-model-select"]')).toHaveCount(1);
  const styles = await page.locator('.modelTargetPill').evaluate((pill) => {
    const select = pill.querySelector('[data-testid="agent-model-select"]') as HTMLSelectElement;
    const pillStyle = getComputedStyle(pill);
    const selectStyle = getComputedStyle(select);
    return {
      pillText: pill.textContent,
      pill: {
        backgroundColor: pillStyle.backgroundColor,
        color: pillStyle.color,
        borderColor: pillStyle.borderColor,
        width: pillStyle.width,
      },
      select: {
        backgroundColor: selectStyle.backgroundColor,
        backgroundImage: selectStyle.backgroundImage,
        color: selectStyle.color,
        borderColor: selectStyle.borderColor,
        width: selectStyle.width,
        maxWidth: selectStyle.maxWidth,
        padding: selectStyle.padding,
        appearance: selectStyle.appearance,
      },
      outerHTML: select.outerHTML,
    };
  });
  console.log('MODEL_STYLE_DEBUG', JSON.stringify(styles, null, 2));
});
