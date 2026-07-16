import { test, expect, Page } from '@playwright/test';
import { expectModelPickerSelection, getModelPickerButton, selectModelOption } from './model-picker-helpers';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';
const SCHEDULER_AGENT_ID = 'scheduler';
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

test('records selecting per-agent ACP models and sending selected modelId', async ({ page }) => {
  const sent: any[] = [];
  await page.addInitScript(() => { window.localStorage.setItem('acp_chat_orchestration_mode', 'discussion'); });

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    if (body?.action === 'list-agents') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          agents: [
            {
              id: SCHEDULER_AGENT_ID,
              name: 'Scheduler',
              command: 'mock',
              args: [],
              cwd: '',
              running: true,
              canTalk: true,
              canModify: true,
            },
            {
              id: 'alpha',
              name: 'Alpha Agent',
              command: 'mock',
              args: [],
              cwd: '',
              running: true,
              canTalk: true,
              canModify: true,
              models: [
                { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
                { modelId: 'gpt-5.2', name: 'GPT-5.2' },
              ],
              defaultModelId: 'claude-sonnet-4.6',
            },
            {
              id: 'beta',
              name: 'Beta Agent',
              command: 'mock',
              args: [],
              cwd: '',
              running: true,
              canTalk: true,
              canModify: true,
              models: [
                { modelId: 'gpt-5.4', name: 'GPT-5.4' },
                { modelId: 'claude-opus-4.7', name: 'Claude Opus 4.7' },
              ],
              defaultModelId: 'gpt-5.4',
            },
          ],
        }),
      });
      return;
    }
    if (body?.action === 'send') {
      console.log('ACP send', JSON.stringify({ agentId: body.agentId, text: body.text, modelId: body.modelId }));
      if (body.agentId !== SCHEDULER_AGENT_ID) sent.push(body);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, phase: 'thinking', sessionId: `session-${body.agentId}`, turn: { id: `turn-${body.agentId}` } }),
      });
      return;
    }
    if (body?.action === 'poll') {
      const request = [...sent].reverse().find((item) => item.agentId === body.agentId);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          phase: 'idle',
          ready: true,
          booting: false,
          activeTurn: {
            id: `turn-${body.agentId}`,
            fullText: `reply from ${body.agentId} using ${request?.modelId || 'default-model'}`,
            done: true,
            phase: 'done',
            events: [{ type: 'text_chunk', ts: Date.now(), text: `reply from ${body.agentId} using ${request?.modelId || 'default-model'}` }],
          },
        }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await login(page);
  await ensureActiveChat(page);
  await page.waitForTimeout(700);

  const textarea = page.locator('textarea.composerTextarea');
  await textarea.fill('@alpha compare models for this task');
  await expect(page.locator('[data-testid="agent-model-select"]')).toHaveCount(1);

  const alphaSelect = getModelPickerButton(page, 'alpha');
  await expectModelPickerSelection(page, 'alpha', 'Claude Sonnet 4.6');
  const longModelWidth = await alphaSelect.evaluate((node) => node.getBoundingClientRect().width);

  await selectModelOption(page, 'alpha', 'GPT-5.2');
  await expectModelPickerSelection(page, 'alpha', 'GPT-5.2');
  await expect.poll(async () => alphaSelect.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThan(longModelWidth - 20);
  await page.waitForTimeout(700);

  await page.locator('button[aria-label="Send message"]').click();

  await expect.poll(() => sent.map((item) => `${item.agentId}:${item.modelId}`)).toEqual([
    'alpha:gpt-5.2',
  ]);
  await expect(page.locator('.message.agent')).toContainText('reply from alpha using gpt-5.2', { timeout: 15000 });
  await page.waitForTimeout(1800);
});
