import { expect, test, type Locator } from '@playwright/test';
import { settleChatLayout } from './helpers/chatLayout';
import {
  installMobileChatFixture,
  loginMobileFixture,
  type MobileFixture,
} from './helpers/mobileChatFixture';
import {
  installTestVisualViewport,
  setTestVisualViewport,
} from './helpers/visualViewport';

let fixture: MobileFixture;

test.beforeEach(async ({ page }) => {
  await installTestVisualViewport(page);
  fixture = await installMobileChatFixture(page);
  await loginMobileFixture(page);
});

function settingsField(dialog: Locator, name: string) {
  return dialog.locator('label').filter({ hasText: new RegExp(`^${name}`) }).locator('input').first();
}

async function expectDialogFitsVisualViewport(dialog: Locator) {
  await expect.poll(() => dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    return rect.left >= left - 1
      && rect.right <= left + width + 1
      && rect.top >= top - 1
      && rect.bottom <= top + height + 1;
  })).toBe(true);
}

async function expectExactlyOneActiveModal(page: import('@playwright/test').Page) {
  await expect(page.locator('[role="dialog"][aria-modal="true"]:not([aria-hidden="true"])')).toHaveCount(1);
}

test('responsive composer placeholder stays on one line without shrinking on input', async ({ page }) => {
  const textarea = page.locator('textarea.composerTextarea');
  const mobilePlaceholder = 'Type a message, / or @';
  const desktopPlaceholder = 'Type a message, / for commands, or @ to mention an agent';

  for (const width of [320, 375, 390, 430, 844, 900, 901, 1280, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await setTestVisualViewport(page, 844, 0);
    await expect(textarea).toHaveAttribute('placeholder', width <= 900 ? mobilePlaceholder : desktopPlaceholder);
    await expect(textarea).toHaveValue('');
    await expect.poll(() => textarea.evaluate((element) => {
      const style = getComputedStyle(element);
      const singleLineHeight = parseFloat(style.lineHeight)
        + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      return Math.abs(element.getBoundingClientRect().height - singleLineHeight);
    })).toBeLessThanOrEqual(1);
    const emptyHeight = await textarea.evaluate((element) => element.getBoundingClientRect().height);

    for (const value of ['a', '', '字', '']) {
      await textarea.fill(value);
      await expect.poll(() => textarea.evaluate(
        (element) => element.getBoundingClientRect().height,
      )).toBeCloseTo(emptyHeight, 0);
    }

    await textarea.fill('First line\nSecond line');
    await expect.poll(() => textarea.evaluate(
      (element) => element.getBoundingClientRect().height,
    )).toBeGreaterThan(emptyHeight + 10);
    await textarea.fill('');
    await expect.poll(() => textarea.evaluate(
      (element) => element.getBoundingClientRect().height,
    )).toBeCloseTo(emptyHeight, 0);
  }

  await textarea.fill('Keep my draft');
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(textarea).toHaveAttribute('placeholder', desktopPlaceholder);
  await expect(textarea).toHaveValue('Keep my draft');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(textarea).toHaveAttribute('placeholder', mobilePlaceholder);
  await expect(textarea).toHaveValue('Keep my draft');
});

test('mobile header controls match the account chip height', async ({ page }) => {
  for (const width of [320, 390, 560, 561, 844, 900]) {
    await page.setViewportSize({ width, height: 844 });
    await setTestVisualViewport(page, 844, 0);
    const size = width <= 560 ? 30 : 34;
    const account = page.locator('.userChip');
    await expect(account).toHaveCSS('height', `${size}px`);

    for (const name of ['Open navigation', 'More actions']) {
      const button = page.getByRole('button', { name });
      await expect(button).toHaveCSS('height', `${size}px`);
      await expect(button).toHaveCSS('width', `${size}px`);
    }
    await expect.poll(() => page.locator('.header').evaluate((header) => {
      const tops = Array.from(header.querySelectorAll(
        '.mobileNavigationButton, .headerOverflowBtn, .userChip',
      ), (element) => element.getBoundingClientRect().top);
      return Math.max(...tops) - Math.min(...tops);
    })).toBeLessThanOrEqual(1);
  }

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('.participantsSidebar')).toHaveClass(/mobilePanelVisible/);
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menu', { name: 'Header actions' })).toBeVisible();
  await page.locator('.userNameButton').click();
  await expect(page.getByRole('dialog', { name: 'Account details' })).toBeVisible();
});

