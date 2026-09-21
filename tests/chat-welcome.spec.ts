import { expect, test, type Page } from '@playwright/test';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';

async function openNavigation(page: Page) {
  const toggle = page.getByRole('button', { name: 'Open navigation' });
  if (await toggle.isVisible()) await toggle.click();
}

test.beforeEach(async ({ page }) => {
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
});

test('new chat welcomes without adding history and disappears on first message', async ({ page }, info) => {
  const welcome = page.getByRole('region', { name: 'Welcome to Agents Chat' });
  await expect(welcome).toHaveCount(0);
  await openNavigation(page);
  await page.getByRole('button', { name: /New Chat/ }).first().click();
  await expect(page.locator('.chatWelcome')).toBeAttached();
  const closeNavigation = page.getByRole('button', { name: 'Close navigation', exact: true });
  if (await closeNavigation.isVisible()) await closeNavigation.click();
  await expect(welcome).toBeVisible();
  await expect(welcome.getByText('Type / for commands')).toBeVisible();
  await expect(welcome.getByText('Use @ to mention an agent')).toBeVisible();
  await expect(page.locator('.message')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('new-chat-welcome.png'), animations: 'disabled', scale: 'css' });
  const composer = page.locator('textarea.composerTextarea');
  await composer.fill('Keep my draft');
  await expect(welcome).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.message.user')).toContainText('Keep my draft');
  await expect(welcome).toHaveCount(0);
});

test('empty chat survives reload and fits a short landscape viewport', async ({ page }, info) => {
  await page.route('**/api/chats**', async route => {
    if (route.request().method() !== 'GET'
      || new URL(route.request().url()).searchParams.get('id') !== 'mobile-chat') return route.fallback();
    await route.fulfill({ json: { ok: true, chat: {
      id: 'mobile-chat', name: 'Mobile coverage', ts: 1000, agentSessions: {}, messages: [],
    } } });
  });
  await page.reload();
  const welcome = page.getByRole('region', { name: 'Welcome to Agents Chat' });
  await expect(welcome).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(welcome).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeInViewport();
  if (info.project.name !== 'desktop-chromium') {
    await expect(page.locator('textarea.composerTextarea')).toHaveCSS('font-size', '16px');
  }
  await page.screenshot({ path: info.outputPath('welcome-landscape.png'), animations: 'disabled', scale: 'css' });
});

test('placeholder uses chat body typography while mobile input avoids focus zoom', async ({ page }, info) => {
  const result = await page.locator('textarea.composerTextarea').evaluate(element => {
    const message = document.querySelector('.message')!;
    const placeholder = getComputedStyle(element, '::placeholder');
    return {
      placeholderSize: placeholder.fontSize,
      messageSize: getComputedStyle(message).fontSize,
      placeholderFont: placeholder.fontFamily,
      messageFont: getComputedStyle(message).fontFamily,
      inputSize: parseFloat(getComputedStyle(element).fontSize),
    };
  });
  expect(result.placeholderSize).toBe(result.messageSize);
  expect(result.placeholderFont).toBe(result.messageFont);
  if (info.project.name !== 'desktop-chromium') expect(result.inputSize).toBeGreaterThanOrEqual(16);
});

test('restored system-only chat shows welcome without masking loading', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/chats**', async route => {
    if (new URL(route.request().url()).searchParams.get('id') !== 'second-mobile-chat') return route.fallback();
    await gate;
    await route.fulfill({ json: { ok: true, chat: {
      id: 'second-mobile-chat', name: 'Second mobile chat', ts: 900, agentSessions: {},
      messages: [{ id: 'welcome', type: 'system', content: 'Welcome', ts: 901 }],
    } } });
  });
  await openNavigation(page);
  await page.getByRole('button', { name: 'Second mobile chat' }).click();
  await expect(page.getByRole('status', { name: 'Loading Second mobile chat' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Welcome to Agents Chat' })).toHaveCount(0);
  release();
  await expect(page.getByRole('region', { name: 'Welcome to Agents Chat' })).toBeVisible();
});
