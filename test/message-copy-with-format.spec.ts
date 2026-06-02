import { test, expect, Page } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

test.use({
  video: 'on',
  viewport: { width: 1280, height: 900 },
  ignoreHTTPSErrors: true,
  permissions: ['clipboard-read', 'clipboard-write'],
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

test('agent message exposes Copy and Copy-with-format buttons that write expected clipboard payloads', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  const markdownReply = '# Heading\n\nThis is **bold** and a [link](https://example.com).\n\n- item one\n- item two';

  const agent = {
    id: 'alpha',
    name: 'Alpha Agent',
    command: 'mock',
    args: [],
    cwd: 'Q:\\repos\\demo',
    running: true,
    canTalk: true,
    canModify: true,
    public: true,
  };

  const sent: any[] = [];

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    if (body?.action === 'list-agents') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, agents: [agent] }) });
      return;
    }
    if (body?.action === 'get-model-prefs') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, prefs: {} }) });
      return;
    }
    if (body?.action === 'send') {
      sent.push(body);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, phase: 'thinking', sessionId: 'session-alpha', turn: { id: 'turn-alpha' } }) });
      return;
    }
    if (body?.action === 'poll') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          phase: 'idle',
          ready: true,
          booting: false,
          activeTurn: {
            id: 'turn-alpha',
            fullText: markdownReply,
            done: true,
            phase: 'done',
            events: [
              { type: 'thinking', ts: Date.now(), text: 'secret-thought-do-not-copy' },
              { type: 'tool_start', ts: Date.now(), toolCallId: 't1', toolName: 'secret_tool', toolArgs: 'private-args-do-not-copy' },
              { type: 'tool_complete', ts: Date.now(), toolCallId: 't1', toolName: 'secret_tool', toolResult: 'private-result-do-not-copy' },
              { type: 'text_chunk', ts: Date.now(), text: markdownReply },
            ],
          },
        }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await login(page);
  await ensureActiveChat(page);
  await page.waitForTimeout(400);

  const textarea = page.locator('textarea[placeholder^="Message Agents Chat"]');
  await textarea.fill('@alpha please reply with formatting');
  await page.locator('button[aria-label="Send message"]').click();

  const agentMessage = page.locator('.message.agent').last();
  await expect(agentMessage).toContainText('bold', { timeout: 15000 });
  await expect(agentMessage.locator('h1')).toHaveText('Heading');

  // Copy (plain markdown / text)
  const copyButton = agentMessage.getByRole('button', { name: 'Copy answer', exact: true });
  await expect(copyButton).toBeVisible();
  await copyButton.click();
  await expect(copyButton).toHaveText('Copied');
  const plain = await page.evaluate(() => navigator.clipboard.readText());
  expect(plain).toContain('**bold**');
  expect(plain).toContain('[link](https://example.com)');

  // Copy with format (HTML preserved on clipboard)
  const copyFormattedButton = agentMessage.getByRole('button', { name: 'Copy answer with formatting' });
  await expect(copyFormattedButton).toBeVisible();
  await expect(copyFormattedButton).toHaveText('Copy with format');
  await copyFormattedButton.click();
  await expect(copyFormattedButton).toHaveText('Copied');

  const htmlPayload = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes('text/html')) {
        const blob = await item.getType('text/html');
        return await blob.text();
      }
    }
    return '';
  });
  expect(htmlPayload).toContain('<strong>bold</strong>');
  expect(htmlPayload).toContain('<a');
  expect(htmlPayload).toContain('href="https://example.com');
  expect(htmlPayload).toContain('<h1');
  expect(htmlPayload).not.toContain('**bold**');
  // Thinking and tool-call DOM must NOT leak into the formatted copy
  expect(htmlPayload).not.toContain('secret-thought-do-not-copy');
  expect(htmlPayload).not.toContain('private-args-do-not-copy');
  expect(htmlPayload).not.toContain('private-result-do-not-copy');
  expect(htmlPayload).not.toContain('thinkingPart');
  expect(htmlPayload).not.toContain('toolCall');

  const plainFormatted = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes('text/plain')) {
        const blob = await item.getType('text/plain');
        return await blob.text();
      }
    }
    return '';
  });
  expect(plainFormatted).not.toContain('secret-thought-do-not-copy');
  expect(plainFormatted).not.toContain('private-args-do-not-copy');
  expect(plainFormatted).not.toContain('private-result-do-not-copy');

  await page.waitForTimeout(800);
});
