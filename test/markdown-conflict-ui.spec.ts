import { test, expect } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[placeholder="Admin username"]', 'admin');
  await page.fill('input[placeholder="Password"]', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.chatContainer', { timeout: 30000 });
}

test('Files editor shows conflict choices and manual diff resolver', async ({ page }) => {
  await page.route('**/api/acp', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const body = request.postDataJSON();
    if (body?.action === 'list-agents') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, agents: [{ id: 'test-agent', name: 'Test Agent', cwd: '/tmp/test-agent', canTalk: true }] }),
      });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/chats**', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, chats: [] }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/markdown**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && !url.searchParams.get('path')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ files: [{ path: 'docs/conflict.md', name: 'conflict.md', mtime: '2026-01-01T00:00:00.000Z' }] }),
      });
    }
    if (request.method() === 'GET') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ path: 'docs/conflict.md', content: 'base line\nold line\n', kind: 'markdown', mtime: '2026-01-01T00:00:00.000Z' }),
      });
    }
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'conflict',
        message: 'File was modified externally. Choose how to resolve the conflict.',
        serverContent: 'base line\nserver line\n',
        serverMtime: '2026-01-01T00:00:05.000Z',
      }),
    });
  });

  await login(page);
  await page.getByRole('button', { name: /Files/ }).click();
  await page.locator('select.remoteAgentSelect').selectOption('test-agent');
  await page.getByRole('button', { name: /conflict\.md/ }).click();
  await page.getByRole('button', { name: 'Split' }).click();
  await page.locator('textarea.mdEditorTextarea').fill('base line\nmy line\n');
  await page.getByRole('button', { name: /Save/ }).click();

  await expect(page.getByRole('dialog', { name: 'File changed on disk' })).toBeVisible();
  await expect(page.getByText('Reload will discard your current unsaved changes.')).toBeVisible();
  await page.getByRole('button', { name: 'Handle conflict manually' }).click();

  await expect(page.locator('.mdConflictDiffPage')).toBeVisible();
  await expect(page.getByText('Server')).toBeVisible();
  await expect(page.getByText('Mine')).toBeVisible();
  await expect(page.getByText('server line')).toBeVisible();
  await expect(page.getByText('my line')).toBeVisible();
  await expect(page.locator('#md-conflict-resolved')).toHaveValue('base line\nmy line\n');
});
