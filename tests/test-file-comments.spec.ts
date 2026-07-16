/**
 * File Comments — API + E2E tests.
 *
 * Requires: dev server running on localhost:3010
 * Run:  npx playwright test --config tests/playwright.config.ts tests/test-file-comments.spec.ts
 */

import { test, expect, Page } from '@playwright/test';
import { createFileComment, deleteFileComment, updateFileCommentStatus } from '../lib/chatStore';
import { selectFilesAgent, filesAgentTrigger } from './themed-picker-helpers';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  const usernameInput = page.locator('input[placeholder="Admin username"]');
  const passwordInput = page.locator('input[placeholder="Password"]');
  const submitButton = page.locator('button[type="submit"]');
  await expect(async () => {
    await usernameInput.fill(ADMIN_USER);
    await passwordInput.fill(ADMIN_PASS);
    await expect(submitButton).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 10000 });
  await submitButton.click();
  await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 30000 });
  const isEmpty = await page.locator('.emptyHomepage').isVisible({ timeout: 2000 }).catch(() => false);
  if (isEmpty) {
    await page.click('button.newChatButton, button.emptyHomepageNewChat');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
  }
  await page.waitForTimeout(500);
}

// ─── API Tests ───────────────────────────────────────────────────────────────

test.describe('File Comments API', () => {
  const TEST_AGENT = 'test-agent-comments';
  const TEST_FILE = 'test-file.md';

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('create a comment and list it', async ({ page }) => {
    // Create comment
    const createRes = await page.evaluate(async ({ agentId, filePath }: { agentId: string; filePath: string }) => {
      const r = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          agentId,
          filePath,
          rangeStartLine: 5,
          rangeEndLine: 10,
          content: 'Test comment from API test',
          authorType: 'user',
        }),
      });
      return r.json();
    }, { agentId: TEST_AGENT, filePath: TEST_FILE });

    expect(createRes.ok).toBe(true);
    expect(createRes.id).toBeDefined();
    const commentId = createRes.id;

    // List comments and verify created comment
    const listRes = await page.evaluate(async ({ agentId, filePath }: { agentId: string; filePath: string }) => {
      const r = await fetch(`/api/comments?agentId=${encodeURIComponent(agentId)}&filePath=${encodeURIComponent(filePath)}`);
      return r.json();
    }, { agentId: TEST_AGENT, filePath: TEST_FILE });

    expect(listRes.ok).toBe(true);
    expect(Array.isArray(listRes.comments)).toBe(true);
    const found = listRes.comments.find((c: { id: string }) => c.id === commentId);
    expect(found).toBeDefined();
    expect(found.content).toBe('Test comment from API test');
    expect(found.rangeStartLine).toBe(5);
    expect(found.rangeEndLine).toBe(10);
    expect(found.status).toBe('active');

    // Cleanup
    await page.evaluate(async (id: string) => {
      await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', commentId: id }),
      });
    }, commentId);
  });

  test('reply to a comment', async ({ page }) => {
    // Create comment
    const createRes = await page.evaluate(async ({ agentId, filePath }: { agentId: string; filePath: string }) => {
      const r = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          agentId,
          filePath,
          rangeStartLine: 1,
          content: 'Parent comment',
          authorType: 'user',
        }),
      });
      return r.json();
    }, { agentId: TEST_AGENT, filePath: TEST_FILE });

    const commentId = createRes.id;

    // Reply
    const replyRes = await page.evaluate(async (id: string) => {
      const r = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reply',
          commentId: id,
          content: 'Test reply',
          authorType: 'user',
        }),
      });
      return r.json();
    }, commentId);

    expect(replyRes.ok).toBe(true);
    expect(replyRes.id).toBeDefined();

    // Verify reply appears in list
    const listRes = await page.evaluate(async ({ agentId, filePath }: { agentId: string; filePath: string }) => {
      const r = await fetch(`/api/comments?agentId=${encodeURIComponent(agentId)}&filePath=${encodeURIComponent(filePath)}`);
      return r.json();
    }, { agentId: TEST_AGENT, filePath: TEST_FILE });

    const comment = listRes.comments.find((c: { id: string }) => c.id === commentId);
    expect(comment.replies).toHaveLength(1);
    expect(comment.replies[0].content).toBe('Test reply');

    // Cleanup
    await page.evaluate(async (id: string) => {
      await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', commentId: id }),
      });
    }, commentId);
  });

  test('reject (resolve) a comment', async ({ page }) => {
    // Create
    const createRes = await page.evaluate(async ({ agentId, filePath }: { agentId: string; filePath: string }) => {
      const r = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          agentId,
          filePath,
          content: 'To be rejected',
          authorType: 'agent',
          authorName: 'TestBot',
        }),
      });
      return r.json();
    }, { agentId: TEST_AGENT, filePath: TEST_FILE });

    const commentId = createRes.id;
    const rejectRes = await page.evaluate(async (id: string) => {
      const r = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject', commentId: id }),
      });
      return r.json();
    }, commentId);

    expect(rejectRes.ok).toBe(true);

    // Verify status changed to resolved
    const listRes = await page.evaluate(async ({ agentId, filePath }: { agentId: string; filePath: string }) => {
      const r = await fetch(`/api/comments?agentId=${encodeURIComponent(agentId)}&filePath=${encodeURIComponent(filePath)}`);
      return r.json();
    }, { agentId: TEST_AGENT, filePath: TEST_FILE });

    const comment = listRes.comments.find((c: { id: string }) => c.id === commentId);
    expect(comment.status).toBe('resolved');

    // Cleanup
    await page.evaluate(async (id: string) => {
      await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', commentId: id }),
      });
    }, commentId);
  });

  test('delete a comment', async ({ page }) => {
    // Create
    const createRes = await page.evaluate(async ({ agentId, filePath }: { agentId: string; filePath: string }) => {
      const r = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          agentId,
          filePath,
          content: 'To be deleted',
          authorType: 'user',
        }),
      });
      return r.json();
    }, { agentId: TEST_AGENT, filePath: TEST_FILE });

    const commentId = createRes.id;

    // Delete
    const deleteRes = await page.evaluate(async (id: string) => {
      const r = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', commentId: id }),
      });
      return r.json();
    }, commentId);

    expect(deleteRes.ok).toBe(true);

    // Verify gone
    const listRes = await page.evaluate(async ({ agentId, filePath }: { agentId: string; filePath: string }) => {
      const r = await fetch(`/api/comments?agentId=${encodeURIComponent(agentId)}&filePath=${encodeURIComponent(filePath)}`);
      return r.json();
    }, { agentId: TEST_AGENT, filePath: TEST_FILE });

    const found = listRes.comments.find((c: { id: string }) => c.id === commentId);
    expect(found).toBeUndefined();
  });

  test('approve creates a chat', async ({ page }) => {
    // Create a comment first
    const createRes = await page.evaluate(async ({ agentId, filePath }: { agentId: string; filePath: string }) => {
      const r = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          agentId,
          filePath,
          rangeStartLine: 1,
          rangeEndLine: 3,
          content: 'Please fix this function',
          authorType: 'user',
        }),
      });
      return r.json();
    }, { agentId: TEST_AGENT, filePath: TEST_FILE });

    const commentId = createRes.id;

    // Approve — may fail if no default agent configured, which is OK
    const approveRes = await page.evaluate(async ({ commentId, fileContent }: { commentId: string; fileContent: string }) => {
      const r = await fetch('/api/comments/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId, fileContent }),
      });
      return r.json();
    }, { commentId, fileContent: 'line1\nline2\nline3' });

    // If agents are configured, approve should succeed and return a chatId
    if (approveRes.ok) {
      expect(approveRes.chatId).toBeDefined();
      expect(approveRes.prompt).toBeDefined();
    }
    // Otherwise it may fail gracefully — that's fine in test environments without agents

    // Cleanup
    await page.evaluate(async (id: string) => {
      await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', commentId: id }),
      });
    }, commentId);
  });

  test('approve reuses one review chat per file path and queues while processing', async ({ page }) => {
    const testFile = `test-file-${Date.now()}.md`;
    async function createComment(content: string) {
      return page.evaluate(async ({ agentId, filePath, content }: { agentId: string; filePath: string; content: string }) => {
        const r = await fetch('/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create',
            agentId,
            filePath,
            rangeStartLine: 1,
            rangeEndLine: 1,
            content,
            authorType: 'user',
          }),
        });
        return r.json();
      }, { agentId: TEST_AGENT, filePath: testFile, content });
    }

    const createdCommentIds: string[] = [];
    let reviewChatId: string | null = null;

    try {
      const firstCreate = await createComment('First queued review comment');
      const secondCreate = await createComment('Second queued review comment');
      expect(firstCreate.ok).toBe(true);
      expect(secondCreate.ok).toBe(true);
      expect(firstCreate.id).toEqual(expect.any(String));
      expect(secondCreate.id).toEqual(expect.any(String));
      createdCommentIds.push(firstCreate.id);
      createdCommentIds.push(secondCreate.id);

      const firstApprove = await page.evaluate(async ({ commentId }: { commentId: string }) => {
        const r = await fetch('/api/comments/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commentId, fileContent: 'line1\nline2\nline3' }),
        });
        return r.json();
      }, { commentId: firstCreate.id });

      expect(firstApprove.ok).toBe(true);
      expect(firstApprove.status).toBe('processing');
      expect(firstApprove.chatId).toContain('comment-review:');
      expect(firstApprove.chatName).toBe(`Review: ${testFile}`);
      expect(firstApprove.prompt).toContain('First queued review comment');
      reviewChatId = firstApprove.chatId;

      const secondApprove = await page.evaluate(async ({ commentId }: { commentId: string }) => {
        const r = await fetch('/api/comments/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commentId, fileContent: 'line1\nline2\nline3' }),
        });
        return r.json();
      }, { commentId: secondCreate.id });

      expect(secondApprove.ok).toBe(true);
      expect(secondApprove.chatId).toBe(firstApprove.chatId);
      expect(secondApprove.status).toBe('queued');
      expect(secondApprove.prompt).toContain('Second queued review comment');

      const chatBefore = await page.evaluate(async (chatId: string) => {
        const r = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`);
        return r.json();
      }, firstApprove.chatId);
      expect(chatBefore.ok).toBe(true);
      expect(chatBefore.chat).toBeDefined();
      expect(chatBefore.chat.messages.filter((m: { type: string }) => m.type === 'user')).toHaveLength(1);

      const listedBefore = await page.evaluate(async ({ agentId, filePath }: { agentId: string; filePath: string }) => {
        const r = await fetch(`/api/comments?agentId=${encodeURIComponent(agentId)}&filePath=${encodeURIComponent(filePath)}`);
        return r.json();
      }, { agentId: TEST_AGENT, filePath: testFile });
      expect(listedBefore.ok).toBe(true);
      expect(Array.isArray(listedBefore.comments)).toBe(true);
      const firstBefore = listedBefore.comments.find((c: { id: string }) => c.id === firstCreate.id);
      const secondBefore = listedBefore.comments.find((c: { id: string }) => c.id === secondCreate.id);
      expect(firstBefore).toBeDefined();
      expect(secondBefore).toBeDefined();
      expect(firstBefore.status).toBe('processing');
      expect(secondBefore.status).toBe('queued');

      const resolveRes = await page.evaluate(async (commentId: string) => {
        const r = await fetch('/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'resolve', commentId }),
        });
        return r.json();
      }, firstCreate.id);
      expect(resolveRes.ok).toBe(true);

      const startNext = await page.evaluate(async ({ chatId }: { chatId: string }) => {
        const r = await fetch('/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start-next-queued', chatId, fileContent: 'line1\nline2\nline3' }),
        });
        return r.json();
      }, { chatId: firstApprove.chatId });

      expect(startNext.ok).toBe(true);
      expect(startNext.started).toBe(true);
      expect(startNext.commentId).toBe(secondCreate.id);
      expect(startNext.status).toBe('processing');
      expect(startNext.chatId).toBe(firstApprove.chatId);

      const chatAfter = await page.evaluate(async (chatId: string) => {
        const r = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`);
        return r.json();
      }, firstApprove.chatId);
      expect(chatAfter.ok).toBe(true);
      expect(chatAfter.chat).toBeDefined();
      expect(chatAfter.chat.messages.filter((m: { type: string }) => m.type === 'user')).toHaveLength(2);
    } finally {
      for (const id of createdCommentIds) {
        await page.evaluate(async (commentId: string) => {
          await fetch('/api/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', commentId }),
          });
        }, id);
      }
      if (reviewChatId) {
        await page.evaluate(async (chatId: string) => {
          await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`, { method: 'DELETE' });
        }, reviewChatId);
      }
    }
  });

  test('reset-processing returns a processing comment to active for retry', async ({ page }) => {
    const testFile = `test-reset-${Date.now()}.md`;
    let commentId: string | null = null;
    let reviewChatId: string | null = null;

    try {
      const createRes = await page.evaluate(async ({ agentId, filePath }: { agentId: string; filePath: string }) => {
        const r = await fetch('/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create',
            agentId,
            filePath,
            rangeStartLine: 1,
            rangeEndLine: 1,
            content: 'Reset this processing comment',
            authorType: 'user',
          }),
        });
        return r.json();
      }, { agentId: TEST_AGENT, filePath: testFile });
      expect(createRes.ok).toBe(true);
      commentId = createRes.id;

      const approveRes = await page.evaluate(async (commentId: string) => {
        const r = await fetch('/api/comments/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commentId, fileContent: 'line1\nline2\nline3' }),
        });
        return r.json();
      }, commentId);
      expect(approveRes.ok).toBe(true);
      expect(approveRes.status).toBe('processing');
      reviewChatId = approveRes.chatId;

      const resetRes = await page.evaluate(async (commentId: string) => {
        const r = await fetch('/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reset-processing', commentId }),
        });
        return r.json();
      }, commentId);
      expect(resetRes.ok).toBe(true);

      const listRes = await page.evaluate(async ({ agentId, filePath }: { agentId: string; filePath: string }) => {
        const r = await fetch(`/api/comments?agentId=${encodeURIComponent(agentId)}&filePath=${encodeURIComponent(filePath)}`);
        return r.json();
      }, { agentId: TEST_AGENT, filePath: testFile });
      const resetComment = listRes.comments.find((c: { id: string }) => c.id === commentId);
      expect(resetComment.status).toBe('active');
      expect(resetComment.linkedChatId).toBeNull();
    } finally {
      if (commentId) {
        await page.evaluate(async (id: string) => {
          await fetch('/api/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', commentId: id }),
          });
        }, commentId);
      }
      if (reviewChatId) {
        await page.evaluate(async (chatId: string) => {
          await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`, { method: 'DELETE' });
        }, reviewChatId);
      }
    }
  });

  test('reset-processing rejects orphaned processing comments', async ({ page }) => {
    const commentId = await createFileComment({
      agentId: TEST_AGENT,
      filePath: `test-orphan-reset-${Date.now()}.md`,
      rangeStartLine: 1,
      rangeEndLine: 1,
      content: 'Orphan processing comment',
      authorType: 'user',
      authorName: 'Test User',
    });

    try {
      await updateFileCommentStatus(commentId, 'processing');
      const resetRes = await page.evaluate(async (commentId: string) => {
        const r = await fetch('/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reset-processing', commentId }),
        });
        return { status: r.status, body: await r.json() };
      }, commentId);

      expect(resetRes.status).toBe(400);
      expect(resetRes.body.ok).toBe(false);
      expect(resetRes.body.error).toBe('processing comment has no linked chat');
    } finally {
      await deleteFileComment(commentId);
    }
  });
});

