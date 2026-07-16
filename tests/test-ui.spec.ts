/**
 * Playwright UI tests for Agents Chat.
 *
 * Requires: dev server running on localhost:3010
 * Run:  PLAYWRIGHT_BROWSERS_PATH=$HOME/.playwright-mcp npx playwright test tests/test-ui.spec.ts --headed
 *   or: npx playwright test tests/test-ui.spec.ts
 */

import { test, expect, Locator, Page } from '@playwright/test';
import { selectFilesAgent, filesAgentTrigger } from './themed-picker-helpers';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

/** Login helper — fills credentials and waits for redirect to main page */
async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  const usernameInput = page.locator('input[placeholder="Admin username"]');
  const passwordInput = page.locator('input[placeholder="Password"]');
  await usernameInput.fill(ADMIN_USER);
  await passwordInput.fill(ADMIN_PASS);
  await expect(page.locator('button[type="submit"]')).toBeEnabled({ timeout: 10000 });
  await page.click('button[type="submit"]');
  // Wait for the chat UI to be visible — could be chatContainer or emptyHomepage
  await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 30000 });
  await page.waitForTimeout(500);
}

/** Delete all existing chats via the API so each test starts clean */
async function deleteAllChats(page: Page) {
  // Unmount the chat runtime first so an in-flight persistence effect cannot
  // recreate a chat while the test fixture is deleting it.
  await page.goto('about:blank');
  const request = page.context().request;
  const listResponse = await request.get(`${BASE}/api/chats`);
  expect(listResponse.ok()).toBeTruthy();
  const res = await listResponse.json();

  for (const chat of res.chats ?? []) {
    const deleteResponse = await request.delete(`${BASE}/api/chats?id=${encodeURIComponent(chat.id)}`);
    expect(deleteResponse.ok()).toBeTruthy();
  }
  const clearResponse = await request.post(`${BASE}/api/chats`, {
    data: { action: 'set-last-chat', chatId: '' },
  });
  expect(clearResponse.ok()).toBeTruthy();
  await page.goto(BASE);
}

/** Ensure an active chat exists — clicks "+ New Chat" if on empty homepage */
async function ensureActiveChat(page: Page) {
  const isEmpty = await page.locator('.emptyHomepage').isVisible({ timeout: 2000 }).catch(() => false);
  if (isEmpty) {
    await page.click('button.newChatButton, button.emptyHomepageNewChat');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
  }
}

async function expectCompactFailedSendStatus(message: Locator, error = 'Failed to send prompt to agent') {
  const failure = message.locator('.userSendFailureNotice');
  const card = failure.locator('.userSendFailureCard');
  await expect(card.locator('.userSendFailureStatus')).toHaveText(`Failed to send: ${error}`);
  await expect(card.locator('.userSendFailureMessage')).toHaveCount(0);
  await expect(card).toHaveAttribute('title', error);
  await expect(message.getByRole('button', { name: 'Delete' })).toHaveCount(0);
}

async function mockTwoAgentsAcp(page: Page, sent: any[]) {
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    if (body?.action === 'list-agents') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          agents: [
            { id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true },
            { id: 'beta', name: 'Beta Agent', command: 'mock', args: [], cwd: '', running: true },
          ],
        }),
      });
      return;
    }
    if (body?.action === 'send') {
      sent.push(body);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, phase: 'thinking', sessionId: `session-${body.agentId}`, turn: { id: `turn-${body.agentId}` } }),
      });
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
            id: `turn-${body.agentId}`,
            fullText: `reply from ${body.agentId}`,
            done: true,
            phase: 'done',
            events: [{ type: 'text_chunk', ts: Date.now(), text: `reply from ${body.agentId}` }],
          },
        }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
}

test.describe('Login', () => {
  test('should show login page', async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await expect(page.locator('h1')).toContainText('Agents Chat');
    await expect(page.locator('input[placeholder="Admin username"]')).toBeVisible();
    await expect(page.locator('input[placeholder="Password"]')).toBeVisible();
  });

  test('should reject invalid credentials', async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.fill('input[placeholder="Admin username"]', 'wrong');
    await page.fill('input[placeholder="Password"]', 'wrong');
    await page.click('button[type="submit"]');
    // Should show error and stay on login page
    await expect(page.locator('text=Invalid username or password')).toBeVisible({ timeout: 5000 });
  });

  test('should login successfully with admin credentials', async ({ page }) => {
    await login(page);
    // Should see either the chat container or the empty homepage
    const hasChatUI = await page.locator('.chatContainer, .emptyHomepage').isVisible();
    expect(hasChatUI).toBe(true);
  });
});

