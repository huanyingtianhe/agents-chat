import { test, expect, Page } from '@playwright/test';
import { expectModelOptions, expectModelPickerSelection } from './model-picker-helpers';

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
  await page.locator('button.newChatButton, button.emptyHomepageNewChat').first().click();
  await page.waitForSelector('.chatContainer', { timeout: 10000 });
}

test('composer creates a chat-bound session to populate empty agent models', async ({ page }) => {
  let models: any[] = [];
  let defaultModelId = '';
  const ensureRequests: any[] = [];
  let seenChatId = '';

  const alphaAgent = () => ({
    id: 'alpha',
    name: 'Alpha Agent',
    command: 'mock',
    args: ['--acp'],
    cwd: 'Q:\\repos\\demo',
    yolo: true,
    running: true,
    canTalk: true,
    canModify: true,
    public: true,
    models,
    defaultModelId,
  });

  await page.addInitScript(() => { window.localStorage.setItem('acp_chat_orchestration_mode', 'discussion'); });

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    if (body?.action === 'list-agents') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, agents: [alphaAgent()] }) });
      return;
    }
    if (body?.action === 'ensure-agent-models') {
      ensureRequests.push(body);
      seenChatId = body.chatId;
      models = [
        { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
        { modelId: 'gpt-5.2', name: 'GPT-5.2' },
      ];
      defaultModelId = 'claude-sonnet-4.6';
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, models, defaultModelId, sessionId: 'session-from-model-discovery', cached: false }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await login(page);
  await ensureActiveChat(page);

  const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
  await textarea.fill('@alpha discover models before sending');

  await expect.poll(() => ensureRequests.map((request) => `${request.agentId}:${request.chatId}`)).toEqual([`alpha:${seenChatId}`]);
  expect(seenChatId).toMatch(/^chat-/);

  await expectModelPickerSelection(page, 'alpha', 'Claude Sonnet 4.6');
  await expectModelOptions(page, 'alpha', ['Claude Sonnet 4.6', 'GPT-5.2']);
});
