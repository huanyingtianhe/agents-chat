import { expect, test } from '@playwright/test';
import {
  installMobileChatFixture,
  loginMobileFixture,
} from './helpers/mobileChatFixture';

test.beforeEach(async ({ page }) => {
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
});

test('masks the previous desktop chat and composer while loading', async ({ page }) => {
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  await page.route('**/api/chats**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (id === 'second-mobile-chat') await loadGate;
    await route.fallback();
  });

  await page.getByRole('button', { name: 'Second mobile chat' }).click();

  await expect(page.getByRole('status', { name: 'Loading Second mobile chat' })).toBeVisible();
  await expect(page.getByText('Existing mobile message')).toHaveCount(0);
  await expect(page.locator('textarea.composerTextarea')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Third mobile chat' })).toBeVisible();

  releaseLoad();
  await expect(page.getByText('Second chat message')).toBeVisible();
  await expect(page.locator('textarea.composerTextarea')).toBeVisible();
});

test('keeps the latest desktop chat when an earlier selection finishes last', async ({ page }) => {
  let releaseSecond!: () => void;
  let releaseThird!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const thirdGate = new Promise<void>((resolve) => { releaseThird = resolve; });
  await page.route('**/api/chats**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (id === 'second-mobile-chat') await secondGate;
    if (id === 'third-mobile-chat') await thirdGate;
    await route.fallback();
  });

  await page.getByRole('button', { name: 'Second mobile chat' }).click();
  await expect(page.getByRole('status', { name: 'Loading Second mobile chat' })).toBeVisible();
  await page.getByRole('button', { name: 'Third mobile chat' }).click();
  await expect(page.getByRole('status', { name: 'Loading Third mobile chat' })).toBeVisible();

  releaseThird();
  await expect(page.getByText('Third chat message')).toBeVisible();

  releaseSecond();
  await expect(page.getByText('Third chat message')).toBeVisible();
  await expect(page.getByText('Second chat message')).toHaveCount(0);
});

test('shows the saved title and masks Chat content during an F5 restore', async ({ page }) => {
  let releaseInitialChat!: () => void;
  const initialChatGate = new Promise<void>((resolve) => {
    releaseInitialChat = resolve;
  });
  await page.route('**/api/chats**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (id === 'mobile-chat') await initialChatGate;
    await route.fallback();
  });

  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('status', { name: 'Loading Mobile coverage' })).toBeVisible();
  const activeChat = page.locator('.chatHistoryRow.active');
  await expect(activeChat).toContainText('Mobile coverage');
  await expect(activeChat).not.toContainText('New Chat');
  await expect(page.getByText('Existing mobile message')).toHaveCount(0);
  await expect(page.locator('textarea.composerTextarea')).toHaveCount(0);

  releaseInitialChat();
  await expect(page.getByText('Existing mobile message')).toBeVisible();
  await expect(page.locator('textarea.composerTextarea')).toBeVisible();
});

test('shows the empty homepage after an F5 restore with no chats', async ({ page }) => {
  await page.route('**/api/chats**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (id) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, chats: [], lastChatId: null }),
    });
  });

  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Agents Chat' })).toBeVisible();
  await expect(page.getByRole('status', { name: /Loading/ })).toHaveCount(0);
  await expect(page.locator('textarea.composerTextarea')).toHaveCount(0);
});

test('shows an initial Chat load error and retries with the saved title', async ({ page }) => {
  await expect(page.getByText('Existing mobile message')).toBeVisible();
  let detailAttempts = 0;
  await page.route('**/api/chats**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (id !== 'mobile-chat' || detailAttempts++ > 0) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'temporarily unavailable' }),
    });
  });

  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('alert', {
    name: 'Failed to load Mobile coverage',
  })).toBeVisible();
  await expect(page.locator('.chatHistoryRow.active')).toContainText('Mobile coverage');
  await expect(page.locator('textarea.composerTextarea')).toHaveCount(0);

  await page.getByRole('button', { name: 'Retry loading Mobile coverage' }).click();

  await expect(page.getByText('Existing mobile message')).toBeVisible();
  await expect(page.locator('textarea.composerTextarea')).toBeVisible();
});

test('does not let a delayed F5 restore replace a manual Chat selection', async ({ page }) => {
  let releaseInitialChat!: () => void;
  const initialChatGate = new Promise<void>((resolve) => {
    releaseInitialChat = resolve;
  });
  await page.route('**/api/chats**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (id === 'mobile-chat') await initialChatGate;
    await route.fallback();
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('status', { name: 'Loading Mobile coverage' })).toBeVisible();

  await page.getByRole('button', { name: 'Second mobile chat' }).click();
  await expect(page.getByText('Second chat message')).toBeVisible();

  releaseInitialChat();
  await expect(page.getByText('Second chat message')).toBeVisible();
  await expect(page.getByText('Existing mobile message')).toHaveCount(0);
});
