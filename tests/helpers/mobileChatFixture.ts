import { expect, type Page } from '@playwright/test';

export const TEST_AGENT = {
  id: 'alpha',
  name: 'Alpha Agent',
  command: 'mock',
  args: ['--acp'],
  cwd: '/home/xujx/wa/agents-chat',
  running: true,
  canTalk: true,
  canModify: true,
  public: true,
  models: [{ modelId: 'gpt-5.4', name: 'GPT-5.4' }],
  defaultModelId: 'gpt-5.4',
};

export const TEST_AGENT_B = {
  ...TEST_AGENT,
  id: 'beta',
  name: 'Beta Agent',
  cwd: '/home/xujx/wa/agents-chat/beta',
};

const WIDE_MESSAGE_CONTENT = `Existing mobile message

${'unbrokenmobiletoken'.repeat(50)}

\`\`\`text
${'widecodecolumn'.repeat(50)}
\`\`\`

![Wide mobile fixture](/wide-mobile-fixture.svg)

| Column one | Column two | Column three | Column four | Column five | Column six |
| --- | --- | --- | --- | --- | --- |
| Alpha value | Beta value | Gamma value | Delta value | Epsilon value | Zeta value |`;

export type MobileFixture = {
  agents: Map<string, Record<string, unknown>>;
  access: Map<string, string[]>;
  acpRequests: Record<string, unknown>[];
  scheduleRequests: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
  failNextAgentUpdate: () => void;
  holdNextAgentUpdate: () => () => void;
  holdAgentSettings: (agentId: string) => () => void;
  holdNextScheduleUpdate: () => () => void;
  failNextScheduleRefresh: () => void;
};