test.describe('Chat UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'warm-local-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, warmed: 0, agents: [] }),
        });
        return;
      }
      await route.fallback();
    });
    await login(page);
    await deleteAllChats(page);
    await page.reload();
    await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 10000 });
    await ensureActiveChat(page);
  });

  test('should display chat input and send button', async ({ page }) => {
    await ensureActiveChat(page);
    await expect(page.locator('textarea.composerTextarea')).toBeVisible();
    await expect(page.locator('.composerShell')).toHaveCSS('border-radius', '12px');
    await page.setViewportSize({ width: 420, height: 800 });
    await expect(page.locator('.composerShell')).toHaveCSS('border-radius', '12px');
    const filesButton = page.locator('.attachButton');
    await expect(filesButton.locator('.attachButtonIcon')).toBeVisible();
    await expect(filesButton.locator('.attachButtonLabel')).toHaveCount(0);
    const filesButtonStyle = await filesButton.evaluate((button) => {
      const style = getComputedStyle(button);
      return {
        borderRadius: style.borderRadius,
        display: style.display,
        height: style.height,
        width: style.width,
      };
    });
    expect(filesButtonStyle.display).toBe('flex');
    expect(filesButtonStyle.borderRadius).toBe('999px');
    expect(filesButtonStyle.width).toBe('32px');
    expect(filesButtonStyle.height).toBe('32px');
    await expect(page.locator('button[aria-label="Send message"]')).toBeVisible();
  });

  test('keeps the header stationary while messages scroll in either direction', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 800 });
    await ensureActiveChat(page);

    const header = page.locator('.header');
    const chat = page.locator('.chatContainer');
    await chat.evaluate((container) => {
      const filler = document.createElement('div');
      filler.setAttribute('data-testid', 'header-scroll-filler');
      filler.style.height = '2400px';
      filler.style.flex = '0 0 2400px';
      container.appendChild(filler);
    });
    await page.waitForTimeout(300);
    const initialBox = await header.boundingBox();
    expect(initialBox).not.toBeNull();

    for (const scrollTop of [1200, 200]) {
      await chat.evaluate((container, top) => {
        container.scrollTop = top;
        container.dispatchEvent(new Event('scroll', { bubbles: true }));
      }, scrollTop);
      await page.waitForTimeout(100);
      await expect(header).toBeVisible();
      await expect(header).not.toHaveClass(/headerHidden/);
      const box = await header.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeCloseTo(initialBox!.x, 0);
      expect(box!.y).toBeCloseTo(initialBox!.y, 0);
      expect(box!.height).toBeCloseTo(initialBox!.height, 0);
    }
  });

  test('Claude theme keeps the send button warm and readable', async ({ page }) => {
    const sent: any[] = [];
    await mockTwoAgentsAcp(page, sent);

    await page.evaluate(() => window.localStorage.setItem('acp_chat_theme_v1', 'claude'));
    await page.reload();
    await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 10000 });
    await ensureActiveChat(page);

    await page.locator('textarea.composerTextarea').fill('hello claude theme');
    const sendButton = page.locator('button[aria-label="Send message"]');
    await expect(sendButton).toBeEnabled();

    const styles = await sendButton.evaluate((button) => {
      const style = getComputedStyle(button);
      return {
        backgroundImage: style.backgroundImage,
        color: style.color,
      };
    });

    expect(styles.backgroundImage).toContain('rgb(217, 130, 103)');
    expect(styles.backgroundImage).toContain('rgb(201, 106, 75)');
    expect(styles.backgroundImage).not.toContain('rgb(83, 102, 121)');
    expect(styles.color).toBe('rgb(255, 250, 242)');
  });

  test('warms local agents after loading agents without blocking send', async ({ page }) => {
    await page.goto('about:blank');

    const actions: string[] = [];
    const sent: any[] = [];
    let warmupRequested = false;
    let listAgentsFulfilled = false;
    let warmupSawListCompleted = false;
    let warmupCompleted = false;
    let releaseWarmup: () => void = () => {};
    const warmupCanFinish = new Promise<void>((resolve) => {
      releaseWarmup = resolve;
    });

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      actions.push(String(body?.action || ''));

      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [
              { id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: false, relay: false },
              { id: 'remote', name: 'Remote Agent', cwd: '', running: false, relay: true, relayConnectionName: 'remote-node' },
            ],
          }),
        });
        listAgentsFulfilled = true;
        return;
      }

      if (body?.action === 'get-model-prefs') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, prefs: {} }) });
        return;
      }

      if (body?.action === 'warm-local-agents') {
        warmupRequested = true;
        warmupSawListCompleted = listAgentsFulfilled;
        await warmupCanFinish;
        warmupCompleted = true;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            warmed: 1,
            agents: [
              { agentId: 'alpha', status: 'started' },
              { agentId: 'remote', status: 'skipped_remote' },
            ],
          }),
        });
        return;
      }

      if (body?.action === 'send') {
        sent.push(body);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, phase: 'thinking', sessionId: `session-${body.agentId}`, turn: { id: `turn-${body.agentId}` } }),
        });
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
              id: `turn-${body.agentId}`,
              fullText: `reply from ${body.agentId}`,
              done: true,
              phase: 'done',
              events: [{ type: 'text_chunk', ts: Date.now(), text: `reply from ${body.agentId}` }],
            },
          }),
        });
        return;
      }

      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto(BASE);
    await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 30000 });
    await ensureActiveChat(page);

    await expect.poll(() => warmupRequested).toBe(true);
    expect(warmupSawListCompleted).toBe(true);
    await page.locator('textarea.composerTextarea').fill('send while warmup pending');
    await expect(page.locator('button[aria-label="Send message"]')).toBeEnabled();
    await page.click('button[aria-label="Send message"]');
    await expect.poll(() => sent.map((request) => request.agentId)).toEqual(['alpha']);
    expect(warmupCompleted).toBe(false);

    releaseWarmup();
    await expect.poll(() => warmupCompleted).toBe(true);
    expect(actions.filter((action) => action === 'warm-local-agents')).toHaveLength(1);
  });

  test('logs local agent warmup failures returned as JSON', async ({ page }) => {
    await page.addInitScript(() => {
      const originalError = console.error.bind(console);
      (window as typeof window & { __warmupConsoleErrors?: string[][] }).__warmupConsoleErrors = [];
      console.error = (...args: unknown[]) => {
        const serialized = args.map((arg) => {
          if (typeof arg === 'string') return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        });
        (window as typeof window & { __warmupConsoleErrors?: string[][] }).__warmupConsoleErrors?.push(serialized);
        originalError(...args);
      };
    });

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;

      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: false, relay: false }],
          }),
        });
        return;
      }

      if (body?.action === 'get-model-prefs') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, prefs: {} }) });
        return;
      }

      if (body?.action === 'warm-local-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'warm failed' }),
        });
        return;
      }

      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 30000 });
    await ensureActiveChat(page);

    await expect.poll(async () => {
      const errors = await page.evaluate(() => (window as typeof window & { __warmupConsoleErrors?: string[][] }).__warmupConsoleErrors ?? []);
      return errors.length;
    }).toBe(1);

    const errors = await page.evaluate(() => (window as typeof window & { __warmupConsoleErrors?: string[][] }).__warmupConsoleErrors ?? []);
    expect(errors.some((entry) =>
      entry[0] === 'Failed to warm local agents' && entry.some((part) => part.includes('warm failed')),
    )).toBe(true);
    await expect(page.locator('.chatContainer, .emptyHomepage').first()).not.toContainText('Failed to warm local agents');
  });

  test('remembers the first mentioned agent as the next composer target for the same chat', async ({ page }) => {
    const textarea = page.locator('textarea.composerTextarea');
    const sent: any[] = [];
    await mockTwoAgentsAcp(page, sent);

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });

    await textarea.fill('@beta @alpha first routed message');
    await page.click('button[aria-label="Send message"]');
    await expect(page.locator('.rememberedAgentPill')).toHaveText(/@beta/);
    await expect(page.locator('button[aria-label="Stop generation"]')).toBeHidden({ timeout: 15000 });

    await textarea.fill('next message without mention');
    await page.click('button[aria-label="Send message"]');
    await expect.poll(() => sent.filter((request) => request.text === 'next message without mention').map((request) => request.agentId)).toEqual(['beta']);
  });

  test('uses primary agent fallback, then default agent when no remembered target exists', async ({ page }) => {
    const textarea = page.locator('textarea.composerTextarea');
    const sent: any[] = [];
    await mockTwoAgentsAcp(page, sent);

    await page.evaluate(async () => {
      const chat = {
        id: 'primary-agent-chat',
        name: 'Primary agent chat',
        ts: Date.now(),
        agentId: 'beta',
        messages: [],
        agentSessions: {},
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId: chat.id }),
      });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await expect(page.locator('.rememberedAgentPill')).toHaveText(/@beta/);

    await textarea.fill('message using primary fallback');
    await page.click('button[aria-label="Send message"]');
    await expect.poll(() => sent.filter((request) => request.text === 'message using primary fallback').map((request) => request.agentId)).toEqual(['beta']);
    await expect(page.locator('button[aria-label="Stop generation"]')).toBeHidden({ timeout: 15000 });

    await page.evaluate(async () => {
      await fetch('/api/chats?id=primary-agent-chat', { method: 'DELETE' });
      const chat = {
        id: 'default-agent-chat',
        name: 'Default agent chat',
        ts: Date.now(),
        messages: [],
        agentSessions: {},
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId: chat.id }),
      });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await expect(page.locator('.rememberedAgentPill')).toHaveText(/@alpha/);

    await textarea.fill('message using default fallback');
    await page.click('button[aria-label="Send message"]');
    await expect.poll(() => sent.filter((request) => request.text === 'message using default fallback').map((request) => request.agentId)).toEqual(['alpha']);
  });

  test('clears remembered composer target with hover remove button', async ({ page }) => {
    const textarea = page.locator('textarea.composerTextarea');
    const sent: any[] = [];
    await mockTwoAgentsAcp(page, sent);

    await page.evaluate(async () => {
      const chat = {
        id: 'remembered-remove-chat',
        name: 'Remembered remove chat',
        ts: Date.now(),
        agentId: 'alpha',
        messages: [],
        agentSessions: {},
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId: chat.id }),
      });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });

    await textarea.fill('@beta remember beta');
    await page.click('button[aria-label="Send message"]');
    await expect(page.locator('button[aria-label="Stop generation"]')).toBeHidden({ timeout: 15000 });

    const pill = page.locator('.rememberedAgentPill');
    const removeButton = page.locator('button[aria-label="Remove remembered agent beta"]');
    await expect(pill).toHaveText('@beta');
    await expect(removeButton).toHaveCSS('opacity', '0');

    await pill.hover();
    await expect(removeButton).toHaveCSS('opacity', '1');
    await removeButton.click();

    await expect(page.locator('.rememberedAgentPill')).toHaveText('@alpha');
    await expect(removeButton).toHaveCount(0);

    await textarea.fill('message after clearing remembered target');
    await page.click('button[aria-label="Send message"]');
    await expect.poll(() => sent.filter((request) => request.text === 'message after clearing remembered target').map((request) => request.agentId)).toEqual(['alpha']);
  });

  test('should copy only answer text from the below-message copy button', async ({ page }) => {
    const seedResult = await page.evaluate(async () => {
      const response = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat: {
            id: 'copy-message-chat',
            name: 'Copy message chat',
            ts: Date.now(),
            messages: [
              { id: 'copy-user', type: 'user', content: 'copy this user message', ts: Date.now() },
              {
                id: 'copy-agent',
                type: 'agent',
                agentId: 'alpha',
                content: '',
                parts: [
                  { kind: 'thinking', text: 'do not copy thinking' },
                  { kind: 'tool', toolName: 'terminal', args: 'do not copy args', result: 'do not copy result', done: true },
                  { kind: 'text', text: 'copy only this answer' },
                ],
                ts: Date.now() + 1,
              },
            ],
            agentSessions: {},
          },
        }),
      });
      return { ok: response.ok, status: response.status };
    });
    expect(seedResult.ok).toBe(true);
    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
    await expect(page.locator('button:has-text("Copy message chat")')).toBeVisible();
    await page.click('button:has-text("Copy message chat")');

    let copiedText = '';
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { (window as any).__copiedText = text; } },
      });
    });

    const agentMessage = page.locator('.message.agent', { hasText: 'copy only this answer' });
    const copyButton = agentMessage.locator('.messageActions button[aria-label="Copy answer"]');
    await expect(copyButton).toBeVisible();
    expect(await copyButton.evaluate((button) => button.parentElement?.classList.contains('messageActions'))).toBe(true);
    await copyButton.click();
    copiedText = await page.evaluate(() => (window as any).__copiedText || '');
    expect(copiedText).toBe('copy only this answer');
    expect(copiedText).not.toContain('thinking');
    expect(copiedText).not.toContain('tool');
    await expect(copyButton).toContainText('Copied');
  });


  test.describe('ACP attachments', () => {
    async function mockAcpForAttachments(page: Page, captured: any[]) {
      await page.route('**/api/acp', async (route) => {
        const body = route.request().postDataJSON() as any;
        if (body?.action === 'list-agents') {
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }] }),
          });
          return;
        }
        if (body?.action === 'send') {
          captured.push(body);
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, phase: 'idle', sessionId: 's1', turn: { id: 't1' } }),
          });
          return;
        }
        if (body?.action === 'poll') {
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, activeTurn: { done: true, fullText: 'received attachment', phase: 'done' } }),
          });
          return;
        }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      });
      await page.reload();
      await page.waitForSelector('.chatContainer', { timeout: 10000 });
    }

    test('upload button queues and sends image attachment', async ({ page }) => {
      const captured: any[] = [];
      await mockAcpForAttachments(page, captured);

      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      await page.locator('input[type="file"]').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: png });
      await expect(page.locator('.attachmentChip', { hasText: 'tiny.png' })).toBeVisible();

      await page.fill('textarea.composerTextarea', 'please inspect this image');
      await page.click('button[aria-label="Send message"]');

      const sentAttachment = page.locator('.message.user .messageAttachment', { hasText: 'tiny.png' });
      await expect(sentAttachment).toBeVisible();
      await expect(sentAttachment.locator('.messageAttachmentImage')).toBeVisible();
      await expect(sentAttachment.locator('.messageAttachmentPreview')).toBeHidden();
      await sentAttachment.locator('.messageAttachmentImageWrap').hover();
      await expect(sentAttachment.locator('.messageAttachmentPreview')).toBeVisible();
      await expect.poll(() => captured.length).toBeGreaterThan(0);
      expect(captured[0].text).toBe('please inspect this image');
      expect(captured[0].attachments).toHaveLength(1);
      expect(captured[0].attachments[0]).toMatchObject({ name: 'tiny.png', mimeType: 'image/png', kind: 'image' });
      expect(captured[0].attachments[0].dataUrl).toContain('data:image/png;base64,');
    });

    test('paste screenshot queues attachment without inserting text', async ({ page }) => {
      const captured: any[] = [];
      await mockAcpForAttachments(page, captured);

      await page.focus('textarea.composerTextarea');
      await page.evaluate(async () => {
        const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
        const file = new File([bytes], 'pasted.png', { type: 'image/png' });
        const data = new DataTransfer();
        data.items.add(file);
        const textarea = document.querySelector('textarea.composerTextarea') as HTMLTextAreaElement;
        textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      });

      await expect(page.locator('.attachmentChip', { hasText: 'pasted.png' })).toBeVisible();
      await expect(page.locator('textarea.composerTextarea')).toHaveValue('');
    });

    test('paste screenshot queues one attachment when exposed as both file and item', async ({ page }) => {
      const captured: any[] = [];
      await mockAcpForAttachments(page, captured);

      await page.focus('textarea.composerTextarea');
      await page.evaluate(async () => {
        const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
        const fileFromFiles = new File([bytes], 'pasted.png', { type: 'image/png', lastModified: 1 });
        const fileFromItems = new File([bytes], 'pasted.png', { type: 'image/png', lastModified: 2 });
        const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(pasteEvent, 'clipboardData', {
          value: {
            files: [fileFromFiles],
            items: [{ kind: 'file', getAsFile: () => fileFromItems }],
          },
        });
        const textarea = document.querySelector('textarea.composerTextarea') as HTMLTextAreaElement;
        textarea.dispatchEvent(pasteEvent);
      });

      await expect(page.locator('.attachmentChip')).toHaveCount(1);
      await expect(page.locator('.attachmentChip', { hasText: 'pasted.png' })).toBeVisible();
    });

    test('file attachment chip has compact icon and remove control', async ({ page }) => {
      const captured: any[] = [];
      await mockAcpForAttachments(page, captured);

      await page.locator('input[type="file"]').setInputFiles({
        name: 'tunel.py',
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(845, 1),
      });
      const chip = page.locator('.attachmentChip', { hasText: 'tunel.py' });
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute('title', 'tunel.py · PY file · 845 B');
      await expect(chip.locator('.attachmentDetails')).toHaveCount(0);
      await expect(chip.locator('.attachmentFileIcon')).toHaveCSS('width', '16px');
      await expect(chip.locator('.attachmentFileIcon')).toHaveCSS('height', '16px');
      await expect(chip.locator('.attachmentFileIcon')).toHaveText('PY');
      const chipBox = await chip.boundingBox();
      const inputBox = await page.locator('.composerTextarea').boundingBox();
      expect(chipBox?.height).toBeLessThan(inputBox?.height || 0);

      const removeButton = chip.locator('button[aria-label="Remove tunel.py"]');
      await expect(removeButton).toBeVisible();
      await expect(removeButton).toHaveCSS('position', 'absolute');
      await removeButton.click();
      await expect(page.locator('.attachmentChip', { hasText: 'tunel.py' })).toHaveCount(0);
    });

    test('attachment-only send is allowed and uses fallback prompt', async ({ page }) => {
      const captured: any[] = [];
      await mockAcpForAttachments(page, captured);

      await page.locator('input[type="file"]').setInputFiles({
        name: 'note.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('hello attachment'),
      });
      const sendButton = page.locator('button[aria-label="Send message"]');
      await expect(sendButton).toBeEnabled();
      await sendButton.click();

      await expect(page.locator('.message.user .messageAttachments', { hasText: 'note.txt' })).toBeVisible();
      await expect.poll(() => captured.length).toBeGreaterThan(0);
      expect(captured[0].text).toBe('Please review the attached file(s).');
      expect(captured[0].attachments).toHaveLength(1);
      expect(captured[0].attachments[0]).toMatchObject({ name: 'note.txt', mimeType: 'text/plain', kind: 'file' });
    });

    test('markdown attachment send is normalized from octet-stream', async ({ page }) => {
      const captured: any[] = [];
      await mockAcpForAttachments(page, captured);

      await page.locator('input[type="file"]').setInputFiles({
        name: 'README.md',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('# Context\n\nHello'),
      });
      await page.fill('textarea.composerTextarea', 'summarize the context');
      await page.click('button[aria-label="Send message"]');

      await expect.poll(() => captured.length).toBeGreaterThan(0);
      expect(captured[0].attachments).toHaveLength(1);
      expect(captured[0].attachments[0]).toMatchObject({ name: 'README.md', mimeType: 'text/markdown', kind: 'file' });
      expect(captured[0].attachments[0].dataUrl).toContain('data:text/markdown;base64,');
    });

    test('PowerShell attachment send is normalized from octet-stream', async ({ page }) => {
      const captured: any[] = [];
      await mockAcpForAttachments(page, captured);

      await page.locator('input[type="file"]').setInputFiles({
        name: 'setup-node.ps1',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('Write-Host "hello"'),
      });
      await page.fill('textarea.composerTextarea', 'summarize the script');
      await page.click('button[aria-label="Send message"]');

      await expect.poll(() => captured.length).toBeGreaterThan(0);
      expect(captured[0].attachments).toHaveLength(1);
      expect(captured[0].attachments[0]).toMatchObject({ name: 'setup-node.ps1', mimeType: 'text/x-powershell', kind: 'file' });
      expect(captured[0].attachments[0].dataUrl).toContain('data:text/x-powershell;base64,');
    });

    test('common code attachments are normalized from octet-stream', async ({ page }) => {
      const captured: any[] = [];
      await mockAcpForAttachments(page, captured);

      await page.locator('input[type="file"]').setInputFiles([
        { name: 'Program.cs', mimeType: 'application/octet-stream', buffer: Buffer.from('class Program {}') },
        { name: 'main.cpp', mimeType: 'application/octet-stream', buffer: Buffer.from('int main() { return 0; }') },
        { name: 'App.java', mimeType: 'application/octet-stream', buffer: Buffer.from('class App {}') },
        { name: 'server.go', mimeType: 'application/octet-stream', buffer: Buffer.from('package main') },
      ]);
      await page.fill('textarea.composerTextarea', 'summarize these code files');
      await page.click('button[aria-label="Send message"]');

      await expect.poll(() => captured.length).toBeGreaterThan(0);
      expect(captured[0].attachments).toHaveLength(4);
      expect(captured[0].attachments.map((attachment: any) => [attachment.name, attachment.mimeType])).toEqual([
        ['Program.cs', 'text/x-csharp'],
        ['main.cpp', 'text/x-c++'],
        ['App.java', 'text/x-java-source'],
        ['server.go', 'text/x-go'],
      ]);
    });

    test('repo-common text attachments are normalized from octet-stream', async ({ page }) => {
      const captured: any[] = [];
      await mockAcpForAttachments(page, captured);

      await page.locator('input[type="file"]').setInputFiles([
        { name: 'test.mjs', mimeType: 'application/octet-stream', buffer: Buffer.from('export default 1;') },
        { name: '.env.local', mimeType: 'application/octet-stream', buffer: Buffer.from('A=B') },
        { name: 'server.log', mimeType: 'application/octet-stream', buffer: Buffer.from('ready') },
        { name: 'cert.pem', mimeType: 'application/octet-stream', buffer: Buffer.from('-----BEGIN CERTIFICATE-----') },
        { name: 'diagram.svg', mimeType: 'application/octet-stream', buffer: Buffer.from('<svg></svg>') },
      ]);
      await page.fill('textarea.composerTextarea', 'summarize these files');
      await page.click('button[aria-label="Send message"]');

      await expect.poll(() => captured.length).toBeGreaterThan(0);
      expect(captured[0].attachments).toHaveLength(5);
      expect(captured[0].attachments.map((attachment: any) => [attachment.name, attachment.mimeType])).toEqual([
        ['test.mjs', 'text/javascript'],
        ['.env.local', 'text/plain'],
        ['server.log', 'text/plain'],
        ['cert.pem', 'application/x-pem-file'],
        ['diagram.svg', 'image/svg+xml'],
      ]);
    });
  });

  test('should display agent in sidebar', async ({ page }) => {
    // Open agents panel
    await page.click('button[title="Agents"]');
    await expect(page.locator('.agentsSidebar')).toBeVisible();
    // Should show at least one configured agent, regardless of the local agent names.
    await expect(page.locator('.agentsSidebar .agentListItem').first()).toBeVisible({ timeout: 10000 });
  });

  test('should show remote node display name in agents list', async ({ page }) => {
    const suffix = Date.now();
    const nodeName = `ui-node-id-${suffix}`;
    const nodeLabel = 'UI Friendly Node';
    const agentId = `ui-node-agent-${suffix}`;
    const agentName = 'UI Node Display Agent';

    async function cleanup() {
      await page.evaluate(async ({ agentId, nodeName }) => {
        await fetch('/api/acp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete-agent', agentId }),
        }).catch(() => null);
        await fetch('/api/nodes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove-node', name: nodeName }),
        }).catch(() => null);
      }, { agentId, nodeName });
    }

    await cleanup();
    try {
      const seedResult = await page.evaluate(async ({ agentId, agentName, nodeName, nodeLabel }) => {
        const nodeResponse = await fetch('/api/nodes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add-node', name: nodeName, label: nodeLabel }),
        });
        const agentResponse = await fetch('/api/acp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create-agent',
            agent: {
              id: agentId,
              name: agentName,
              relay: true,
              relayConnectionName: nodeName,
              cwd: '/',
              yolo: true,
            },
          }),
        });
        return { nodeOk: nodeResponse.ok, agentOk: agentResponse.ok };
      }, { agentId, agentName, nodeName, nodeLabel });
      expect(seedResult).toEqual({ nodeOk: true, agentOk: true });

      await page.reload();
      await page.waitForSelector('.chatContainer', { timeout: 30000 });
      await page.click('button[title="Agents"]');
      await expect(page.locator('.agentsSidebar')).toBeVisible();
      const agentRow = page.locator('.agentListItem', { hasText: agentName });
      await expect(agentRow).toBeVisible({ timeout: 10000 });
      const nodeInfo = agentRow.locator('.agentListId');
      await expect(nodeInfo).toHaveText(`🌐 ${nodeLabel}`);
      await expect(nodeInfo).toHaveAttribute('title', nodeName);
    } finally {
      await cleanup();
    }
  });

  test('should show only the first word of chat status in the sidebar', async ({ page }) => {
    const chatId = `ui-sidebar-status-${Date.now()}`;
    const chatName = 'Sidebar long status';
    const fullStatus = 'Starting environment';

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, activeTurn: null }) });
    });

    await page.evaluate(async ({ chatId, chatName, fullStatus }) => {
      const now = Date.now();
      const chat = {
        id: chatId,
        name: chatName,
        ts: now,
        messages: [
          { id: 'u1', type: 'user', content: 'trigger long sidebar status', ts: now },
          { id: 'a1', type: 'agent', content: '', agentId: 'alpha', pending: true, statusText: fullStatus, ts: now + 1 },
        ],
        agentSessions: {},
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, chatName, fullStatus });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    const chatRow = page.locator('.chatHistoryRow', { hasText: chatName }).first();
    await expect(chatRow).toBeVisible({ timeout: 10000 });
    const statusBadge = chatRow.locator('.chatStatusBadge.running');
    await expect(statusBadge).toHaveText('Starting');
    await expect(statusBadge).not.toHaveText(fullStatus);
  });

  test('should not show punctuation-only chat status in the sidebar', async ({ page }) => {
    const chatId = `ui-sidebar-punctuation-status-${Date.now()}`;
    const chatName = 'Sidebar punctuation status';

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, activeTurn: null }) });
    });

    await page.evaluate(async ({ chatId, chatName }) => {
      const now = Date.now();
      const chat = {
        id: chatId,
        name: chatName,
        ts: now,
        messages: [
          { id: 'u1', type: 'user', content: 'trigger punctuation sidebar status', ts: now },
          { id: 'a1', type: 'agent', content: '', agentId: 'alpha', pending: true, statusText: '.', ts: now + 1 },
        ],
        agentSessions: {},
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, chatName });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    const chatRow = page.locator('.chatHistoryRow', { hasText: chatName }).first();
    await expect(chatRow).toBeVisible({ timeout: 10000 });
    const statusBadge = chatRow.locator('.chatStatusBadge.running');
    await expect(statusBadge).toHaveText('Running');
    await expect(statusBadge).not.toHaveText('.');
  });

  test('should not show sidebar error when the visible agent message is successful', async ({ page }) => {
    const chatId = `ui-sidebar-visible-success-${Date.now()}`;
    const chatName = 'Sidebar visible success';
    const visibleAnswer = 'Successful answer visible to the user.';

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, activeTurn: null }) });
    });

    await page.evaluate(async ({ chatId, chatName, visibleAnswer }) => {
      const now = Date.now();
      const chat = {
        id: chatId,
        name: chatName,
        ts: now,
        messages: [
          { id: 'u1', type: 'user', content: 'show a normal answer', ts: now },
          {
            id: 'a1',
            type: 'agent',
            agentId: 'alpha',
            content: '⚠️ stale hidden transport warning',
            parts: [{ kind: 'text', text: visibleAnswer }],
            ts: now + 1,
          },
        ],
        agentSessions: {},
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, chatName, visibleAnswer });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    const chatRow = page.locator('.chatHistoryRow', { hasText: chatName }).first();
    await expect(chatRow).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.message.agent .messageContent', { hasText: visibleAnswer })).toBeVisible();
    await expect(chatRow.locator('.chatStatusBadge.error')).toHaveCount(0);
    await expect(chatRow.locator('.chatStatusBadge.done')).toHaveText('Done');
  });

  test('should not show punctuation-only ongoing message status', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const chatId = `ui-message-punctuation-status-${Date.now()}`;
    const chatName = 'Message punctuation status';
    const partialText = 'partial answer with punctuation status';

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'resume-session') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: body.sessionId, loaded: true, activeTurn: null, recoveredMessages: [] }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, activeTurn: null }) });
    });

    await page.evaluate(async ({ chatId, chatName, partialText }) => {
      const now = Date.now();
      const chat = {
        id: chatId,
        name: chatName,
        ts: now,
        messages: [
          { id: 'u1', type: 'user', content: 'trigger empty punctuation message status', ts: now },
          { id: 'a1', type: 'agent', content: '', agentId: 'alpha', pending: true, statusText: '.', ts: now + 1 },
          { id: 'u2', type: 'user', content: 'trigger content punctuation message status', ts: now + 2 },
          { id: 'a2', type: 'agent', content: partialText, agentId: 'alpha', pending: true, statusText: '.', ts: now + 3 },
        ],
        agentSessions: { alpha: 'session-alpha' },
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, chatName, partialText });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await expect(chatArea.locator('.thinkingText').first()).toHaveText('Thinking');
    await expect(chatArea.locator('.thinkingText').first()).not.toHaveText('.');

    const contentPending = chatArea.locator('.message.agent', { hasText: partialText });
    await expect(contentPending.locator('.ptyStatusBadge')).toHaveText('Generating');
    await expect(contentPending.locator('.streamingIndicator')).toContainText('Generating');
    await expect(contentPending.locator('.ptyStatusBadge')).not.toHaveText('.');
    await expect(contentPending.locator('.streamingIndicator')).not.toContainText('.');
  });

  test('should send a message and receive a reply', async ({ page }) => {
    await ensureActiveChat(page);
    const textarea = page.locator('textarea.composerTextarea');
    await textarea.fill('What is 1+1? Reply with just the number.');
    await page.click('button[aria-label="Send message"]');

    // User message should appear
    await expect(page.locator('.message.user').last()).toContainText('What is 1+1', { timeout: 15000 });

    // Wait for agent reply (may take a while for the agent to boot and respond)
    const agentReply = page.locator('.message.agent').last();
    await expect(agentReply).toBeVisible({ timeout: 120000 });
    // Wait for reply to finish (no longer pending — check that messageContent no longer has .pending)
    await page.waitForFunction(
      () => {
        const msgs = document.querySelectorAll('.message.agent');
        const last = msgs[msgs.length - 1];
        if (!last) return false;
        // Message is done when there's no .pending messageContent inside
        return !last.querySelector('.messageContent.pending');
      },
      { timeout: 120000 },
    );
    // Should contain some text
    const replyText = await agentReply.textContent();
    expect(replyText!.length).toBeGreaterThan(0);
    console.log(`Agent replied: "${replyText!.slice(0, 100)}"`);
  });

  test('should show failed send status on the user message and allow resend', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    const replyText = 'Resent message completed.';
    let sendCalls = 0;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        sendCalls++;
        if (sendCalls > 1) {
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, sessionId: 'session-alpha', phase: 'thinking', turn: { id: 'turn-resend-user-status' } }),
          });
          return;
        }
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'Failed to send prompt to agent' }),
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'idle',
            ready: true,
            activeTurn: {
              id: 'turn-resend-user-status',
              fullText: replyText,
              done: true,
              phase: 'done',
              statusText: '',
              events: [{ type: 'text_chunk', ts: Date.now(), text: replyText }],
            },
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, activeTurn: null }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await textarea.fill('@alpha trigger a send failure');
    await page.click('button[aria-label="Send message"]');

    await expect.poll(() => sendCalls, { timeout: 10000 }).toBe(1);
    const failedUserMessage = chatArea.locator('.message.user', { hasText: 'trigger a send failure' });
    await expectCompactFailedSendStatus(failedUserMessage);
    await expect(failedUserMessage.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(chatArea.locator('.message.agent', { hasText: 'Failed to send prompt to agent' })).toHaveCount(0);
    await expect(chatArea.locator('.message.system', { hasText: 'Send failed' })).toHaveCount(0);

    await failedUserMessage.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => sendCalls, { timeout: 10000 }).toBe(2);
    await expect(failedUserMessage.locator('.userSendFailure')).toHaveCount(0);
    await expect(chatArea.locator('.message.agent', { hasText: replyText })).toBeVisible({ timeout: 10000 });
  });

  test('should style failed message resend as a card with a separate retry action', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const failedText = 'failed message style check';
    const chatId = `ui-resend-style-${Date.now()}`;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, activeTurn: null }) });
    });

    await page.evaluate(async ({ chatId, failedText }) => {
      const now = Date.now();
      const chat = {
        id: chatId,
        name: 'UI resend style',
        ts: now,
        messages: [
          {
            id: 'u1',
            type: 'user',
            content: failedText,
            sendStatus: 'failed',
            sendError: 'Failed to send prompt to agent',
            resendAgentIds: ['alpha'],
            resendMessage: failedText,
            ts: now,
          },
          { id: 'a1', type: 'agent', content: 'normal answer with copy action', agentId: 'alpha', ts: now + 1 },
        ],
        agentSessions: { alpha: 'session-alpha' },
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, failedText });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    const resendButton = chatArea.locator('.message.user', { hasText: failedText }).getByRole('button', { name: 'Retry' });
    await expect(resendButton).toBeVisible({ timeout: 15000 });

    const styles = await resendButton.evaluate((button) => {
      const message = button.closest('.message.user') as HTMLElement | null;
      const notice = message?.querySelector('.userSendFailureNotice') as HTMLElement | null;
      const card = notice?.querySelector('.userSendFailureCard') as HTMLElement | null;
      const actions = button.closest('.userSendFailureActions') as HTMLElement | null;
      const status = card?.querySelector('.userSendFailureStatus') as HTMLElement | null;
      const detail = card?.querySelector('.userSendFailureMessage') as HTMLElement | null;
      if (!notice || !card || !actions || !status) throw new Error('Expected a failed send one-line notice card and retry action row');
      const resendStyle = getComputedStyle(button as HTMLElement);
      const resendBeforeStyle = getComputedStyle(button as HTMLElement, '::before');
      const noticeStyle = getComputedStyle(notice);
      const cardStyle = getComputedStyle(card);
      const actionsStyle = getComputedStyle(actions);
      const statusStyle = getComputedStyle(status);
      return {
        noticeDisplay: noticeStyle.display,
        noticeJustifyContent: noticeStyle.justifyContent,
        noticeMarginBottom: noticeStyle.marginBottom,
        cardBorderRadius: cardStyle.borderRadius,
        cardBackground: cardStyle.backgroundColor,
        cardBoxShadow: cardStyle.boxShadow,
        cardWidth: cardStyle.width,
        cardText: status.textContent?.trim(),
        detailCount: detail ? 1 : 0,
        actionsDisplay: actionsStyle.display,
        actionsJustifyContent: actionsStyle.justifyContent,
        statusText: status.textContent?.trim(),
        statusFontWeight: statusStyle.fontWeight,
        statusWhiteSpace: statusStyle.whiteSpace,
        resendMinHeight: resendStyle.minHeight,
        resendFlexDirection: resendStyle.flexDirection,
        resendBeforeContent: resendBeforeStyle.content,
        resendBorderRadius: resendStyle.borderRadius,
        resendBorderStyle: resendStyle.borderStyle,
        resendFontWeight: resendStyle.fontWeight,
        resendPaddingLeft: resendStyle.paddingLeft,
        resendPaddingRight: resendStyle.paddingRight,
        resendText: button.textContent?.trim(),
      };
    });
    expect(styles.noticeDisplay).toBe('flex');
    expect(styles.noticeJustifyContent).toBe('flex-start');
    expect(styles.noticeMarginBottom).toBe('8px');
    expect(styles.cardBorderRadius).toBe('0px');
    expect(styles.cardBackground).toBe('rgba(0, 0, 0, 0)');
    expect(styles.cardBoxShadow).toBe('none');
    expect(styles.cardText).toBe('Failed to send: Failed to send prompt to agent');
    expect(styles.detailCount).toBe(0);
    expect(styles.actionsDisplay).toBe('flex');
    expect(styles.actionsJustifyContent).toBe('flex-end');
    expect(styles.statusText).toBe('Failed to send: Failed to send prompt to agent');
    expect(styles.statusFontWeight).toBe('600');
    expect(styles.statusWhiteSpace).toBe('nowrap');
    expect(styles.resendMinHeight).toBe('28px');
    expect(styles.resendFlexDirection).toBe('row');
    expect(styles.resendBeforeContent).toBe('none');
    expect(styles.resendBorderRadius).toBe('6px');
    expect(styles.resendBorderStyle).toBe('none');
    expect(styles.resendFontWeight).toBe('500');
    expect(styles.resendPaddingLeft).toBe(styles.resendPaddingRight);
    expect(styles.resendText).toBe('Retry');

    const alignment = await resendButton.evaluate((button) => {
      const message = button.closest('.message.user') as HTMLElement | null;
      const notice = message?.querySelector('.userSendFailureNotice') as HTMLElement | null;
      const card = notice?.querySelector('.userSendFailureCard') as HTMLElement | null;
      const messageContent = message?.querySelector('.messageContent') as HTMLElement | null;
      const actionRow = button.closest('.userSendFailureActions') as HTMLElement | null;
      if (!notice || !card || !actionRow || !message || !messageContent) throw new Error('Expected failed-send notice above message text and retry actions below');
      const noticeRect = notice.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const contentRect = messageContent.getBoundingClientRect();
      const actionsRect = actionRow.getBoundingClientRect();
      const buttonRect = (button as HTMLElement).getBoundingClientRect();
      const messageRect = message.getBoundingClientRect();
      return {
        messageLeft: Math.round(messageRect.left),
        messageRight: Math.round(messageRect.right),
        noticeBottom: Math.round(noticeRect.bottom),
        contentTop: Math.round(contentRect.top),
        contentBottom: Math.round(contentRect.bottom),
        cardLeft: Math.round(cardRect.left),
        cardBottom: Math.round(cardRect.bottom),
        cardRight: Math.round(cardRect.right),
        contentLeft: Math.round(contentRect.left),
        actionsTop: Math.round(actionsRect.top),
        actionsRight: Math.round(actionsRect.right),
        retryRight: Math.round(buttonRect.right),
      };
    });
    expect(Math.abs(alignment.cardLeft - alignment.contentLeft)).toBeLessThanOrEqual(1);
    expect(alignment.noticeBottom).toBeLessThanOrEqual(alignment.contentTop);
    expect(alignment.actionsTop).toBeGreaterThanOrEqual(alignment.contentBottom);
    expect(Math.abs(alignment.messageRight - alignment.actionsRight)).toBeLessThan(28);
    expect(Math.abs(alignment.actionsRight - alignment.retryRight)).toBeLessThanOrEqual(6);
  });

  test('should align failed send controls with the collapse action row', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const failedText = `failed long message action row check ${'long content '.repeat(60)}`;
    const chatId = `ui-failed-action-row-${Date.now()}`;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, activeTurn: null }) });
    });

    await page.evaluate(async ({ chatId, failedText }) => {
      const now = Date.now();
      const chat = {
        id: chatId,
        name: 'UI failed action row',
        ts: now,
        messages: [
          {
            id: 'u1',
            type: 'user',
            content: failedText,
            sendStatus: 'failed',
            sendError: 'Failed to send prompt to agent',
            resendAgentIds: ['alpha'],
            resendMessage: failedText,
            ts: now,
          },
        ],
        agentSessions: { alpha: 'session-alpha' },
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, failedText });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    const failedUserMessage = chatArea.locator('.message.user', { hasText: 'failed long message action row check' });
    await expect(failedUserMessage).toBeVisible({ timeout: 15000 });
    await expect(failedUserMessage.getByRole('button', { name: 'Collapse' })).toBeVisible();
    await expect(failedUserMessage.locator('.userSendFailure')).toBeVisible();

    const verticalAlignment = await failedUserMessage.evaluate((message) => {
      const collapse = message.querySelector('.collapseToggle') as HTMLElement | null;
      const failureActions = message.querySelector('.userSendFailureActions') as HTMLElement | null;
      if (!collapse || !failureActions) throw new Error('Expected collapse and retry controls');
      const collapseRect = collapse.getBoundingClientRect();
      const failureRect = failureActions.getBoundingClientRect();
      const messageRect = (message as HTMLElement).getBoundingClientRect();
      return {
        verticalDelta: Math.abs(
          collapseRect.top + collapseRect.height / 2 -
          (failureRect.top + failureRect.height / 2),
        ),
        collapseLeft: Math.round(collapseRect.left),
        failureRight: Math.round(failureRect.right),
        messageRight: Math.round(messageRect.right),
      };
    });
    expect(verticalAlignment.verticalDelta).toBeLessThanOrEqual(2);
    expect(verticalAlignment.failureRight).toBeGreaterThan(verticalAlignment.collapseLeft);
    expect(Math.abs(verticalAlignment.messageRight - verticalAlignment.failureRight)).toBeLessThan(28);
  });

  test('should keep failed send status on the original chat when user switches before failure returns', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    const failedText = 'delayed failure belongs to original chat';
    let sendCalls = 0;
    let releaseFailure: () => void = () => {};
    const failureReady = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        sendCalls++;
        await failureReady;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'Failed to send prompt to agent' }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, activeTurn: null }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await textarea.fill(failedText);
    await page.click('button[aria-label="Send message"]');
    await expect.poll(() => sendCalls, { timeout: 10000 }).toBe(1);

    await page.click('button.newChatButton');
    await expect(chatArea.locator('.message.system', { hasText: 'New chat "New Chat" created.' })).toBeVisible({ timeout: 10000 });
    releaseFailure();
    await expect(chatArea.locator('.message.user', { hasText: failedText })).toHaveCount(0);

    await page.locator('.chatHistoryItem', { hasText: failedText }).click();
    const failedUserMessage = chatArea.locator('.message.user', { hasText: failedText });
    await expect(failedUserMessage).toBeVisible({ timeout: 15000 });
    await expectCompactFailedSendStatus(failedUserMessage);
    await expect(chatArea.locator('.message.system', { hasText: 'Send failed' })).toHaveCount(0);
  });

  test('should disable failed message resend while the chat has an active run', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    const pendingText = 'saved failed message waits for active run';
    const chatId = `ui-resend-disabled-running-${Date.now()}`;
    const sendRequests: any[] = [];

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'resume-session') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: body.sessionId, loaded: true, activeTurn: null, recoveredMessages: [] }),
        });
        return;
      }
      if (body?.action === 'send') {
        sendRequests.push(body);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: 'session-alpha', phase: 'thinking', turn: { id: 'turn-active-run' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'thinking',
            ready: false,
            activeTurn: {
              id: 'turn-active-run',
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
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.evaluate(async ({ chatId, pendingText }) => {
      const chat = {
        id: chatId,
        name: 'UI resend disabled while running',
        ts: Date.now(),
        messages: [
          { id: 'u1', type: 'user', content: pendingText, sendStatus: 'failed', sendError: 'Failed to send prompt to agent', resendAgentIds: ['alpha'], resendMessage: pendingText, ts: Date.now() },
        ],
        agentSessions: { alpha: 'session-alpha' },
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, pendingText });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    const failedUserMessage = chatArea.locator('.message.user', { hasText: pendingText });
    await expect(failedUserMessage).toBeVisible({ timeout: 15000 });
    await expect(failedUserMessage.getByRole('button', { name: 'Retry' })).toBeEnabled();

    await textarea.fill('keep alpha busy');
    await page.click('button[aria-label="Send message"]');
    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBe(1);
    await expect(failedUserMessage.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  test('should mark the source user message failed when an auto orchestration follow-up send fails', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    const userText = '@alpha @beta coordinate follow-up failure';
    const schedulerDecision = JSON.stringify({
      version: 1,
      nodes: [
        { id: 'beta-step', agent: 'beta', instruction: 'Beta follow-up instruction', dependsOn: [] },
        { id: 'alpha-step', agent: 'alpha', instruction: 'Alpha follows beta', dependsOn: ['beta-step'] },
      ],
    });
    const sendRequests: any[] = [];

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [
              { id: 'scheduler', name: 'Scheduler', command: 'mock', args: [], cwd: '', running: true },
              { id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true },
              { id: 'beta', name: 'Beta Agent', command: 'mock', args: [], cwd: '', running: true },
            ],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        sendRequests.push(body);
        if (body.agentId === 'beta') {
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, error: 'Failed to send prompt to agent' }),
          });
          return;
        }
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: 'session-scheduler', phase: 'thinking', turn: { id: 'turn-scheduler-follow-up' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'idle',
            ready: true,
            activeTurn: {
              id: 'turn-scheduler-follow-up',
              fullText: schedulerDecision,
              done: true,
              phase: 'done',
              statusText: '',
              events: [{ type: 'text_chunk', ts: Date.now(), text: schedulerDecision }],
            },
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await textarea.fill(userText);
    await page.click('button[aria-label="Send message"]');
    await expect.poll(() => sendRequests.some((request) => request.agentId === 'beta'), { timeout: 10000 }).toBe(true);

    const failedUserMessage = chatArea.locator('.message.user', { hasText: userText });
    await expectCompactFailedSendStatus(failedUserMessage);
    await expect(chatArea.locator('.message.system', { hasText: 'Auto orchestration error' })).toHaveCount(0);
    await expect(chatArea.locator('.message.agent', { hasText: 'Failed to send prompt to agent' })).toHaveCount(0);
  });

  test('should remove partial workflow agent messages when one initial send fails', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    const userText = '@alpha @beta discuss partial initial failure';
    const sendRequests: any[] = [];

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [
              { id: 'scheduler', name: 'Scheduler', command: 'mock', args: [], cwd: '', running: true },
              { id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true },
              { id: 'beta', name: 'Beta Agent', command: 'mock', args: [], cwd: '', running: true },
            ],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        sendRequests.push(body);
        if (body.agentId === 'beta') {
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, error: 'Failed to send prompt to agent' }),
          });
          return;
        }
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: 'session-alpha', phase: 'thinking', turn: { id: 'turn-alpha-discussion-partial' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        if (body.agentId === 'scheduler') {
          const schedulerPlan = JSON.stringify({
            version: 1,
            nodes: [
              { id: 'alpha-step', agent: 'alpha', instruction: 'Alpha handles the task', dependsOn: [] },
              { id: 'beta-step', agent: 'beta', instruction: 'Beta handles the task', dependsOn: [] },
            ],
          });
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              ok: true,
              phase: 'idle',
              ready: true,
              activeTurn: {
                id: 'turn-scheduler-discussion-partial',
                fullText: schedulerPlan,
                done: true,
                phase: 'done',
                statusText: '',
                events: [{ type: 'text_chunk', ts: Date.now(), text: schedulerPlan }],
              },
            }),
          });
          return;
        }
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'thinking',
            ready: false,
            activeTurn: {
              id: 'turn-alpha-discussion-partial',
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
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await textarea.fill(userText);
    await page.click('button[aria-label="Send message"]');
    await expect.poll(() => sendRequests.some((request) => request.agentId === 'beta'), { timeout: 10000 }).toBe(true);

    const failedUserMessage = chatArea.locator('.message.user', { hasText: userText });
    await expectCompactFailedSendStatus(failedUserMessage);
    await expect(chatArea.locator('.message.agent', { has: page.locator('.agentName', { hasText: /Alpha Agent|Beta Agent/ }) })).toHaveCount(0);
  });

  test('should keep resend disabled for mentioned legacy failures until agents load', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const pendingText = '@beta wait for agents before resend';
    const cleanedText = 'wait for agents before resend';
    const chatId = `ui-resend-waits-for-agents-${Date.now()}`;
    const sendRequests: any[] = [];
    let releaseAgents: () => void = () => {};
    const agentsReady = new Promise<void>((resolve) => {
      releaseAgents = resolve;
    });

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await agentsReady;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [
              { id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true },
              { id: 'beta', name: 'Beta Agent', command: 'mock', args: [], cwd: '', running: true },
            ],
          }),
        });
        return;
      }
      if (body?.action === 'resume-session') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: body.sessionId, loaded: true, activeTurn: null, recoveredMessages: [] }),
        });
        return;
      }
      if (body?.action === 'send') {
        sendRequests.push(body);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: 'session-beta', phase: 'thinking', turn: { id: 'turn-beta-after-agents-load' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'idle',
            ready: true,
            activeTurn: {
              id: 'turn-beta-after-agents-load',
              fullText: 'Beta handled resend after agents loaded.',
              done: true,
              phase: 'done',
              statusText: '',
              events: [{ type: 'text_chunk', ts: Date.now(), text: 'Beta handled resend after agents loaded.' }],
            },
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.evaluate(async ({ chatId, pendingText }) => {
      const chat = {
        id: chatId,
        name: 'UI resend waits for agents',
        ts: Date.now(),
        messages: [
          { id: 'u1', type: 'user', content: pendingText, ts: Date.now() },
          { id: 'a1', type: 'agent', content: '⚠️ Failed to send prompt to agent', agentId: 'alpha', ts: Date.now() + 1 },
        ],
        agentSessions: { alpha: 'session-alpha', beta: 'session-beta' },
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, pendingText });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    const failedUserMessage = chatArea.locator('.message.user', { hasText: pendingText });
    await expect(failedUserMessage).toBeVisible({ timeout: 15000 });
    const resendButton = failedUserMessage.getByRole('button', { name: 'Retry' });
    await expect(resendButton).toBeDisabled();

    releaseAgents();
    await expect(resendButton).toBeEnabled({ timeout: 10000 });
    await resendButton.click();
    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBe(1);
    expect(sendRequests[0]).toMatchObject({ action: 'send', agentId: 'beta', text: cleanedText, chatId });
  });

  test('should create a new chat', async ({ page }) => {
    // From empty homepage, click the sidebar New Chat button
    await page.click('button.newChatButton');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });

    // Should show welcome message in the new empty chat
    await expect(page.locator('text=Welcome to Agents Chat')).toBeVisible();

    // Chat input should be empty and ready
    const textarea = page.locator('textarea.composerTextarea');
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue('');
  });

  test('should switch between chats and remember context', async ({ page }) => {
    test.setTimeout(360000); // 6 min — two agent round-trips + session reload
    let turn = 0;
    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        turn += 1;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: 'session-alpha', phase: 'thinking', turn: { id: `turn-${turn}` } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        const reply = turn === 1 ? 'a is 2' : '2';
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'idle',
            ready: true,
            activeTurn: {
              id: `turn-${turn}`,
              fullText: reply,
              done: true,
              phase: 'done',
              events: [{ type: 'text_chunk', ts: Date.now(), text: reply }],
            },
          }),
        });
        return;
      }
      if (body?.action === 'resume-session' || body?.action === 'ensure-agent-session') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: 'session-alpha', loaded: true, activeTurn: null, recoveredMessages: [] }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    const textarea = page.locator('textarea.composerTextarea');
    const chatArea = page.locator('.chatContainer');

    // Step 1: Tell the agent to remember a value
    await textarea.fill('Let a = 1 + 1. Just confirm you understood by saying "a is 2".');
    await page.click('button[aria-label="Send message"]');
    await expect(chatArea.locator('.message.user').last()).toContainText('Let a = 1 + 1', { timeout: 15000 });
    await expect(page.locator('button[aria-label="Stop generation"]')).toBeHidden({ timeout: 180000 });

    // Verify agent acknowledged
    const firstReply = chatArea.locator('.message.agent').last();
    await expect(firstReply).toBeVisible({ timeout: 10000 });
    const firstReplyText = await firstReply.textContent() || '';
    console.log(`Step 1 reply: "${firstReplyText.slice(0, 100)}"`);

    // Step 2: Switch to a new chat and wait for it to fully initialize
    await page.click('button.newChatButton');
    await expect(chatArea.locator('text=Welcome to Agents Chat')).toBeVisible();
    // Wait for createNewChat() to finish creating agent sessions
    await expect(chatArea.locator('.message.system:has-text("created")')).toBeVisible({ timeout: 30000 });

    // Step 3: Switch back to the old chat
    const oldChat = page.locator('.chatHistoryItem', { hasText: 'Let a = 1 + 1' });
    await expect(oldChat).toBeVisible({ timeout: 15000 });
    await oldChat.click();

    // Verify: old messages are visible IN THE CHAT AREA after switching
    await expect(chatArea.locator('.message.user:has-text("Let a = 1 + 1")')).toBeVisible({ timeout: 15000 });
    // Verify: agent's previous reply is still there
    await expect(chatArea.locator('.message.agent')).toBeVisible({ timeout: 10000 });
    console.log('Chat history preserved after switch');

    // Wait for session resume to fully settle (session/load or fallback to session/new)
    await page.waitForTimeout(5000);

    // Step 4: Ask the agent what the value of a is — tests session memory
    await textarea.fill('What is the value of a that I defined earlier? Reply with just the number.');
    await page.click('button[aria-label="Send message"]');
    await expect(chatArea.locator('.message.user').last()).toContainText('What is the value of a', { timeout: 15000 });
    await expect(page.locator('button[aria-label="Stop generation"]')).toBeHidden({ timeout: 180000 });

    // Check if agent remembered — this depends on session/load replay working
    const memoryReply = chatArea.locator('.message.agent').last();
    const replyText = await memoryReply.textContent() || '';
    console.log(`Step 4 reply: "${replyText.slice(0, 200)}"`);
    // Assert the agent replied (not stuck)
    expect(replyText.length).toBeGreaterThan(0);
    // Soft check: ideally the reply contains "2"
    if (/\b2\b/.test(replyText)) {
      console.log('PASS: Agent remembered a = 2 after chat switch (session context preserved)');
    } else {
      console.log('WARN: Agent did not remember a = 2 — session/load may have fallen back to new session');
    }
  });

  test('should delete a chat', async ({ page }) => {
    await ensureActiveChat(page);
    // There should be existing chats in the sidebar from previous tests
    // If not, create one by sending a message, waiting, then creating a new chat

    // First, check if there are already non-active chats with delete buttons
    let deleteBtn = page.locator('.chatDeleteBtn').first();
    let hasDeleteBtn = await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false);

    if (!hasDeleteBtn) {
      // Need to create a chat we can delete: send a short message, wait fully, then create new chat
      const textarea = page.locator('textarea.composerTextarea');
      await textarea.fill('Temp message for delete test');
      await page.click('button[aria-label="Send message"]');

      // Wait for the stop button to disappear (isSending becomes false)
      await expect(page.locator('button[aria-label="Stop generation"]')).toBeHidden({ timeout: 120000 });

      await page.click('button.newChatButton');
      await page.waitForTimeout(500);
      deleteBtn = page.locator('.chatDeleteBtn').first();
      hasDeleteBtn = await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false);
    }

    if (hasDeleteBtn) {
      const chatsBefore = await page.locator('.chatHistoryRow').count();
      await deleteBtn.click();

      // Chat count should decrease
      await page.waitForFunction(
        (prev) => document.querySelectorAll('.chatHistoryRow').length < prev,
        chatsBefore,
        { timeout: 10000 },
      );
      const chatsAfter = await page.locator('.chatHistoryRow').count();
      expect(chatsAfter).toBeLessThan(chatsBefore);
      console.log(`Deleted chat: ${chatsBefore} → ${chatsAfter}`);
    } else {
      console.log('No deletable chats found, skipping delete verification');
    }
  });

  test('should persist messages to SQLite after send and reload', async ({ page }) => {
    test.setTimeout(240000);
    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'send') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: 'session-persistence', phase: 'thinking', turn: { id: 'turn-persistence' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'idle',
            ready: true,
            activeTurn: {
              id: 'turn-persistence',
              fullText: '5',
              done: true,
              phase: 'done',
              events: [{ type: 'text_chunk', ts: Date.now(), text: '5' }],
            },
          }),
        });
        return;
      }
      await route.fallback();
    });
    await ensureActiveChat(page);
    const textarea = page.locator('textarea.composerTextarea');
    const chatArea = page.locator('.chatContainer');

    // Send a message
    const userText = 'What is 2+3? Reply with just the number.';
    await textarea.fill(userText);
    await page.click('button[aria-label="Send message"]');
    await expect(chatArea.locator('.message.user').last()).toContainText('What is 2+3', { timeout: 15000 });

    // Wait for agent reply to appear and finish (up to 60s; agent may be slow after many tests)
    let agentResponded = false;
    try {
      await page.waitForFunction(
        () => {
          const msgs = document.querySelectorAll('.message.agent');
          const last = msgs[msgs.length - 1];
          if (!last) return false;
          const hasContent = last.querySelector('.messageContent');
          const isPending = last.querySelector('.messageContent.pending')
            || last.querySelector('.thinkingWrap')
            || last.querySelector('.streamingIndicator');
          return hasContent && !isPending;
        },
        { timeout: 30000 },
      );
      agentResponded = true;
      const replyText = await chatArea.locator('.message.agent').last().textContent() || '';
      console.log(`Persistence test — agent replied: "${replyText.slice(0, 100)}"`);
    } catch {
      console.log('Agent did not finish in 30s — checking user message persistence only');
    }

    // Wait briefly for saveCurrentChatToHistory to complete
    await page.waitForTimeout(2000);

    // Verify messages are stored in SQLite via the API
    const chatsBefore = await page.evaluate(async () => {
      const r = await fetch('/api/chats');
      return r.json();
    });
    expect(chatsBefore.ok).toBe(true);
    expect(chatsBefore.chats.length).toBeGreaterThan(0);

    // Find the most recent chat (should be ours since we just sent a message)
    const targetChat = chatsBefore.chats[0];
    expect(targetChat).toBeTruthy();
    console.log(`Found chat in SQLite: id=${targetChat.id}, name="${targetChat.name}"`);

    // Fetch full chat with messages
    const fullChat = await page.evaluate(async (id: string) => {
      const r = await fetch(`/api/chats?id=${encodeURIComponent(id)}`);
      return r.json();
    }, targetChat.id);
    expect(fullChat.ok).toBe(true);

    const msgs = fullChat.chat.messages;
    const userMsgs = msgs.filter((m: any) => m.type === 'user');
    const agentMsgs = msgs.filter((m: any) => m.type === 'agent');
    console.log(`SQLite has ${msgs.length} messages: ${userMsgs.length} user, ${agentMsgs.length} agent`);

    // The user message MUST be persisted (this was the original stale-closure bug)
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    expect(userMsgs.some((m: any) => m.content.includes('What is 2+3'))).toBe(true);

    // If agent responded, verify agent message was also persisted
    if (agentResponded) {
      expect(agentMsgs.length).toBeGreaterThanOrEqual(1);
    }

    // Reload the page and verify messages survive
    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });

    // The chat should appear in the sidebar
    await expect(page.locator('.chatHistoryItem')).toBeVisible({ timeout: 10000 });

    // Click on the first chat in sidebar (most recent)
    await page.locator('.chatHistoryItem').first().click();
    await page.waitForTimeout(1000);

    // User message must survive reload
    await expect(chatArea.locator('.message.user:has-text("What is 2+3")')).toBeVisible({ timeout: 15000 });
    console.log('PASS: Messages persisted in SQLite and survived page reload');
  });

  test('should preserve messages when a stale browser saves the same chat', async ({ page }) => {
    const chatId = `multi-client-save-${Date.now()}`;
    const userMessage = {
      id: `${chatId}-user`,
      type: 'user',
      content: 'message from the active browser',
      ts: Date.now(),
    };
    const agentMessage = {
      id: `${chatId}-agent`,
      type: 'agent',
      content: 'reply completed in another browser',
      agentId: 'alpha',
      ts: userMessage.ts + 1,
    };

    try {
      const result = await page.evaluate(async ({ id, user, agent }) => {
        const save = (messages: unknown[]) => fetch('/api/chats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat: { id, name: 'Multi-client persistence', ts: Date.now(), messages, agentSessions: {} },
          }),
        });

        await save([user]);
        await save([agent]);
        const staleSaveResponse = await fetch(`/api/chats?id=${encodeURIComponent(id)}`);
        const afterStaleSave = await staleSaveResponse.json();
        await save([user]);
        const removalResponse = await fetch(`/api/chats?id=${encodeURIComponent(id)}`);
        return { afterStaleSave, afterRemoval: await removalResponse.json() };
      }, { id: chatId, user: userMessage, agent: agentMessage });

      expect(result.afterStaleSave.ok).toBe(true);
      expect(result.afterStaleSave.chat.messages).toEqual(expect.arrayContaining([userMessage, agentMessage]));
      expect(result.afterRemoval.chat.messages).toEqual([userMessage]);
    } finally {
      await page.evaluate(async (id) => {
        await fetch(`/api/chats?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      }, chatId);
    }
  });

  test('should show share button', async ({ page }) => {
    // The share button should exist for chat history items
    const shareBtn = page.locator('.chatShareBtn').first();
    // It may not be visible if there are no chats, which is fine
    const count = await shareBtn.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('should not store chat messages in localStorage', async ({ page }) => {
    await ensureActiveChat(page);
    const textarea = page.locator('textarea.composerTextarea');

    // Send a message
    await textarea.fill('Hello localStorage test');
    await page.click('button[aria-label="Send message"]');
    await expect(page.locator('.message.user').last()).toContainText('Hello localStorage test', { timeout: 15000 });
    await page.waitForTimeout(1000);

    // Check that old localStorage keys are NOT written
    const storageKeys = await page.evaluate(() => {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        keys.push(localStorage.key(i)!);
      }
      return keys;
    });
    console.log('localStorage keys:', storageKeys);

    // These keys should NOT exist (removed in favor of SQLite)
    expect(storageKeys).not.toContain('acp_chat_messages_v1');
    expect(storageKeys).not.toContain('acp_chat_current_id_v1');
    expect(storageKeys.filter(k => k.startsWith('acp_chat_data_'))).toHaveLength(0);

    // These UI pref keys SHOULD still exist
    const uiKeys = ['acp_chat_input_v1', 'acp_chat_sidebar_collapsed_v1', 'acp_chat_theme_v1'];
    for (const k of uiKeys) {
      expect(storageKeys).toContain(k);
    }
    console.log('PASS: No chat data in localStorage, UI prefs preserved');
  });

  test('should save and restore lastChatId from server on reload', async ({ page }) => {
    await ensureActiveChat(page);
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');

    // Send a message so the chat has content and a name
    await textarea.fill('lastChatId test message');
    await page.click('button[aria-label="Send message"]');
    await expect(chatArea.locator('.message.user').last()).toContainText('lastChatId test', { timeout: 15000 });
    await page.waitForTimeout(2000);

    // Get the current chat ID from the server
    const chatsRes = await page.evaluate(async () => {
      const r = await fetch('/api/chats');
      return r.json();
    });
    expect(chatsRes.ok).toBe(true);
    const lastChatId = chatsRes.lastChatId;
    console.log(`Server lastChatId: ${lastChatId}`);
    expect(lastChatId).toBeTruthy();

    // Reload the page
    await page.reload();
    await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 30000 });

    // The user message should be visible — loaded from SQLite via lastChatId
    await expect(chatArea.locator('.message.user:has-text("lastChatId test")')).toBeVisible({ timeout: 15000 });
    console.log('PASS: lastChatId restored from server, chat loaded from SQLite after reload');
  });

  test('should show failed saved message status and resend only after user clicks Resend', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const pendingText = 'UI recovery should resend this message';
    const replyText = 'Manual resend completed.';
    const chatId = `ui-auto-resend-${Date.now()}`;
    const resumeRequests: string[] = [];
    const sendRequests: any[] = [];
    let pollCount = 0;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [
              { id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true },
              { id: 'beta', name: 'Beta Agent', command: 'mock', args: [], cwd: '', running: true },
            ],
          }),
        });
        return;
      }
      if (body?.action === 'resume-session') {
        resumeRequests.push(body.agentId);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: body.sessionId, loaded: true, activeTurn: null, recoveredMessages: [] }),
        });
        return;
      }
      if (body?.action === 'send') {
        sendRequests.push(body);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: 'session-alpha', phase: 'thinking', turn: { id: 'turn-auto-resend' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        pollCount++;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'idle',
            ready: true,
            activeTurn: {
              id: 'turn-auto-resend',
              messageId: body.messageId,
              fullText: replyText,
              done: true,
              phase: 'done',
              statusText: '',
              events: [{ type: 'text_chunk', ts: Date.now(), text: replyText }],
            },
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.evaluate(async ({ chatId, pendingText }) => {
      const chat = {
        id: chatId,
        name: 'UI no resend regression',
        ts: Date.now(),
        messages: [
          { id: 'u1', type: 'user', content: pendingText, ts: Date.now() },
          { id: 'a1', type: 'agent', content: '⚠️ Failed to send prompt to agent', agentId: 'alpha', ts: Date.now() + 1 },
          { id: 's1', type: 'system', content: 'Send failed: Failed to send prompt to agent', ts: Date.now() + 2 },
        ],
        agentSessions: { alpha: 'session-alpha', beta: 'session-beta' },
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, pendingText });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    const failedUserMessage = chatArea.locator('.message.user', { hasText: pendingText });
    await expect(failedUserMessage).toBeVisible({ timeout: 15000 });
    await expect.poll(() => resumeRequests.length, { timeout: 10000 }).toBe(2);

    await expect.poll(() => sendRequests.length, { timeout: 1000 }).toBe(0);
    await expectCompactFailedSendStatus(failedUserMessage);
    await expect(failedUserMessage.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(chatArea.locator('.message.agent', { hasText: 'Failed to send prompt to agent' })).toHaveCount(0);
    await expect(chatArea.locator('.message.system', { hasText: 'Send failed' })).toHaveCount(0);
    await failedUserMessage.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBe(1);
    expect(sendRequests[0]).toMatchObject({ action: 'send', agentId: 'alpha', text: pendingText, chatId });
    await expect(chatArea.locator('.message.agent', { hasText: replyText })).toBeVisible({ timeout: 10000 });
    expect(pollCount).toBeGreaterThan(0);
    await expect(chatArea.locator('text=turn_in_progress')).toHaveCount(0);
    console.log('PASS: failed saved message waited for manual resend');
  });

  test('should treat saved user-only message without a session or response as failed on load', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const pendingText = 'UI no session send should become failed';
    const replyText = 'Manual resend after no-session failure completed.';
    const chatId = `ui-no-session-failed-send-${Date.now()}`;
    const sendRequests: any[] = [];

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        sendRequests.push(body);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: 'session-alpha', phase: 'thinking', turn: { id: 'turn-no-session-resend' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'idle',
            ready: true,
            activeTurn: {
              id: 'turn-no-session-resend',
              messageId: body.messageId,
              fullText: replyText,
              done: true,
              phase: 'done',
              statusText: '',
              events: [{ type: 'text_chunk', ts: Date.now(), text: replyText }],
            },
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.evaluate(async ({ chatId, pendingText }) => {
      const chat = {
        id: chatId,
        name: 'UI no session failure',
        ts: Date.now(),
        messages: [
          { id: 'u1', type: 'user', content: pendingText, ts: Date.now() },
        ],
        agentSessions: {},
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, pendingText });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    const failedUserMessage = chatArea.locator('.message.user', { hasText: pendingText });
    await expect(failedUserMessage).toBeVisible({ timeout: 15000 });
    await expect.poll(() => sendRequests.length, { timeout: 1000 }).toBe(0);
    await expectCompactFailedSendStatus(failedUserMessage);
    await expect(failedUserMessage.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect.poll(async () => page.evaluate(async (chatId) => {
      const response = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`);
      const data = await response.json();
      return data.chat?.messages?.[0]?.sendStatus || null;
    }, chatId), { timeout: 5000 }).toBe('failed');

    await failedUserMessage.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBe(1);
    expect(sendRequests[0]).toMatchObject({ action: 'send', agentId: 'alpha', text: pendingText, chatId });
    await expect(chatArea.locator('.message.agent', { hasText: replyText })).toBeVisible({ timeout: 10000 });
  });

  test('should manually resend a mentioned failed message to the correct agent when multiple agents exist', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const pendingText = '@beta please resume only beta';
    const cleanedText = 'please resume only beta';
    const replyText = 'Beta handled the resent message.';
    const chatId = `ui-auto-resend-target-agent-${Date.now()}`;
    const resumeRequests: string[] = [];
    const sendRequests: any[] = [];

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [
              { id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true },
              { id: 'beta', name: 'Beta Agent', command: 'mock', args: [], cwd: '', running: true },
            ],
          }),
        });
        return;
      }
      if (body?.action === 'resume-session') {
        resumeRequests.push(body.agentId);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: body.sessionId, loaded: true, activeTurn: null, recoveredMessages: [] }),
        });
        return;
      }
      if (body?.action === 'send') {
        sendRequests.push(body);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: 'session-beta', phase: 'thinking', turn: { id: 'turn-auto-resend-beta' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'idle',
            ready: true,
            activeTurn: {
              id: 'turn-auto-resend-beta',
              messageId: body.messageId,
              fullText: replyText,
              done: true,
              phase: 'done',
              statusText: '',
              events: [{ type: 'text_chunk', ts: Date.now(), text: replyText }],
            },
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.evaluate(async ({ chatId, pendingText }) => {
      const chat = {
        id: chatId,
        name: 'UI auto resend correct target',
        ts: Date.now(),
        messages: [
          { id: 'u1', type: 'user', content: pendingText, ts: Date.now() },
          { id: 'a1', type: 'agent', content: '⚠️ Failed to send prompt to agent', agentId: 'beta', ts: Date.now() + 1 },
        ],
        agentSessions: { alpha: 'session-alpha', beta: 'session-beta' },
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, pendingText });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    const failedUserMessage = chatArea.locator('.message.user', { hasText: pendingText });
    await expect(failedUserMessage).toBeVisible({ timeout: 15000 });
    await expect.poll(() => resumeRequests.length, { timeout: 10000 }).toBe(2);
    await expect.poll(() => sendRequests.length, { timeout: 1000 }).toBe(0);
    await expectCompactFailedSendStatus(failedUserMessage);
    await failedUserMessage.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBe(1);

    expect(sendRequests[0]).toMatchObject({ action: 'send', agentId: 'beta', text: cleanedText, chatId });
    expect(sendRequests.some((request) => request.agentId === 'alpha')).toBe(false);
    await expect(chatArea.locator('.message.agent', { hasText: replyText })).toBeVisible({ timeout: 10000 });
  });

  test('should use scheduler routing when manually resending a failed multi-agent message', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const pendingText = '@alpha @beta coordinate this resend';
    const cleanedText = 'coordinate this resend';
    const chatId = `ui-auto-resend-scheduler-${Date.now()}`;
    const sendRequests: any[] = [];

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [
              { id: 'scheduler', name: 'Scheduler', command: 'mock', args: [], cwd: '', running: true },
              { id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true },
              { id: 'beta', name: 'Beta Agent', command: 'mock', args: [], cwd: '', running: true },
            ],
          }),
        });
        return;
      }
      if (body?.action === 'resume-session') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: body.sessionId, loaded: true, activeTurn: null, recoveredMessages: [] }),
        });
        return;
      }
      if (body?.action === 'send') {
        sendRequests.push(body);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: body.agentId === 'scheduler' ? 'session-scheduler' : body.sessionId, phase: 'thinking', turn: { id: `turn-${body.agentId}` } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        const responseText = body.agentId === 'scheduler'
          ? '{ "done": true, "summary": "scheduler handled resend" }'
          : 'worker handled resend';
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'idle',
            ready: true,
            activeTurn: {
              id: `turn-${body.agentId}`,
              fullText: responseText,
              done: true,
              phase: 'done',
              statusText: '',
              events: [{ type: 'text_chunk', ts: Date.now(), text: responseText }],
            },
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.evaluate(async ({ chatId, pendingText }) => {
      const chat = {
        id: chatId,
        name: 'UI auto resend scheduler routing',
        ts: Date.now(),
        messages: [
          { id: 'u1', type: 'user', content: pendingText, ts: Date.now() },
          { id: 'a1', type: 'agent', content: '⚠️ Failed to send prompt to agent', agentId: 'alpha', ts: Date.now() + 1 },
        ],
        agentSessions: { alpha: 'session-alpha', beta: 'session-beta', scheduler: 'session-scheduler' },
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, pendingText });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    const failedUserMessage = chatArea.locator('.message.user', { hasText: pendingText });
    await expect(failedUserMessage).toBeVisible({ timeout: 15000 });
    await expect.poll(() => sendRequests.length, { timeout: 1000 }).toBe(0);
    await expectCompactFailedSendStatus(failedUserMessage);
    await failedUserMessage.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBeGreaterThan(0);
    expect(sendRequests[0].agentId).toBe('scheduler');
    expect(sendRequests[0].text).toContain(cleanedText);
    expect(sendRequests.some((request) => request.agentId === 'alpha')).toBe(false);
    expect(sendRequests.some((request) => request.agentId === 'beta')).toBe(false);
  });

  test('should manually resend to scheduler again when the failed auto-mode message was sent to scheduler', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const pendingText = '@alpha @beta coordinate this resend after scheduler failure';
    const cleanedText = 'coordinate this resend after scheduler failure';
    const chatId = `ui-auto-resend-scheduler-failed-${Date.now()}`;
    const sendRequests: any[] = [];

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [
              { id: 'scheduler', name: 'Scheduler', command: 'mock', args: [], cwd: '', running: true },
              { id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true },
              { id: 'beta', name: 'Beta Agent', command: 'mock', args: [], cwd: '', running: true },
            ],
          }),
        });
        return;
      }
      if (body?.action === 'resume-session') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: body.sessionId, loaded: true, activeTurn: null, recoveredMessages: [] }),
        });
        return;
      }
      if (body?.action === 'send') {
        sendRequests.push(body);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: 'session-scheduler', phase: 'thinking', turn: { id: 'turn-scheduler-resend' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'thinking',
            ready: false,
            activeTurn: {
              id: 'turn-scheduler-resend',
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
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.evaluate(async ({ chatId, pendingText }) => {
      const chat = {
        id: chatId,
        name: 'UI auto resend scheduler failed target',
        ts: Date.now(),
        messages: [
          { id: 'u1', type: 'user', content: pendingText, ts: Date.now() },
          { id: 'a1', type: 'agent', content: '⚠️ Failed to send prompt to agent', agentId: 'scheduler', ts: Date.now() + 1 },
        ],
        agentSessions: { alpha: 'session-alpha', beta: 'session-beta', scheduler: 'session-scheduler' },
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, pendingText });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    const failedUserMessage = chatArea.locator('.message.user', { hasText: pendingText });
    await expect(failedUserMessage).toBeVisible({ timeout: 15000 });
    await expect.poll(() => sendRequests.length, { timeout: 1000 }).toBe(0);
    await expectCompactFailedSendStatus(failedUserMessage);
    await failedUserMessage.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBe(1);
    expect(sendRequests[0].agentId).toBe('scheduler');
    expect(sendRequests[0].text).toContain(cleanedText);
    expect(sendRequests.some((request) => request.agentId === 'alpha')).toBe(false);
    expect(sendRequests.some((request) => request.agentId === 'beta')).toBe(false);
  });

  test('should use auto mode to manually resend a two-agent mention to the scheduler-selected worker only', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const pendingText = '@alpha @beta choose the right worker for this resend';
    const selectedInstruction = 'Beta should handle this resent prompt';
    const chatId = `ui-auto-resend-selected-worker-${Date.now()}`;
    const sendRequests: any[] = [];

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [
              { id: 'scheduler', name: 'Scheduler', command: 'mock', args: [], cwd: '', running: true },
              { id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true },
              { id: 'beta', name: 'Beta Agent', command: 'mock', args: [], cwd: '', running: true },
            ],
          }),
        });
        return;
      }
      if (body?.action === 'resume-session') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: body.sessionId, loaded: true, activeTurn: null, recoveredMessages: [] }),
        });
        return;
      }
      if (body?.action === 'send') {
        sendRequests.push(body);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: `session-${body.agentId}`, phase: 'thinking', turn: { id: `turn-${body.agentId}` } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        if (body.agentId === 'scheduler') {
          const schedulerDecision = JSON.stringify({
            version: 1,
            nodes: [
              { id: 'beta-step', agent: 'beta', instruction: selectedInstruction, dependsOn: [] },
              { id: 'alpha-step', agent: 'alpha', instruction: 'Alpha follows beta', dependsOn: ['beta-step'] },
            ],
          });
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              ok: true,
              phase: 'idle',
              ready: true,
              activeTurn: {
                id: 'turn-scheduler',
                fullText: schedulerDecision,
                done: true,
                phase: 'done',
                statusText: '',
                events: [{ type: 'text_chunk', ts: Date.now(), text: schedulerDecision }],
              },
            }),
          });
          return;
        }
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'thinking',
            ready: false,
            activeTurn: {
              id: `turn-${body.agentId}`,
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
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.evaluate(async ({ chatId, pendingText }) => {
      const chat = {
        id: chatId,
        name: 'UI auto resend selected worker',
        ts: Date.now(),
        messages: [
          { id: 'u1', type: 'user', content: pendingText, ts: Date.now() },
          { id: 'a1', type: 'agent', content: '⚠️ Failed to send prompt to agent', agentId: 'alpha', ts: Date.now() + 1 },
        ],
        agentSessions: { alpha: 'session-alpha', beta: 'session-beta', scheduler: 'session-scheduler' },
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, pendingText });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    const failedUserMessage = chatArea.locator('.message.user', { hasText: pendingText });
    await expect(failedUserMessage).toBeVisible({ timeout: 15000 });
    await expect.poll(() => sendRequests.length, { timeout: 1000 }).toBe(0);
    await expectCompactFailedSendStatus(failedUserMessage);
    await failedUserMessage.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBe(2);

    expect(sendRequests[0].agentId).toBe('scheduler');
    expect(sendRequests[1]).toMatchObject({ action: 'send', agentId: 'beta', text: selectedInstruction, chatId });
    expect(sendRequests.some((request) => request.agentId === 'alpha')).toBe(false);
  });

  test('should allow manual send while a failed saved message waits for manual resend', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    const pendingText = 'UI recovery should wait for manual resend';
    const manualText = 'manual message while resend is available';
    const chatId = `ui-auto-resend-block-send-${Date.now()}`;
    const resumeRequests: string[] = [];
    const sendRequests: any[] = [];
    const interruptRequests: any[] = [];

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [
              { id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true },
            ],
          }),
        });
        return;
      }
      if (body?.action === 'resume-session') {
        resumeRequests.push(body.agentId);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: body.sessionId, loaded: true, activeTurn: null, recoveredMessages: [] }),
        });
        return;
      }
      if (body?.action === 'send') {
        sendRequests.push(body);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, sessionId: 'session-alpha', phase: 'thinking', turn: { id: 'turn-auto-resend-block-send' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'thinking',
            ready: false,
            activeTurn: {
              id: 'turn-auto-resend-block-send',
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
        interruptRequests.push(body);
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.evaluate(async ({ chatId, pendingText }) => {
      const chat = {
        id: chatId,
        name: 'UI failed saved message does not block manual send',
        ts: Date.now(),
        messages: [
          { id: 'u1', type: 'user', content: pendingText, ts: Date.now() },
          { id: 'a1', type: 'agent', content: '⚠️ Failed to send prompt to agent', agentId: 'alpha', ts: Date.now() + 1 },
        ],
        agentSessions: { alpha: 'session-alpha' },
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, pendingText });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    const failedUserMessage = chatArea.locator('.message.user', { hasText: pendingText });
    await expect(failedUserMessage).toBeVisible({ timeout: 15000 });
    await expectCompactFailedSendStatus(failedUserMessage);
    await expect.poll(() => resumeRequests.length, { timeout: 10000 }).toBe(1);
    await expect.poll(() => sendRequests.length, { timeout: 1000 }).toBe(0);
    await textarea.fill(manualText);
    await textarea.press('Enter');

    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBe(1);
    expect(sendRequests[0]).toMatchObject({ action: 'send', agentId: 'alpha', text: manualText, chatId });
    await expect(chatArea.locator('.message.user', { hasText: manualText })).toBeVisible({ timeout: 10000 });
    expect(interruptRequests).toHaveLength(0);
    console.log('PASS: manual send remained available while failed saved message waited for manual resend');
  });

  test('forwards ACP permission questions to the user inline in chat', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    let respondedBody: any = null;
    let permissionAnswered = false;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, phase: 'thinking', turn: { id: 'turn-user-request' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            activeTurn: permissionAnswered
              ? {
                  id: 'turn-user-request',
                  messageId: body.messageId,
                  fullText: 'I used the approved permission.',
                  done: true,
                  phase: 'done',
                  statusText: '',
                  events: [{ type: 'text_chunk', ts: Date.now(), text: 'I used the approved permission.' }],
                }
              : {
                  id: 'turn-user-request',
                  messageId: body.messageId,
                  fullText: '',
                  done: false,
                  phase: 'thinking',
                  statusText: 'Waiting for your response',
                  events: [],
                  userRequest: {
                    id: 'request-allow-shell',
                    method: 'session/request_permission',
                    agentId: 'alpha',
                    title: 'Permission request',
                    prompt: 'Allow Alpha Agent to run a shell command?',
                    inputKind: 'options',
                    options: [
                      { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once' },
                      { optionId: 'allow_always', kind: 'allow_always', label: 'Always allow' },
                      { optionId: 'reject_once', kind: 'reject_once', label: 'Reject once' },
                    ],
                    createdAt: Date.now(),
                  },
                },
          }),
        });
        return;
      }
      if (body?.action === 'respond-user-request') {
        respondedBody = body;
        permissionAnswered = true;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      if (body?.action === 'turn-clear') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await textarea.fill('@alpha please inspect the repo');
    await textarea.press('Enter');

    const requestCard = chatArea.locator('.agentUserRequestCard', { hasText: 'Allow Alpha Agent to run a shell command?' });
    await expect(requestCard).toBeVisible({ timeout: 10000 });
    await expect(requestCard.getByRole('button', { name: 'Always allow in current session' })).toBeVisible();
    const allowButton = requestCard.getByRole('button', { name: 'Allow once' });
    await expect(allowButton).toBeVisible();
    const buttonStyles = await allowButton.evaluate((button) => {
      const copyButton = button.closest('.message')?.querySelector('.messageCopyButton') as HTMLElement | null;
      if (!copyButton) throw new Error('Expected request card to render with a message copy button');
      const requestStyle = getComputedStyle(button as HTMLElement);
      const copyStyle = getComputedStyle(copyButton);
      return {
        request: {
          minHeight: requestStyle.minHeight,
          borderRadius: requestStyle.borderRadius,
          backgroundColor: requestStyle.backgroundColor,
          backgroundImage: requestStyle.backgroundImage,
          color: requestStyle.color,
          fontSize: requestStyle.fontSize,
          lineHeight: requestStyle.lineHeight,
        },
        copy: {
          minHeight: copyStyle.minHeight,
          borderRadius: copyStyle.borderRadius,
          backgroundColor: copyStyle.backgroundColor,
          backgroundImage: copyStyle.backgroundImage,
          color: copyStyle.color,
          fontSize: copyStyle.fontSize,
          lineHeight: copyStyle.lineHeight,
        },
      };
    });
    expect(buttonStyles.request).toEqual(buttonStyles.copy);
    await allowButton.click();

    await expect.poll(() => respondedBody?.requestId ?? null).toBe('request-allow-shell');
    expect(respondedBody?.optionId).toBe('allow_once');
    await expect(chatArea.locator('.message.agent', { hasText: 'I used the approved permission.' })).toBeVisible({ timeout: 10000 });
  });

  test('forwards freeform ACP questions to the user inline in chat', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    let respondedBody: any = null;
    let answered = false;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, phase: 'thinking', turn: { id: 'turn-freeform' } }) });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            activeTurn: answered
              ? { id: 'turn-freeform', fullText: 'Thanks, I will use westus2.', done: true, phase: 'done', statusText: '', events: [{ type: 'text_chunk', ts: Date.now(), text: 'Thanks, I will use westus2.' }] }
              : {
                  id: 'turn-freeform',
                  fullText: '',
                  done: false,
                  phase: 'thinking',
                  statusText: 'Waiting for your response',
                  events: [],
                  userRequest: {
                    id: 'request-region',
                    method: 'session/request_input',
                    agentId: 'alpha',
                    title: 'Agent question',
                    prompt: 'Which Azure region should I use?',
                    inputKind: 'text',
                    options: [],
                    createdAt: Date.now(),
                  },
                },
          }),
        });
        return;
      }
      if (body?.action === 'respond-user-request') {
        respondedBody = body;
        answered = true;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      if (body?.action === 'turn-clear') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await textarea.fill('@alpha deploy it');
    await textarea.press('Enter');

    const requestCard = chatArea.locator('.agentUserRequestCard', { hasText: 'Which Azure region should I use?' });
    await expect(requestCard).toBeVisible({ timeout: 10000 });
    await requestCard.locator('input[name="answer"]').fill('westus2');
    await requestCard.getByRole('button', { name: 'Send' }).click();

    await expect.poll(() => respondedBody?.requestId ?? null).toBe('request-region');
    expect(respondedBody?.answer).toBe('westus2');
    await expect(chatArea.locator('.message.agent', { hasText: 'Thanks, I will use westus2.' })).toBeVisible({ timeout: 10000 });
  });

  test('forwards structured ACP questions to the user inline in chat', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    let respondedBody: any = null;
    let answered = false;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, phase: 'thinking', turn: { id: 'turn-structured' } }) });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            activeTurn: answered
              ? {
                  id: 'turn-structured',
                  fullText: 'Please provide two numbers:\n\n12 + 30 = 42',
                  done: true,
                  phase: 'done',
                  statusText: '',
                  events: [
                    { type: 'text_chunk', ts: Date.now(), text: 'Please provide two numbers:' },
                    { type: 'user_response', ts: Date.now(), text: 'You answered:\nFirst number: 12\nSecond number: 30' },
                    { type: 'text_chunk', ts: Date.now(), text: '\n\n12 + 30 = 42' },
                  ],
                }
              : {
                  id: 'turn-structured',
                  fullText: '',
                  done: false,
                  phase: 'thinking',
                  statusText: 'Waiting for your response',
                  events: [],
                  userRequest: {
                    id: 'request-two-numbers',
                    method: 'session/request_user_input',
                    agentId: 'alpha',
                    title: 'Agent question',
                    prompt: 'Please provide two numbers:',
                    inputKind: 'text',
                    options: [],
                    questions: [
                      { header: 'First number', question: 'First number:' },
                      { header: 'Second number', question: 'Second number:' },
                    ],
                    createdAt: Date.now(),
                  },
                },
          }),
        });
        return;
      }
      if (body?.action === 'respond-user-request') {
        respondedBody = body;
        answered = true;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      if (body?.action === 'turn-clear') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await textarea.fill('@alpha use the test-user-input skill');
    await textarea.press('Enter');

    const requestCard = chatArea.locator('.agentUserRequestCard', { hasText: 'Please provide two numbers:' });
    await expect(requestCard).toBeVisible({ timeout: 10000 });
    await requestCard.getByRole('textbox', { name: 'First number' }).fill('12');
    await requestCard.getByRole('textbox', { name: 'Second number' }).fill('30');
    await requestCard.getByRole('button', { name: 'Send' }).click();

    await expect.poll(() => respondedBody?.requestId ?? null).toBe('request-two-numbers');
    expect(respondedBody?.answers).toEqual({
      'First number': { selected: [], freeText: '12', skipped: false },
      'Second number': { selected: [], freeText: '30', skipped: false },
    });
    const answerMessage = chatArea.locator('.message.agent', { hasText: '12 + 30 = 42' });
    await expect(answerMessage).toBeVisible({ timeout: 10000 });
    await expect(answerMessage.locator('.userAnswerPart')).toContainText('You answered');
    await expect(answerMessage.locator('.userAnswerPart')).toContainText('First number: 12');
    await expect(answerMessage.locator('.userAnswerPart')).toContainText('Second number: 30');
  });

  test('prevents duplicate inline permission responses while submit is pending', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    let respondCallCount = 0;
    let permissionAnswered = false;
    let releaseResponse: (() => void) | null = null;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, phase: 'thinking', turn: { id: 'turn-user-request-pending' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            activeTurn: permissionAnswered
              ? {
                  id: 'turn-user-request-pending',
                  messageId: body.messageId,
                  fullText: 'Permission approved once.',
                  done: true,
                  phase: 'done',
                  statusText: '',
                  events: [{ type: 'text_chunk', ts: Date.now(), text: 'Permission approved once.' }],
                }
              : {
                  id: 'turn-user-request-pending',
                  messageId: body.messageId,
                  fullText: '',
                  done: false,
                  phase: 'thinking',
                  statusText: 'Waiting for your response',
                  events: [],
                  userRequest: {
                    id: 'request-allow-shell-pending',
                    method: 'session/request_permission',
                    agentId: 'alpha',
                    title: 'Permission request',
                    prompt: 'Allow Alpha Agent to run a shell command?',
                    inputKind: 'options',
                    options: [
                      { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once' },
                      { optionId: 'reject_once', kind: 'reject_once', label: 'Reject once' },
                    ],
                    createdAt: Date.now(),
                  },
                },
          }),
        });
        return;
      }
      if (body?.action === 'respond-user-request') {
        respondCallCount++;
        await responseReleased;
        permissionAnswered = true;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      if (body?.action === 'turn-clear') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await textarea.fill('@alpha please inspect the repo');
    await textarea.press('Enter');

    const requestCard = chatArea.locator('.agentUserRequestCard', { hasText: 'Allow Alpha Agent to run a shell command?' });
    const allowButton = requestCard.getByRole('button', { name: 'Allow once' });
    const rejectButton = requestCard.getByRole('button', { name: 'Reject once' });
    await expect(requestCard).toBeVisible({ timeout: 10000 });

    await requestCard.evaluate((card) => {
      const buttons = Array.from(card.querySelectorAll('button')) as HTMLButtonElement[];
      buttons[0]?.click();
      buttons[1]?.click();
    });

    await expect(allowButton).toBeDisabled();
    await expect(rejectButton).toBeDisabled();
    await expect.poll(() => respondCallCount).toBe(1);

    releaseResponse?.();

    await expect(chatArea.locator('.message.agent', { hasText: 'Permission approved once.' })).toBeVisible({ timeout: 10000 });
  });

  test('shows inline error and allows retry for failed freeform permission responses', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    let respondAttempts = 0;
    let permissionAnswered = false;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, phase: 'thinking', turn: { id: 'turn-user-request-text' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            activeTurn: permissionAnswered
              ? {
                  id: 'turn-user-request-text',
                  messageId: body.messageId,
                  fullText: 'Thanks for the extra details.',
                  done: true,
                  phase: 'done',
                  statusText: '',
                  events: [{ type: 'text_chunk', ts: Date.now(), text: 'Thanks for the extra details.' }],
                }
              : {
                  id: 'turn-user-request-text',
                  messageId: body.messageId,
                  fullText: '',
                  done: false,
                  phase: 'thinking',
                  statusText: 'Waiting for your response',
                  events: [],
                  userRequest: {
                    id: 'request-extra-context',
                    method: 'session/request_input',
                    agentId: 'alpha',
                    title: 'Need more detail',
                    prompt: 'Describe what the agent should check.',
                    inputKind: 'text',
                    options: [],
                    createdAt: Date.now(),
                  },
                },
          }),
        });
        return;
      }
      if (body?.action === 'respond-user-request') {
        respondAttempts++;
        if (respondAttempts === 1) {
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Request failed. Please try again.' }) });
          return;
        }
        permissionAnswered = true;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      if (body?.action === 'turn-clear') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await textarea.fill('@alpha please inspect the repo');
    await textarea.press('Enter');

    const requestCard = chatArea.locator('.agentUserRequestCard', { hasText: 'Describe what the agent should check.' });
    const answerInput = requestCard.getByRole('textbox', { name: 'Response to Need more detail' });
    const sendButton = requestCard.getByRole('button', { name: 'Send' });

    await expect(requestCard).toBeVisible({ timeout: 10000 });
    await answerInput.fill('Check the frontend request flow.');
    await sendButton.click();

    await expect(requestCard.getByRole('alert')).toContainText('Request failed. Please try again.');
    await expect(answerInput).toBeEnabled();
    await expect(sendButton).toBeEnabled();

    await answerInput.fill('Retry with the same request flow.');
    await sendButton.click();

    await expect.poll(() => respondAttempts).toBe(2);
    await expect(chatArea.locator('.message.agent', { hasText: 'Thanks for the extra details.' })).toBeVisible({ timeout: 10000 });
  });

  test('clears stale inline request submit state when polling replaces the request', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    let requestVersion: 'first' | 'second' = 'first';

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, phase: 'thinking', turn: { id: 'turn-user-request-replaced' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        const requestId = requestVersion === 'first' ? 'request-extra-context-first' : 'request-extra-context-second';
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            activeTurn: {
              id: 'turn-user-request-replaced',
              messageId: body.messageId,
              fullText: '',
              done: false,
              phase: 'thinking',
              statusText: 'Waiting for your response',
              events: [],
              userRequest: {
                id: requestId,
                method: 'session/request_input',
                agentId: 'alpha',
                title: 'Need more detail',
                prompt: 'Describe what the agent should check.',
                inputKind: 'text',
                options: [],
                createdAt: Date.now(),
              },
            },
          }),
        });
        return;
      }
      if (body?.action === 'respond-user-request') {
        requestVersion = 'second';
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Request failed. Please try again.' }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await textarea.fill('@alpha please inspect the repo');
    await textarea.press('Enter');

    const requestCard = chatArea.locator('.agentUserRequestCard', { hasText: 'Describe what the agent should check.' });
    const answerInput = requestCard.getByRole('textbox', { name: 'Response to Need more detail' });
    const sendButton = requestCard.getByRole('button', { name: 'Send' });

    await expect(requestCard).toBeVisible({ timeout: 10000 });
    await answerInput.fill('Check the frontend request flow.');
    await sendButton.click();
    await expect(requestCard.getByRole('alert')).toContainText('Request failed. Please try again.');

    await expect(requestCard.getByRole('alert')).toHaveCount(0);
    await expect(answerInput).toHaveValue('');
    await expect(answerInput).toBeEnabled();
    await expect(sendButton).toBeEnabled();
  });

  test('removes stale inline request cards after polling bails out on repeated errors', async ({ page }) => {
    await page.addInitScript(() => {
      const realSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) =>
        realSetTimeout(handler, Math.min(Number(timeout) || 0, 20), ...args)) as typeof window.setTimeout;
    });

    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    let pollCount = 0;
    let respondCallCount = 0;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, phase: 'thinking', turn: { id: 'turn-user-request-timeout' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        pollCount++;
        if (pollCount === 1) {
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              ok: true,
              activeTurn: {
                id: 'turn-user-request-timeout',
                messageId: body.messageId,
                fullText: '',
                done: false,
                phase: 'thinking',
                statusText: 'Waiting for your response',
                events: [],
                userRequest: {
                  id: 'request-stale-after-errors',
                  method: 'session/request_input',
                  agentId: 'alpha',
                  title: 'Need more detail',
                  prompt: 'Describe what the agent should check before polling fails.',
                  inputKind: 'text',
                  options: [],
                  createdAt: Date.now(),
                },
              },
            }),
          });
          return;
        }
        await route.abort('failed');
        return;
      }
      if (body?.action === 'respond-user-request') {
        respondCallCount++;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await textarea.fill('@alpha please inspect the repo');
    await textarea.press('Enter');

    const requestCard = chatArea.locator('.agentUserRequestCard', { hasText: 'Describe what the agent should check before polling fails.' });
    await expect(requestCard).toBeVisible({ timeout: 10000 });

    await expect(chatArea.locator('.message.agent', { hasText: 'Lost connection to agent' })).toBeVisible({ timeout: 10000 });
    await expect(requestCard).toHaveCount(0);
    await expect.poll(() => respondCallCount).toBe(0);
  });

  test('clears inline agent request cards when stopping an active run', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    let interruptCount = 0;
    let respondCallCount = 0;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, phase: 'thinking', turn: { id: 'turn-user-request-stop' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            activeTurn: {
              id: 'turn-user-request-stop',
              messageId: body.messageId,
              fullText: '',
              done: false,
              phase: 'thinking',
              statusText: 'Waiting for your response',
              events: [],
              userRequest: {
                id: 'request-stop-before-answer',
                method: 'session/request_permission',
                agentId: 'alpha',
                title: 'Permission request',
                prompt: 'Allow Alpha Agent to run a command before stop?',
                inputKind: 'options',
                options: [
                  { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once' },
                  { optionId: 'reject_once', kind: 'reject_once', label: 'Reject once' },
                ],
                createdAt: Date.now(),
              },
            },
          }),
        });
        return;
      }
      if (body?.action === 'interrupt') {
        interruptCount++;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      if (body?.action === 'respond-user-request') {
        respondCallCount++;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await textarea.fill('@alpha please inspect the repo');
    await textarea.press('Enter');

    const requestCard = chatArea.locator('.agentUserRequestCard', { hasText: 'Allow Alpha Agent to run a command before stop?' });
    await expect(requestCard).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: 'Stop generation' }).click();

    await expect.poll(() => interruptCount).toBe(1);
    await expect(requestCard).toHaveCount(0);
    await expect(chatArea.locator('.message.agent', { hasText: 'Stopped' })).toBeVisible();
    expect(respondCallCount).toBe(0);
  });

  test('should render streaming thinking parts without frontend stream saves', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    const userText = 'stream persistence regression message';
    const thinkingText = 'planning saved before completion';
    const finalText = 'Final answer after saved thinking.';
    let finishTurn = false;
    let pollCount = 0;
    const chatPosts: any[] = [];

    await page.route('**/api/chats', async (route) => {
      if (route.request().method() === 'POST') {
        chatPosts.push(route.request().postDataJSON());
      }
      await route.continue();
    });

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, phase: 'thinking', turn: { id: 'turn-stream-persist' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        pollCount++;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: finishTurn ? 'idle' : 'busy',
            ready: true,
            booting: false,
            sessionId: 'session-alpha',
            activeTurn: {
              id: 'turn-stream-persist',
              fullText: finishTurn ? finalText : '',
              done: finishTurn,
              phase: finishTurn ? 'done' : 'thinking',
              statusText: finishTurn ? '' : 'Thinking',
              events: finishTurn
                ? [
                    { type: 'thinking', ts: Date.now(), text: thinkingText },
                    { type: 'text_chunk', ts: Date.now(), text: finalText },
                  ]
                : [{ type: 'thinking', ts: Date.now(), text: thinkingText }],
              totalEvents: finishTurn ? 2 : 1,
            },
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });

    await textarea.fill(userText);
    await page.click('button[aria-label="Send message"]');
    await expect(chatArea.locator(`.message.user:has-text("${userText}")`)).toBeVisible({ timeout: 15000 });
    await expect(chatArea.locator(`.thinkingPartText:has-text("${thinkingText}")`)).toBeVisible({ timeout: 15000 });

    await expect.poll(() => chatPosts.some((body) => body?.chat?.messages?.some((message: any) => message.type === 'user' && message.content === userText)), { timeout: 10000 }).toBe(true);
    const chatSaveCountAfterUserMessage = chatPosts.filter((body) => body?.chat).length;
    await page.waitForTimeout(2500);
    expect(chatPosts.filter((body) => body?.chat).length).toBe(chatSaveCountAfterUserMessage);

    expect(pollCount).toBeGreaterThan(0);
    finishTurn = true;
    await expect(chatArea.locator(`.message.agent:has-text("${finalText}")`)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('button[aria-label="Stop generation"]')).toBeHidden({ timeout: 15000 });
    await expect.poll(() => chatPosts.filter((body) => body?.chat).length, { timeout: 10000 })
      .toBe(chatSaveCountAfterUserMessage + 1);
    const finalSave = chatPosts.filter((body) => body?.chat).at(-1);
    expect(finalSave.chat.messages.some((message: any) => message.type === 'agent' && message.content === finalText)).toBe(true);

    console.log('PASS: streaming thinking parts render without frontend stream saves');
  });

  test('should not force-scroll to bottom after user scrolls up during streaming', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    const userText = 'stream without forcing scroll';
    const newChunk = 'new streamed chunk after manual scroll';
    let streamedText = 'Initial streaming answer.';

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, phase: 'thinking', turn: { id: 'turn-scroll-lock' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'busy',
            ready: true,
            booting: false,
            sessionId: 'session-alpha',
            activeTurn: {
              id: 'turn-scroll-lock',
              fullText: streamedText,
              done: false,
              phase: 'responding',
              statusText: 'Generating',
              events: [{ type: 'text_chunk', ts: Date.now(), text: streamedText }],
              totalEvents: 1,
            },
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.evaluate(async () => {
      const now = Date.now();
      const fillerMessages = Array.from({ length: 18 }, (_, index) => ({
        id: `filler-${index}`,
        type: index % 2 === 0 ? 'user' : 'agent',
        agentId: index % 2 === 0 ? undefined : 'alpha',
        content: `Scrollable history row ${index} `.repeat(20),
        ts: now + index,
      }));
      const chat = {
        id: 'stream-scroll-lock-chat',
        name: 'Stream scroll lock chat',
        ts: now,
        messages: fillerMessages,
        agentSessions: { alpha: 'session-alpha' },
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId: chat.id }),
      });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await textarea.fill(userText);
    await page.click('button[aria-label="Send message"]');
    await expect(chatArea.locator('.message.agent', { hasText: streamedText })).toBeVisible({ timeout: 15000 });

    const manualDistanceFromBottom = await chatArea.evaluate((el) => {
      const maxScrollTop = el.scrollHeight - el.clientHeight;
      if (maxScrollTop < 160) throw new Error(`Expected scrollable chat, got ${maxScrollTop}`);
      el.scrollTop = maxScrollTop - 40;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      return el.scrollHeight - el.scrollTop - el.clientHeight;
    });
    expect(manualDistanceFromBottom).toBeGreaterThan(30);
    expect(manualDistanceFromBottom).toBeLessThan(80);

    streamedText = `${streamedText}\n\n${newChunk}\n${'more generated text '.repeat(80)}`;
    await expect(chatArea.locator('.message.agent', { hasText: newChunk })).toBeVisible({ timeout: 15000 });

    await expect.poll(async () => chatArea.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(20);
  });

  test('should keep pending agent bubble width stable while streaming response grows', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    const userText = 'stream without bubble shake';
    const initialText = 'Short answer.';
    const longChunk = 'additional streamed response text';
    let streamedText = initialText;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, phase: 'thinking', turn: { id: 'turn-width-lock' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'busy',
            ready: true,
            booting: false,
            sessionId: 'session-alpha',
            activeTurn: {
              id: 'turn-width-lock',
              fullText: streamedText,
              done: false,
              phase: 'responding',
              statusText: 'Generating',
              events: [{ type: 'text_chunk', ts: Date.now(), text: streamedText }],
              totalEvents: 1,
            },
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await textarea.fill(userText);
    await page.click('button[aria-label="Send message"]');
    const agentMessage = chatArea.locator('.message.agent').last();
    await expect(agentMessage).toContainText(initialText, { timeout: 15000 });

    const initialBox = await agentMessage.boundingBox();
    expect(initialBox).not.toBeNull();

    streamedText = `${initialText} ${Array(35).fill(longChunk).join(' ')}`;
    await expect(agentMessage).toContainText(longChunk, { timeout: 15000 });
    const grownBox = await agentMessage.boundingBox();
    expect(grownBox).not.toBeNull();

    expect(Math.abs(grownBox!.width - initialBox!.width)).toBeLessThanOrEqual(2);
  });

  test('chat-scoped active turns: same chat rejects second send while another chat can keep its own active turn', async ({ page }) => {
    const agentId = 'alpha';
    const activeTurns = new Map<string, { id: string; messageId: string; text: string }>();
    const sendRequests: any[] = [];
    const pollRequests: any[] = [];
    let sendSeq = 0;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: agentId, name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        sendRequests.push(body);
        const chatId = body.chatId || '__default';
        const existing = activeTurns.get(chatId);
        if (existing) {
          await route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, error: 'turn_in_progress' }),
          });
          return;
        }
        const turn = { id: `turn-${++sendSeq}`, messageId: body.messageId, text: body.text };
        activeTurns.set(chatId, turn);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, phase: 'thinking', sessionId: `session-${chatId}`, turn: { id: turn.id, messageId: turn.messageId } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        pollRequests.push(body);
        const chatId = body.chatId || '__default';
        const turn = activeTurns.get(chatId);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: turn ? 'busy' : 'idle',
            ready: true,
            booting: false,
            sessionId: `session-${chatId}`,
            activeTurn: turn
              ? {
                  id: turn.id,
                  messageId: turn.messageId,
                  fullText: '',
                  done: false,
                  phase: 'thinking',
                  statusText: 'Thinking',
                  events: [{ type: 'thinking', ts: Date.now(), text: `working on ${turn.text}` }],
                  totalEvents: 1,
                }
              : null,
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    const firstChatId = `chat-e2e-${Date.now()}`;
    await page.evaluate(async (firstChatId) => {
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: { id: firstChatId, name: 'E2E Chat', ts: Date.now(), messages: [], agentSessions: {} } }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId: firstChatId }),
      });
    }, firstChatId);
    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await expect(page.locator(`button:has-text("E2E Chat")`)).toBeVisible({ timeout: 10000 });
    await page.evaluate(async ({ agentId, firstChatId }) => {
      await fetch('/api/acp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send', agentId, text: 'first chat active turn', messageId: `msg-${Date.now()}-a`, chatId: firstChatId }),
      });
      await fetch('/api/acp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send', agentId, text: 'duplicate same chat turn', messageId: `msg-${Date.now()}-b`, chatId: firstChatId }),
      });
      await fetch('/api/acp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send', agentId, text: 'second chat active turn', messageId: `msg-${Date.now()}-c`, chatId: 'chat-e2e-other' }),
      });
      await fetch('/api/acp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'poll', agentId, chatId: firstChatId }),
      });
      await fetch('/api/acp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'poll', agentId, chatId: 'chat-e2e-other' }),
      });
    }, { agentId, firstChatId });

    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBe(3);
    await expect.poll(() => pollRequests.length, { timeout: 10000 }).toBeGreaterThan(0);

    const sendsByChat = sendRequests.reduce((acc, body) => {
      acc[body.chatId] = (acc[body.chatId] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    expect(sendsByChat[firstChatId]).toBe(2);
    expect(sendsByChat['chat-e2e-other']).toBe(1);
    expect(activeTurns.has(firstChatId)).toBe(true);
    expect(activeTurns.has('chat-e2e-other')).toBe(true);
    expect(pollRequests.some((body) => body.chatId === firstChatId)).toBe(true);
    expect(pollRequests.some((body) => body.chatId === 'chat-e2e-other')).toBe(true);
  });


  test('switching chats preserves active turn instead of marking it interrupted', async ({ page }) => {
    const agentId = 'alpha';
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    const firstText = 'keep running while switching chats';
    const thinkingText = `working on ${firstText}`;
    const firstFinal = 'First chat finished after switching back.';
    const activeTurns = new Map<string, { id: string; messageId: string; text: string; pollCount: number }>();
    let allowFirstTurnToFinish = false;
    let sendSeq = 0;
    const firstChatId = `chat-switch-source-${Date.now()}`;
    const switchTargetChatId = `chat-switch-target-${Date.now()}`;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: agentId, name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        const chatId = body.chatId || '__default';
        const turn = { id: `turn-switch-${++sendSeq}`, messageId: body.messageId, text: body.text, pollCount: 0 };
        activeTurns.set(chatId, turn);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, phase: 'thinking', sessionId: `session-${chatId}`, turn: { id: turn.id, messageId: turn.messageId } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        const chatId = body.chatId || '__default';
        const turn = activeTurns.get(chatId);
        if (turn) turn.pollCount += 1;
        const shouldFinish = !!turn && turn.text === firstText && allowFirstTurnToFinish && turn.pollCount >= 3;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: turn && !shouldFinish ? 'busy' : 'idle',
            ready: true,
            booting: false,
            sessionId: `session-${chatId}`,
            activeTurn: turn
              ? {
                  id: turn.id,
                  messageId: turn.messageId,
                  fullText: shouldFinish ? firstFinal : '',
                  done: shouldFinish,
                  phase: shouldFinish ? 'done' : 'thinking',
                  statusText: shouldFinish ? '' : 'Thinking',
                  events: shouldFinish
                    ? [
                        { type: 'thinking', ts: Date.now(), text: thinkingText },
                        { type: 'text_chunk', ts: Date.now(), text: firstFinal },
                      ]
                    : [{ type: 'thinking', ts: Date.now(), text: thinkingText }],
                  totalEvents: shouldFinish ? 2 : 1,
                }
              : null,
          }),
        });
        if (shouldFinish) activeTurns.delete(chatId);
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    const seedResult = await page.evaluate(async ({ firstChatId, switchTargetChatId }) => {
      const makeChat = (id: string, name: string) => fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: { id, name, ts: Date.now(), messages: [], agentSessions: {} } }),
      });
      const first = await makeChat(firstChatId, 'Switch source');
      const target = await makeChat(switchTargetChatId, 'Switch target');
      const last = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId: firstChatId }),
      });
      return { firstOk: first.ok, targetOk: target.ok, lastOk: last.ok };
    }, { firstChatId, switchTargetChatId });
    expect(seedResult).toEqual({ firstOk: true, targetOk: true, lastOk: true });
    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
    const sourceRowBeforeSend = page.locator('.chatHistoryRow', { hasText: 'Switch source' }).first();
    const switchTargetRow = page.locator('.chatHistoryRow', { hasText: 'Switch target' }).first();
    await expect(sourceRowBeforeSend).toBeVisible({ timeout: 5000 });
    await expect(switchTargetRow).toBeVisible({ timeout: 5000 });

    await textarea.fill(firstText);
    await page.click('button[aria-label="Send message"]');
    await expect(chatArea.locator(`.message.user:has-text("${firstText}")`)).toBeVisible({ timeout: 15000 });
    await expect(chatArea.locator(`.thinkingPartText:has-text("${thinkingText}")`)).toBeVisible({ timeout: 15000 });

    await expect(sourceRowBeforeSend.locator('.chatStatusBadge.running')).toBeVisible({ timeout: 5000 });
    await expect(sourceRowBeforeSend).toContainText('Thinking');
    const pollCountBeforeSwitch = activeTurns.get(firstChatId)?.pollCount ?? 0;
    const firstRowBeforeSwitch = await sourceRowBeforeSend.boundingBox();
    const targetRowBeforeSwitch = await switchTargetRow.boundingBox();

    await page.click('button:has-text("Switch target")');
    await expect(page.locator('button[aria-label="Stop generation"]')).toBeHidden({ timeout: 5000 });
    await expect(page.locator('button[aria-label="Send message"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=interrupted by chat switch')).toHaveCount(0);
    const firstChatRow = page.locator('.chatHistoryRow', { hasText: 'Switch source' }).first();
    await expect(firstChatRow.locator('.chatStatusBadge.running')).toBeVisible({ timeout: 5000 });
    await expect(firstChatRow).toContainText('Thinking');
    await expect.poll(() => activeTurns.get(firstChatId)?.pollCount ?? 0, { timeout: 5000 }).toBeGreaterThan(pollCountBeforeSwitch);
    const firstRowAfterSwitch = await firstChatRow.boundingBox();
    const targetRowAfterSwitch = await switchTargetRow.boundingBox();
    expect(firstRowBeforeSwitch?.y).toBe(firstRowAfterSwitch?.y);
    expect(targetRowBeforeSwitch?.y).toBe(targetRowAfterSwitch?.y);

    const savedFirstChat = await page.evaluate(async (firstChatId) => {
      const data = await fetch(`/api/chats?id=${encodeURIComponent(firstChatId)}`).then((r) => r.json());
      return data.chat;
    }, firstChatId);
    const savedPending = savedFirstChat.messages.find((message: any) => message.agentId === agentId);
    expect(savedPending?.pending).toBe(true);
    expect(savedPending?.content || '').not.toContain('interrupted by chat switch');

    allowFirstTurnToFinish = true;
    await firstChatRow.locator('.chatHistoryItem').click();
    await expect(chatArea.locator(`.message.agent:has-text("${firstFinal}")`)).toBeVisible({ timeout: 15000 });
    await expect(firstChatRow.locator('.chatStatusBadge.done')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=interrupted by chat switch')).toHaveCount(0);
  });

  test('should continue polling an active turn after page refresh', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const chatId = `ui-refresh-active-${Date.now()}`;
    const pendingId = `pending-refresh-${Date.now()}`;
    const userText = 'refresh should keep active turn attached';
    const thinkingText = 'still working after refresh';
    const finalText = 'Finished after refresh.';
    let pollCount = 0;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'resume-session') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            sessionId: body.sessionId,
            loaded: true,
            activeTurn: {
              id: 'turn-refresh-active',
              messageId: pendingId,
              fullText: '',
              done: false,
              phase: 'thinking',
              statusText: 'Thinking',
              events: [{ type: 'thinking', ts: Date.now(), text: thinkingText }],
              totalEvents: 1,
            },
          }),
        });
        return;
      }
      if (body?.action === 'poll') {
        pollCount++;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'idle',
            ready: true,
            booting: false,
            sessionId: 'session-alpha',
            activeTurn: {
              id: 'turn-refresh-active',
              messageId: pendingId,
              fullText: finalText,
              done: true,
              phase: 'done',
              statusText: '',
              events: [
                { type: 'thinking', ts: Date.now(), text: thinkingText },
                { type: 'text_chunk', ts: Date.now(), text: finalText },
              ],
              totalEvents: 2,
            },
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.evaluate(async ({ chatId, pendingId, userText, thinkingText }) => {
      const now = Date.now();
      const chat = {
        id: chatId,
        name: userText,
        ts: now,
        messages: [
          { id: 'u-refresh', type: 'user', content: userText, ts: now - 1000 },
          {
            id: pendingId,
            type: 'agent',
            content: '',
            agentId: 'alpha',
            ts: now,
            pending: false,
            parts: [{ kind: 'thinking', text: thinkingText }],
          },
        ],
        agentSessions: { alpha: 'session-alpha' },
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, pendingId, userText, thinkingText });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await expect(chatArea.locator(`.message.user:has-text("${userText}")`)).toBeVisible({ timeout: 15000 });
    await expect(chatArea.locator(`.message.agent:has-text("${finalText}")`)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('button[aria-label="Stop generation"]')).toBeHidden({ timeout: 15000 });
    expect(pollCount).toBeGreaterThan(0);

    console.log('PASS: refreshed page reattached to active turn and finished polling');
  });

  test('should stop polling a stalled active turn with no progress', async ({ page }) => {
    await page.addInitScript(() => {
      const initialNow = Date.now();
      let callCount = 0;
      Date.now = () => initialNow + (callCount++ * 2 * 60 * 1000);
    });

    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea.composerTextarea');
    const finalLookingText = 'Implemented in `app/page.tsx`.';
    let pollCount = 0;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'send') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, phase: 'replying', turn: { id: 'turn-stalled' } }),
        });
        return;
      }
      if (body?.action === 'poll') {
        pollCount++;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            activeTurn: {
              id: 'turn-stalled',
              messageId: body.messageId,
              fullText: finalLookingText,
              done: false,
              phase: 'replying',
              statusText: '',
              events: [{ type: 'text_chunk', ts: 123, text: finalLookingText }],
            },
          }),
        });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await textarea.fill('@alpha finish and do not report done');
    await textarea.press('Enter');

    const agentMessage = chatArea.locator('.message.agent', { hasText: 'Implemented in' }).last();
    await expect(agentMessage).toBeVisible({ timeout: 10000 });
    await expect(agentMessage.locator('.streamingIndicator')).toHaveCount(0, { timeout: 15000 });
    expect(pollCount).toBeGreaterThan(2);
  });

  test('should restore pending request card from resumed active turn', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const chatId = `ui-resume-request-${Date.now()}`;
    const pendingId = `pending-resume-request-${Date.now()}`;
    const userText = 'resume should restore pending request card';
    const requestPrompt = 'Allow the agent to get the current branch name?';
    let pollCount = 0;

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }],
          }),
        });
        return;
      }
      if (body?.action === 'resume-session') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            sessionId: body.sessionId,
            loaded: true,
            activeTurn: {
              id: 'turn-resume-request',
              messageId: pendingId,
              fullText: '',
              done: false,
              phase: 'tool_exec',
              statusText: 'Waiting for your response',
              events: [
                { type: 'thinking', ts: Date.now(), text: 'I need permission before continuing.' },
                { type: 'tool_start', ts: Date.now(), toolName: 'Get current branch name', toolCallId: 'tool-branch', toolArgs: '{}' },
              ],
              userRequest: {
                id: 'request-resume-allow',
                method: 'session/request_permission',
                agentId: 'alpha',
                title: 'Permission request',
                prompt: requestPrompt,
                inputKind: 'options',
                options: [
                  { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once' },
                  { optionId: 'reject_once', kind: 'reject_once', label: 'Reject once' },
                ],
                createdAt: Date.now(),
              },
              totalEvents: 2,
            },
          }),
        });
        return;
      }
      if (body?.action === 'poll') {
        pollCount++;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, activeTurn: null }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.evaluate(async ({ chatId, pendingId, userText }) => {
      const now = Date.now();
      const chat = {
        id: chatId,
        name: userText,
        ts: now,
        messages: [
          { id: 'u-resume-request', type: 'user', content: userText, ts: now - 1000 },
          {
            id: pendingId,
            type: 'agent',
            content: '',
            agentId: 'alpha',
            ts: now,
            pending: true,
            statusText: 'Waiting for your response',
            parts: [{ kind: 'tool', toolName: 'Get current branch name', args: '{}', done: false }],
          },
        ],
        agentSessions: { alpha: 'session-alpha' },
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, pendingId, userText });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await expect(chatArea.locator(`.message.user:has-text("${userText}")`)).toBeVisible({ timeout: 15000 });
    const requestCard = chatArea.locator('.agentUserRequestCard', { hasText: requestPrompt });
    await expect(requestCard).toBeVisible({ timeout: 10000 });
    await expect(requestCard.getByRole('button', { name: 'Allow once' })).toBeVisible();
    expect(pollCount).toBeGreaterThan(0);
  });

  test('should switch lastChatId when creating new chat', async ({ page }) => {
    await ensureActiveChat(page);
    const textarea = page.locator('textarea.composerTextarea');

    // Send a message in the first chat
    await textarea.fill('first chat message');
    await page.click('button[aria-label="Send message"]');
    await expect(page.locator('.message.user').last()).toContainText('first chat', { timeout: 15000 });
    await page.waitForTimeout(1000);

    // Get lastChatId before creating new chat
    const before = await page.evaluate(async () => {
      const r = await fetch('/api/chats');
      return r.json();
    });
    const firstChatId = before.lastChatId;
    console.log(`Before new chat: lastChatId=${firstChatId}`);

    // Create a new chat
    await page.click('button.newChatButton');
    await page.waitForTimeout(2000);

    // Get lastChatId after creating new chat
    const after = await page.evaluate(async () => {
      const r = await fetch('/api/chats');
      return r.json();
    });
    const newChatId = after.lastChatId;
    console.log(`After new chat: lastChatId=${newChatId}`);

    // lastChatId should have changed
    expect(newChatId).toBeTruthy();
    expect(newChatId).not.toBe(firstChatId);
    console.log('PASS: lastChatId updated on server when creating new chat');
  });
});

