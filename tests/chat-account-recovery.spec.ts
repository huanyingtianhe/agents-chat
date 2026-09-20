import { expect, test, type Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';
import type { ChatOutboxEntry } from '../app/features/chat/runtime/chatOutboxStore';

async function drafts(page: Page): Promise<ChatOutboxEntry[]> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('agents-chat-outbox', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('operations');
      const read = transaction.objectStore('operations').getAll();
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
      transaction.oncomplete = () => database.close();
    };
  }));
}

for (const action of ['Retry saving drafts', 'Discard local draft', 'Save as new message']) {
  test(`account changes during ${action} cannot consume or display the previous account's draft`, async ({ page }) => {
    await installMobileChatFixture(page);
    await loginMobileFixture(page);
    await expect.poll(async () => (await drafts(page)).length).toBe(0);
    let holdRead = false;
    let reading = false;
    let finished = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writes: string[] = [];
    await page.route('**/api/chats**', async route => {
      if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'save-sync') {
        writes.push(route.request().postData() || '');
        return route.fulfill({ status: 503, json: { ok: false, error: 'Offline fixture' } });
      }
      if (holdRead && route.request().method() === 'GET' && new URL(route.request().url()).searchParams.has('id')) {
        reading = true;
        await gate;
        await route.fulfill({ json: {
          ok: true, chat: {
            id: 'mobile-chat', name: 'Alice private', ts: 1, agentSessions: {},
            messages: [{ id: 'welcome', type: 'user', content: 'Late Alice-only response', ts: 1, version: 2 }],
          },
        } });
        finished = true;
        return;
      }
      return route.fallback();
    });
    try {
      await page.locator('textarea.composerTextarea').fill('Alice private pending draft');
      await page.locator('textarea.composerTextarea').press('Enter');
      await expect(page.locator('.userSendFailureCard')).toBeVisible();
      const panel = page.getByTestId('chat-outbox');
      await panel.locator('summary').first().click();
      const before = await drafts(page);
      expect(before.length).toBeGreaterThan(0);
      holdRead = true;
      await panel.getByRole('button', { name: action, exact: true }).first().click();
      await expect.poll(() => reading).toBe(true);
      const writesBeforeSwitch = writes.length;
      const secret = process.env.NEXTAUTH_SECRET;
      if (!secret) throw new Error('NEXTAUTH_SECRET is required for the authenticated account-switch test');
      const cookie = (await page.context().cookies()).find(item => item.name === 'next-auth.session-token');
      if (!cookie) throw new Error('Missing authenticated session cookie');
      const token = await encode({ secret, token: { sub: 'bob', name: 'Bob', email: 'bob@local', role: 'admin' } });
      await page.context().addCookies([{ ...cookie, value: token }]);
      const session = page.waitForResponse(response => response.url().includes('/api/auth/session'));
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      expect((await (await session).json()).user.email).toBe('bob@local');
      await expect(panel).toHaveCount(0);
      release();
      await expect.poll(() => finished).toBe(true);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.getByText('Late Alice-only response', { exact: true })).toHaveCount(0);
      expect((await drafts(page)).map(entry => entry.operation.operationId).sort())
        .toEqual(before.map(entry => entry.operation.operationId).sort());
      expect(writes.length).toBe(writesBeforeSwitch);
    } finally {
      release();
      await page.goto('about:blank');
    }
  });
}
