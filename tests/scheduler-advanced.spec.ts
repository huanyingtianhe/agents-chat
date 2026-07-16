import { expect, Page, test } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';

const alphaAgent = {
  id: 'alpha',
  name: 'Alpha Agent',
  command: 'mock',
  args: ['--acp'],
  cwd: '/tmp',
  running: true,
  canTalk: true,
  canModify: true,
  public: true,
  models: [],
};

type ScheduleJob = {
  id: string;
  agentId: string;
  ownerEmail: string;
  name: string;
  prompt: string;
  scheduleSpec: Record<string, unknown>;
  cronExpr: string;
  enabled: boolean;
  timeoutMinutes: number;
  createdAt: number;
  updatedAt: number;
};

async function mockApp(page: Page, initialJobs: ScheduleJob[] = []) {
  const jobs = [...initialJobs];
  const runs = new Map<string, any[]>();
  const createRequests: any[] = [];
  const runRequests: string[] = [];

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    const response = body?.action === 'list-agents' ? { ok: true, agents: [alphaAgent] } : { ok: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });
  await page.route('**/api/chats**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, chats: [], lastChatId: '' }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/orchestrations**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }),
  );
  await page.route('**/api/schedules**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const segments = url.pathname.split('/').filter(Boolean);
    const id = segments[2];
    const isRun = segments[3] === 'run';

    if (request.method() === 'GET' && !id) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jobs }) });
      return;
    }
    if (request.method() === 'POST' && !id) {
      const body = request.postDataJSON();
      createRequests.push(body);
      const job: ScheduleJob = {
        id: `schedule-${jobs.length + 1}`,
        ownerEmail: 'admin',
        cronExpr: '* * * * *',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...body,
      };
      jobs.push(job);
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ job, id: job.id }) });
      return;
    }
    if (request.method() === 'POST' && id && isRun) {
      runRequests.push(id);
      const run = {
        id: `run-${runRequests.length + 2}`,
        jobId: id,
        status: 'success',
        scheduledFor: Date.now(),
        startedAt: Date.now(),
        finishedAt: Date.now() + 100,
        replyText: 'Run-now reply',
      };
      runs.set(id, [run, ...(runs.get(id) || [])]);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ run }) });
      return;
    }
    if (request.method() === 'GET' && id) {
      const job = jobs.find((item) => item.id === id);
      await route.fulfill({
        status: job ? 200 : 404,
        contentType: 'application/json',
        body: JSON.stringify(job ? { job, runs: runs.get(id) || [] } : { error: 'not found' }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  return { jobs, runs, createRequests, runRequests };
}

async function login(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder('Admin username').fill('admin');
  await page.getByPlaceholder('Password').fill('admin123');
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('.emptyHomepage, .chatContainer', { timeout: 30000 });
  await page.waitForTimeout(500);
}

async function openSchedules(page: Page) {
  await page.locator('button[title="Schedules"]').click();
  await expect(page.locator('.agentsSidebar', { hasText: 'Schedules' })).toBeVisible();
}

test('scheduler creates a weekly local-time job with timeout and selected weekdays', async ({ page }) => {
  const { createRequests } = await mockApp(page);
  await login(page);
  await openSchedules(page);
  await page.getByTitle('Create schedule').click();

  const modal = page.locator('.agentSettingsModal');
  await modal.getByPlaceholder('E.g., Daily report generation').fill('Weekly review');
  await modal.getByPlaceholder('What should the agent do?').fill('Review the weekly changes');

  await modal.getByRole('button', { name: 'Schedule Type' }).click();
  await page.locator('.themedPickerDropdown[aria-label="Schedule Type"]')
    .locator('button.themedPickerOption[data-value="weekly"]')
    .click();
  await modal.getByLabel('Mon', { exact: true }).check();
  await modal.getByLabel('Wed', { exact: true }).check();
  await modal.getByLabel('Hour (0-23)').fill('14');
  await modal.getByLabel('Minute (0-59)').fill('30');
  await modal.getByLabel(/Run timeout/).fill('45');
  await modal.getByRole('button', { name: 'Save' }).click();

  await expect(modal).toBeHidden();
  await expect(page.locator('.scheduleListItem', { hasText: 'Weekly review' })).toBeVisible();
  const expectedUtc = await page.evaluate(() => {
    let total = 14 * 60 + 30 + new Date().getTimezoneOffset();
    let dayShift = 0;
    while (total < 0) {
      total += 24 * 60;
      dayShift -= 1;
    }
    while (total >= 24 * 60) {
      total -= 24 * 60;
      dayShift += 1;
    }
    const shiftDay = (day: number) => ((day + dayShift) % 7 + 7) % 7;
    return { hour: Math.floor(total / 60), minute: total % 60, weekdays: [shiftDay(1), shiftDay(3)] };
  });
  expect(createRequests).toHaveLength(1);
  expect(createRequests[0]).toMatchObject({
    agentId: 'alpha',
    name: 'Weekly review',
    prompt: 'Review the weekly changes',
    enabled: true,
    timeoutMinutes: 45,
    scheduleSpec: { kind: 'weekly', ...expectedUtc },
  });
});

test('scheduler displays run history and refreshes after Run now', async ({ page }) => {
  const job: ScheduleJob = {
    id: 'history-job',
    agentId: 'alpha',
    ownerEmail: 'admin',
    name: 'History coverage',
    prompt: 'Run history',
    scheduleSpec: { kind: 'daily', hour: 9, minute: 15 },
    cronExpr: '15 9 * * *',
    enabled: true,
    timeoutMinutes: 10,
    createdAt: 1,
    updatedAt: 1,
  };
  const { runs, runRequests } = await mockApp(page, [job]);
  runs.set(job.id, [
    {
      id: 'run-success',
      jobId: job.id,
      status: 'success',
      scheduledFor: 1_700_000_000_000,
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_500,
      replyText: 'Scheduled reply',
    },
    {
      id: 'run-error',
      jobId: job.id,
      status: 'error',
      scheduledFor: 1_699_999_000_000,
      startedAt: 1_699_999_000_000,
      finishedAt: 1_699_999_000_500,
      errorMessage: 'Agent unavailable',
    },
  ]);

  await login(page);
  await openSchedules(page);
  await page.locator('.scheduleListItem', { hasText: job.name }).getByTitle('View run history').click();

  const modal = page.locator('.agentSettingsModal');
  await expect(modal.getByRole('heading')).toContainText('History coverage — Runs');
  await modal.locator('details').first().locator('summary').click();
  await expect(modal).toContainText('Scheduled reply');
  await modal.locator('details').nth(1).locator('summary').click();
  await expect(modal).toContainText('Agent unavailable');

  await modal.getByRole('button', { name: '▶ Run now' }).click();
  await expect.poll(() => runRequests).toEqual([job.id]);
  await expect(modal).toContainText('Run-now reply');
});