test('composer controls share a compact height on mobile and desktop', async ({ page }) => {
  const textarea = page.locator('textarea.composerTextarea');
  const send = page.getByRole('button', { name: 'Send message' });
  for (const width of [320, 390, 844, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await setTestVisualViewport(page, 844, 0);
    for (const draft of ['', '@alpha aligned controls']) {
      await textarea.fill(draft);
      const controls = page.locator('.attachButton, .sendButton, .targetPill');
      await expect(send).toHaveCSS('height', '32px');
      const sendBox = await send.boundingBox();
      expect(sendBox).not.toBeNull();
      for (const control of await controls.all()) {
        await expect(control).toHaveCSS('height', '32px');
        const box = await control.boundingBox();
        expect(box).not.toBeNull();
        expect(Math.abs(box!.y - sendBox!.y)).toBeLessThanOrEqual(1);
      }
    }
  }
});

for (const theme of ['VS Code Dark', 'Claude']) {
  test(`mobile pills fade softly without covering send or the last workflow pill in ${theme}`, async ({ page }, testInfo) => {
    await page.route('**/api/workflows', (route) => route.fulfill({
      json: { ok: true, repo: [], user: [] },
    }));
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Theme' }).click();
    await page.getByRole('menuitemradio', { name: theme, exact: false }).click();

    const pills = page.locator('.targetPills');
    const workflow = pills.getByRole('button', { name: /workflow/ });
    const send = page.getByRole('button', { name: 'Send message' });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await setTestVisualViewport(page, 844, 0);
      await page.locator('textarea.composerTextarea').fill('@alpha @beta overflow controls');
      await expect(pills.locator('.modelTargetPill')).toHaveCount(2);
      await expect(pills).toHaveCSS('overflow-x', 'auto');
      await expect.poll(() => pills.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      await expect(pills).toHaveCSS('mask-image', /linear-gradient/);
      await pills.evaluate((element) => { element.scrollLeft = 0; });
      await settleChatLayout(page);
      const [pillsBox, sendBox] = await Promise.all([pills.boundingBox(), send.boundingBox()]);
      expect(pillsBox).not.toBeNull();
      expect(sendBox).not.toBeNull();
      expect(pillsBox!.x + pillsBox!.width).toBeLessThanOrEqual(sendBox!.x - 6);
      const overflowScreenshot = testInfo.outputPath(`composer-${width}-overflow.png`);
      await page.locator('.composerShell').screenshot({ path: overflowScreenshot });
      await testInfo.attach(`composer-${theme}-${width}-overflow`, {
        path: overflowScreenshot,
        contentType: 'image/png',
      });

      await pills.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      await expect.poll(() => pills.evaluate((element) => {
        const pill = element.lastElementChild;
        if (!pill) throw new Error('Expected a workflow pill at the end of the toolbar');
        return element.getBoundingClientRect().right - pill.getBoundingClientRect().right;
      })).toBeGreaterThanOrEqual(11);
      const [workflowBox, scrollBox] = await Promise.all([workflow.boundingBox(), pills.boundingBox()]);
      expect(workflowBox).not.toBeNull();
      expect(scrollBox).not.toBeNull();
      expect(workflowBox!.x).toBeGreaterThanOrEqual(scrollBox!.x - 1);
      await workflow.click();
      await expect(page.getByRole('heading', { name: 'Pick a workflow' })).toBeVisible();
      await page.locator('.wfPickerClose').click();

      await page.locator('textarea.composerTextarea').fill('');
      await pills.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      await expect(workflow).toBeVisible();
      const endScreenshot = testInfo.outputPath(`composer-${width}-end.png`);
      await page.locator('.composerShell').screenshot({ path: endScreenshot });
      await testInfo.attach(`composer-${theme}-${width}-end`, {
        path: endScreenshot,
        contentType: 'image/png',
      });
    }
  });
}

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

for (const tab of ['Chats', 'Files']) {
  test(`sidebar collapse closes and reopens the mobile ${tab} drawer`, async ({ page }) => {
    const navigation = page.getByRole('button', { name: 'Open navigation' });
    const sidebar = page.locator('.participantsSidebar');
    const composer = page.locator('textarea.composerTextarea');
    await composer.fill('Keep my draft when closing navigation');
    await navigation.click();
    await sidebar.getByRole('tab', { name: tab }).click();
    await expect(sidebar.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');

    await sidebar.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();

    await expect(sidebar).not.toHaveClass(/mobilePanelVisible/);
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
    await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    await expect(page.locator('.mobilePanelBackdrop')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
    await expect.poll(() => page.evaluate(() => window.history.state?.agentsChatMobileOverlay ?? false)).toBe(false);
    await expect(navigation).toBeFocused();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('acp_chat_sidebar_collapsed_v1'))).toBe('0');

    await navigation.click();
    await expect(sidebar.getByRole('tab', { name: 'Chats' })).toBeVisible();
    await expect(sidebar.getByRole('tab', { name: 'Files' })).toBeVisible();
    await expect(sidebar.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
    await expect(sidebar.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible();
    await expect(sidebar.locator('.collapsedSidebarControls')).toHaveCount(0);
    await sidebar.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await expect(composer).toHaveValue('Keep my draft when closing navigation');
  });
}

test('mobile navigation ignores a saved desktop collapse preference without overwriting it', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('acp_chat_sidebar_collapsed_v1', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Existing mobile message')).toBeVisible();

  const sidebar = page.locator('.participantsSidebar');
  const collapse = sidebar.getByRole('button', { name: 'Collapse sidebar', exact: true });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(sidebar.getByRole('tab', { name: 'Chats' })).toBeVisible();
  await expect(sidebar.getByRole('tab', { name: 'Files' })).toBeVisible();
  await expect(sidebar.locator('.collapsedSidebarControls')).toHaveCount(0);
  await expect(page.locator('.chatLayout')).not.toHaveClass(/sidebarCollapsed/);
  await collapse.click();
  await expect(page.locator('.mobilePanelBackdrop')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('acp_chat_sidebar_collapsed_v1'))).toBe('1');

  await page.setViewportSize({ width: 1280, height: 800 });
  await setTestVisualViewport(page, 800, 0);
  await expect(sidebar.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible();
  await expect(page.locator('.chatLayout')).toHaveClass(/sidebarCollapsed/);
  await sidebar.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await expect(sidebar.getByRole('tab', { name: 'Chats' })).toBeVisible();
  await collapse.click();
  await expect(sidebar.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await setTestVisualViewport(page, 844, 0);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(sidebar.getByRole('tab', { name: 'Chats' })).toBeVisible();
  await expect(sidebar.getByRole('tab', { name: 'Files' })).toBeVisible();
  await collapse.click();
  await expect(page.locator('.mobilePanelBackdrop')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('acp_chat_sidebar_collapsed_v1'))).toBe('1');
});

test('account replaces every persistent-header mobile overlay', async ({ page }) => {
  const account = page.locator('.userNameButton');
  const overlays = [
    {
      open: async () => page.getByRole('button', { name: 'Open navigation' }).click(),
      surface: page.locator('.participantsSidebar.mobilePanelVisible'),
    },
    ...(['Agents', 'Nodes', 'Schedules'] as const).map((name) => ({
      open: async () => {
        await page.getByRole('button', { name: 'More actions' }).click();
        await page.getByRole('menu', { name: 'Header actions' }).getByRole('menuitem', { name }).click();
      },
      surface: page.locator(`[data-mobile-overlay-surface="${name.toLowerCase()}"]`),
    })),
  ];

  for (const overlay of overlays) {
    await overlay.open();
    await expect(overlay.surface).toBeVisible();

    await account.click();

    await expect(overlay.surface).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Account details' })).toBeVisible();
    await expect(page.locator('[data-mobile-overlay-surface]')).toHaveCount(1);
    await expect(page.locator('.mobilePanelBackdrop')).toHaveCount(1);

    await page.getByRole('button', { name: 'Close active panel' }).click();
    await expect(account).toBeFocused();
  }
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
  await page.locator('input[type="file"]').setInputFiles({
    name: 'mobile-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('attachment retained behind overlay'),
  });
  await expect(page.locator('.attachmentChip')).toContainText('mobile-note.txt');
  await expect(page.getByText('Existing mobile message')).toBeVisible();
  await settleChatLayout(page);
  const chatContainer = page.locator('.chatContainer');
  const preservedScrollTop = await chatContainer.evaluate((element) => {
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
    return element.scrollTop;
  });
  expect(preservedScrollTop).toBeGreaterThan(0);
  await settleChatLayout(page);
  await expect.poll(() => chatContainer.evaluate((element) => element.scrollTop)).toBe(preservedScrollTop);

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await page.getByRole('button', { name: 'Close active panel' }).click({ position: { x: 400, y: 100 } });

  await expect(composer).toHaveValue('unsent mobile draft');
  await expect(page.locator('.attachmentChip')).toContainText('mobile-note.txt');
  await expect(page.getByText('Existing mobile message')).toBeVisible();
  await expect.poll(() => chatContainer.evaluate((element) => element.scrollTop)).toBe(preservedScrollTop);
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
});

test('keeps navigation, composer, and overlays usable in landscape', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await setTestVisualViewport(page, 390, 0);
  const composer = page.locator('.chatInputDock');
  const send = page.getByRole('button', { name: 'Send message' });
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await expect(composer).toBeVisible();
  await expect(send).toBeVisible();

  for (const locator of [composer, send]) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(844);
    expect(box!.y + box!.height).toBeLessThanOrEqual(390);
  }

  await page.getByRole('button', { name: 'Open navigation' }).click();
  const navigation = page.getByRole('dialog', { name: 'Chats and files navigation' });
  await expect(navigation).toBeVisible();
  const navigationBox = await navigation.boundingBox();
  expect(navigationBox).not.toBeNull();
  expect(navigationBox!.height).toBeLessThanOrEqual(390);
});

test('keeps controls and management panels within a narrow phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await setTestVisualViewport(page, 568, 0);
  await expectDialogFitsVisualViewport(page.locator('.chatInputDock'));
  await expectDialogFitsVisualViewport(page.getByRole('button', { name: 'Send message' }));
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expectDialogFitsVisualViewport(page.getByRole('dialog', { name: 'Chats and files navigation' }));
  await page.getByRole('button', { name: 'Close navigation' }).click();

  for (const name of ['Agents', 'Nodes', 'Schedules']) {
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name }).click();
    const panel = page.locator(`[data-mobile-overlay-surface="${name.toLowerCase()}"]`);
    await expect(panel).toBeVisible();
    await expectDialogFitsVisualViewport(panel);
    const close = page.getByRole('button', { name: `Close ${name.toLowerCase()}` });
    await expectDialogFitsVisualViewport(close);
    await close.click();
  }
});

