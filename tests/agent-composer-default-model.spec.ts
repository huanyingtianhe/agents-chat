import { test, expect, Page } from '@playwright/test';
import { expectModelPickerSelection, selectModelOption } from './model-picker-helpers';

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

test('composer model picker saves the selected model as a user preference', async ({ page }) => {
  const modelPrefRequests: any[] = [];
  const sent: any[] = [];

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
    models: [
      { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
      { modelId: 'gpt-5.2', name: 'GPT-5.2' },
    ],
    defaultModelId: 'claude-sonnet-4.6',
  });

  await page.addInitScript(() => { window.localStorage.setItem('acp_chat_orchestration_mode', 'discussion'); });

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    if (body?.action === 'list-agents') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, agents: [alphaAgent()] }) });
      return;
    }
    if (body?.action === 'get-agent-config') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, agent: alphaAgent() }) });
      return;
    }
    if (body?.action === 'list-agent-access') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, access: [] }) });
      return;
    }
    if (body?.action === 'get-model-prefs') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, prefs: {} }) });
      return;
    }
    if (body?.action === 'set-model-pref') {
      modelPrefRequests.push(body);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    if (body?.action === 'send') {
      console.log('ACP send after composer model save', JSON.stringify({ agentId: body.agentId, modelId: body.modelId }));
      sent.push(body);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, phase: 'thinking', sessionId: 'session-alpha', turn: { id: 'turn-alpha' } }) });
      return;
    }
    if (body?.action === 'poll') {
      const request = sent.at(-1);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          phase: 'idle',
          ready: true,
          booting: false,
          activeTurn: {
            id: 'turn-alpha',
            fullText: `reply using ${request?.modelId || 'default-model'}`,
            done: true,
            phase: 'done',
            events: [{ type: 'text_chunk', ts: Date.now(), text: `reply using ${request?.modelId || 'default-model'}` }],
          },
        }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await login(page);
  await ensureActiveChat(page);
  await page.waitForTimeout(500);

  const textarea = page.locator('textarea.composerTextarea');
  await textarea.fill('@alpha use composer default model');

  await expectModelPickerSelection(page, 'alpha', 'Claude Sonnet 4.6');
  await selectModelOption(page, 'alpha', 'GPT-5.2');
  await expectModelPickerSelection(page, 'alpha', 'GPT-5.2');

  await expect.poll(() => modelPrefRequests.map((request) => `${request.agentId}:${request.modelId}`)).toEqual(['alpha:gpt-5.2']);

  await page.locator('button[title="Agents"]').click();
  await page.locator('.agentListItem', { hasText: 'Alpha Agent' }).click();
  await expect(page.locator('[data-testid="agent-settings-default-model-select"]')).toHaveCount(0);
  await expect(page.locator('.agentSettingsModal')).not.toContainText('Default Model');
  await expect(page.locator('.agentSettingsModal')).not.toContainText('Models');
  await expect(page.locator('.agentSettingsModal')).not.toContainText('Refresh models');
  await expect(page.locator('.agentSettingsModal')).not.toContainText('Claude Sonnet 4.6');
  await expect(page.locator('.agentSettingsModal')).not.toContainText('GPT-5.2');
  await page.locator('.modalActions button', { hasText: 'Cancel' }).click();

  await page.locator('button[aria-label="Send message"]').click();
  await expect.poll(() => sent.map((request) => `${request.agentId}:${request.modelId}`)).toEqual(['alpha:gpt-5.2']);
  await expect(page.locator('.message.agent')).toContainText('reply using gpt-5.2', { timeout: 15000 });
  await page.waitForTimeout(1200);
});
