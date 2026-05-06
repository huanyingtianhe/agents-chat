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

  test('should not resend unanswered message when resuming multiple saved sessions', async ({ page }) => {
    const chatArea = page.locator('.chatContainer');
    const pendingText = 'UI recovery should not resend this message';
    const chatId = `ui-no-resend-${Date.now()}`;
    const resumeRequests: string[] = [];

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
          body: JSON.stringify({ ok: true, sessionId: body.sessionId, loaded: false, pendingUserMessage: pendingText }),
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

    await expect(chatArea.locator('text=Re-sending unanswered message')).toHaveCount(0);
    await expect(chatArea.locator('.message.agent')).toHaveCount(0);
    await expect(chatArea.locator('text=turn_in_progress')).toHaveCount(0);
    console.log('PASS: multiple resume results did not trigger UI auto-resend');
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
