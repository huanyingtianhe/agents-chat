import { expect, test, type Page } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';

type Plan = {
  name?: string;
  version: 1;
  nodes: Array<{ id: string; agent: string; instruction: string; dependsOn: string[] }>;
};

type UserWorkflow = { id: string; name: string; plan: Plan; createdAt: number; updatedAt: number };

const repoPlan: Plan = {
  name: 'Repository Review',
  version: 1,
  nodes: [{ id: 'review', agent: 'alpha', instruction: 'Review {{input}}', dependsOn: [] }],
};
const savedPlan: Plan = {
  name: 'Saved Triage',
  version: 1,
  nodes: [{ id: 'triage', agent: 'beta', instruction: 'Triage {{input}}', dependsOn: [] }],
};
const suggestedPlan: Plan = {
  name: 'Suggested Plan',
  version: 1,
  nodes: [{ id: 'suggest', agent: 'alpha', instruction: 'Investigate {{input}}', dependsOn: [] }],
};

async function mockIsolatedApp(page: Page) {
  const userWorkflows = new Map<string, UserWorkflow>([
    ['saved-triage', { id: 'saved-triage', name: 'Saved Triage', plan: savedPlan, createdAt: 10, updatedAt: 10 }],
  ]);
  const workflowRequests: Array<{ method: string; path: string; body?: unknown }> = [];
  const chat = {
    id: 'workflow-chat',
    name: 'Workflow coverage',
    ts: 700,
    messages: [
      { id: 'wf-user', type: 'user', content: 'Create a reusable workflow.', ts: 701 },
      {
        id: 'wf-agent',
        type: 'agent',
        agentId: 'alpha',
        content: `\`\`\`json\n${JSON.stringify(suggestedPlan, null, 2)}\n\`\`\``,
        ts: 702,
      },
    ],
    agentSessions: {},
  };

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action === 'list-agents') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          agents: [
            { id: 'alpha', name: 'Alpha', relay: true, canTalk: true, models: [] },
            { id: 'beta', name: 'Beta', relay: true, canTalk: true, models: [] },
          ],
        }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/orchestrations**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }),
  );
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
  await page.route('**/api/workflows', async (route) => {
    const request = route.request();
    workflowRequests.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.method() === 'POST' ? request.postDataJSON() : undefined,
    });
    if (request.method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          repo: [{ name: repoPlan.name, source: 'repo', filePath: '.github/workflows/review.json', plan: repoPlan }],
          user: [...userWorkflows.values()],
        }),
      });
      return;
    }
    const body = request.postDataJSON();
    const id = body.id || 'saved-from-message';
    const workflow: UserWorkflow = {
      id,
      name: body.name,
      plan: body.plan,
      createdAt: 20,
      updatedAt: 20,
    };
    userWorkflows.set(id, workflow);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, workflow }) });
  });
  await page.route('**/api/workflows/**', async (route) => {
    const request = route.request();
    const id = decodeURIComponent(new URL(request.url()).pathname.split('/').pop() || '');
    workflowRequests.push({ method: request.method(), path: new URL(request.url()).pathname });
    const workflow = userWorkflows.get(id);
    if (request.method() === 'DELETE') {
      const deleted = userWorkflows.delete(id);
      await route.fulfill({
        status: deleted ? 200 : 404,
        contentType: 'application/json',
        body: JSON.stringify(deleted ? { ok: true } : { ok: false, error: 'not_found' }),
      });
      return;
    }
    await route.fulfill({
      status: workflow ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(workflow ? { ok: true, workflow } : { ok: false, error: 'not_found' }),
    });
  });

  return { userWorkflows, workflowRequests };
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder('Admin username').fill('admin');
  await page.getByPlaceholder('Password').fill('admin123');
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole('button', { name: 'workflow', exact: true })).toBeVisible({ timeout: 30_000 });
}

async function openPicker(page: Page) {
  await page.getByRole('button', { name: /^workflow(?::|$)/ }).click();
  await expect(page.getByRole('heading', { name: 'Pick a workflow' })).toBeVisible();
}

