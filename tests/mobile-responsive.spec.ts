import { expect, test, type Locator } from '@playwright/test';
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
  await expect(page.getByText('Existing mobile message')).toBeVisible();

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await page.getByRole('button', { name: 'Close active panel' }).click({ position: { x: 400, y: 100 } });

  await expect(composer).toHaveValue('unsent mobile draft');
  await expect(page.getByText('Existing mobile message')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
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
  await page.getByRole('button', { name: 'notes' }).click();
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
  await expect(page.getByTitle('Toggle comments')).toBeVisible();
  await expect(page.getByRole('button', { name: /Save/ })).toHaveCount(0);
  await expect(page.getByText('Use the desktop interface to edit files.')).toBeVisible();
  await expect(page.locator('textarea.composerTextarea')).toHaveCount(0);

  await page.getByRole('button', { name: /Close/ }).click();
  await expect(page.locator('textarea.composerTextarea')).toHaveValue('draft retained behind file');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => filesList.evaluate((element) => element.scrollTop)).toBe(preservedScrollTop);
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
