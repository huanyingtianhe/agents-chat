import { expect, test, type Locator, type Page } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';

type Agent = {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  cwd?: string;
  yolo?: boolean;
  env?: Record<string, string>;
  relay?: boolean;
  relayConnectionName?: string;
  owner?: string;
  canModify: boolean;
  canTalk: boolean;
  public?: boolean;
  models: unknown[];
};

type Node = {
  name: string;
  label: string;
  online: boolean;
  checkedAt: number;
  manual: boolean;
  owner: string;
  canModify: boolean;
};

type AccessEntry = { email: string; grantedBy: string; createdAt: string };

async function installIsolatedBackend(page: Page) {
  const agents = new Map<string, Agent>([
    ['locked-agent', {
      id: 'locked-agent',
      name: 'Locked Agent',
      command: 'locked-command',
      args: ['--acp'],
      cwd: '/locked',
      yolo: false,
      env: {},
      owner: 'other@example.com',
      canModify: false,
      canTalk: false,
      public: false,
      models: [],
    }],
  ]);
  const nodes = new Map<string, Node>([
    ['remote-owned', {
      name: 'remote-owned',
      label: 'Owned Remote Node',
      online: true,
      checkedAt: 100,
      manual: true,
      owner: 'admin@local',
      canModify: true,
    }],
    ['locked-node', {
      name: 'locked-node',
      label: 'Locked Node',
      online: false,
      checkedAt: 100,
      manual: true,
      owner: 'other@example.com',
      canModify: false,
    }],
  ]);
  const access = new Map<string, AccessEntry[]>();
  const acpRequests: Record<string, any>[] = [];
  const nodeRequests: Record<string, any>[] = [];
  const chat = {
    id: 'management-chat',
    name: 'Management coverage',
    ts: 1_000,
    messages: [{ id: 'welcome-user', type: 'user', content: 'Manage test resources.', ts: 1_001 }],
    agentSessions: {},
  };

  await page.route('**/api/chats**', async (route) => {
    const request = route.request();
    const id = new URL(request.url()).searchParams.get('id');
    if (request.method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(id
          ? { ok: true, chat }
          : { ok: true, chats: [{ id: chat.id, name: chat.name, ts: chat.ts }], lastChatId: chat.id }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/orchestrations**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }),
  );
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as Record<string, any>;
    acpRequests.push(body);
    const agentId = body.agentId as string | undefined;

    if (body.action === 'list-agents') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, agents: [...agents.values()] }),
      });
      return;
    }
    if (body.action === 'create-agent') {
      const input = body.agent;
      agents.set(input.id, {
        command: input.relay ? undefined : input.command,
        args: input.relay ? undefined : input.args,
        cwd: input.cwd,
        env: input.env || {},
        yolo: input.yolo,
        public: false,
        relay: !!input.relay,
        relayConnectionName: input.relayConnectionName,
        owner: 'admin@local',
        canModify: true,
        canTalk: true,
        models: [],
        id: input.id,
        name: input.name,
      });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, agent: agents.get(input.id) }) });
      return;
    }
    if (body.action === 'get-agent-config') {
      const agent = agentId ? agents.get(agentId) : undefined;
      await route.fulfill({
        status: agent ? 200 : 404,
        contentType: 'application/json',
        body: JSON.stringify(agent ? { ok: true, agent } : { ok: false, error: 'agent_not_found' }),
      });
      return;
    }
    if (body.action === 'update-agent-config' && agentId) {
      const current = agents.get(agentId)!;
      agents.set(agentId, { ...current, ...body.updates });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, agent: agents.get(agentId), restarted: false }),
      });
      return;
    }
    if (body.action === 'delete-agent' && agentId) {
      agents.delete(agentId);
      access.delete(agentId);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    if (body.action === 'list-agent-access' && agentId) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, access: access.get(agentId) || [] }),
      });
      return;
    }
    if (body.action === 'add-agent-access' && agentId) {
      const current = access.get(agentId) || [];
      access.set(agentId, [
        ...current.filter((entry) => entry.email !== body.email),
        { email: body.email, grantedBy: 'admin@local', createdAt: '2026-07-16T00:00:00.000Z' },
      ]);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    if (body.action === 'remove-agent-access' && agentId) {
      access.set(agentId, (access.get(agentId) || []).filter((entry) => entry.email !== body.email));
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/nodes', async (route) => {
    const body = route.request().postDataJSON() as Record<string, any>;
    nodeRequests.push(body);
    if (body.action === 'list-nodes') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, nodes: [...nodes.values()] }),
      });
      return;
    }
    if (body.action === 'add-node') {
      nodes.set(body.name, {
        name: body.name,
        label: body.label || body.name,
        online: false,
        checkedAt: 200,
        manual: true,
        owner: 'admin@local',
        canModify: true,
      });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    if (body.action === 'check-node') {
      const node = nodes.get(body.name)!;
      node.online = true;
      node.checkedAt = 300;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, name: body.name, online: true, checkedAt: 300 }),
      });
      return;
    }
    if (body.action === 'update-node') {
      const node = nodes.get(body.name)!;
      node.label = body.label;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    if (body.action === 'remove-node') {
      nodes.delete(body.name);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'unknown action' }) });
  });

  return { agents, nodes, access, acpRequests, nodeRequests };
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder('Admin username').fill('admin');
  await page.getByPlaceholder('Password').fill('admin123');
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('.message.user')).toBeVisible({ timeout: 30_000 });
}

