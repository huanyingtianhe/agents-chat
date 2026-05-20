/**
 * Playwright tests for agent schedules REST API and UI.
 *
 * Requires: dev server running on localhost:3010
 * Run: npx playwright test test/test-schedules.spec.ts
 */

import { test, expect, Page } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

/** Login helper — fills credentials and waits for redirect to main page */
async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  const usernameInput = page.locator('input[placeholder="Admin username"]');
  const passwordInput = page.locator('input[placeholder="Password"]');
  await usernameInput.fill(ADMIN_USER);
  await passwordInput.fill(ADMIN_PASS);
  await expect(page.locator('button[type="submit"]')).toBeEnabled({ timeout: 10000 });
  await page.click('button[type="submit"]');
  // Wait for the chat UI to be visible
  await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 30000 });
  await page.waitForTimeout(500);
}

/** Fetch the first agent ID from /api/agents */
async function getFirstAgentId(page: Page): Promise<string | null> {
  const r = await page.request.get(`${BASE}/api/agents`);
  if (!r.ok()) return null;
  const data = await r.json();
  // API may return { agents: [...] } or [...] directly
  const list = (data.agents ?? data) as Array<{ id: string }> | undefined;
  return Array.isArray(list) && list[0]?.id ? list[0].id : null;
}

test.describe('Schedules', () => {
  let createdIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test.afterEach(async ({ page }) => {
    // Clean up all created schedules
    for (const id of createdIds) {
      try {
        await page.request.delete(`${BASE}/api/schedules/${id}`);
      } catch {
        // Ignore cleanup errors
      }
    }
    createdIds = [];
  });

  // ============ API Tests (Task 12) ============

  test('API: POST /api/schedules creates a job', async ({ page }) => {
    const agentId = await getFirstAgentId(page);
    test.skip(!agentId, 'no agents configured');

    const payload = {
      agentId,
      name: 'pw-test-create',
      prompt: 'noop',
      scheduleSpec: { kind: 'every_minutes', interval: 30 },
      enabled: false,
    };

    const r = await page.request.post(`${BASE}/api/schedules`, { data: payload });
    expect(r.status()).toBe(201);

    const body = await r.json();
    expect(body).toHaveProperty('id');
    const scheduleId = body.id as string;
    createdIds.push(scheduleId);

    expect(scheduleId).toBeTruthy();
  });

  test('API: GET /api/schedules lists the created job', async ({ page }) => {
    const agentId = await getFirstAgentId(page);
    test.skip(!agentId, 'no agents configured');

    // Create a schedule
    const createPayload = {
      agentId,
      name: 'pw-test-list',
      prompt: 'noop',
      scheduleSpec: { kind: 'every_minutes', interval: 30 },
      enabled: false,
    };
    const createRes = await page.request.post(`${BASE}/api/schedules`, { data: createPayload });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json();
    const scheduleId = created.id as string;
    createdIds.push(scheduleId);

    // Fetch all schedules
    const listRes = await page.request.get(`${BASE}/api/schedules`);
    expect(listRes.status()).toBe(200);
    const listBody = await listRes.json();

    // Assert the jobs array contains the created schedule
    expect(listBody).toHaveProperty('jobs');
    const jobs = listBody.jobs as Array<{ id: string; name: string }>;
    const found = jobs.find((j) => j.id === scheduleId);
    expect(found).toBeTruthy();
    expect(found?.name).toBe('pw-test-list');
  });

  test('API: PATCH /api/schedules/:id updates fields', async ({ page }) => {
    const agentId = await getFirstAgentId(page);
    test.skip(!agentId, 'no agents configured');

    // Create a schedule
    const createPayload = {
      agentId,
      name: 'pw-test-patch',
      prompt: 'noop',
      scheduleSpec: { kind: 'every_minutes', interval: 30 },
      enabled: false,
    };
    const createRes = await page.request.post(`${BASE}/api/schedules`, { data: createPayload });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json();
    const scheduleId = created.id as string;
    createdIds.push(scheduleId);

    // Update the schedule
    const updatePayload = {
      enabled: true,
      name: 'pw-test-patched',
    };
    const patchRes = await page.request.patch(`${BASE}/api/schedules/${scheduleId}`, {
      data: updatePayload,
    });
    expect(patchRes.status()).toBe(200);

    // Fetch the updated schedule
    const getRes = await page.request.get(`${BASE}/api/schedules/${scheduleId}`);
    expect(getRes.status()).toBe(200);
    const job = await getRes.json();
    expect(job.enabled).toBe(true);
    expect(job.name).toBe('pw-test-patched');
  });

  test('API: DELETE /api/schedules/:id removes the job', async ({ page }) => {
    const agentId = await getFirstAgentId(page);
    test.skip(!agentId, 'no agents configured');

    // Create a schedule
    const createPayload = {
      agentId,
      name: 'pw-test-delete',
      prompt: 'noop',
      scheduleSpec: { kind: 'every_minutes', interval: 30 },
      enabled: false,
    };
    const createRes = await page.request.post(`${BASE}/api/schedules`, { data: createPayload });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json();
    const scheduleId = created.id as string;

    // Delete the schedule
    const deleteRes = await page.request.delete(`${BASE}/api/schedules/${scheduleId}`);
    expect(deleteRes.status()).toBe(200);

    // Verify it's gone
    const getRes = await page.request.get(`${BASE}/api/schedules/${scheduleId}`);
    expect(getRes.status()).toBe(404);
  });

  test('API: POST /api/schedules rejects invalid spec', async ({ page }) => {
    const agentId = await getFirstAgentId(page);
    test.skip(!agentId, 'no agents configured');

    const invalidPayload = {
      agentId,
      name: 'pw-test-invalid',
      prompt: 'noop',
      scheduleSpec: { kind: 'every_minutes', interval: 0 }, // Invalid: 0 minutes
      enabled: false,
    };

    const r = await page.request.post(`${BASE}/api/schedules`, { data: invalidPayload });
    expect(r.status()).toBeGreaterThanOrEqual(400);
    expect(r.status()).toBeLessThan(500);
  });

  // ============ UI Tests (Task 18) ============

  test('UI: opens schedules panel from header', async ({ page }) => {
    // Click the schedules button in the header (title="Schedules")
    const schedulesBtn = page.locator('[title="Schedules"]');
    await expect(schedulesBtn).toBeVisible({ timeout: 10000 });
    await schedulesBtn.click();

    // Assert the schedules panel is visible with the heading "Schedules"
    const sidebar = page.locator('aside.agentsSidebar');
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    // Check for "Schedules" text in the sidebar header
    const schedulesHeading = page.locator('aside .agentsSidebarHeader', { hasText: 'Schedules' });
    await expect(schedulesHeading).toBeVisible({ timeout: 10000 });
  });

  test('UI: creates a schedule via the editor', async ({ page }) => {
    const agentId = await getFirstAgentId(page);
    test.skip(!agentId, 'no agents configured');

    // Open the schedules panel
    const schedulesBtn = page.locator('[title="Schedules"]');
    await expect(schedulesBtn).toBeVisible({ timeout: 10000 });
    await schedulesBtn.click();

    // Wait for the sidebar to be visible
    const sidebar = page.locator('aside.agentsSidebar');
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    // Click the + button to create a new schedule
    const addBtn = page.locator('aside .agentsSidebarHeader button.sidebarToggle:has-text("+")');
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();

    // Wait for the modal to appear
    const modal = page.locator('.modal.agentSettingsModal');
    await expect(modal).toBeVisible({ timeout: 10000 });

    // Fill in the schedule form
    const nameInput = modal.locator('label:has(span:text-is("Name")) input');
    await expect(nameInput).toBeVisible({ timeout: 10000 });
    await nameInput.fill('pw-ui-create');

    // Select an agent
    const agentSelect = modal.locator('label:has(span:text-is("Agent")) select');
    await agentSelect.selectOption(agentId!);

    // Fill in the prompt
    const promptInput = modal.locator('label:has(span:text-is("Prompt")) textarea');
    await promptInput.fill('noop');

    // Leave kind as Interval (default should already be selected)

    // Click Save button
    const saveBtn = modal.locator('button:has-text("Save")');
    await expect(saveBtn).toBeVisible({ timeout: 10000 });
    await saveBtn.click();

    // Wait for modal to close
    await expect(modal).not.toBeVisible({ timeout: 10000 });

    // Fetch all schedules to find the created one by name
    const listRes = await page.request.get(`${BASE}/api/schedules`);
    expect(listRes.status()).toBe(200);
    const listBody = await listRes.json();
    const jobs = listBody.jobs as Array<{ id: string; name: string }>;
    const created = jobs.find((j) => j.name === 'pw-ui-create');
    expect(created).toBeTruthy();
    if (created) {
      createdIds.push(created.id);
    }

    // Assert the new schedule row appears in the panel (by text 'pw-ui-create')
    const scheduleRow = page.locator('aside').locator('text=pw-ui-create');
    await expect(scheduleRow).toBeVisible({ timeout: 10000 });
  });
});
