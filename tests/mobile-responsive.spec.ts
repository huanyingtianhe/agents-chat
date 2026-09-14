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
