import { expect, test, type Page } from '@playwright/test';
import { applyFixtureChatSave, chatSaveAcknowledgement } from './helpers/chatSaveFixture';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';

async function pickOption(page: Page, label: string, value: string) {
  const trigger = page.getByLabel(label);
  await expect(trigger).toBeVisible({ timeout: 15000 });
  await expect(trigger).toBeEnabled({ timeout: 15000 });
  await trigger.click();
  await page.locator(`[role="option"][data-value="${value}"]`).click();
}

test('shows branch/worktree controls in the status bar and keeps selection per chat', async ({ page }) => {
  const chats = new Map<string, any>();
  const gitContextLoadedChatIds = new Set<string>();
  let lastChatId = '';
  let createdChatId = '';
  let agentsListed = false;
  const gitContextUpdates: string[] = [];

  function buildGitContextOptions(chat: any) {
    const effective = chat?.gitContext || {
      repoRoot: 'C:/repo',
      worktreePath: 'C:/repo',
      branchName: 'main',
    };
    return {
      available: true,
      repoRoot: 'C:/repo',
      branches: ['main', 'feat/a', 'feat/b'],
      worktrees: [
        { worktreePath: 'C:/repo', branchName: 'main', isMain: true },
        { worktreePath: 'C:/repo/.worktrees/feat-a', branchName: 'feat/a', isMain: false },
        { worktreePath: 'C:/repo/.worktrees/feat-b', branchName: 'feat/b', isMain: false },
      ],
      effective,
    };
  }

  await page.route('**/api/chats**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.method() === 'GET') {
      const id = url.searchParams.get('id');
      if (id) {
        const chat = chats.get(id);
        if (!chat) {
          await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'not_found' }) });
          return;
        }
        gitContextLoadedChatIds.add(id);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, chat, gitContextOptions: buildGitContextOptions(chat) }),
        });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          chats: [...chats.values()].map((chat) => ({ id: chat.id, name: chat.name, ts: chat.ts })),
          lastChatId,
        }),
      });
      return;
    }

    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      const delta = body.operation?.chat || body.chat;
      const saved = applyFixtureChatSave(body, delta && chats.get(delta.id));
      if (saved) {
        createdChatId = saved.id;
        chats.set(saved.id, saved);
      }
      if (body?.action === 'set-last-chat') {
        lastChatId = body.chatId || '';
      }
      if (body?.action === 'update-git-context') {
        gitContextUpdates.push(body.gitContext?.worktreePath || '');
        const existing = chats.get(body.chatId);
        if (existing) {
          existing.gitContext = body.gitContext;
          existing.agentSessions = {};
          chats.set(body.chatId, existing);
        }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, gitContext: body.gitContext }) });
        return;
      }
      await route.fulfill({ json: chatSaveAcknowledgement(body) });
      return;
    }

    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action === 'list-agents') {
      agentsListed = true;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          agents: [{
            id: 'alpha',
            name: 'Alpha Agent',
            canTalk: true,
            canModify: true,
            public: true,
            relay: false,
            noTools: false,
            command: 'mock',
            args: [],
            cwd: 'C:/repo',
            models: [{ modelId: 'gpt-5.3', name: 'GPT-5.3' }],
            defaultModelId: 'gpt-5.3',
          }],
        }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/orchestrations**', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) });
  });

  await page.goto(`${BASE}/login`);
  await page.locator('input[placeholder="Admin username"]').fill(process.env.ADMIN_USERNAME || 'admin');
  await page.locator('input[placeholder="Password"]').fill(process.env.ADMIN_PASSWORD || 'admin123');
  await page.locator('button[type="submit"]').click();

  async function createChatAndWaitForGitContext(buttonSelector: string) {
    const previousChatId = createdChatId;
    await expect.poll(() => agentsListed, { timeout: 15000 }).toBe(true);
    const button = page.locator(buttonSelector);
    await expect(button).toBeVisible({ timeout: 15000 });
    await expect(button).toBeEnabled({ timeout: 15000 });
    await button.click();
    await expect.poll(() => createdChatId, { timeout: 15000 }).not.toBe(previousChatId);
    await expect.poll(() => gitContextLoadedChatIds.has(createdChatId), { timeout: 15000 }).toBe(true);
  }

  await createChatAndWaitForGitContext('button.emptyHomepageNewChat');
  await expect(page.locator('button.newChatButton')).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel('Branch', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel('Worktree', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel('Worktree', { exact: true })).toBeEnabled({ timeout: 15000 });

  await pickOption(page, 'Worktree', 'C:/repo/.worktrees/feat-a');
  expect(gitContextUpdates).toContain('C:/repo/.worktrees/feat-a');
  await expect(page.getByLabel('Worktree', { exact: true })).toHaveAttribute('data-value', 'C:/repo/.worktrees/feat-a');

  await createChatAndWaitForGitContext('button.newChatButton');
  await pickOption(page, 'Worktree', 'C:/repo/.worktrees/feat-b');
  expect(gitContextUpdates).toContain('C:/repo/.worktrees/feat-b');
  await expect(page.getByLabel('Worktree', { exact: true })).toHaveAttribute('data-value', 'C:/repo/.worktrees/feat-b');

  await page.getByRole('button', { name: /Chats/i }).first().click();
  const firstChat = page.locator('.participantsSidebar .chatHistoryItem').nth(1);
  await firstChat.click();

  await expect(page.getByLabel('Worktree', { exact: true })).toHaveAttribute('data-value', 'C:/repo/.worktrees/feat-a');
});