test.describe('workflow library', () => {
  test('loads repo and user workflows and selects each from the picker', async ({ page }) => {
    const { workflowRequests } = await mockIsolatedApp(page);
    await login(page);

    await openPicker(page);
    await expect(page.getByRole('heading', { name: 'Repo workflows' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Saved workflows' })).toBeVisible();
    await page.getByRole('button', { name: /Repository Review 1 nodes/ }).click();
    await expect(page.getByRole('button', { name: 'workflow: Repository Review' })).toBeVisible();

    await openPicker(page);
    await page.getByRole('button', { name: /Saved Triage 1 nodes/ }).click();
    await expect(page.getByRole('button', { name: 'workflow: Saved Triage' })).toBeVisible();
    expect(workflowRequests.filter((request) => request.method === 'GET').length).toBeGreaterThanOrEqual(2);
  });

  test('reports invalid JSON and builds a selectable template with available agents', async ({ page }) => {
    await mockIsolatedApp(page);
    await login(page);
    await openPicker(page);

    const editor = page.locator('.wfPickerModal textarea');
    await editor.fill('{ invalid json');
    await page.getByRole('button', { name: 'Use this plan' }).click();
    await expect(page.locator('.wfPickerError')).toContainText('Invalid JSON:');

    await page.getByRole('button', { name: 'Use template' }).click();
    await expect(editor).toContainText('"name": "my-workflow"');
    await expect(editor).toContainText('"agent": "alpha"');
    await expect(editor).toContainText('"agent": "beta"');
    await page.getByRole('button', { name: 'Use this plan' }).click();
    await expect(page.getByRole('button', { name: 'workflow: my-workflow' })).toBeVisible();
  });

  test('saves from chat UI, reloads it in the picker, and deletes it through the API', async ({ page }) => {
    const { userWorkflows, workflowRequests } = await mockIsolatedApp(page);
    await login(page);

    page.once('dialog', (dialog) => dialog.accept('Saved from E2E'));
    await page.getByRole('button', { name: 'Save as workflow' }).click();
    await expect(page.getByText('Saved ✓', { exact: true })).toBeVisible();
    expect(userWorkflows.get('saved-from-message')?.name).toBe('Saved from E2E');

    await openPicker(page);
    await expect(page.getByRole('button', { name: /Saved from E2E 1 nodes/ })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    const apiResult = await page.evaluate(async () => {
      const loaded = await fetch('/api/workflows/saved-from-message').then((response) => response.json());
      const deleted = await fetch('/api/workflows/saved-from-message', { method: 'DELETE' })
        .then((response) => response.json());
      return { loaded, deleted };
    });
    expect(apiResult.loaded.workflow.name).toBe('Saved from E2E');
    expect(apiResult.deleted).toEqual({ ok: true });
    expect(workflowRequests).toContainEqual({ method: 'DELETE', path: '/api/workflows/saved-from-message' });

    await openPicker(page);
    await expect(page.getByRole('button', { name: /Saved from E2E/ })).toHaveCount(0);
  });
});

test('workflow API persists, validates, lists, and deletes a user workflow', async ({ page }) => {
  const id = `workflow-api-${Date.now()}`;
  const plan: Plan = {
    name: 'API Workflow',
    version: 1,
    nodes: [{ id: 'step', agent: 'alpha', instruction: 'Process {{input}}', dependsOn: [] }],
  };
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON();
    const response = body?.action === 'list-agents' ? { ok: true, agents: [] } : { ok: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder('Admin username').fill('admin');
  await page.getByPlaceholder('Password').fill('admin123');
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('.emptyHomepage, .chatContainer', { timeout: 30_000 });

  try {
    const result = await page.evaluate(async ({ id, plan }) => {
      const request = async (url: string, init?: RequestInit) => {
        const response = await fetch(url, init);
        return { status: response.status, body: await response.json() };
      };
      const created = await request('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: 'API Workflow', plan }),
      });
      const loaded = await request(`/api/workflows/${encodeURIComponent(id)}`);
      const listed = await request('/api/workflows');
      const invalid = await request('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `${id}-invalid`,
          name: 'Invalid workflow',
          plan: { version: 1, nodes: [{ id: 'broken', agent: '', instruction: '', dependsOn: ['missing'] }] },
        }),
      });
      return { created, loaded, listed, invalid };
    }, { id, plan });

    expect(result.created.status).toBe(200);
    expect(result.loaded.body.workflow).toMatchObject({ id, name: 'API Workflow' });
    expect(result.listed.body.user.some((workflow: { id: string }) => workflow.id === id)).toBe(true);
    expect(result.invalid.status).toBe(400);
  } finally {
    await page.evaluate(async (workflowId) => {
      await fetch(`/api/workflows/${encodeURIComponent(workflowId)}`, { method: 'DELETE' });
    }, id);
  }
});