async function openAgents(page: Page) {
  await page.locator('button[title="Agents"]').click();
  await expect(page.locator('.agentsSidebar').filter({ hasText: 'Agents' })).toBeVisible();
}

function settingsField(modal: Locator, name: string) {
  return modal.locator('label').filter({ hasText: new RegExp(`^${name}`) }).locator('input').first();
}

test.describe('agent and node management', () => {
  test('creates, edits permissions and environment, then deletes a local server agent', async ({ page }) => {
    const backend = await installIsolatedBackend(page);
    await login(page);
    await openAgents(page);

    const agentsPanel = page.locator('.agentsSidebar').filter({ hasText: 'Agents' });
    const locked = agentsPanel.locator('.agentListItem', { hasText: 'Locked Agent' });
    await expect(locked.locator('.agentListName')).toContainText('🔒');
    await expect(locked).toHaveAttribute('title', 'Locked Agent');
    await locked.click();
    await expect(page.locator('.agentSettingsModal')).toHaveCount(0);

    await agentsPanel.locator('button[title="Add agent"]').click();
    await page.getByRole('button', { name: /Add Agent in Server/ }).click();
    const addModal = page.locator('.agentSettingsModal', { hasText: 'Add New Agent' });
    await addModal.getByPlaceholder('unique-agent-id').fill('managed-local');
    await addModal.getByPlaceholder('My Agent').fill('Managed Local');
    await addModal.getByPlaceholder('copilot.exe').fill('mock-copilot');
    await addModal.getByPlaceholder('--acp').fill('--acp --safe');
    await addModal.getByPlaceholder('C:\\path\\to\\project').fill('/workspace/original');
    await addModal.locator('textarea').fill('TOKEN=initial\nIGNORED\nMODE=test');
    await addModal.getByRole('checkbox', { name: /YOLO mode/ }).uncheck();
    await addModal.getByRole('button', { name: 'Create Agent' }).click();

    await expect(agentsPanel.locator('.agentListItem', { hasText: 'Managed Local' })).toBeVisible();
    expect(backend.agents.get('managed-local')).toMatchObject({
      command: 'mock-copilot',
      args: ['--acp', '--safe'],
      cwd: '/workspace/original',
      yolo: false,
      env: { TOKEN: 'initial', MODE: 'test' },
    });

    await agentsPanel.locator('.agentListItem', { hasText: 'Managed Local' }).click();
    const settings = page.locator('.agentSettingsModal', { hasText: 'Managed Local' });
    await expect(settings).toBeVisible();
    const typography = await settings.evaluate((modal) => {
      const fieldLabel = modal.querySelector('label > span');
      const fieldValue = modal.querySelector('label > input');
      const environmentValue = modal.querySelector('textarea');
      const accessValue = modal.querySelector('input[placeholder="user@email.com"]');
      const title = modal.querySelector('h2');
      return {
        label: fieldLabel ? getComputedStyle(fieldLabel).fontSize : '',
        value: fieldValue ? getComputedStyle(fieldValue).fontSize : '',
        environmentValue: environmentValue ? getComputedStyle(environmentValue).fontSize : '',
        accessValue: accessValue ? getComputedStyle(accessValue).fontSize : '',
        title: title ? getComputedStyle(title).fontSize : '',
      };
    });
    expect(typography).toEqual({
      label: '13.5px',
      value: '13.5px',
      environmentValue: '13.5px',
      accessValue: '13.5px',
      title: '18px',
    });
    await expect(settingsField(settings, 'Agent ID')).toBeDisabled();
    await settingsField(settings, 'Name').fill('Managed Local Updated');
    await settingsField(settings, 'Command').fill('mock-copilot-v2');
    await settingsField(settings, 'Arguments').fill('--acp --verbose');
    await settingsField(settings, 'Working Directory').fill('/workspace/updated');
    await settings.getByRole('checkbox', { name: /YOLO mode/ }).check();
    await settings.locator('textarea').fill('TOKEN=updated\nEXTRA=value=with-equals');

    const publicToggle = settings.getByRole('checkbox', { name: /Public/ });
    await publicToggle.check();
    await expect(settings.getByPlaceholder('user@email.com')).toHaveCount(0);
    await publicToggle.uncheck();
    await settings.getByPlaceholder('user@email.com').fill('reader@example.com');
    await settings.getByRole('button', { name: 'Grant' }).click();
    const accessEmail = settings.getByText('reader@example.com', { exact: true });
    await expect(accessEmail).toBeVisible();
    await accessEmail.locator('..').getByRole('button').click();
    await expect(settings.getByText('reader@example.com', { exact: true })).toHaveCount(0);

    await settings.getByRole('button', { name: 'Save' }).click();
    await expect(agentsPanel.locator('.agentListItem', { hasText: 'Managed Local Updated' })).toBeVisible();
    expect(backend.agents.get('managed-local')).toMatchObject({
      name: 'Managed Local Updated',
      command: 'mock-copilot-v2',
      args: ['--acp', '--verbose'],
      cwd: '/workspace/updated',
      yolo: true,
      public: false,
      env: { TOKEN: 'updated', EXTRA: 'value=with-equals' },
    });

    await agentsPanel.locator('.agentListItem', { hasText: 'Managed Local Updated' }).click();
    await expect(settingsField(page.locator('.agentSettingsModal'), 'Name')).toHaveValue('Managed Local Updated');
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('.agentSettingsModal').getByRole('button', { name: 'Delete' }).click();
    await expect(agentsPanel.locator('.agentListItem', { hasText: 'Managed Local Updated' })).toHaveCount(0);
    expect(backend.agents.has('managed-local')).toBe(false);
  });

  test('creates a remote agent from the Agents panel with the selected node', async ({ page }) => {
    const backend = await installIsolatedBackend(page);
    await login(page);
    await openAgents(page);

    const agentsPanel = page.locator('.agentsSidebar').filter({ hasText: 'Agents' });
    await agentsPanel.locator('button[title="Add agent"]').click();
    await page.getByRole('button', { name: /Add Agent from Remote Node/ }).click();
    const modal = page.locator('.agentSettingsModal', { hasText: 'Add Agent from Remote Node' });
    await modal.getByPlaceholder('unique-agent-id').fill('remote-created');
    await modal.getByPlaceholder('My Remote Agent').fill('Remote Created');
    await modal.locator('select').selectOption('remote-owned');
    await modal.getByPlaceholder(/home\/user\/project/).fill('/srv/remote-project');
    await modal.getByRole('button', { name: 'Create Remote Agent' }).click();

    await expect(agentsPanel.locator('.agentListItem', { hasText: 'Remote Created' })).toContainText('remote-owned');
    expect(backend.agents.get('remote-created')).toMatchObject({
      relay: true,
      relayConnectionName: 'remote-owned',
      cwd: '/srv/remote-project',
      yolo: true,
    });
    expect(backend.acpRequests).toContainEqual(expect.objectContaining({
      action: 'create-agent',
      agent: expect.objectContaining({ id: 'remote-created', relayConnectionName: 'remote-owned' }),
    }));
  });

  test('covers node setup, add, rename, probe, relay-agent creation, removal, and locked controls', async ({ page }) => {
    const backend = await installIsolatedBackend(page);
    await login(page);

    const addResult = await page.evaluate(async () => {
      const response = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add-node', name: 'owned-node', label: 'Owned Node' }),
      });
      return response.json();
    });
    expect(addResult).toEqual({ ok: true });

    await page.locator('button[title="Nodes"]').click();
    const nodesPanel = page.locator('.agentsSidebar').filter({ hasText: 'Nodes' });
    await expect(nodesPanel.locator('.agentListItem', { hasText: 'Owned Node' })).toBeVisible();

    await nodesPanel.locator('button[title="Add node"]').click();
    const setup = page.locator('.setupScriptModal');
    await expect(setup.getByRole('heading', { name: /Node Setup Kit/ })).toBeVisible();
    await expect(setup.locator('input[type="radio"][value="copilot"]')).toBeChecked();
    await setup.locator('input[type="radio"][value="agency"]').check();
    await expect(setup.locator('input[type="radio"][value="agency"]')).toBeChecked();
    await setup.getByRole('button', { name: 'Close' }).click();

    let ownedRow = nodesPanel.locator('.agentListItem', { hasText: 'owned-node' });
    await ownedRow.click();
    await expect(ownedRow.locator('.nodeAvatar')).toHaveAttribute('data-online', '');
    expect(backend.nodeRequests).toContainEqual({ action: 'check-node', name: 'owned-node' });

    await ownedRow.locator('.nodeListName').dblclick();
    const rename = ownedRow.locator('.nodeEditInput');
    await rename.fill('Renamed Owned Node');
    await rename.press('Enter');
    await expect(ownedRow.locator('.nodeListName')).toHaveText('Renamed Owned Node');
    expect(backend.nodes.get('owned-node')?.label).toBe('Renamed Owned Node');

    const lockedRow = nodesPanel.locator('.agentListItem', { hasText: 'Locked Node' });
    await expect(lockedRow.locator('.nodeActionBtn')).toHaveCount(0);
    await expect(lockedRow.locator('.nodeRemoveBtn')).toHaveCount(0);
    await lockedRow.locator('.nodeListName').dblclick();
    await expect(lockedRow.locator('.nodeEditInput')).toHaveCount(0);

    ownedRow = nodesPanel.locator('.agentListItem', { hasText: 'owned-node' });
    await ownedRow.hover();
    const relayModal = page.locator('.agentSettingsModal', { hasText: 'Add Agent on owned-node' });
    await expect(async () => {
      await ownedRow.locator('[title="Add agent on this node"]').click();
      await expect(relayModal).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 5_000 });
    await relayModal.getByPlaceholder('unique-agent-id').fill('relay-from-node');
    await relayModal.getByPlaceholder('My Remote Agent').fill('Relay From Node');
    await relayModal.getByPlaceholder(/home\/user\/project/).fill('/srv/node-agent');
    await relayModal.getByRole('button', { name: 'Create Relay Agent' }).click();
    expect(backend.agents.get('relay-from-node')).toMatchObject({
      relay: true,
      relayConnectionName: 'owned-node',
      cwd: '/srv/node-agent',
    });

    await ownedRow.hover();
    await ownedRow.locator('[title="Remove node"]').click();
    await expect(nodesPanel.locator('.agentListItem', { hasText: 'Renamed Owned Node' })).toHaveCount(0);
    expect(backend.nodes.has('owned-node')).toBe(false);
    expect(backend.nodeRequests).toContainEqual({ action: 'remove-node', name: 'owned-node' });
  });
});
