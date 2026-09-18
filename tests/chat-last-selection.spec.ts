import { expect, test } from '@playwright/test';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';

test.beforeEach(async ({ page }) => {
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
});

for (const hasHistory of [false, true]) {
  test(`ignores a deleted last chat with ${hasHistory ? 'remaining history' : 'empty history'}`, async ({ page }) => {
    const requestedDetails: string[] = [];
    await page.route('**/api/chats**', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      const id = new URL(route.request().url()).searchParams.get('id');
      if (id) {
        requestedDetails.push(id);
        if (id === 'deleted-chat') {
          await route.fulfill({
            status: 404,
            json: { ok: false, error: 'not_found' },
          });
        } else {
          await route.fallback();
        }
        return;
      }
      await route.fulfill({
        json: {
          ok: true,
          chats: hasHistory ? [{ id: 'mobile-chat', name: 'Mobile coverage', ts: 1_000 }] : [],
          lastChatId: 'deleted-chat',
        },
      });
    });

    await page.reload({ waitUntil: 'domcontentloaded' });

    if (hasHistory) {
      await expect(page.getByText('Existing mobile message')).toBeVisible();
      await expect(page.locator('.chatHistoryRow.active')).toContainText('Mobile coverage');
      expect(requestedDetails).toContain('mobile-chat');
    } else {
      await expect(page.locator('.emptyHomepage')).toBeVisible();
      await expect(page.locator('textarea.composerTextarea')).toHaveCount(0);
    }
    expect(requestedDetails).not.toContain('deleted-chat');
    await expect(page.getByRole('alert', { name: /Failed to load/ })).toHaveCount(0);
  });
}

test('deleting a chat through the API clears only its last-chat preference', async ({ page }) => {
  const api = page.request;
  const listResponse = await api.get('/api/chats');
  expect(listResponse.ok()).toBe(true);
  const previous = await listResponse.json();
  const selectedId = `last-selection-${Date.now()}`;
  const otherId = `${selectedId}-other`;

  try {
    for (const id of [selectedId, otherId]) {
      const saved = await api.post('/api/chats', {
        data: { chat: { id, name: id, ts: Date.now(), messages: [] } },
      });
      expect(saved.ok()).toBe(true);
    }
    const selected = await api.post('/api/chats', {
      data: { action: 'set-last-chat', chatId: selectedId },
    });
    expect(selected.ok()).toBe(true);

    expect((await api.delete(`/api/chats?id=${otherId}`)).ok()).toBe(true);
    expect(await (await api.get('/api/chats')).json()).toMatchObject({ lastChatId: selectedId });

    expect((await api.delete(`/api/chats?id=${selectedId}`)).ok()).toBe(true);
    const afterDelete = await (await api.get('/api/chats')).json();
    expect(afterDelete).toMatchObject({ ok: true, lastChatId: null });
    expect(afterDelete.chats.map((chat: { id: string }) => chat.id)).not.toContain(selectedId);
    expect((await api.get(`/api/chats?id=${selectedId}`)).status()).toBe(404);
  } finally {
    for (const id of [selectedId, otherId]) {
      expect((await api.delete(`/api/chats?id=${id}`)).ok()).toBe(true);
    }
    expect((await api.post('/api/chats', {
      data: { action: 'set-last-chat', chatId: previous.lastChatId || '' },
    })).ok()).toBe(true);
  }
});
