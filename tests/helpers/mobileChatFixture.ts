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

export type MobileFixture = {
  agents: Map<string, Record<string, unknown>>;
  access: Map<string, string[]>;
  acpRequests: Record<string, unknown>[];
  scheduleRequests: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
  failNextAgentUpdate: () => void;
};

export async function installMobileChatFixture(page: Page): Promise<MobileFixture> {
  const agents = new Map<string, Record<string, unknown>>([
    [TEST_AGENT.id, { ...TEST_AGENT }],
  ]);
  const access = new Map<string, string[]>();
  const acpRequests: Record<string, unknown>[] = [];
  const scheduleRequests: MobileFixture['scheduleRequests'] = [];
  let rejectNextAgentUpdate = false;
  const chat = {
    id: 'mobile-chat',
    name: 'Mobile coverage',
    ts: 1_000,
    messages: [{ id: 'welcome', type: 'user', content: 'Existing mobile message', ts: 1_001 }],
    agentSessions: {},
  };

  await page.route('**/api/chats**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(id
        ? { ok: true, chat }
        : { ok: true, chats: [{ id: chat.id, name: chat.name, ts: chat.ts }], lastChatId: chat.id }),
    });
  });
  await page.route('**/api/orchestrations**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }),
  );
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    acpRequests.push(body);
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
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        nodes: [{
          name: 'mobile-node',
          label: 'Mobile Node',
          online: true,
          checkedAt: 1_000,
          manual: true,
          owner: 'admin@local',
          canModify: true,
        }],
      }),
    });
  });
  await page.route('**/api/schedules**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as Record<string, unknown> | null;
    scheduleRequests.push({ method: request.method(), path, body: body ?? undefined });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        jobs: [{
          id: 'schedule-1',
          agentId: 'alpha',
          name: 'Daily report',
          prompt: 'Report',
          scheduleSpec: { kind: 'daily', hour: 9, minute: 0 },
          enabled: false,
          timeoutMinutes: 30,
          createdAt: 1_000,
          updatedAt: 1_000,
        }],
      }),
    });
  });
  return {
    agents,
    access,
    acpRequests,
    scheduleRequests,
    failNextAgentUpdate: () => {
      rejectNextAgentUpdate = true;
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