test('clears mobile overlay state when resizing to desktop and back', async ({ page }) => {
  await page.locator('textarea.composerTextarea').fill('Draft survives responsive layout changes');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('.mobilePanelBackdrop')).toHaveCount(1);

  await page.setViewportSize({ width: 1280, height: 800 });
  await setTestVisualViewport(page, 800, 0);
  await expect(page.locator('.mobilePanelBackdrop')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
  await expect(page.getByRole('complementary', { name: 'Chats and files navigation' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await setTestVisualViewport(page, 844, 0);
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await expect(page.locator('.mobilePanelBackdrop')).toHaveCount(0);
  await expect(page.locator('textarea.composerTextarea')).toHaveValue('Draft survives responsive layout changes');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expectExactlyOneActiveModal(page);
  await page.getByRole('button', { name: 'Close navigation' }).click();
  await expect(page.locator('.mobilePanelBackdrop')).toHaveCount(0);
});

test('restores the inline body overflow that existed before mobile scroll lock', async ({ page }) => {
  await page.evaluate(() => {
    document.body.style.overflow = 'clip';
  });

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');

  await page.getByRole('button', { name: 'Close navigation' }).click();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('clip');
});

test('keeps wide message content inside the viewport and hides unavailable voice input', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Start voice input' })).toHaveCount(0);

  const chatContainer = page.locator('.chatContainer');
  const message = page.locator('.message.user').first();
  const markdown = message.locator('.markdownBody');
  const codeBlock = markdown.locator('pre');
  const table = markdown.locator('table');
  const image = markdown.getByRole('img', { name: 'Wide mobile fixture' });

  await expect(image).toBeVisible();
  await expect.poll(async () => {
    const [messageBox, viewportWidth] = await Promise.all([
      message.boundingBox(),
      page.evaluate(() => window.innerWidth),
    ]);
    return messageBox !== null && messageBox.x >= 0
      && messageBox.x + messageBox.width <= viewportWidth;
  }).toBe(true);

  await expect.poll(() => chatContainer.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
  await expect.poll(() => codeBlock.evaluate(
    (element) => element.scrollWidth > element.clientWidth,
  )).toBe(true);
  await expect.poll(() => table.evaluate(
    (element) => element.scrollWidth > element.clientWidth,
  )).toBe(true);
  await expect.poll(async () => {
    const [imageBox, markdownBox] = await Promise.all([
      image.boundingBox(),
      markdown.boundingBox(),
    ]);
    return imageBox !== null && markdownBox !== null
      && imageBox.width <= markdownBox.width
      && imageBox.x + imageBox.width <= markdownBox.x + markdownBox.width;
  }).toBe(true);
});

test('closes navigation immediately and masks chat while selection loads', async ({ page }) => {
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  await page.route('**/api/chats**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (id === 'second-mobile-chat') await loadGate;
    await route.fallback();
  });

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Second mobile chat' }).click();

  await expect(page.locator('.participantsSidebar')).not.toHaveClass(/mobilePanelVisible/);
  await expect(page.getByRole('status', { name: 'Loading Second mobile chat' })).toBeVisible();
  await expect(page.locator('textarea.composerTextarea')).toHaveCount(0);
  await expect(page.getByText('Existing mobile message')).toHaveCount(0);

  releaseLoad();
  await expect(page.getByText('Second chat message')).toBeVisible();
  await expect(page.locator('.chatContainer')).toBeFocused();
  await expect(page.locator('textarea.composerTextarea')).not.toBeFocused();
});

test('closes navigation immediately and restores the current chat after a failed selection', async ({ page }) => {
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
  await expect(page.locator('.participantsSidebar')).not.toHaveClass(/mobilePanelVisible/);
  await expect(page.getByText('Existing mobile message')).toBeVisible();
  await expect(page.getByText('Failed to load chat: Chat unavailable')).toBeVisible();
});

test('closes the drawer after selecting a file and preserves the Files tree when reopening', async ({ page }) => {
  await page.route('**/api/markdown**', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (path) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        files: [
          { path: 'README.md', name: 'README.md', mtime: '2026-09-14T00:00:00.000Z' },
          { path: 'notes.txt', name: 'notes.txt', mtime: '2026-09-14T00:00:00.000Z' },
          ...Array.from({ length: 60 }, (_, index) => ({
            path: `notes/note-${String(index).padStart(2, '0')}.md`,
            name: `note-${String(index).padStart(2, '0')}.md`,
            mtime: '2026-09-14T00:00:00.000Z',
          })),
        ],
      }),
    });

  });

  await page.locator('textarea.composerTextarea').fill('draft retained behind file');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('tab', { name: 'Files' }).click();
  await page.getByRole('button', { name: 'Files agent' }).click();
  await page.getByRole('option', { name: 'Alpha Agent' }).click();
  await page.locator('.mdTreeDir', { hasText: 'notes' }).click();
  const filesList = page.locator('.mdFilesList');
  const preservedScrollTop = await filesList.evaluate((element) => {
    element.scrollTop = 240;
    return element.scrollTop;
  });
  expect(preservedScrollTop).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'README.md' }).evaluate((element) => {
    (element as HTMLButtonElement).click();
  });

  await expect(page.locator('.participantsSidebar')).not.toHaveClass(/mobilePanelVisible/);
  await expect(page.locator('.mdEditorInline')).toBeVisible();
  const mobileMarkdown = page.locator('.mobileMarkdownViewer');
  await expect(mobileMarkdown).toBeVisible();
  await expect(mobileMarkdown.locator('.markdownBody')).toBeVisible();
  await expect(mobileMarkdown.getByRole('heading', { name: 'Mobile rendered heading', level: 1 })).toBeVisible();
  await expect(mobileMarkdown.locator('strong')).toHaveText('rendered emphasis');
  await expect(mobileMarkdown.getByRole('listitem')).toHaveCount(2);
  await expect(mobileMarkdown.locator('table')).toBeVisible();
  await expect(mobileMarkdown.locator('pre code')).toContainText('mobileRendered');
  await expect(page.locator('.fileLine')).toHaveCount(0);
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(page.getByTitle('Toggle comments')).toBeVisible();
  await expect(page.getByRole('button', { name: /Save/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Split' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Live Edit' })).toHaveCount(0);
  await expect(page.getByText('Use the desktop interface to edit files.')).toBeVisible();
  await expect(page.locator('textarea.composerTextarea')).toHaveCount(0);

  await page.getByRole('button', { name: /Close/ }).click();
  await expect(page.locator('textarea.composerTextarea')).toHaveValue('draft retained behind file');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => filesList.evaluate((element) => element.scrollTop)).toBe(preservedScrollTop);
  await page.getByRole('button', { name: 'notes.txt' }).evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
  await expect(page.locator('.mobileMarkdownViewer')).toHaveCount(0);
  await expect(page.locator('.fileContentWithLines')).toBeVisible();
  await expect(page.locator('.fileLineText').first()).toHaveText('# Plain text heading');
  await page.getByRole('button', { name: /Close/ }).click();
  await expect(page.locator('textarea.composerTextarea')).toHaveValue('draft retained behind file');
});

