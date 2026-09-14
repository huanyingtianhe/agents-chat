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

test('preserves composer and current chat state while opening and closing navigation', async ({ page }) => {
  const composer = page.locator('textarea.composerTextarea');
  await composer.fill('unsent mobile draft');
  await expect(page.getByText('Existing mobile message')).toBeVisible();

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await page.getByRole('button', { name: 'Close active panel' }).click();

  await expect(composer).toHaveValue('unsent mobile draft');
  await expect(page.getByText('Existing mobile message')).toBeVisible();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
});

test('closes navigation only after a successful chat selection', async ({ page }) => {
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Second mobile chat' }).click();

  await expect(page.locator('.participantsSidebar')).not.toHaveClass(/mobilePanelVisible/);
  await expect(page.getByText('Second chat message')).toBeVisible();
});

test('keeps navigation open after a failed chat selection', async ({ page }) => {
  await page.route('**/api/chats**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (id === 'second-mobile-chat') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'Chat unavailable' }),
      });
      return;
    }
    await route.fallback();
  });

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Second mobile chat' }).click();
  await expect(page.locator('.participantsSidebar')).toHaveClass(/mobilePanelVisible/);
});

test('closes the drawer after selecting a file and keeps the viewer in main content', async ({ page }) => {
  await page.locator('textarea.composerTextarea').fill('draft retained behind file');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('tab', { name: 'Files' }).click();
  await page.getByRole('button', { name: 'Files agent' }).click();
  await page.getByRole('option', { name: 'Alpha Agent' }).click();
  await page.getByRole('button', { name: 'README.md' }).click();

  await expect(page.locator('.participantsSidebar')).not.toHaveClass(/mobilePanelVisible/);
  await expect(page.locator('.mdEditorInline')).toBeVisible();
  await expect(page.getByTitle('Toggle comments')).toBeVisible();
  await expect(page.getByRole('button', { name: /Save/ })).toHaveCount(0);
  await expect(page.getByText('Use the desktop interface to edit files.')).toBeVisible();
  await expect(page.locator('textarea.composerTextarea')).toHaveCount(0);

  await page.getByRole('button', { name: /Close/ }).click();
  await expect(page.locator('textarea.composerTextarea')).toHaveValue('draft retained behind file');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
});

test('keeps navigation open and reports a failed file preview', async ({ page }) => {
  await page.route('**/api/markdown**', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (path === 'broken.md') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Preview unavailable' }),
      });
      return;
    }
    await route.fallback();
  });

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('tab', { name: 'Files' }).click();
  await page.getByRole('button', { name: 'Files agent' }).click();
  await page.getByRole('option', { name: 'Alpha Agent' }).click();
  await page.getByRole('button', { name: 'broken.md' }).click();

  await expect(page.locator('.participantsSidebar')).toHaveClass(/mobilePanelVisible/);
  await expect(page.getByRole('alert')).toContainText('Preview unavailable');
});

test('Escape and browser back close the active overlay and restore trigger focus', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Open navigation' });
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.goBack();
  await expect(page.locator('.participantsSidebar')).not.toHaveClass(/mobilePanelVisible/);
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(/\/$/);
});
