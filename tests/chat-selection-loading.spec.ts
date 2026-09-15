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