export async function installMobileChatFixture(page: Page): Promise<MobileFixture> {
  const agents = new Map<string, Record<string, unknown>>([
    [TEST_AGENT.id, { ...TEST_AGENT }],
    [TEST_AGENT_B.id, { ...TEST_AGENT_B }],
  ]);
  const access = new Map<string, string[]>();
  const acpRequests: Record<string, unknown>[] = [];
  const scheduleRequests: MobileFixture['scheduleRequests'] = [];
  let rejectNextAgentUpdate = false;
  let pendingAgentUpdate: Promise<void> | null = null;
  let pendingScheduleUpdate: Promise<void> | null = null;
  let rejectNextScheduleRefresh = false;
  const pendingAgentSettings = new Map<string, Promise<void>>();
  const nodes = [{
    name: 'mobile-node',
    label: 'Mobile Node',
    online: true,
    checkedAt: 1_000,
    platform: null,
    connectionError: null,
    manual: true,
    owner: 'admin@local',
    canModify: true,
  }, {
    name: 'offline-node',
    label: 'Offline Node',
    online: false,
    checkedAt: 1_000,
    platform: null,
    connectionError: 'Relay connection closed before opening',
    manual: true,
    owner: 'admin@local',
    canModify: true,
  }];
  const schedule = {
    id: 'schedule-1',
    agentId: 'alpha',
    ownerEmail: 'admin@local',
    name: 'Daily report',
    prompt: 'Report',
    scheduleSpec: { kind: 'daily' as const, hour: 9, minute: 0 },
    cronExpr: '0 9 * * *',
    enabled: false,
    timeoutMinutes: 30,
    createdAt: 1_000,
    updatedAt: 1_000,
    lastRunAt: 900,
    nextRunAt: 2_000,
  };
  const chat = {
    id: 'mobile-chat',
    name: 'Mobile coverage',
    ts: 1_000,
    messages: [{ id: 'welcome', type: 'user', content: WIDE_MESSAGE_CONTENT, ts: 1_001 }],
    agentSessions: {},
  };
  const secondChat = {
    id: 'second-mobile-chat',
    name: 'Second mobile chat',
    ts: 900,
    messages: [{ id: 'second-message', type: 'user', content: 'Second chat message', ts: 901 }],
    agentSessions: {},
  };

  await page.route('**/api/chats**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    const selectedChat = id === secondChat.id ? secondChat : chat;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(id
        ? { ok: true, chat: selectedChat }
        : {
          ok: true,
          chats: [
            { id: chat.id, name: chat.name, ts: chat.ts },
            { id: secondChat.id, name: secondChat.name, ts: secondChat.ts },
          ],
          lastChatId: chat.id,
        }),
    });
  });
  await page.route('**/api/orchestrations**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }),
  );
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    acpRequests.push(body);
    const agentId = String(body.agentId || '');
    if (
      (body.action === 'get-agent-config' || body.action === 'list-agent-access')
      && pendingAgentSettings.has(agentId)
    ) {
      await pendingAgentSettings.get(agentId);
    }
    if (body.action === 'update-agent-config' && pendingAgentUpdate) {
      const updateGate = pendingAgentUpdate;
      pendingAgentUpdate = null;
      await updateGate;
    }
    if (body.action === 'update-agent-config' && rejectNextAgentUpdate) {
      rejectNextAgentUpdate = false;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'Agent update rejected' }),
      });
      return;
    }
    let response: Record<string, unknown> = { ok: true };
    if (body.action === 'list-agents') {
      response = { ok: true, agents: [...agents.values()] };
    } else if (body.action === 'create-agent') {
      const agent = body.agent as Record<string, unknown>;
      agents.set(String(agent.id), {
        ...agent,
        canTalk: true,
        canModify: true,
        public: false,
        models: [],
      });
      response = { ok: true, agent };
    } else if (body.action === 'get-agent-config') {
      response = { ok: true, agent: agents.get(String(body.agentId)) };
    } else if (body.action === 'update-agent-config') {
      const id = String(body.agentId);
      agents.set(id, { ...agents.get(id), ...(body.updates as Record<string, unknown>) });
      response = { ok: true, agent: agents.get(id), restarted: false };
    } else if (body.action === 'delete-agent') {
      agents.delete(String(body.agentId));
    } else if (body.action === 'list-agent-access') {
      response = {
        ok: true,
        access: (access.get(String(body.agentId)) || []).map((email) => ({
          email,
          grantedBy: 'admin@local',
          createdAt: '2026-09-14T00:00:00.000Z',
        })),
      };
    } else if (body.action === 'add-agent-access') {
      const id = String(body.agentId);
      access.set(id, [...new Set([...(access.get(id) || []), String(body.email)])]);
    } else if (body.action === 'remove-agent-access') {
      const id = String(body.agentId);
      access.set(id, (access.get(id) || []).filter((email) => email !== body.email));
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });
  await page.route('**/api/nodes', async (route) => {
    const body = route.request().postDataJSON() as { action?: string; name?: string };
    if (body.action === 'check-node') {
      const node = nodes.find((item) => item.name === body.name);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(node
          ? {
            ok: true,
            name: node.name,
            online: node.online,
            checkedAt: node.checkedAt,
            platform: node.platform,
            connectionError: node.connectionError,
          }
          : { ok: false, error: 'Node not found' }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        nodes,
      }),
    });
  });
  await page.route('**/api/schedules**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as Record<string, unknown> | null;
    scheduleRequests.push({ method: request.method(), path, body: body ?? undefined });
    if (request.method() === 'PATCH' && pendingScheduleUpdate) {
      const updateGate = pendingScheduleUpdate;
      pendingScheduleUpdate = null;
      await updateGate;
    }
    if (request.method() === 'PATCH') {
      schedule.enabled = Boolean(body?.enabled);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ job: schedule }),
      });
      return;
    }
    if (request.method() === 'GET' && path === '/api/schedules' && rejectNextScheduleRefresh) {
      rejectNextScheduleRefresh = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Schedule reconciliation unavailable' }),
      });
      return;
    }
    if (request.method() === 'GET' && path === '/api/schedules/schedule-1') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          job: schedule,
          runs: [{
            id: 'run-1',
            jobId: schedule.id,
            scheduledFor: 900,
            startedAt: 901,
            finishedAt: 905,
            status: 'success',
            replyText: 'Report complete',
            errorMessage: null,
            rawLogPath: null,
          }],
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        jobs: [schedule],
      }),
    });
  });
  await page.route('**/api/markdown**', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(path
        ? { path, content: '# Mobile file\n\nComment-ready content.', kind: 'markdown', mtime: '2026-09-14T00:00:00.000Z' }
        : {
          files: [
            { path: 'README.md', name: 'README.md', mtime: '2026-09-14T00:00:00.000Z' },
            { path: 'broken.md', name: 'broken.md', mtime: '2026-09-14T00:00:00.000Z' },
          ],
        }),
    });
  });
  await page.route('**/api/comments**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, comments: [] }),
    }),
  );
  await page.route('**/wide-mobile-fixture.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="120"><rect width="1200" height="120" fill="#45d7ff"/></svg>',
    }),
  );
  return {
    agents,
    access,
    acpRequests,
    scheduleRequests,
    failNextAgentUpdate: () => {
      rejectNextAgentUpdate = true;
    },
    holdNextAgentUpdate: () => {
      let release = () => {};
      pendingAgentUpdate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    holdAgentSettings: (agentId: string) => {
      let release = () => {};
      pendingAgentSettings.set(agentId, new Promise<void>((resolve) => {
        release = () => {
          pendingAgentSettings.delete(agentId);
          resolve();
        };
      }));
      return release;
    },
    holdNextScheduleUpdate: () => {
      let release = () => {};
      pendingScheduleUpdate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    failNextScheduleRefresh: () => {
      rejectNextScheduleRefresh = true;
    },
  };
}

export async function loginMobileFixture(page: Page): Promise<void> {
  await page.goto('/login');
  await expect(page.locator('form')).toHaveAttribute('data-hydrated', 'true');
  await page.getByPlaceholder('Admin username').fill(process.env.ADMIN_USERNAME || 'admin');
  await page.getByPlaceholder('Password').fill(process.env.ADMIN_PASSWORD || 'admin123');
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('.message.user')).toBeVisible({ timeout: 30_000 });
}