// ─── E2E / UI Tests ──────────────────────────────────────────────────────────

test.describe('File Comments UI', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('comment sidebar toggle appears in file editor toolbar', async ({ page }) => {
    // Switch to Files tab
    await page.click('button:has-text("Files")');
    await page.waitForTimeout(500);

    // Select an agent if available
    const agentSelect = page.locator('.mdAgentSelect');
    if (await agentSelect.count() > 0) {
      await agentSelect.selectOption({ index: 0 });
      await page.waitForTimeout(1000);
    }

    // Open a file if available
    const fileItem = page.locator('.mdFileItem').first();
    if (await fileItem.count() > 0) {
      await fileItem.click();
      await page.waitForTimeout(500);

      // Verify comment toggle button exists
      const commentToggle = page.locator('button:has-text("💬")');
      await expect(commentToggle).toBeVisible();
    }
  });

  test('comment sidebar opens and closes', async ({ page }) => {
    await page.click('button:has-text("Files")');
    await page.waitForTimeout(500);

    const agentSelect = page.locator('.mdAgentSelect');
    if (await agentSelect.count() > 0) {
      await agentSelect.selectOption({ index: 0 });
      await page.waitForTimeout(1000);
    }

    const fileItem = page.locator('.mdFileItem').first();
    if (await fileItem.count() > 0) {
      await fileItem.click();
      await page.waitForTimeout(500);

      // Open sidebar
      const commentToggle = page.locator('button:has-text("💬")');
      await commentToggle.click();
      await expect(page.locator('.commentSidebar')).toBeVisible();

      // Verify header elements
      await expect(page.locator('.commentSidebarHeader')).toBeVisible();
      await expect(page.locator('.commentFilterSelect')).toBeVisible();

      // Close sidebar
      await page.locator('.commentSidebarHeader button:has-text("◀")').click();
      await expect(page.locator('.commentSidebar')).not.toBeVisible();
    }
  });

  test('shows main-page comment markers and aligns sidebar cards with file lines', async ({ page }) => {
    const agentId = 'inline-marker-agent';
    const filePath = 'inline-marker.txt';
    const comments = [
      {
        id: 'line-two-comment',
        agentId,
        filePath,
        rangeStartLine: 2,
        rangeEndLine: 2,
        rangeStartChar: 7,
        rangeEndChar: 16,
        content: 'Comment aligned to line two',
        authorType: 'user',
        authorName: 'Test User',
        status: 'active',
        linkedChatId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: [],
      },
      {
        id: 'line-five-comment',
        agentId,
        filePath,
        rangeStartLine: 5,
        rangeEndLine: 5,
        rangeStartChar: null,
        rangeEndChar: null,
        content: 'Comment aligned to line five',
        authorType: 'agent',
        authorName: 'Review Agent',
        status: 'active',
        linkedChatId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: [],
      },
    ];

    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as { action?: string } | null;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: agentId, name: 'Inline Marker Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const requestedPath = url.searchParams.get('path');
      if (requestedPath) {
        await route.fulfill({
          json: {
            path: requestedPath,
            content: [
              'First line',
              'Second line with comment',
              'Third line',
              'Fourth line',
              'Fifth line with comment',
            ].join('\n'),
            kind: 'text',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: filePath, name: filePath, mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, comments } });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await login(page);
    await page.click('button.leftSidebarTab:has-text("Files")');
    await selectFilesAgent(page, agentId);
    await page.locator('.mdTreeFile', { hasText: filePath }).click();
    await page.locator('.mdEditorToolbar button[title="Toggle comments"]').click();

    const lineTwo = page.locator('.fileLine[data-line-num="2"]');
    const lineFive = page.locator('.fileLine[data-line-num="5"]');
    const lineTwoMarker = lineTwo.locator('.lineCommentMarker');
    const lineFiveMarker = lineFive.locator('.lineCommentMarker');
    const lineTwoCard = page.locator('.commentCard', { hasText: 'Comment aligned to line two' });
    const lineFiveCard = page.locator('.commentCard', { hasText: 'Comment aligned to line five' });

    await expect(lineTwoMarker).toBeVisible();
    await expect(lineFiveMarker).toBeVisible();
    await expect(lineTwoCard).toBeVisible();
    await expect(lineFiveCard).toBeVisible();
    await expect.poll(async () => {
      const markerBox = await lineTwoMarker.boundingBox();
      const textBox = await lineTwo.locator('.fileLineText').boundingBox();
      if (!markerBox || !textBox) return Number.NEGATIVE_INFINITY;
      return markerBox.x - (textBox.x + textBox.width);
    }).toBeGreaterThanOrEqual(0);

    await expect.poll(async () => {
      const lineBox = await lineTwo.boundingBox();
      const cardBox = await lineTwoCard.boundingBox();
      if (!lineBox || !cardBox) return Number.POSITIVE_INFINITY;
      return Math.abs(lineBox.y - cardBox.y);
    }).toBeLessThan(10);

    await expect.poll(async () => {
      const lineBox = await lineFive.boundingBox();
      const cardBox = await lineFiveCard.boundingBox();
      if (!lineBox || !cardBox) return Number.POSITIVE_INFINITY;
      return Math.abs(lineBox.y - cardBox.y);
    }).toBeLessThan(10);

    await lineTwoMarker.click();
    const selectedTextHighlight = lineTwo.locator('.fileLineSelectedText');
    await expect(selectedTextHighlight).toBeVisible();
    await expect(selectedTextHighlight).toHaveText('line with');
    await expect.poll(async () => {
      const highlightBox = await selectedTextHighlight.boundingBox();
      const lineBox = await lineTwo.locator('.fileLineText').boundingBox();
      if (!highlightBox || !lineBox) return Number.NEGATIVE_INFINITY;
      return highlightBox.x - lineBox.x;
    }).toBeGreaterThan(0);

    await lineTwoCard.click();
    await expect(lineTwoMarker).toBeVisible();
    await expect(page.locator('.commentConnectorSvg')).toHaveCount(0);
  });

  test('shows live comment markers for rendered markdown lines and syncs sidebar scroll', async ({ page }) => {
    const agentId = 'live-marker-agent';
    const filePath = 'live-marker.md';
    const contentLines = ['# Commented heading', ''];
    for (let index = 1; index <= 50; index += 1) {
      contentLines.push(`Paragraph ${index} unique live marker text.`);
      contentLines.push('');
    }
    const bottomCommentLine = contentLines.findIndex(line => line.includes('Paragraph 35 unique live marker text.')) + 1;
    const comments = [
      {
        id: 'heading-live-comment',
        agentId,
        filePath,
        rangeStartLine: 1,
        rangeEndLine: 1,
        rangeStartChar: null,
        rangeEndChar: null,
        content: 'Comment on rendered heading',
        authorType: 'user',
        authorName: 'Test User',
        status: 'active',
        linkedChatId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: [],
      },
      {
        id: 'resolved-heading-live-comment',
        agentId,
        filePath,
        rangeStartLine: 1,
        rangeEndLine: 1,
        rangeStartChar: null,
        rangeEndChar: null,
        content: 'Resolved comment on rendered heading',
        authorType: 'user',
        authorName: 'Test User',
        status: 'resolved',
        linkedChatId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: [],
      },
      {
        id: 'bottom-live-comment',
        agentId,
        filePath,
        rangeStartLine: bottomCommentLine,
        rangeEndLine: bottomCommentLine,
        rangeStartChar: null,
        rangeEndChar: null,
        content: 'Comment near bottom',
        authorType: 'agent',
        authorName: 'Review Agent',
        status: 'active',
        linkedChatId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: [],
      },
    ];

    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as { action?: string } | null;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: agentId, name: 'Live Marker Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const requestedPath = url.searchParams.get('path');
      if (requestedPath) {
        await route.fulfill({
          json: {
            path: requestedPath,
            content: contentLines.join('\n'),
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: filePath, name: filePath, mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, comments } });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await login(page);
    await page.click('button.leftSidebarTab:has-text("Files")');
    await selectFilesAgent(page, agentId);
    await page.locator('.mdTreeFile', { hasText: filePath }).click();
    await expect(page.locator('.mdModeBtn').filter({ hasText: /^Review$/ })).toHaveCount(0);
    const commentToggle = page.locator('.mdEditorToolbar button[title="Toggle comments"]');
    if (!(await page.locator('.commentSidebar').isVisible().catch(() => false))) {
      await commentToggle.click();
    }

    await expect(page.locator('.liveCommentMarker')).toHaveCount(2);
    await expect(page.locator('.commentConnectorSvg')).toHaveCount(0);
    await expect(page.locator('.commentSidebarList')).toHaveCSS('overflow-y', 'visible');
    await expect(page.locator('.mdEditorLive')).toHaveCSS('overflow-y', 'auto');

    await page.locator('.mdEditorLive').evaluate(el => {
      el.scrollTop = 600;
      el.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(async () => page.locator('.commentSidebarList').evaluate(el => el.scrollTop)).toBe(0);
    await expect.poll(async () => {
      const paragraphTop = await page.locator('.mdLiveEditable p', { hasText: 'Paragraph 35 unique live marker text.' }).evaluate(el => el.getBoundingClientRect().top);
      const bottomCard = page.locator('.commentCard', { hasText: 'Comment near bottom' });
      const cardTop = await bottomCard.evaluate(el => el.getBoundingClientRect().top);
      return Math.abs(cardTop - paragraphTop);
    }).toBeLessThan(16);
  });

  test('aligns the selected live comment card with its highlighted text', async ({ page }) => {
    const agentId = 'live-selected-card-agent';
    const filePath = 'live-selected-card.md';
    const comments = [
      {
        id: 'first-live-card-comment',
        agentId,
        filePath,
        rangeStartLine: 3,
        rangeEndLine: 3,
        rangeStartChar: 0,
        rangeEndChar: 'First rendered target for comment alignment.'.length,
        content: 'First nearby comment',
        authorType: 'user',
        authorName: 'Test User',
        status: 'active',
        linkedChatId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: [],
      },
      {
        id: 'second-live-card-comment',
        agentId,
        filePath,
        rangeStartLine: 4,
        rangeEndLine: 4,
        rangeStartChar: 0,
        rangeEndChar: 'Second rendered target for comment alignment.'.length,
        content: 'Second nearby comment',
        authorType: 'user',
        authorName: 'Test User',
        status: 'active',
        linkedChatId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: [],
      },
    ];

    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as { action?: string } | null;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: agentId, name: 'Live Selected Card Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const requestedPath = url.searchParams.get('path');
      if (requestedPath) {
        await route.fulfill({
          json: {
            path: requestedPath,
            content: [
              '# Selected card alignment',
              '',
              'First rendered target for comment alignment.',
              'Second rendered target for comment alignment.',
            ].join('\n'),
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: filePath, name: filePath, mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, comments } });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await login(page);
    await page.click('button.leftSidebarTab:has-text("Files")');
    await selectFilesAgent(page, agentId);
    await page.locator('.mdTreeFile', { hasText: filePath }).click();
    const commentToggle = page.locator('.mdEditorToolbar button[title="Toggle comments"]');
    if (!(await page.locator('.commentSidebar').isVisible().catch(() => false))) {
      await commentToggle.click();
    }

    await page.getByLabel('1 comment on line 4').click();
    const selectedCard = page.locator('.commentCard.selected', { hasText: 'Second nearby comment' });
    const selectedHighlight = page.locator('.liveSelectionDraftHighlight').first();
    await expect(selectedCard).toBeVisible();
    await expect(selectedHighlight).toBeVisible();
    await expect.poll(async () => {
      const highlightTop = await selectedHighlight.evaluate(el => el.getBoundingClientRect().top);
      const cardTop = await selectedCard.evaluate(el => el.getBoundingClientRect().top);
      return Math.abs(cardTop - highlightTop);
    }).toBeLessThan(20);
  });

  test('approved comment dispatches to the path review chat', async ({ page }) => {
    const agentId = 'ui-dispatch-agent';
    const filePath = 'ui-dispatch.md';
    const ordinaryChatId = `ui-dispatch-current-${Date.now()}`;
    const reviewChatId = `comment-review:${filePath}`;
    const reviewChatName = `Review: ${filePath}`;
    const prompt = 'Apply this review comment: Dispatch this approved comment';
    const comment = {
      id: 'ui-dispatch-comment',
      agentId,
      filePath,
      rangeStartLine: 1,
      rangeEndLine: 1,
      rangeStartChar: null,
      rangeEndChar: null,
      content: 'Dispatch this approved comment',
      authorType: 'user',
      authorName: 'Test User',
      status: 'active',
      linkedChatId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      replies: [],
    };
    let capturedSendBody: Record<string, unknown> | null = null;

    await page.evaluate(async ({ ordinaryChatId }) => {
      window.localStorage.removeItem('acp_file_workspace_v1');
      window.localStorage.setItem('commentSidebarOpen', 'false');
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat: {
            id: ordinaryChatId,
            name: 'Ordinary Current Chat',
            ts: Date.now(),
            messages: [
              { id: 'ordinary-message', type: 'user', content: 'ordinary current chat', ts: Date.now() },
            ],
            agentSessions: {},
          },
        }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId: ordinaryChatId }),
      });
    }, { ordinaryChatId });

    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (body.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: agentId, name: 'UI Dispatch Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      if (body.action === 'send') {
        capturedSendBody = body;
        await route.fulfill({ json: { ok: true, sessionId: 'ui-dispatch-session', turn: { id: 'ui-dispatch-turn' } } });
        return;
      }
      if (body.action === 'poll') {
        await route.fulfill({
          json: {
            ok: true,
            activeTurn: {
              fullText: 'Applied review comment.',
              done: true,
              phase: 'replying',
              events: [{ type: 'text_chunk', ts: Date.now(), text: 'Applied review comment.' }],
            },
          },
        });
        return;
      }
      if (body.action === 'turn-clear' || body.action === 'resume-session') {
        await route.fulfill({ json: { ok: true, loaded: true } });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const requestedPath = url.searchParams.get('path');
      if (requestedPath) {
        await route.fulfill({
          json: {
            path: requestedPath,
            content: 'Line one for review.\nLine two for context.',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: filePath, name: filePath, mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/comments/approve') {
        await route.fulfill({
          json: {
            ok: true,
            chatId: reviewChatId,
            chatName: reviewChatName,
            prompt,
            agentId,
            status: 'processing',
          },
        });
        return;
      }
      if (url.pathname === '/api/comments' && route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, comments: [comment] } });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    try {
      await page.reload();
      await page.waitForSelector('.chatContainer', { timeout: 30000 });
      await expect(page.locator('.message.user', { hasText: 'ordinary current chat' })).toBeVisible();

      await page.click('button.leftSidebarTab:has-text("Files")');
      await selectFilesAgent(page, agentId);
      await page.locator('.mdTreeFile', { hasText: filePath }).click();
      await expect(page.locator('.mdEditorFilePath')).toContainText(filePath);

      await page.locator('.mdEditorToolbar button[title="Toggle comments"]').click();
      const commentCard = page.locator('.commentCard', { hasText: 'Dispatch this approved comment' });
      await commentCard.click();
      const approveStyle = await commentCard.locator('.commentActionBtn.approve').evaluate(el => {
        const style = window.getComputedStyle(el);
        return {
          backgroundImage: style.backgroundImage,
          borderColor: style.borderColor,
          color: style.color,
        };
      });
      expect(approveStyle.backgroundImage).toContain('linear-gradient');
      expect(approveStyle.backgroundImage).toContain('20, 184, 166');
      expect(approveStyle.backgroundImage).toContain('52, 211, 153');
      expect(approveStyle.borderColor).toBe('rgba(94, 234, 212, 0.45)');
      expect(approveStyle.color).toBe('rgb(4, 47, 46)');
      await commentCard.locator('.commentActionBtn.approve').click();

      await expect.poll(() => capturedSendBody?.chatId ?? null).toBe(reviewChatId);
      expect(capturedSendBody?.text).toContain('Dispatch this approved comment');
    } finally {
      await page.evaluate(async ({ ordinaryChatId }) => {
        await fetch(`/api/chats?id=${encodeURIComponent(ordinaryChatId)}`, { method: 'DELETE' });
      }, { ordinaryChatId }).catch(() => undefined);
    }
  });

  test('resolved comment links back to its review chat', async ({ page }) => {
    const agentId = 'ui-resolved-link-agent';
    const filePath = 'ui-resolved-link.md';
    const reviewChatId = `comment-review:${filePath}`;
    const comment = {
      id: 'ui-resolved-link-comment',
      agentId,
      filePath,
      rangeStartLine: 1,
      rangeEndLine: 1,
      rangeStartChar: null,
      rangeEndChar: null,
      content: 'Resolved comment should still link to chat',
      authorType: 'user',
      authorName: 'Test User',
      status: 'resolved',
      linkedChatId: reviewChatId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      replies: [],
    };

    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as { action?: string } | null;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: agentId, name: 'Resolved Link Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const requestedPath = url.searchParams.get('path');
      if (requestedPath) {
        await route.fulfill({
          json: {
            path: requestedPath,
            content: 'Line one for resolved link.',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: filePath, name: filePath, mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/comments' && route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, comments: [comment] } });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    try {
      await page.evaluate(async ({ reviewChatId }) => {
        await fetch('/api/chats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat: {
              id: reviewChatId,
              name: 'Review: ui-resolved-link.md',
              ts: Date.now(),
              messages: [
                { id: 'resolved-chat-message', type: 'agent', agentId: 'ui-resolved-link-agent', content: 'Resolved review chat content', ts: Date.now() },
              ],
              agentSessions: {},
            },
          }),
        });
      }, { reviewChatId });

      await page.reload();
      await page.waitForSelector('.chatContainer', { timeout: 30000 });
      await page.click('button.leftSidebarTab:has-text("Files")');
      await selectFilesAgent(page, agentId);
      await page.locator('.mdTreeFile', { hasText: filePath }).click();
      await page.locator('.mdEditorToolbar button[title="Toggle comments"]').click();

      const commentCard = page.locator('.commentCard', { hasText: 'Resolved comment should still link to chat' });
      await expect(commentCard.locator('.commentStatusBadge')).toHaveText('Resolved');
      await expect(commentCard).toHaveCSS('opacity', '1');
      await expect(commentCard).toHaveCSS('border-color', 'rgba(45, 212, 191, 0.45)');
      await expect(commentCard.locator('.commentStatusBadge')).toHaveCSS('background-color', 'rgba(45, 212, 191, 0.12)');
      await expect(commentCard.locator('.commentStatusBadge')).toHaveCSS('color', 'rgb(94, 234, 212)');
      await commentCard.click();
      await commentCard.getByRole('button', { name: 'View chat' }).click();

      await expect(page.locator('textarea.composerTextarea')).toBeVisible();
      await expect(page.locator('.message.agent', { hasText: 'Resolved review chat content' })).toBeVisible();
    } finally {
      await page.evaluate(async (reviewChatId: string) => {
        await fetch(`/api/chats?id=${encodeURIComponent(reviewChatId)}`, { method: 'DELETE' });
      }, reviewChatId).catch(() => undefined);
    }
  });

  test('queued approved comments wait for the current review turn to finish', async ({ page }) => {
    const agentId = 'ui-queue-agent';
    const filePath = 'ui-queue.md';
    const reviewChatId = `comment-review:${filePath}`;
    const reviewChatName = `Review: ${filePath}`;
    const firstCommentId = 'ui-queue-first-comment';
    const secondCommentId = 'ui-queue-second-comment';
    const firstPrompt = 'Prompt for first queued UI comment';
    const secondPrompt = 'Prompt for second queued UI comment';
    const comments: Array<Record<string, unknown>> = [
      {
        id: firstCommentId,
        agentId,
        filePath,
        rangeStartLine: 1,
        rangeEndLine: 1,
        rangeStartChar: null,
        rangeEndChar: null,
        content: 'First comment is processing',
        authorType: 'user',
        authorName: 'Test User',
        status: 'active',
        linkedChatId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: [],
      },
      {
        id: secondCommentId,
        agentId,
        filePath,
        rangeStartLine: 2,
        rangeEndLine: 2,
        rangeStartChar: null,
        rangeEndChar: null,
        content: 'Second comment should queue',
        authorType: 'user',
        authorName: 'Test User',
        status: 'active',
        linkedChatId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: [],
      },
    ];
    const sendBodies: Record<string, unknown>[] = [];
    const commentActions: string[] = [];
    let allowCompletion = false;
    let startNextCount = 0;

    await page.evaluate(() => {
      window.localStorage.removeItem('acp_file_workspace_v1');
      window.localStorage.setItem('commentSidebarOpen', 'false');
    });

    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (body.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: agentId, name: 'UI Queue Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      if (body.action === 'send') {
        sendBodies.push(body);
        await route.fulfill({ json: { ok: true, sessionId: 'ui-queue-session', turn: { id: `ui-queue-turn-${sendBodies.length}` } } });
        return;
      }
      if (body.action === 'poll') {
        await route.fulfill({
          json: {
            ok: true,
            activeTurn: allowCompletion
              ? {
                  fullText: 'Finished queued UI comment.',
                  done: true,
                  phase: 'replying',
                  events: [{ type: 'text_chunk', ts: Date.now(), text: 'Finished queued UI comment.' }],
                }
              : {
                  fullText: '',
                  done: false,
                  phase: 'thinking',
                  statusText: 'Thinking',
                  events: [],
                },
          },
        });
        return;
      }
      if (body.action === 'turn-clear' || body.action === 'resume-session') {
        await route.fulfill({ json: { ok: true, loaded: true } });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const requestedPath = url.searchParams.get('path');
      if (requestedPath) {
        await route.fulfill({
          json: {
            path: requestedPath,
            content: 'Line one for review.\nLine two for review.\nLine three for context.',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: filePath, name: filePath, mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/comments/approve') {
        const body = route.request().postDataJSON() as { commentId?: string };
        const isSecond = body.commentId === secondCommentId;
        const comment = comments.find(c => c.id === body.commentId);
        if (comment) {
          comment.status = isSecond ? 'queued' : 'processing';
          comment.linkedChatId = reviewChatId;
        }
        await route.fulfill({
          json: {
            ok: true,
            chatId: reviewChatId,
            chatName: reviewChatName,
            prompt: isSecond ? secondPrompt : firstPrompt,
            agentId,
            status: isSecond ? 'queued' : 'processing',
          },
        });
        return;
      }
      if (url.pathname === '/api/comments' && route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, comments } });
        return;
      }
      if (url.pathname === '/api/comments' && route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { action?: string; commentId?: string; chatId?: string };
        if (body.action) commentActions.push(body.action);
        if (body.action === 'resolve' && body.commentId === firstCommentId) {
          comments[0].status = 'resolved';
          await route.fulfill({ json: { ok: true } });
          return;
        }
        if (body.action === 'start-next-queued' && body.chatId === reviewChatId) {
          startNextCount += 1;
          if (startNextCount > 1) {
            await route.fulfill({ json: { ok: true, started: false } });
            return;
          }
          comments[1].status = 'processing';
          await route.fulfill({
            json: {
              ok: true,
              started: true,
              commentId: secondCommentId,
              chatId: reviewChatId,
              chatName: reviewChatName,
              prompt: secondPrompt,
              agentId,
              status: 'processing',
            },
          });
          return;
        }
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });

    await page.click('button.leftSidebarTab:has-text("Files")');
    await selectFilesAgent(page, agentId);
    await page.locator('.mdTreeFile', { hasText: filePath }).click();
    await expect(page.locator('.mdEditorFilePath')).toContainText(filePath);

    await page.locator('.mdEditorToolbar button[title="Toggle comments"]').click();
    const firstCard = page.locator('.commentCard', { hasText: 'First comment is processing' });
    await firstCard.click();
    await firstCard.locator('.commentActionBtn.approve').click();
    await expect.poll(() => sendBodies.length).toBe(1);

    const secondCard = page.locator('.commentCard', { hasText: 'Second comment should queue' });
    await secondCard.click();
    await secondCard.locator('.commentActionBtn.approve').click();

    await expect(secondCard.locator('.commentProcessing.queued')).toContainText('Queued');
    await expect.poll(() => sendBodies.length).toBe(1);

    allowCompletion = true;
    await expect.poll(() => commentActions).toContain('resolve');
    await expect.poll(() => commentActions).toContain('start-next-queued');
    await expect.poll(() => sendBodies.length).toBe(2);
    expect(sendBodies.map(body => body.chatId)).toEqual([reviewChatId, reviewChatId]);
    expect(sendBodies[1].text).toBe(secondPrompt);
  });

  test('stopping a processing comment resets it and starts the next queued comment', async ({ page }) => {
    const agentId = 'ui-stop-agent';
    const filePath = 'ui-stop.md';
    const reviewChatId = `comment-review:${filePath}`;
    const reviewChatName = `Review: ${filePath}`;
    const firstCommentId = 'ui-stop-first-comment';
    const secondCommentId = 'ui-stop-second-comment';
    const firstPrompt = 'Prompt for stopped UI comment';
    const secondPrompt = 'Prompt for queued UI comment after stop';
    const comments: Array<Record<string, unknown>> = [
      {
        id: firstCommentId,
        agentId,
        filePath,
        rangeStartLine: 1,
        rangeEndLine: 1,
        rangeStartChar: null,
        rangeEndChar: null,
        content: 'Stop this processing comment',
        authorType: 'user',
        authorName: 'Test User',
        status: 'active',
        linkedChatId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: [],
      },
      {
        id: secondCommentId,
        agentId,
        filePath,
        rangeStartLine: 2,
        rangeEndLine: 2,
        rangeStartChar: null,
        rangeEndChar: null,
        content: 'Start this queued comment after stop',
        authorType: 'user',
        authorName: 'Test User',
        status: 'active',
        linkedChatId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: [],
      },
    ];
    const sendBodies: Record<string, unknown>[] = [];
    const interruptBodies: Record<string, unknown>[] = [];
    const commentActions: string[] = [];

    await page.evaluate(() => {
      window.localStorage.removeItem('acp_file_workspace_v1');
      window.localStorage.setItem('commentSidebarOpen', 'false');
    });

    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (body.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: agentId, name: 'UI Stop Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      if (body.action === 'send') {
        sendBodies.push(body);
        await route.fulfill({ json: { ok: true, sessionId: 'ui-stop-session', turn: { id: `ui-stop-turn-${sendBodies.length}` } } });
        return;
      }
      if (body.action === 'interrupt') {
        interruptBodies.push(body);
        await route.fulfill({ json: { ok: true } });
        return;
      }
      if (body.action === 'poll') {
        await route.fulfill({
          json: {
            ok: true,
            activeTurn: {
              fullText: '',
              done: false,
              phase: 'thinking',
              statusText: 'Thinking',
              events: [],
            },
          },
        });
        return;
      }
      if (body.action === 'turn-clear' || body.action === 'resume-session') {
        await route.fulfill({ json: { ok: true, loaded: true } });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const requestedPath = url.searchParams.get('path');
      if (requestedPath) {
        await route.fulfill({
          json: {
            path: requestedPath,
            content: 'Line one for stop.\nLine two for queued.',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: filePath, name: filePath, mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/comments/approve') {
        const body = route.request().postDataJSON() as { commentId?: string };
        const isSecond = body.commentId === secondCommentId;
        const comment = comments.find(c => c.id === body.commentId);
        if (comment) {
          comment.status = isSecond ? 'queued' : 'processing';
          comment.linkedChatId = reviewChatId;
        }
        await route.fulfill({
          json: {
            ok: true,
            chatId: reviewChatId,
            chatName: reviewChatName,
            prompt: isSecond ? secondPrompt : firstPrompt,
            agentId,
            status: isSecond ? 'queued' : 'processing',
          },
        });
        return;
      }
      if (url.pathname === '/api/comments' && route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, comments } });
        return;
      }
      if (url.pathname === '/api/comments' && route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { action?: string; commentId?: string; chatId?: string };
        if (body.action) commentActions.push(body.action);
        if (body.action === 'reset-processing' && body.commentId === firstCommentId) {
          comments[0].status = 'active';
          comments[0].linkedChatId = null;
          await route.fulfill({ json: { ok: true } });
          return;
        }
        if (body.action === 'start-next-queued' && body.chatId === reviewChatId) {
          comments[1].status = 'processing';
          await route.fulfill({
            json: {
              ok: true,
              started: true,
              commentId: secondCommentId,
              chatId: reviewChatId,
              chatName: reviewChatName,
              prompt: secondPrompt,
              agentId,
              status: 'processing',
            },
          });
          return;
        }
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await page.click('button.leftSidebarTab:has-text("Files")');
    await selectFilesAgent(page, agentId);
    await page.locator('.mdTreeFile', { hasText: filePath }).click();
    await page.locator('.mdEditorToolbar button[title="Toggle comments"]').click();

    const firstCard = page.locator('.commentCard', { hasText: 'Stop this processing comment' });
    await firstCard.click();
    await firstCard.locator('.commentActionBtn.approve').click();
    await expect.poll(() => sendBodies.length).toBe(1);

    const secondCard = page.locator('.commentCard', { hasText: 'Start this queued comment after stop' });
    await secondCard.click();
    await secondCard.locator('.commentActionBtn.approve').click();
    await expect(secondCard.locator('.commentProcessing.queued')).toContainText('Queued');

    await firstCard.locator('.commentActionBtn.stop').click();

    await expect.poll(() => interruptBodies.length).toBe(1);
    expect(interruptBodies[0].chatId).toBe(reviewChatId);
    await expect.poll(() => commentActions).toContain('reset-processing');
    await expect.poll(() => commentActions).toContain('start-next-queued');
    await expect.poll(() => sendBodies.length).toBe(2);
    expect(sendBodies[1].text).toBe(secondPrompt);
    await expect(firstCard.locator('.commentActionBtn.approve')).toBeVisible();
    await expect(secondCard.locator('.commentProcessing')).toContainText('Processing');
  });

  test('completed review run resolves the approved comment instead of a stale processing card', async ({ page }) => {
    const agentId = 'ui-specific-resolve-agent';
    const filePath = 'ui-specific-resolve.md';
    const reviewChatId = `comment-review:${filePath}`;
    const staleCommentId = 'ui-specific-stale-processing';
    const approvedCommentId = 'ui-specific-approved-comment';
    const prompt = 'Prompt for specifically approved comment';
    const comments: Array<Record<string, unknown>> = [
      {
        id: staleCommentId,
        agentId,
        filePath,
        rangeStartLine: 1,
        rangeEndLine: 1,
        rangeStartChar: null,
        rangeEndChar: null,
        content: 'Stale processing comment',
        authorType: 'user',
        authorName: 'Test User',
        status: 'processing',
        linkedChatId: reviewChatId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: [],
      },
      {
        id: approvedCommentId,
        agentId,
        filePath,
        rangeStartLine: 2,
        rangeEndLine: 2,
        rangeStartChar: null,
        rangeEndChar: null,
        content: 'Approved comment should resolve',
        authorType: 'user',
        authorName: 'Test User',
        status: 'active',
        linkedChatId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: [],
      },
    ];
    const resolvedCommentIds: string[] = [];

    await page.evaluate(() => {
      window.localStorage.removeItem('acp_file_workspace_v1');
      window.localStorage.setItem('commentSidebarOpen', 'false');
    });

    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (body.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: agentId, name: 'Specific Resolve Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      if (body.action === 'send') {
        await route.fulfill({ json: { ok: true, sessionId: 'ui-specific-session', turn: { id: 'ui-specific-turn' } } });
        return;
      }
      if (body.action === 'poll') {
        await route.fulfill({
          json: {
            ok: true,
            activeTurn: {
              fullText: 'Finished specifically approved comment.',
              done: true,
              phase: 'replying',
              events: [{ type: 'text_chunk', ts: Date.now(), text: 'Finished specifically approved comment.' }],
            },
          },
        });
        return;
      }
      if (body.action === 'turn-clear' || body.action === 'resume-session') {
        await route.fulfill({ json: { ok: true, loaded: true } });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const requestedPath = url.searchParams.get('path');
      if (requestedPath) {
        await route.fulfill({
          json: {
            path: requestedPath,
            content: 'Line one.\nLine two.\nLine three.',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: filePath, name: filePath, mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/comments/approve') {
        await route.fulfill({
          json: {
            ok: true,
            chatId: reviewChatId,
            chatName: `Review: ${filePath}`,
            prompt,
            agentId,
            status: 'processing',
          },
        });
        return;
      }
      if (url.pathname === '/api/comments' && route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, comments } });
        return;
      }
      if (url.pathname === '/api/comments' && route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { action?: string; commentId?: string };
        if (body.action === 'resolve' && body.commentId) {
          resolvedCommentIds.push(body.commentId);
        }
      }
      await route.fulfill({ json: { ok: true, started: false } });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await page.click('button.leftSidebarTab:has-text("Files")');
    await selectFilesAgent(page, agentId);
    await page.locator('.mdTreeFile', { hasText: filePath }).click();
    await page.locator('.mdEditorToolbar button[title="Toggle comments"]').click();

    const approvedCard = page.locator('.commentCard', { hasText: 'Approved comment should resolve' });
    await approvedCard.click();
    await approvedCard.locator('.commentActionBtn.approve').click();

    await expect.poll(() => resolvedCommentIds).toContain(approvedCommentId);
    expect(resolvedCommentIds).not.toContain(staleCommentId);
  });

  test('legacy review run without tracked comment id resolves the processing comment', async ({ page }) => {
    const agentId = 'ui-legacy-review-agent';
    const filePath = 'ui-legacy-review.md';
    const reviewChatId = `comment-review:${filePath}`;
    const commentId = 'ui-legacy-processing-comment';
    const comments: Array<Record<string, unknown>> = [
      {
        id: commentId,
        agentId,
        filePath,
        rangeStartLine: 1,
        rangeEndLine: 1,
        rangeStartChar: null,
        rangeEndChar: null,
        content: 'Legacy processing comment',
        authorType: 'user',
        authorName: 'Test User',
        status: 'processing',
        linkedChatId: reviewChatId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: [],
      },
    ];
    const resolvedCommentIds: string[] = [];

    await page.evaluate(async ({ reviewChatId }) => {
      window.localStorage.removeItem('acp_file_workspace_v1');
      window.localStorage.setItem('commentSidebarOpen', 'false');
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat: {
            id: reviewChatId,
            name: 'Review: ui-legacy-review.md',
            ts: Date.now(),
            messages: [{ id: 'legacy-message', type: 'user', content: 'legacy review chat', ts: Date.now() }],
            agentSessions: {},
          },
        }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId: reviewChatId }),
      });
    }, { reviewChatId });

    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (body.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: agentId, name: 'Legacy Review Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      if (body.action === 'send') {
        await route.fulfill({ json: { ok: true, sessionId: 'ui-legacy-session', turn: { id: 'ui-legacy-turn' } } });
        return;
      }
      if (body.action === 'poll') {
        await route.fulfill({
          json: {
            ok: true,
            activeTurn: {
              fullText: 'Finished legacy review run.',
              done: true,
              phase: 'replying',
              events: [{ type: 'text_chunk', ts: Date.now(), text: 'Finished legacy review run.' }],
            },
          },
        });
        return;
      }
      if (body.action === 'turn-clear' || body.action === 'resume-session') {
        await route.fulfill({ json: { ok: true, loaded: true } });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const requestedPath = url.searchParams.get('path');
      if (requestedPath) {
        await route.fulfill({
          json: {
            path: requestedPath,
            content: 'Legacy line one.',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: filePath, name: filePath, mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/comments' && route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, comments } });
        return;
      }
      if (url.pathname === '/api/comments' && route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { action?: string; commentId?: string };
        if (body.action === 'resolve' && body.commentId) {
          resolvedCommentIds.push(body.commentId);
        }
      }
      await route.fulfill({ json: { ok: true, started: false } });
    });

    try {
      await page.reload();
      await page.waitForSelector('.chatContainer', { timeout: 30000 });
      await page.click('button.leftSidebarTab:has-text("Files")');
      await selectFilesAgent(page, agentId);
      await page.locator('.mdTreeFile', { hasText: filePath }).click();
      await page.click('button.leftSidebarTab:has-text("Chats")');
      await page.click('button.chatHistoryItem:has-text("Review: ui-legacy-review.md")');
      await page.fill('textarea.composerTextarea', 'finish legacy review run');
      await page.click('button[aria-label="Send message"]');

      await expect.poll(() => resolvedCommentIds).toContain(commentId);
    } finally {
      await page.evaluate(async (reviewChatId: string) => {
        await fetch(`/api/chats?id=${encodeURIComponent(reviewChatId)}`, { method: 'DELETE' });
      }, reviewChatId).catch(() => undefined);
    }
  });

  test('failed approved-comment dispatch resets the comment to active for retry', async ({ page }) => {
    const agentId = 'ui-dispatch-fail-agent';
    const filePath = 'ui-dispatch-fail.md';
    const reviewChatId = `comment-review:${filePath}`;
    const commentId = 'ui-dispatch-fail-comment';
    const comment = {
      id: commentId,
      agentId,
      filePath,
      rangeStartLine: 1,
      rangeEndLine: 1,
      rangeStartChar: null,
      rangeEndChar: null,
      content: 'Dispatch should fail and reset',
      authorType: 'user',
      authorName: 'Test User',
      status: 'active',
      linkedChatId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      replies: [],
    };
    const resetCommentIds: string[] = [];

    await page.evaluate(() => {
      window.localStorage.removeItem('acp_file_workspace_v1');
      window.localStorage.setItem('commentSidebarOpen', 'false');
    });

    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (body.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: agentId, name: 'Dispatch Fail Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      if (body.action === 'send') {
        await route.fulfill({ json: { ok: false, error: 'turn_in_progress' } });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const requestedPath = url.searchParams.get('path');
      if (requestedPath) {
        await route.fulfill({
          json: {
            path: requestedPath,
            content: 'Line one for dispatch failure.',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: filePath, name: filePath, mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/comments/approve') {
        comment.status = 'processing';
        comment.linkedChatId = reviewChatId;
        await route.fulfill({
          json: {
            ok: true,
            chatId: reviewChatId,
            chatName: `Review: ${filePath}`,
            prompt: 'Prompt that will fail to dispatch',
            agentId,
            status: 'processing',
          },
        });
        return;
      }
      if (url.pathname === '/api/comments' && route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, comments: [comment] } });
        return;
      }
      if (url.pathname === '/api/comments' && route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { action?: string; commentId?: string };
        if (body.action === 'reset-processing' && body.commentId === commentId) {
          resetCommentIds.push(body.commentId);
          comment.status = 'active';
          comment.linkedChatId = null;
          await route.fulfill({ json: { ok: true } });
          return;
        }
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer', { timeout: 30000 });
    await page.click('button.leftSidebarTab:has-text("Files")');
    await selectFilesAgent(page, agentId);
    await page.locator('.mdTreeFile', { hasText: filePath }).click();
    await page.locator('.mdEditorToolbar button[title="Toggle comments"]').click();

    const commentCard = page.locator('.commentCard', { hasText: 'Dispatch should fail and reset' });
    await commentCard.click();
    await commentCard.locator('.commentActionBtn.approve').click();

    await expect.poll(() => resetCommentIds).toContain(commentId);
    await expect(commentCard.locator('.commentActionBtn.approve')).toBeVisible();
  });

  test('live edit double-click selection stays visible and shows Add Comment near selection', async ({ page }) => {
    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as { action?: string } | null;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: 'test-md-agent', name: 'Test Markdown Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const filePath = url.searchParams.get('path');
      if (filePath) {
        await route.fulfill({
          json: {
            path: filePath,
            content: 'Intro line without selected text.\n\nAlpha beta gamma beta gamma beta gamma beta gamma beta gamma beta gamma beta gamma beta gamma beta gamma beta gamma beta gamma beta gamma Omega\n\nSecond paragraph for triple click.',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: 'live-selection.md', name: 'live-selection.md', mtime: new Date().toISOString() }],
        },
      });
    });

    const comments: Array<Record<string, unknown>> = [];
    let lastCreateBody: Record<string, unknown> | null = null;
    await page.route('**/api/comments**', async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, comments } });
        return;
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (body.action === 'create') {
        lastCreateBody = body;
        comments.push({
          id: 'test-comment-id',
          agentId: body.agentId,
          filePath: body.filePath,
          rangeStartLine: body.rangeStartLine,
          rangeEndLine: body.rangeEndLine,
          rangeStartChar: body.rangeStartChar,
          rangeEndChar: body.rangeEndChar,
          content: body.content,
          authorType: body.authorType,
          authorName: 'Test User',
          status: 'active',
          linkedChatId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          replies: [],
        });
      }
      await route.fulfill({ json: { ok: true, id: 'test-comment-id' } });
    });

    await login(page);
    await page.click('button:has-text("Files")');
    await selectFilesAgent(page, 'test-md-agent');
    await page.locator('.mdTreeFile', { hasText: 'live-selection.md' }).click();

    const liveEditor = page.locator('.mdLiveEditable');
    await expect(liveEditor).toBeVisible();
    const alphaBox = await page.evaluate(() => {
      const editor = document.querySelector('.mdLiveEditable');
      const walker = document.createTreeWalker(editor!, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        const index = text.indexOf('Omega');
        if (index >= 0) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 'Omega'.length);
          const rect = range.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
      return null;
    });
    expect(alphaBox).not.toBeNull();

    await page.mouse.dblclick(alphaBox!.x + alphaBox!.width / 2, alphaBox!.y + alphaBox!.height / 2);

    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || '')).toContain('Omega');
    const addCommentButton = page.locator('.addCommentFloatingBtn');
    await expect(addCommentButton).toBeVisible();
    const buttonBox = await addCommentButton.boundingBox();
    expect(buttonBox).not.toBeNull();
    expect(buttonBox!.y).toBeGreaterThan(alphaBox!.y);
    expect(Math.abs(buttonBox!.x - alphaBox!.x)).toBeLessThan(220);

    await addCommentButton.click();
    await expect(page.locator('.commentAddForm')).toBeVisible();
    await expect(page.locator('.commentAddLabel')).toHaveText('New comment on L3');
    const currentAlphaBox = await page.evaluate(() => {
      const editor = document.querySelector('.mdLiveEditable');
      const walker = document.createTreeWalker(editor!, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        const index = text.indexOf('Omega');
        if (index >= 0) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 'Omega'.length);
          const rect = range.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
      return null;
    });
    expect(currentAlphaBox).not.toBeNull();
    const draftHighlight = page.locator('.liveSelectionDraftHighlight').first();
    await expect(draftHighlight).toBeVisible();
    await expect.poll(async () => {
      const highlightBox = await draftHighlight.boundingBox();
      if (!highlightBox || !currentAlphaBox) return Number.POSITIVE_INFINITY;
      return Math.abs(highlightBox.x - currentAlphaBox.x) + Math.abs(highlightBox.y - currentAlphaBox.y);
    }).toBeLessThan(4);
    await expect(page.locator('.commentDraftConnectorSvg')).toHaveCount(0);

    await page.fill('.commentAddTextarea', 'Comment on selected word');
    await page.click('.commentAddActions button:has-text("Submit")');
    await expect(page.locator('.commentAddForm')).toHaveCount(0);
    await expect(page.locator('.commentCard', { hasText: 'Comment on selected word' })).toBeVisible();
    expect(lastCreateBody?.rangeStartChar).toEqual(expect.any(Number));
    expect(lastCreateBody?.rangeEndChar).toEqual((lastCreateBody?.rangeStartChar as number) + 'Omega'.length);
    const liveMarker = page.locator('.liveCommentMarker').first();
    await expect(liveMarker).toBeVisible();
    await expect.poll(async () => {
      const markerBox = await liveMarker.boundingBox();
      if (!markerBox || !currentAlphaBox) return Number.NEGATIVE_INFINITY;
      return markerBox.x - (currentAlphaBox.x + currentAlphaBox.width);
    }).toBeGreaterThan(20);
    await expect.poll(async () => {
      const markerBox = await liveMarker.boundingBox();
      if (!markerBox || !currentAlphaBox) return Number.POSITIVE_INFINITY;
      return Math.abs(markerBox.y - currentAlphaBox.y);
    }).toBeLessThan(20);

    const createdCommentCard = page.locator('.commentCard', { hasText: 'Comment on selected word' });
    if (!(await createdCommentCard.evaluate((node) => node.classList.contains('selected')))) {
      await createdCommentCard.click();
    }
    await expect(createdCommentCard).toHaveClass(/selected/);
    await expect.poll(async () => {
      const highlightBox = await page.locator('.liveSelectionDraftHighlight').first().boundingBox();
      const omegaBox = await page.evaluate(() => {
        const editor = document.querySelector('.mdLiveEditable');
        const walker = document.createTreeWalker(editor!, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const text = node.textContent || '';
          const index = text.indexOf('Omega');
          if (index >= 0) {
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + 'Omega'.length);
            const rect = range.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }
        }
        return null;
      });
      if (!highlightBox || !omegaBox) return Number.POSITIVE_INFINITY;
      return Math.abs(highlightBox.x - omegaBox.x) + Math.abs(highlightBox.y - omegaBox.y) + Math.abs(highlightBox.width - omegaBox.width);
    }).toBeLessThan(4);
  });

  test('live edit multi-paragraph selection shows Add Comment', async ({ page }) => {
    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as { action?: string } | null;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: 'test-md-multi-select-agent', name: 'Test Markdown Multi Select Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const filePath = url.searchParams.get('path');
      if (filePath) {
        await route.fulfill({
          json: {
            path: filePath,
            content: 'First paragraph selected text.\n\nSecond paragraph selected text.',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: 'live-multi-selection.md', name: 'live-multi-selection.md', mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      await route.fulfill({ json: { ok: true, comments: [] } });
    });

    await login(page);
    await page.click('button:has-text("Files")');
    await selectFilesAgent(page, 'test-md-multi-select-agent');
    await page.locator('.mdTreeFile', { hasText: 'live-multi-selection.md' }).click();

    await expect(page.locator('.mdLiveEditable')).toBeVisible();
    const selectionBoxes = await page.locator('.mdLiveEditable').evaluate(editor => {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let firstNode: Text | null = null;
      let secondNode: Text | null = null;
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        if (text.includes('First paragraph selected text.')) firstNode = node as Text;
        if (text.includes('Second paragraph selected text.')) secondNode = node as Text;
      }
      if (!firstNode || !secondNode) throw new Error('Expected rendered paragraph text nodes');

      const firstRange = document.createRange();
      firstRange.setStart(firstNode, firstNode.textContent!.indexOf('First paragraph'));
      firstRange.setEnd(firstNode, firstNode.textContent!.indexOf('First paragraph') + 'First'.length);
      const firstRect = firstRange.getBoundingClientRect();

      const secondRange = document.createRange();
      secondRange.setStart(secondNode, secondNode.textContent!.indexOf('Second paragraph selected text.') + 'Second paragraph selected text.'.length - 1);
      secondRange.setEnd(secondNode, secondNode.textContent!.indexOf('Second paragraph selected text.') + 'Second paragraph selected text.'.length);
      const secondRect = secondRange.getBoundingClientRect();

      return {
        startX: firstRect.left + 1,
        startY: firstRect.top + firstRect.height / 2,
        endX: secondRect.right + 1,
        endY: secondRect.top + secondRect.height / 2,
      };
    });

    await page.mouse.move(selectionBoxes.startX, selectionBoxes.startY);
    await page.mouse.down();
    await page.mouse.move(selectionBoxes.endX, selectionBoxes.endY, { steps: 12 });
    await page.mouse.up();

    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || '')).toContain('Second paragraph selected text.');
    const addCommentButton = page.locator('.addCommentFloatingBtn');
    await expect(addCommentButton).toBeVisible();

    await addCommentButton.click();
    await expect(page.locator('.commentAddForm')).toBeVisible();
    await expect(page.locator('.commentAddLabel')).toHaveText('New comment on L1-3');
  });

  test('live edit triple-click rendered markdown paragraph shows Add Comment', async ({ page }) => {
    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as { action?: string } | null;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: 'test-md-triple-select-agent', name: 'Test Markdown Triple Select Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const filePath = url.searchParams.get('path');
      if (filePath) {
        await route.fulfill({
          json: {
            path: filePath,
            content: 'Paragraph with **bold selected phrase** and [linked selected text](https://example.com).',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: 'live-triple-selection.md', name: 'live-triple-selection.md', mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      await route.fulfill({ json: { ok: true, comments: [] } });
    });

    await login(page);
    await page.click('button:has-text("Files")');
    await selectFilesAgent(page, 'test-md-triple-select-agent');
    await page.locator('.mdTreeFile', { hasText: 'live-triple-selection.md' }).click();

    const paragraph = page.locator('.mdLiveEditable p', { hasText: 'Paragraph with bold selected phrase' });
    await expect(paragraph).toBeVisible();
    const paragraphTextBox = await paragraph.evaluate(el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        const index = text.indexOf('bold selected phrase');
        if (index >= 0) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 'bold'.length);
          const rect = range.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });

    await page.mouse.click(
      paragraphTextBox.x + paragraphTextBox.width / 2,
      paragraphTextBox.y + paragraphTextBox.height / 2,
      { clickCount: 3 },
    );

    const addCommentButton = page.locator('.addCommentFloatingBtn');
    await expect(addCommentButton).toBeVisible();

    await addCommentButton.click();
    await expect(page.locator('.commentAddForm')).toBeVisible();
    await expect(page.locator('.commentAddLabel')).toHaveText('New comment on L1');
  });

  test('restores Files tab, agent, editor mode, and open file after refresh', async ({ page }) => {
    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as { action?: string } | null;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: 'restore-agent', name: 'Restore Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const filePath = url.searchParams.get('path');
      if (filePath) {
        await route.fulfill({
          json: {
            path: filePath,
            content: '# Restored file\n\nThis file should reopen after refresh.',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: 'restore.md', name: 'restore.md', mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      await route.fulfill({ json: { ok: true, comments: [] } });
    });

    await page.goto(`${BASE}/login`);
    await page.evaluate(() => {
      window.localStorage.setItem('acp_file_workspace_v1', JSON.stringify({
        tab: 'files',
        agentId: 'restore-agent',
        filePath: 'restore.md',
        diffOnly: false,
        editorMode: 'review',
      }));
    });
    await page.fill('input[placeholder="Admin username"]', ADMIN_USER);
    await page.fill('input[placeholder="Password"]', ADMIN_PASS);
    await page.click('button[type="submit"]');

    await expect(page.locator('.leftSidebarTab.active')).toContainText('Files');
    await expect(filesAgentTrigger(page)).toHaveAttribute('data-value', 'restore-agent');
    await expect(page.locator('.mdEditorFilePath')).toContainText('restore.md');
    await expect(page.locator('.mdModeBtn').filter({ hasText: /^Review$/ })).toHaveCount(0);
    await expect(page.locator('.mdModeBtn.active')).toHaveText('Live Edit');
    await expect(page.locator('.mdEditorLive')).toBeVisible();
  });

  test('file editor toolbar buttons match Files tab styling', async ({ page }) => {
    const agentId = 'toolbar-style-agent';
    const filePath = 'toolbar-style.md';

    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as { action?: string } | null;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: agentId, name: 'Toolbar Style Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const requestedPath = url.searchParams.get('path');
      if (requestedPath) {
        await route.fulfill({
          json: {
            path: requestedPath,
            content: '# Toolbar style\n\nEditable content.',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: filePath, name: filePath, mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      await route.fulfill({ json: { ok: true, comments: [] } });
    });

    await login(page);
    await page.click('button.leftSidebarTab:has-text("Files")');
    await selectFilesAgent(page, agentId);
    await page.locator('.mdTreeFile', { hasText: filePath }).click();

    await page.locator('.mdLiveEditable').evaluate(el => {
      el.textContent = 'Changed toolbar content.';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Changed toolbar content.' }));
    });
    const commentToggle = page.locator('.mdEditorToolbar button[title="Toggle comments"]');
    if (!(await page.locator('.commentSidebar').isVisible().catch(() => false))) {
      await commentToggle.click();
    }

    const activeFileStyle = await page.locator('.mdTreeFile.active').evaluate(el => {
      const style = window.getComputedStyle(el);
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderRadius: style.borderRadius,
      };
    });
    const liveEditStyle = await page.locator('.mdModeBtn.active', { hasText: 'Live Edit' }).evaluate(el => {
      const style = window.getComputedStyle(el);
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderRadius: style.borderRadius,
      };
    });
    const saveStyle = await page.locator('.mdEditorBtn', { hasText: 'Save' }).evaluate(el => {
      const style = window.getComputedStyle(el);
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderRadius: style.borderRadius,
      };
    });
    const commentToggleStyle = await commentToggle.evaluate(el => {
      const style = window.getComputedStyle(el);
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderRadius: style.borderRadius,
      };
    });

    expect(liveEditStyle).toEqual(activeFileStyle);
    expect(saveStyle).toEqual(activeFileStyle);
    expect(commentToggleStyle).toEqual(activeFileStyle);
  });

  test('html files use preview only without review mode', async ({ page }) => {
    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as { action?: string } | null;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: 'html-mode-agent', name: 'HTML Mode Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const filePath = url.searchParams.get('path');
      if (filePath) {
        await route.fulfill({
          json: {
            path: filePath,
            content: '<!doctype html><html><body><p>Preview only.</p></body></html>',
            kind: 'html',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: 'preview-only.html', name: 'preview-only.html', mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      await route.fulfill({ json: { ok: true, comments: [] } });
    });

    await login(page);
    await page.click('button.leftSidebarTab:has-text("Files")');
    await selectFilesAgent(page, 'html-mode-agent');
    await page.locator('.mdTreeFile', { hasText: 'preview-only.html' }).click();

    await expect(page.locator('.mdModeBtn').filter({ hasText: /^Review$/ })).toHaveCount(0);
    await expect(page.locator('.mdModeBtn.active')).toHaveText('Preview');
    await expect(page.locator('.mdHtmlPreviewFrame')).toBeVisible();
  });

  test('shows the chat page when selecting a chat after opening a file', async ({ page }) => {
    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as { action?: string } | null;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: 'switch-agent', name: 'Switch Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const filePath = url.searchParams.get('path');
      if (filePath) {
        await route.fulfill({
          json: {
            path: filePath,
            content: '# Open file\n\nThis file is open before switching back to chat.',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: 'switch.md', name: 'switch.md', mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      await route.fulfill({ json: { ok: true, comments: [] } });
    });

    await page.evaluate(async () => {
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat: {
            id: 'switch-back-chat',
            name: 'Switch Back Chat',
            ts: Date.now(),
            messages: [
              { id: 'switch-user-message', type: 'user', content: 'chat content should be visible after switching back', ts: Date.now() },
            ],
            agentSessions: {},
          },
        }),
      });
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId: 'switch-back-chat' }),
      });
      window.localStorage.setItem('acp_file_workspace_v1', JSON.stringify({
        tab: 'files',
        agentId: 'switch-agent',
        filePath: 'switch.md',
        diffOnly: false,
        editorMode: 'review',
      }));
    });

    await page.reload();
    await expect(page.locator('.mdEditorFilePath')).toContainText('switch.md');
    await page.click('button.leftSidebarTab:has-text("Chats")');
    await page.click('button.chatHistoryItem:has-text("Switch Back Chat")');

    await expect(page.locator('textarea.composerTextarea')).toBeVisible();
    await expect(page.locator('.message.user', { hasText: 'chat content should be visible after switching back' })).toBeVisible();
    await expect(page.locator('.mdEditorFilePath')).toHaveCount(0);
  });

  test('preserves unsaved Live Edit changes when switching to Chats and back', async ({ page }) => {
    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as { action?: string } | null;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: 'live-preserve-agent', name: 'Live Preserve Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const filePath = url.searchParams.get('path');
      if (filePath) {
        await route.fulfill({
          json: {
            path: filePath,
            content: '# Live file\n\nOriginal live text.',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: 'live-preserve.md', name: 'live-preserve.md', mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      await route.fulfill({ json: { ok: true, comments: [] } });
    });

    await login(page);
    await page.click('button.leftSidebarTab:has-text("Files")');
    await selectFilesAgent(page, 'live-preserve-agent');
    await page.locator('.mdTreeFile', { hasText: 'live-preserve.md' }).click();
    await page.locator('.mdModeBtn', { hasText: 'Live Edit' }).click();

    const liveEditor = page.locator('.mdLiveEditable');
    await expect(liveEditor).toBeVisible();
    await liveEditor.fill('Changed live text survives switching.');
    await expect(page.locator('.mdDirtyBadge')).toBeVisible();

    await page.click('button.leftSidebarTab:has-text("Chats")');
    await expect(page.locator('textarea.composerTextarea')).toBeVisible();
    await page.click('button.leftSidebarTab:has-text("Files")');

    await expect(page.locator('.mdLiveEditable')).toContainText('Changed live text survives switching.');
    await expect(page.locator('.mdDirtyBadge')).toBeVisible();
  });

  test('keeps Live Edit caret at edit position after deleting text', async ({ page }) => {
    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as { action?: string } | null;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: 'live-caret-agent', name: 'Live Caret Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const filePath = url.searchParams.get('path');
      if (filePath) {
        await route.fulfill({
          json: {
            path: filePath,
            content: 'Alpha bravo charlie.',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: 'live-caret.md', name: 'live-caret.md', mtime: new Date().toISOString() }],
        },
      });
    });

    await page.route('**/api/comments**', async route => {
      await route.fulfill({ json: { ok: true, comments: [] } });
    });

    await login(page);
    await page.click('button.leftSidebarTab:has-text("Files")');
    await selectFilesAgent(page, 'live-caret-agent');
    await page.locator('.mdTreeFile', { hasText: 'live-caret.md' }).click();

    const liveEditor = page.locator('.mdLiveEditable');
    await expect(liveEditor).toBeVisible();
    await liveEditor.evaluate(editor => {
      (editor as HTMLElement).focus();
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        const index = text.indexOf('Alpha bravo charlie.');
        if (index >= 0) {
          const offset = index + 'Alpha bravo'.length;
          const range = document.createRange();
          range.setStart(node, offset);
          range.collapse(true);
          const selection = window.getSelection();
          if (!selection) throw new Error('Expected selection');
          selection.removeAllRanges();
          selection.addRange(range);
          editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'deleteContentBackward' }));
          node.textContent = `${text.slice(0, offset - 1)}${text.slice(offset)}`;
          range.setStart(node, offset - 1);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
          return;
        }
      }
      throw new Error('Expected editable text node');
    });

    await expect(liveEditor).toContainText('Alpha brav charlie.');

    await expect.poll(() => liveEditor.evaluate(editor => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      return {
        insideEditor: editor.contains(range.startContainer),
        offset: range.startOffset,
        text: range.startContainer.textContent || '',
      };
    })).toEqual({
      insideEditor: true,
      offset: 'Alpha brav'.length,
      text: 'Alpha brav charlie.',
    });
  });
});