test('searches, refreshes, and previews images from the mobile Files drawer', async ({ page }) => {
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('tab', { name: 'Files' }).click();
  await page.getByRole('button', { name: 'Files agent' }).click();
  await page.getByRole('option', { name: 'Alpha Agent' }).click();

  const search = page.getByRole('searchbox', { name: 'Search files' });
  await search.fill('mobile.png');
  await expect(page.getByRole('button', { name: 'mobile.png' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'README.md' })).toHaveCount(0);

  const requestCount = fixture.markdownListRequests.length;
  await page.getByRole('button', { name: 'Refresh files' }).click();
  await expect.poll(() => fixture.markdownListRequests.length).toBeGreaterThan(requestCount);

  await page.getByRole('button', { name: 'mobile.png' }).click();
  await expect(page.locator('.participantsSidebar')).not.toHaveClass(/mobilePanelVisible/);
  await expect(page.getByRole('img', { name: 'assets/mobile.png' })).toBeVisible();
  await expect(page.getByText('Image preview')).toBeVisible();
  await expect(page.getByText('Use the desktop interface to edit files.')).toHaveCount(0);
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
  await expect(page.locator('.fileWorkspaceError')).toContainText('Preview unavailable');
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

test('mobile Agent management keeps full CRUD and access controls reachable', async ({ page }) => {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Agents' }).click();
  const panel = page.locator('.agentsSidebar').filter({ hasText: 'Agents' });

  await panel.getByTitle('Add agent').click();
  await page.getByRole('button', { name: /Add Agent from Remote Node/ }).click();
  const remoteCreate = page.getByRole('dialog', { name: 'Add Agent from Remote Node' });
  await expectExactlyOneActiveModal(page);
  await expectDialogFitsVisualViewport(remoteCreate);
  await remoteCreate.getByPlaceholder('unique-agent-id').fill('mobile-remote');
  await remoteCreate.getByPlaceholder('My Remote Agent').fill('Mobile Remote');
  await remoteCreate.locator('select').selectOption('mobile-node');
  await remoteCreate.getByPlaceholder(/home\/user\/project/).fill('/srv/mobile');
  await remoteCreate.getByRole('button', { name: 'Create Remote Agent' }).click();
  await expect(panel.getByText('Mobile Remote')).toBeVisible();
  expect(fixture.agents.get('mobile-remote')).toMatchObject({
    relay: true,
    relayConnectionName: 'mobile-node',
    cwd: '/srv/mobile',
  });

  await panel.getByTitle('Add agent').click();
  await page.getByRole('button', { name: /Add Agent in Server/ }).click();
  const create = page.getByRole('dialog', { name: 'Add New Agent' });
  await expectExactlyOneActiveModal(page);
  await expectDialogFitsVisualViewport(create);
  await create.getByPlaceholder('unique-agent-id').fill('mobile-managed');
  await create.getByPlaceholder('My Agent').fill('Mobile Managed');
  await create.getByPlaceholder('copilot.exe').fill('mock-agent');
  await create.getByPlaceholder('--acp').fill('--acp --mobile');
  await create.getByPlaceholder('C:\\path\\to\\project').fill('/workspace/mobile');
  await create.locator('textarea').fill('TOKEN=mobile');
  await create.getByRole('button', { name: 'Create Agent' }).click();
  await expect(panel.getByText('Mobile Managed')).toBeVisible();

  await panel.getByText('Mobile Managed').click();
  const settings = page.getByRole('dialog', { name: /Mobile Managed settings/ });
  await expectExactlyOneActiveModal(page);
  await expectDialogFitsVisualViewport(settings);
  await settingsField(settings, 'Name').fill('Mobile Managed Updated');
  await settingsField(settings, 'Command').fill('mock-agent-v2');
  await settingsField(settings, 'Arguments').fill('--acp --updated');
  await settingsField(settings, 'Working Directory').fill('/workspace/updated');
  await settings.locator('textarea').fill('TOKEN=updated\nMODE=mobile');
  await settings.getByRole('checkbox', { name: /Public/ }).uncheck();
  await settings.getByPlaceholder('user@email.com').fill('mobile@example.com');
  await settings.getByRole('button', { name: 'Grant' }).click();
  await expect(settings.getByText('mobile@example.com', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Revoke access for mobile@example.com' }).click();
  await expect(settings.getByText('mobile@example.com', { exact: true })).toHaveCount(0);

  const envTextarea = settings.locator('textarea');
  await envTextarea.focus();
  await setTestVisualViewport(page, 420, 96);
  await expect(envTextarea).toBeFocused();
  await expectDialogFitsVisualViewport(envTextarea);
  await expectDialogFitsVisualViewport(settings.locator('.agentSheetActions'));
  for (const name of ['Save', 'Cancel', 'Delete']) {
    await expect(settings.getByRole('button', { name })).toBeVisible();
  }
  await expectDialogFitsVisualViewport(settings);

  const releaseUpdate = fixture.holdNextAgentUpdate();
  const save = settings.locator('.agentSheetActions button.primary');
  await save.click();
  await expect(save).toBeDisabled();
  expect(fixture.acpRequests.filter((request) => request.action === 'update-agent-config')).toHaveLength(1);
  releaseUpdate();
  await expect(settings).toBeHidden();

  expect(fixture.agents.get('mobile-managed')).toMatchObject({
    name: 'Mobile Managed Updated',
    command: 'mock-agent-v2',
    args: ['--acp', '--updated'],
    cwd: '/workspace/updated',
    public: false,
    env: { TOKEN: 'updated', MODE: 'mobile' },
  });

  await panel.getByText('Mobile Managed Updated').click();
  const updatedSettings = page.getByRole('dialog', { name: /Mobile Managed Updated settings/ });
  page.once('dialog', (dialog) => dialog.accept());
  await updatedSettings.getByRole('button', { name: 'Delete' }).click();
  await expect(panel.getByText('Mobile Managed Updated')).toHaveCount(0);
  expect(fixture.agents.has('mobile-managed')).toBe(false);
});

test('mobile Agent settings ignores stale loads and saves the active agent', async ({ page }) => {
  const releaseAlpha = fixture.holdAgentSettings('alpha');
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Agents' }).click();
  const panel = page.locator('.agentsSidebar').filter({ hasText: 'Agents' });

  await panel.getByText('Alpha Agent', { exact: true }).click();
  await expect.poll(() => fixture.acpRequests.filter((request) =>
    request.agentId === 'alpha'
    && (request.action === 'get-agent-config' || request.action === 'list-agent-access')).length,
  ).toBe(2);
  await page.keyboard.press('Escape');

  await panel.getByText('Beta Agent', { exact: true }).click();
  const betaSettings = page.getByRole('dialog', { name: /Beta Agent settings/ });
  await expect(betaSettings).toBeVisible();
  releaseAlpha();
  await expect(betaSettings).toBeVisible();
  await expect(settingsField(betaSettings, 'Agent ID')).toHaveValue('beta');
  await expect(settingsField(betaSettings, 'Name')).toHaveValue('Beta Agent');

  await settingsField(betaSettings, 'Name').fill('Beta Agent Updated');
  await betaSettings.getByRole('button', { name: 'Save' }).click();
  await expect(betaSettings).toBeHidden();
  const updates = fixture.acpRequests.filter((request) => request.action === 'update-agent-config');
  expect(updates.at(-1)).toMatchObject({
    agentId: 'beta',
    updates: { name: 'Beta Agent Updated' },
  });
  expect(fixture.agents.get('alpha')).toMatchObject({ name: 'Alpha Agent' });
  expect(fixture.agents.get('beta')).toMatchObject({ name: 'Beta Agent Updated' });
});

test('mobile Agent settings retains values and reports a failed save', async ({ page }) => {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Agents' }).click();
  await page.getByText('Alpha Agent', { exact: true }).click();
  const settings = page.getByRole('dialog', { name: /Alpha Agent settings/ });
  await settingsField(settings, 'Name').fill('Unsaved Mobile Name');
  await settings.locator('textarea').fill('TOKEN=still-present');
  fixture.failNextAgentUpdate();
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings.getByRole('alert')).toContainText('Agent update rejected');
  await expect(settingsField(settings, 'Name')).toHaveValue('Unsaved Mobile Name');
  await expect(settings.locator('textarea')).toHaveValue('TOKEN=still-present');
  await expect(settings).toBeVisible();
  await expectDialogFitsVisualViewport(settings);
});

test('mobile Nodes exposes status and refresh but defers complex setup', async ({ page }) => {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Nodes' }).click();
  const nodes = page.getByRole('dialog', { name: 'Nodes' });

  await expect(nodes.getByText('Mobile Node')).toBeVisible();
  await expect(nodes.getByText('Platform unavailable')).toHaveCount(2);
  await expect(nodes.getByText('Online', { exact: true })).toBeVisible();
  await expect(nodes.getByText('Offline', { exact: true })).toBeVisible();
  await expect(nodes.getByText('Relay connection closed before opening')).toBeVisible();
  await expect(nodes.getByTitle('Refresh all')).toBeVisible();
  await expect(nodes.getByTitle('Add node')).toHaveCount(0);
  await expect(nodes.getByTitle('Add agent on this node')).toHaveCount(0);
  await expect(nodes.getByTitle('Remove node')).toHaveCount(0);
  await expect(nodes.locator('.nodeEditInput')).toHaveCount(0);
  await expect(nodes.getByText('Use the desktop interface to configure nodes.')).toBeVisible();
});

test('mobile Nodes reports load and check failures with retry in the panel', async ({ page }) => {
  let listAttempts = 0;
  let failCheck = true;
  await page.route('**/api/nodes', async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action === 'list-nodes' && listAttempts++ === 0) {
      await route.fulfill({
        status: 503,
        contentType: 'text/plain',
        body: 'Nodes unavailable as text',
      });
      return;
    }
    if (body.action === 'list-nodes' && listAttempts === 3) {
      await route.fulfill({ status: 504, body: '' });
      return;
    }
    if (body.action === 'check-node' && failCheck) {
      failCheck = false;
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'Node check unavailable' }),
      });
      return;
    }
    await route.fallback();
  });

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Nodes' }).click();
  const panel = page.getByRole('dialog', { name: 'Nodes' });
  await expect(panel.getByRole('alert')).toContainText('Nodes unavailable as text');
  await expect(panel.getByText('No nodes configured')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Retry' }).click();
  await expect(panel.getByText('Mobile Node')).toBeVisible();

  await panel.getByRole('button', { name: 'Refresh Mobile Node' }).click();
  await expect(panel.getByRole('alert')).toContainText('Node check unavailable');
  await panel.getByRole('button', { name: 'Retry' }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);

  await panel.getByRole('button', { name: 'Refresh all nodes' }).click();
  await expect(panel.getByRole('alert')).toContainText('Nodes request failed (504)');
  await expect(panel.getByText('No nodes configured')).toHaveCount(0);
});