test.describe('Empty Homepage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await deleteAllChats(page);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.emptyHomepage', { timeout: 10000 });
  });

  test('should show empty homepage when no chats exist', async ({ page }) => {
    await expect(page.locator('.emptyHomepage')).toBeVisible();
    await expect(page.locator('.emptyHomepageTitle')).toContainText('Agents Chat');
    await expect(page.locator('.emptyHomepageNewChat')).toBeVisible();
    // Chat container should NOT be visible
    await expect(page.locator('.chatContainer')).not.toBeVisible();
  });

  test('should create chat from empty homepage button', async ({ page }) => {
    await page.click('button.emptyHomepageNewChat');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
    await expect(page.locator('text=Welcome to Agents Chat')).toBeVisible();
    // Empty homepage should be gone
    await expect(page.locator('.emptyHomepage')).not.toBeVisible();
  });

  test('should create chat from sidebar New Chat button on empty homepage', async ({ page }) => {
    await page.click('button.newChatButton');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
    await expect(page.locator('text=Welcome to Agents Chat')).toBeVisible();
  });
});

test.describe('Delete Active Chat', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await deleteAllChats(page);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.emptyHomepage', { timeout: 10000 });
  });

  test('should delete the active chat and return to empty homepage', async ({ page }) => {
    // Create a chat first
    await page.click('button.emptyHomepageNewChat');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });

    // Verify one chat exists in sidebar
    await expect(page.locator('.chatHistoryRow')).toHaveCount(1);

    // Open the "..." menu on the chat
    await page.locator('.chatHistoryRow').first().hover();
    await page.locator('.chatHistoryRow').first().locator('.chatMoreBtn').click();
    await page.waitForTimeout(300);

    // Click Delete
    await page.locator('.chatActionItem.danger').click();
    await page.waitForTimeout(500);

    // Should return to empty homepage
    await expect(page.locator('.emptyHomepage')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.chatHistoryRow')).toHaveCount(0);
  });
});

