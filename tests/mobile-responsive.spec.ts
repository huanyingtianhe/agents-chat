import { expect, test } from '@playwright/test';
import {
  installMobileChatFixture,
  loginMobileFixture,
} from './helpers/mobileChatFixture';

test.beforeEach(async ({ page }) => {
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
});

test('separates left navigation from management actions', async ({ page }) => {
  const navigation = page.getByRole('button', { name: 'Open navigation' });
  await expect(navigation).toBeVisible();
  await navigation.click();
  await expect(page.locator('.participantsSidebar')).toHaveClass(/mobilePanelVisible/);
  await expect(page.getByRole('tab', { name: 'Chats' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();

  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.locator('.participantsSidebar')).not.toHaveClass(/mobilePanelVisible/);
  const menu = page.getByRole('menu', { name: 'Header actions' });
  await expect(menu.getByRole('menuitem', { name: 'Chats' })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Files' })).toHaveCount(0);
  for (const name of ['Theme', 'Agents', 'Nodes', 'Schedules', 'Settings']) {
    await expect(menu.getByRole('menuitem', { name })).toBeVisible();
  }
});

test('keeps only one mobile overlay active', async ({ page }) => {
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Agents' }).click();
  await expect(page.locator('.agentsSidebar').filter({ hasText: 'Agents' })).toHaveClass(/mobilePanelVisible/);
  await expect(page.locator('.participantsSidebar')).not.toHaveClass(/mobilePanelVisible/);
  await expect(page.locator('.mobilePanelBackdrop')).toHaveCount(1);
});

test('moves focus into overlays and restores persistent top-level openers', async ({ page }) => {
  const navigation = page.getByRole('button', { name: 'Open navigation' });
  await navigation.click();
  await expect(page.getByRole('tab', { name: 'Chats' })).toBeFocused();
  await page.getByRole('button', { name: 'Close navigation' }).click();
  await expect(navigation).toBeFocused();

  const more = page.getByRole('button', { name: 'More actions' });
  for (const surfaceName of ['Theme', 'Settings']) {
    await more.click();
    await expect(page.getByRole('menu', { name: 'Header actions' }).getByRole('menuitem', { name: 'Theme' })).toBeFocused();
    await page.getByRole('menuitem', { name: surfaceName }).click();
    await expect(page.getByRole('menu', { name: surfaceName }).getByRole('menuitem', { name: 'Back' })).toBeFocused();
    await page.getByRole('button', { name: 'Close active panel' }).click();
    await expect(more).toBeFocused();
  }

  const account = page.locator('.userNameButton');
  await account.click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeFocused();
  await page.getByRole('button', { name: 'Close active panel' }).click();
  await expect(account).toBeFocused();
});

test('close arrows clear panel state, backdrop, body lock, and restore More focus', async ({ page }) => {
  const more = page.getByRole('button', { name: 'More actions' });

  for (const panel of ['agents', 'nodes', 'schedules'] as const) {
    const label = panel[0].toUpperCase() + panel.slice(1);
    await more.click();
    await page.getByRole('menu', { name: 'Header actions' }).getByRole('menuitem', { name: label }).click();

    const close = page.getByRole('button', { name: `Close ${panel}` });
    await expect(close).toBeFocused();
    await expect(page.locator('.mobilePanelBackdrop')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await expect.poll(() => page.evaluate(() => window.history.state?.agentsChatMobileOverlay)).toBe(true);

    await close.click();

    await expect(page.locator(`[data-mobile-overlay-surface="${panel}"]`)).toHaveCount(0);
    await expect(page.locator('.mobilePanelBackdrop')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
    await expect.poll(() => page.evaluate(() => window.history.state?.agentsChatMobileOverlay ?? false)).toBe(false);
    await expect(more).toBeFocused();
  }
});