test('mobile Schedules supports status, guarded enablement, and run history without editing', async ({ page }) => {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Schedules' }).click();
  const schedules = page.getByRole('dialog', { name: 'Schedules' });

  await expect(schedules.getByText('Daily report')).toBeVisible();
  await expect(schedules.getByText('Disabled', { exact: true })).toBeVisible();
  await expect(schedules.getByTitle('Create schedule')).toHaveCount(0);
  await expect(schedules.getByText('Use the desktop interface to create or edit schedules.')).toBeVisible();

  const releaseUpdate = fixture.holdNextScheduleUpdate();
  const enableSwitch = schedules.getByRole('switch', { name: 'Enable Daily report' });
  await enableSwitch.click();
  await expect(enableSwitch).toBeDisabled();
  await enableSwitch.click({ force: true });
  expect(fixture.scheduleRequests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  releaseUpdate();
  await expect(schedules.getByRole('switch', { name: 'Disable Daily report' })).toBeEnabled();
  await expect(schedules.getByText('Enabled', { exact: true })).toBeVisible();
  await expect.poll(() => fixture.scheduleRequests).toContainEqual(
    expect.objectContaining({
      method: 'PATCH',
      path: '/api/schedules/schedule-1',
      body: { enabled: true },
    }),
  );

  await schedules.getByTitle('View run history').click();
  const history = page.getByRole('dialog', { name: 'Daily report runs' });
  await expectExactlyOneActiveModal(page);
  await expect(history).toBeFocused();
  await history.locator('summary').click();
  await expect(history.getByText('Report complete')).toBeVisible();
  const runNow = history.getByRole('button', { name: /Run now/i });
  const closeHistory = history.getByRole('button', { name: 'Close' });
  await expect(runNow).toBeVisible();

  await closeHistory.focus();
  await page.keyboard.press('Tab');
  await expect(runNow).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(closeHistory).toBeFocused();

  await page.getByRole('button', { name: 'Close active panel' }).focus();
  await expect(runNow).toBeFocused();
  await page.getByRole('button', { name: 'More actions' }).focus();
  await expect(runNow).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(history).toHaveCount(0);
  const historyOpener = schedules.getByTitle('View run history');
  await expect(historyOpener).toBeFocused();
  await expect(schedules).toBeVisible();

  await historyOpener.click();
  const reopenedHistory = page.getByRole('dialog', { name: 'Daily report runs' });
  await page.locator('.modalOverlay').filter({ has: reopenedHistory }).click({ position: { x: 1, y: 1 } });
  await expect(reopenedHistory).toHaveCount(0);
  await expect(historyOpener).toBeFocused();

  await historyOpener.click();
  await expect(page.getByRole('dialog', { name: 'Daily report runs' })).toBeVisible();
  await page.locator('[data-mobile-overlay-surface="schedules"] [aria-label="Close schedules"]').evaluate(
    (element) => (element as HTMLButtonElement).click(),
  );
  await expect(page.getByRole('dialog', { name: 'Daily report runs' })).toHaveCount(0);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Schedules' }).click();
  await expect(page.getByRole('dialog', { name: 'Daily report runs' })).toHaveCount(0);
});

test('mobile Run History reports detail failures without empty history and retries', async ({ page }) => {
  let detailAttempts = 0;
  let allowDetailSuccess = false;
  await page.route('**/api/schedules/schedule-1', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    detailAttempts += 1;
    if (!allowDetailSuccess) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Run history unavailable' }),
      });
      return;
    }
    await route.fallback();
  });

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Schedules' }).click();
  const schedules = page.getByRole('dialog', { name: 'Schedules' });
  await schedules.getByTitle('View run history').click();

  const history = page.getByRole('dialog', { name: 'schedule-1 runs' });
  await expect(history.getByRole('alert')).toContainText('Run history unavailable');
  await expect(history.getByText('No runs yet')).toHaveCount(0);
  await expect(history.getByRole('button', { name: /Run now/i })).toHaveCount(0);

  const failedAttempts = detailAttempts;
  allowDetailSuccess = true;
  await history.getByRole('button', { name: 'Retry' }).click();
  const loadedHistory = page.getByRole('dialog', { name: 'Daily report runs' });
  await loadedHistory.locator('summary').click();
  await expect(loadedHistory.getByText('Report complete')).toBeVisible();
  await expect(loadedHistory.getByRole('alert')).toHaveCount(0);
  expect(detailAttempts).toBeGreaterThan(failedAttempts);
});