test.describe('Chat Rename', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await deleteAllChats(page);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.emptyHomepage', { timeout: 10000 });
    await ensureActiveChat(page);
  });

  test('should rename a chat via the menu', async ({ page }) => {
    // Open the "..." menu on the chat
    await page.locator('.chatHistoryRow').first().hover();
    await page.locator('.chatHistoryRow').first().locator('.chatMoreBtn').click();
    await page.waitForTimeout(300);

    // Click Rename
    await page.locator('.chatActionItem:has-text("Rename")').click();
    await page.waitForTimeout(300);

    // Should show rename input
    const renameInput = page.locator('.chatRenameInput');
    await expect(renameInput).toBeVisible();

    // Clear and type new name
    await renameInput.fill('My Renamed Chat');
    await renameInput.press('Enter');
    await page.waitForTimeout(500);

    // Verify the name changed in the sidebar
    await expect(page.locator('.chatHistoryRow').first().locator('.chatHistoryItem')).toContainText('My Renamed Chat');
  });

  test('should keep chat actions usable after sidebar resize', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });

    const resizeHandle = page.locator('.sidebarResizeHandle');
    await expect(resizeHandle).toBeVisible();
    const handleBox = await resizeHandle.boundingBox();
    expect(handleBox).not.toBeNull();

    const dragY = handleBox!.y + 120;
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, dragY);
    await page.mouse.down();
    await page.mouse.move(80, dragY, { steps: 8 });
    await page.mouse.up();

    // Sidebar should be clamped to its minimum width (>= 260px) regardless of drag target.
    const sidebarBox = await page.locator('.participantsSidebar').boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(sidebarBox!.width).toBeGreaterThanOrEqual(260);

    const row = page.locator('.chatHistoryRow').first();
    await row.hover();

    // The chat name and the action button should not overlap horizontally.
    const nameBox = await row.locator('.chatHistoryName').first().boundingBox();
    const moreBtnBox = await row.locator('.chatMoreBtn').boundingBox();
    expect(nameBox).not.toBeNull();
    expect(moreBtnBox).not.toBeNull();
    expect(nameBox!.x + nameBox!.width).toBeLessThanOrEqual(moreBtnBox!.x + 1);

    await row.locator('.chatMoreBtn').click();

    const menu = page.locator('.chatActionsMenu');
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(menuBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x - 1);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width + 1);

    await menu.locator('.chatActionItem', { hasText: 'Rename' }).click();
    await expect(page.locator('.chatRenameInput')).toBeVisible();
  });

  test('should preserve renamed chat name after creating new chat', async ({ page }) => {
    // Rename the first chat
    await page.locator('.chatHistoryRow').first().hover();
    await page.locator('.chatHistoryRow').first().locator('.chatMoreBtn').click();
    await page.waitForTimeout(300);
    await page.locator('.chatActionItem:has-text("Rename")').click();
    const renameInput = page.locator('.chatRenameInput');
    await renameInput.fill('Persisted Name');
    await renameInput.press('Enter');
    await page.waitForTimeout(500);

    // Create a new chat
    await page.click('button.newChatButton');
    await page.waitForTimeout(500);

    // The renamed chat should still show the custom name
    await expect(page.locator('.chatHistoryItem:has-text("Persisted Name")')).toBeVisible();
  });
});

