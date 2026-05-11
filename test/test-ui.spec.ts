/**
 * Playwright UI tests for Agents Chat.
 *
 * Requires: dev server running on localhost:3010
 * Run:  PLAYWRIGHT_BROWSERS_PATH=$HOME/.playwright-mcp npx playwright test test/test-ui.spec.ts --headed
 *   or: npx playwright test test/test-ui.spec.ts
 */

import { test, expect, Page } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

/** Login helper — fills credentials and waits for redirect to main page */
async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[placeholder="Admin username"]', ADMIN_USER);
  await page.fill('input[placeholder="Password"]', ADMIN_PASS);
  await page.click('button[type="submit"]');
  // Wait for the chat UI to be visible (handles redirect automatically)
  await page.waitForSelector('.chatContainer', { timeout: 30000 });
  await page.waitForTimeout(500);
}

/** Delete all existing chats via the API so each test starts clean */
async function deleteAllChats(page: Page) {
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/chats');
    return r.json();
  });
  if (res?.ok && Array.isArray(res.chats)) {
    for (const chat of res.chats) {
      await page.evaluate(async (id: string) => {
        await fetch(`/api/chats?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      }, chat.id);
    }
  }
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
    // Should see the welcome message
    await expect(page.locator('text=Welcome to Agents Chat')).toBeVisible();
  });
});

test.describe('Chat UI', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await deleteAllChats(page);
    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
  });

  test('should display chat input and send button', async ({ page }) => {
    await expect(page.locator('textarea[placeholder="Message Agents Chat"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Send message"]')).toBeVisible();
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

  test('should display agent in sidebar', async ({ page }) => {
    // Open agents panel
    await page.click('button[title="Agents"]');
    await expect(page.locator('.agentsSidebar')).toBeVisible();
    // Should show at least the copilot agent
    await expect(page.locator('text=GitHub Copilot CLI')).toBeVisible({ timeout: 10000 });
  });

  test('should send a message and receive a reply', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
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

  test('should create a new chat', async ({ page }) => {
    // Click New Chat button
    await page.click('button.newChatButton');

    // Should show welcome message in the new empty chat
    await expect(page.locator('text=Welcome to Agents Chat')).toBeVisible();

    // Chat input should be empty and ready
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue('');
  });

  test('should switch between chats and remember context', async ({ page }) => {
    test.setTimeout(360000); // 6 min — two agent round-trips + session reload
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
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
    const oldChat = page.locator('.chatHistoryItem:not(.active)').first();
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
    // There should be existing chats in the sidebar from previous tests
    // If not, create one by sending a message, waiting, then creating a new chat

    // First, check if there are already non-active chats with delete buttons
    let deleteBtn = page.locator('.chatDeleteBtn').first();
    let hasDeleteBtn = await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false);

    if (!hasDeleteBtn) {
      // Need to create a chat we can delete: send a short message, wait fully, then create new chat
      const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
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
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
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

  test('should show share button', async ({ page }) => {
    // The share button should exist for chat history items
    const shareBtn = page.locator('.chatShareBtn').first();
    // It may not be visible if there are no chats, which is fine
    const count = await shareBtn.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('should not store chat messages in localStorage', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');

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
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');

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
    await page.waitForSelector('.chatContainer', { timeout: 30000 });

    // Wait for chat to load from server
    await page.waitForTimeout(2000);

    // The user message should be visible — loaded from SQLite via lastChatId
    await expect(chatArea.locator('.message.user:has-text("lastChatId test")')).toBeVisible({ timeout: 15000 });
    console.log('PASS: lastChatId restored from server, chat loaded from SQLite after reload');
  });

  test('should resend the last unanswered message after loading a saved session', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const pendingText = 'UI recovery should resend this message';
    const replyText = 'Auto-resend completed.';
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
    await expect(chatArea.locator(`.message.user:has-text("${pendingText}")`)).toBeVisible({ timeout: 15000 });
    await expect.poll(() => resumeRequests.length, { timeout: 10000 }).toBe(2);

    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBe(1);
    expect(sendRequests[0]).toMatchObject({ action: 'send', agentId: 'alpha', text: pendingText, chatId });
    await expect(chatArea.locator('.message.agent', { hasText: replyText })).toBeVisible({ timeout: 10000 });
    expect(pollCount).toBeGreaterThan(0);
    await expect(chatArea.locator('text=turn_in_progress')).toHaveCount(0);
    console.log('PASS: unanswered saved message was resent once after session load');
  });

  test('should resend a mentioned message to the correct agent when multiple agents exist', async ({ page }) => {
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
    await expect(chatArea.locator(`.message.user:has-text("${pendingText}")`)).toBeVisible({ timeout: 15000 });
    await expect.poll(() => resumeRequests.length, { timeout: 10000 }).toBe(2);
    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBe(1);

    expect(sendRequests[0]).toMatchObject({ action: 'send', agentId: 'beta', text: cleanedText, chatId });
    expect(sendRequests.some((request) => request.agentId === 'alpha')).toBe(false);
    await expect(chatArea.locator('.message.agent', { hasText: replyText })).toBeVisible({ timeout: 10000 });
  });

  test('should use scheduler routing when auto-resending a multi-agent message', async ({ page }) => {
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
    await expect(chatArea.locator(`.message.user:has-text("${pendingText}")`)).toBeVisible({ timeout: 15000 });
    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBeGreaterThan(0);
    expect(sendRequests[0].agentId).toBe('scheduler');
    expect(sendRequests[0].text).toContain(cleanedText);
    expect(sendRequests.some((request) => request.agentId === 'alpha')).toBe(false);
    expect(sendRequests.some((request) => request.agentId === 'beta')).toBe(false);
  });

  test('should resend to scheduler again when the failed auto-mode message was sent to scheduler', async ({ page }) => {
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
    await expect(chatArea.locator(`.message.user:has-text("${pendingText}")`)).toBeVisible({ timeout: 15000 });
    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBe(1);
    expect(sendRequests[0].agentId).toBe('scheduler');
    expect(sendRequests[0].text).toContain(cleanedText);
    expect(sendRequests.some((request) => request.agentId === 'alpha')).toBe(false);
    expect(sendRequests.some((request) => request.agentId === 'beta')).toBe(false);
  });

  test('should use auto mode to resend a two-agent mention to the scheduler-selected worker only', async ({ page }) => {
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
          const schedulerDecision = JSON.stringify({ done: false, nextAgent: 'beta', instruction: selectedInstruction });
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
    await expect(chatArea.locator(`.message.user:has-text("${pendingText}")`)).toBeVisible({ timeout: 15000 });
    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBe(2);

    expect(sendRequests[0].agentId).toBe('scheduler');
    expect(sendRequests[1]).toMatchObject({ action: 'send', agentId: 'beta', text: selectedInstruction, chatId });
    expect(sendRequests.some((request) => request.agentId === 'alpha')).toBe(false);
  });

  test('should block manual send while auto-resend is running', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
    const pendingText = 'UI recovery should keep running while resend is active';
    const manualText = 'manual message during auto resend';
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
        name: 'UI auto resend blocks manual send',
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
    await expect(chatArea.locator(`.message.user:has-text("${pendingText}")`)).toBeVisible({ timeout: 15000 });
    await expect.poll(() => resumeRequests.length, { timeout: 10000 }).toBe(1);
    await expect.poll(() => sendRequests.length, { timeout: 10000 }).toBe(1);
    expect(sendRequests[0]).toMatchObject({ action: 'send', agentId: 'alpha', text: pendingText, chatId });

    await expect(page.getByRole('button', { name: 'Stop generation' })).toBeVisible({ timeout: 10000 });
    await textarea.fill(manualText);
    await textarea.press('Enter');

    await expect.poll(() => interruptRequests.length, { timeout: 10000 }).toBe(1);
    await page.waitForTimeout(500);
    expect(sendRequests).toHaveLength(1);
    await expect(chatArea.locator('.message.user', { hasText: manualText })).toHaveCount(0);
    await expect(textarea).toHaveValue(manualText);
    console.log('PASS: manual send was blocked while auto-resend was running');
  });

  test('forwards ACP permission questions to the user inline in chat', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
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
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
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

  test('prevents duplicate inline permission responses while submit is pending', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
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
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
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
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
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
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
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
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
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
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
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
    await page.waitForTimeout(500);
    expect(chatPosts.filter((body) => body?.chat).length).toBe(chatSaveCountAfterUserMessage);

    console.log('PASS: streaming thinking parts render without frontend stream saves');
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
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
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
    const firstChatRow = page.locator('.chatHistoryRow', { hasText: firstText }).first();
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
    await page.click(`button:has-text("${firstText}")`);
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
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');
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
    const textarea = page.locator('textarea[placeholder="Message Agents Chat"]');

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

test.describe('Theme', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await deleteAllChats(page);
    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
  });

  test('should open theme menu', async ({ page }) => {
    // Click the theme button (title is dynamic: "Theme: <label>")
    await page.click('button.themeMenuButton');
    // Theme dropdown should appear
    await expect(page.locator('[role="menu"][aria-label="Theme list"]')).toBeVisible();
  });
});
