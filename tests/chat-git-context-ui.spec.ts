import { expect, test } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';

test('shows branch/worktree controls under composer and keeps selection per chat', async ({ page }) => {
  const chats = new Map<string, any>();
  let lastChatId = '';

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
      if (body?.chat) {
        chats.set(body.chat.id, body.chat);
      }
      if (body?.action === 'set-last-chat') {
        lastChatId = body.chatId || '';
      }
      if (body?.action === 'update-git-context') {
        const existing = chats.get(body.chatId);
        if (existing) {
          existing.gitContext = body.gitContext;
          existing.agentSessions = {};
          chats.set(body.chatId, existing);
        }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, gitContext: body.gitContext }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }

    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action === 'list-agents') {
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

  await page.locator('button.emptyHomepageNewChat').click();
  await expect(page.getByLabel('Branch')).toBeVisible();
  await expect(page.getByLabel('Worktree')).toBeVisible();

  await page.getByLabel('Worktree').selectOption('C:/repo/.worktrees/feat-a');

  await page.locator('button.emptyHomepageNewChat').click();
  await page.getByLabel('Worktree').selectOption('C:/repo/.worktrees/feat-b');

  await page.getByRole('button', { name: /Chats/i }).first().click();
  const firstChat = page.locator('.participantsSidebar .participantItem').first();
  await firstChat.click();

  await expect(page.getByLabel('Worktree')).toHaveValue('C:/repo/.worktrees/feat-a');
});