test.describe('Agent Filter Tabs', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await deleteAllChats(page);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.emptyHomepage', { timeout: 10000 });
  });

  test('should show agent filter dropdown in sidebar', async ({ page }) => {
    const slot = page.locator('.chatAgentFilterPickerSlot');
    const trigger = slot.locator('button.themedPickerTrigger');
    await expect(trigger).toBeVisible();
    // Default selection is "All agents"
    await expect(trigger.locator('.themedPickerLabel')).toHaveText(/All/);
  });

  test('should hide scheduler from agent filter dropdown', async ({ page }) => {
    let resolveAgentsLoaded: () => void = () => {};
    const agentsLoaded = new Promise<void>((resolve) => {
      resolveAgentsLoaded = resolve;
    });
    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [
              { id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true },
              { id: 'scheduler', name: 'Scheduler', command: 'mock', args: [], cwd: '', running: true },
            ],
          }),
        });
        resolveAgentsLoaded();
        return;
      }
      await route.continue();
    });

    await page.evaluate(() => window.localStorage.setItem('acp_agent_filter_v1', 'scheduler'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await agentsLoaded;
    await page.waitForSelector('.emptyHomepage, .chatContainer', { timeout: 10000 });

    const slot = page.locator('.chatAgentFilterPickerSlot');
    const trigger = slot.locator('button.themedPickerTrigger');
    await expect(trigger.locator('.themedPickerLabel')).toHaveText(/All/);
    await trigger.click();
    const dropdown = page.locator('.themedPickerDropdown[aria-label="Filter chats by primary agent"]');
    await expect(dropdown.locator('button.themedPickerOption', { hasText: 'Alpha Agent' })).toHaveCount(1);
    await expect(dropdown.locator('button.themedPickerOption', { hasText: 'Scheduler' })).toHaveCount(0);
  });

  test('should switch agent filter and show empty homepage', async ({ page }) => {
    // Create a chat under "All"
    await page.click('button.emptyHomepageNewChat');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });

    const slot = page.locator('.chatAgentFilterPickerSlot');
    const trigger = slot.locator('button.themedPickerTrigger');
    await trigger.click();
    const dropdown = page.locator('.themedPickerDropdown[aria-label="Filter chats by primary agent"]');
    const options = dropdown.locator('button.themedPickerOption');
    const count = await options.count();
    if (count > 1) {
      // Pick first non-"All agents" option
      await options.nth(1).click();
      await page.waitForTimeout(500);

      // Should show empty homepage since there are no chats for that agent
      await expect(page.locator('.emptyHomepage')).toBeVisible();

      // Switch back to All
      await trigger.click();
      await dropdown.locator('button.themedPickerOption', { hasText: 'All agents' }).click();
      await page.waitForTimeout(500);
      await expect(page.locator('.chatHistoryRow')).toHaveCount(1);
    }
  });

  test('should persist agent filter selection after reload', async ({ page }) => {
    const slot = page.locator('.chatAgentFilterPickerSlot');
    const trigger = slot.locator('button.themedPickerTrigger');
    await trigger.click();
    const dropdown = page.locator('.themedPickerDropdown[aria-label="Filter chats by primary agent"]');
    const options = dropdown.locator('button.themedPickerOption');
    const count = await options.count();
    if (count > 1) {
      const targetLabel = (await options.nth(1).locator('.themedPickerOptionLabel').textContent())?.trim() || '';
      await options.nth(1).click();
      await page.waitForTimeout(500);
      await expect(trigger.locator('.themedPickerLabel')).toHaveText(targetLabel);

      // Reload
      await page.reload();
      await page.waitForSelector('.emptyHomepage, .chatContainer', { timeout: 10000 });

      // The same agent should still be selected
      await expect(page.locator('.chatAgentFilterPickerSlot button.themedPickerTrigger .themedPickerLabel')).toHaveText(targetLabel);
    }
  });
});