test('mobile Schedules reports load failures and retries in the panel', async ({ page }) => {
  let fail = true;
  await page.route('**/api/schedules', async (route) => {
    if (!fail) {
      await route.fallback();
      return;
    }
    fail = false;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Schedules unavailable' }),
    });
  });

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Schedules' }).click();
  const panel = page.getByRole('dialog', { name: 'Schedules' });
  await expect(panel.getByRole('alert')).toContainText('Schedules unavailable');
  await expect(panel.getByText('No schedules configured')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Retry' }).click();
  await expect(panel.getByText('Daily report')).toBeVisible();
});

test('mobile Schedules reports action failures without duplicating the update', async ({ page }) => {
  let patchAttempts = 0;
  let releasePatch = () => {};
  const patchGate = new Promise<void>((resolve) => {
    releasePatch = resolve;
  });
  await page.route('**/api/schedules/schedule-1', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback();
      return;
    }
    patchAttempts += 1;
    await patchGate;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Schedule update rejected' }),
    });
  });

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Schedules' }).click();
  const panel = page.getByRole('dialog', { name: 'Schedules' });
  const enableSwitch = panel.getByRole('switch', { name: 'Enable Daily report' });
  await enableSwitch.click();
  await expect(enableSwitch).toBeDisabled();
  await enableSwitch.click({ force: true });

  expect(patchAttempts).toBe(1);
  releasePatch();
  await expect(panel.getByRole('alert')).toContainText('Schedule update rejected');
  expect(patchAttempts).toBe(1);
  await panel.getByRole('button', { name: 'Retry' }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(enableSwitch).toBeEnabled();
});

test('mobile Schedules keeps the authoritative PATCH state when reconciliation fails', async ({ page }) => {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Schedules' }).click();
  const panel = page.getByRole('dialog', { name: 'Schedules' });
  await expect(panel.getByText('Daily report')).toBeVisible();
  fixture.failNextScheduleRefresh();

  await panel.getByRole('switch', { name: 'Enable Daily report' }).click();

  await expect(panel.getByRole('switch', { name: 'Disable Daily report' })).toBeEnabled();
  await expect(panel.getByText('Enabled', { exact: true })).toBeVisible();
  await expect(panel.getByRole('alert')).toContainText('Schedule reconciliation unavailable');
});