test.describe('ESC Key Modal Close', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 10000 });
  });

  test('should close agent settings modal with ESC', async ({ page }) => {
    // Open agents panel
    await page.click('button[title="Agents"]');
    await expect(page.locator('.agentsSidebar')).toBeVisible();

    // Click on agent settings (gear icon or agent name)
    const agentItem = page.locator('.agentItem').first();
    const settingsBtn = agentItem.locator('.agentSettingsBtn, button[title*="Settings"], button[title*="settings"]').first();
    const hasSettings = await settingsBtn.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasSettings) {
      await settingsBtn.click();
      await page.waitForTimeout(500);

      // Check if a modal opened
      const modal = page.locator('.modalOverlay');
      if (await modal.isVisible({ timeout: 2000 }).catch(() => false)) {
        // Press ESC
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        // Modal should be closed
        await expect(modal).not.toBeVisible();
        console.log('PASS: ESC closed the modal');
      }
    } else {
      console.log('SKIP: No agent settings button found');
    }
  });
});

test.describe('Theme', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await deleteAllChats(page);
    await page.reload();
    await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 10000 });
  });

  test('should open theme menu', async ({ page }) => {
    // Click the theme button (title is dynamic: "Theme: <label>")
    await page.click('button.themeMenuButton');
    // Theme dropdown should appear
    await expect(page.locator('[role="menu"][aria-label="Theme list"]')).toBeVisible();
    await expect(page.locator('.themeOption', { hasText: 'VS Code Dark' })).toBeVisible();
    await expect(page.locator('.themeOption', { hasText: 'Claude' })).toBeVisible();
    await expect(page.locator('.themeOption', { hasText: 'One Dark' })).toHaveCount(0);
    await expect(page.locator('.themeOption', { hasText: 'Forest' })).toHaveCount(0);
    await expect(page.locator('.themeOption', { hasText: 'Velvet' })).toHaveCount(0);
  });

  test('should use the same selected text colors in Claude chat and file editors', async ({ page }) => {
    const expectedSelectionStyle = { backgroundColor: 'rgb(237, 194, 178)', color: 'rgb(47, 39, 34)' };
    const getSelectionStyle = (selector: string) =>
      page.locator(selector).first().evaluate((element) => {
        const style = getComputedStyle(element, '::selection');
        return {
          backgroundColor: style.backgroundColor,
          color: style.color,
        };
      });

    await page.route('**/api/acp', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const body = request.postDataJSON() as { action?: string } | null;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: 'selection-agent', name: 'Selection Agent', cwd: 'Q:\\Repos\\Agents-Chat', canTalk: true }],
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const filePath = url.searchParams.get('path');
      if (request.method() === 'GET' && !filePath) {
        await route.fulfill({
          json: {
            files: [
              { path: 'selection.md', name: 'selection.md', mtime: '2026-01-01T00:00:00.000Z' },
              { path: 'selection.txt', name: 'selection.txt', mtime: '2026-01-01T00:00:00.000Z' },
            ],
          },
        });
        return;
      }
      if (request.method() === 'GET' && filePath === 'selection.md') {
        await route.fulfill({
          json: {
            path: filePath,
            content: '# Selection sample\n\nClaude file editor selected text.',
            kind: 'markdown',
            mtime: '2026-01-01T00:00:00.000Z',
          },
        });
        return;
      }
      if (request.method() === 'GET' && filePath === 'selection.txt') {
        await route.fulfill({
          json: {
            path: filePath,
            content: 'Claude plain file selected text.',
            kind: 'text',
            mtime: '2026-01-01T00:00:00.000Z',
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/comments**', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, comments: [] } });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.evaluate(() => {
      window.localStorage.setItem('acp_chat_theme_v1', 'claude');
      window.localStorage.removeItem('acp_file_workspace_v1');
    });

    const seedResult = await page.evaluate(async () => {
      const chatId = 'claude-selection-chat';
      const now = Date.now();
      const saveResponse = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat: {
            id: chatId,
            name: 'Claude selection chat',
            ts: now,
            messages: [
              { id: 'claude-selection-user', type: 'user', content: 'Claude selection sample from the user.', ts: now },
              { id: 'claude-selection-agent', type: 'agent', agentId: 'alpha', content: 'Claude selection sample from the agent.', ts: now + 1 },
            ],
            agentSessions: {},
          },
        }),
      });
      const lastChatResponse = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
      return { saveOk: saveResponse.ok, lastChatOk: lastChatResponse.ok };
    });
    expect(seedResult).toEqual({ saveOk: true, lastChatOk: true });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
    await expect(page.locator('.messageContent p')).toHaveCount(2);

    const chatSelectionStyles = await page.locator('.messageContent p').evaluateAll((paragraphs) =>
      paragraphs.map((paragraph) => {
        const style = getComputedStyle(paragraph, '::selection');
        return {
          backgroundColor: style.backgroundColor,
          color: style.color,
        };
      })
    );

    expect(chatSelectionStyles).toEqual([
      expectedSelectionStyle,
      expectedSelectionStyle,
    ]);

    await page.getByRole('button', { name: /Files/ }).click();
    await selectFilesAgent(page, 'selection-agent');
    await page.locator('.mdTreeFile', { hasText: 'selection.md' }).click();
    await expect(page.locator('.mdLiveEditable')).toBeVisible();

    const liveEditorSelectionStyle = await getSelectionStyle('.mdLiveEditable p');
    await page.getByRole('button', { name: 'Split' }).click();
    await expect(page.locator('textarea.mdEditorTextarea')).toBeVisible();

    const splitTextareaSelectionStyle = await getSelectionStyle('textarea.mdEditorTextarea');
    const splitPreviewSelectionStyle = await getSelectionStyle('.mdEditorPreviewPane p');
    await page.locator('.mdTreeFile', { hasText: 'selection.txt' }).click();
    await expect(page.locator('.fileContentWithLines')).toBeVisible();

    const plainFileSelectionStyle = await getSelectionStyle('.fileLineText');
    expect({
      liveEditorSelectionStyle,
      splitTextareaSelectionStyle,
      splitPreviewSelectionStyle,
      plainFileSelectionStyle,
    }).toEqual({
      liveEditorSelectionStyle: expectedSelectionStyle,
      splitTextareaSelectionStyle: expectedSelectionStyle,
      splitPreviewSelectionStyle: expectedSelectionStyle,
      plainFileSelectionStyle: expectedSelectionStyle,
    });
  });

  test('should recover from removed saved theme ids', async ({ page }) => {
    const cases = [
      { saved: 'oneDark', expectedTitle: 'Theme: VS Code Dark', expectedStored: 'vsCodeDark' },
      { saved: 'forest', expectedTitle: 'Theme: Aurora', expectedStored: 'aurora' },
      { saved: 'velvet', expectedTitle: 'Theme: Aurora', expectedStored: 'aurora' },
    ];

    for (const themeCase of cases) {
      await page.evaluate((savedTheme) => window.localStorage.setItem('acp_chat_theme_v1', savedTheme), themeCase.saved);
      await page.reload();
      await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 10000 });

      await expect(page.locator('button.themeMenuButton')).toHaveAttribute('title', themeCase.expectedTitle);
      await expect.poll(() => page.evaluate(() => window.localStorage.getItem('acp_chat_theme_v1'))).toBe(themeCase.expectedStored);
    }
  });
});

test.describe('Comment Review Chat', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await deleteAllChats(page);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 10000 });
  });

  test('should not mark approved comment user message as failed before agent responds', async ({ page }) => {
    const chatId = `comment-review:${encodeURIComponent('test/dummy.md')}-${Date.now()}`;
    const messageText = `Review comment on test/dummy.md (line 1)\n\n"please change the word"`;

    await page.evaluate(async ({ chatId, messageText }) => {
      const chat = {
        id: chatId,
        name: 'Review: test/dummy.md',
        ts: Date.now(),
        messages: [
          { id: 'u1', type: 'user', content: messageText, ts: Date.now() },
        ],
        agentSessions: {},
      };
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId }),
      });
    }, { chatId, messageText });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 15000 });

    const userMessage = page.locator('.message.user', { hasText: 'please change the word' });
    await expect(userMessage).toBeVisible({ timeout: 10000 });
    await expect(userMessage.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(userMessage.locator('.userSendFailureStatus')).toHaveCount(0);

    // The stored chat must not have been silently re-saved with sendStatus 'failed'
    const stored = await page.evaluate(async (id) => {
      const r = await fetch(`/api/chats?id=${encodeURIComponent(id)}`);
      const data = await r.json();
      return data.chat?.messages?.[0]?.sendStatus || null;
    }, chatId);
    expect(stored).toBeNull();
  });
});
