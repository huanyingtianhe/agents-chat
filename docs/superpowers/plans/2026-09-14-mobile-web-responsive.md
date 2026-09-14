# Mobile Web Responsive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Agents Chat web interface fully usable on iPhone and Android while preserving the current desktop layout and component model.

**Architecture:** Keep one React component tree for all viewport sizes. Add a focused mobile-overlay controller under the layout feature, drive the existing sidebar and right panels through that controller, and use responsive CSS for presentation. Existing feature hooks and backend APIs remain authoritative; mobile-only restrictions are explicit props rather than duplicated feature implementations.

**Tech Stack:** Next.js 16 App Router, React 19, strict TypeScript, feature-local CSS, Playwright with Chromium and WebKit.

---

## Scope and File Map

### New files

- `app/features/layout/hooks/useMobileOverlayState.ts` — owns the 900px media-query result, the active mobile surface, transient history entries, Escape/backdrop closure, body scroll locking, and trigger focus restoration.
- `tests/helpers/mobileChatFixture.ts` — installs deterministic Chat, ACP, Files, Nodes, and Schedules route mocks and logs into the application.
- `tests/mobile-responsive.spec.ts` — shared iPhone/Android responsive navigation, state preservation, feature-scope, and accessibility scenarios.

### Modified files

- `app/features/layout/components/PageHeader.tsx` — adds the left navigation trigger and converts the mobile overflow, Settings, and Account surfaces to controlled mobile-overlay state while preserving desktop behavior.
- `app/features/layout/components/ChatShell.tsx` — renders the shared mobile backdrop and exposes the active surface to CSS and accessibility.
- `app/features/layout/components/ChatShell.css` — styles the mobile header, left drawer, right overlays, body locking, safe areas, reduced motion, full-height forms, and feature restriction hints.
- `app/features/chat/ChatPageClient.tsx` — composition-only wiring between the overlay controller and existing feature state; closes the drawer after selecting a Chat or File.
- `app/features/composer/components/ChatComposer.tsx` — adds an optional capability action slot, absent by default.
- `app/features/composer/components/ChatComposer.css` — keeps optional actions, target controls, and send/stop reachable at phone widths.
- `app/features/messages/components/MessageList.css` — constrains tables, images, long code, and message content to the mobile content width.
- `app/features/agents/components/AgentsPanel.tsx` — adds dialog semantics and mobile-friendly structural classes without duplicating Agent CRUD logic.
- `app/features/agents/hooks/useAgentPanelState.ts` — exposes mutation errors while preserving form values after failed Agent operations.
- `app/features/agents/components/AgentsPanel.css` — presents Agent create/edit/access/delete flows as safe-area-aware full-height mobile sheets.
- `app/features/nodes/components/NodesPanel.tsx` — accepts a mobile-restricted mode that retains status and refresh but hides complex configuration.
- `app/features/nodes/hooks/useNodePanelState.ts` — exposes Node load/refresh errors for an in-panel retry surface.
- `app/features/files/hooks/fileWorkspaceHookTypes.ts` — adds the typed file-preview error state.
- `app/features/files/hooks/useFileWorkspaceState.ts` — reports failed file previews without closing the mobile drawer.
- `app/features/files/components/FileWorkspacePanel.tsx` — renders the file-level error and retry context.
- `app/features/files/components/FileEditorPanel.tsx` — switches the existing viewer to a read-only mobile presentation while retaining comments.
- `app/features/scheduler/hooks/useSchedules.ts` — supports conditionally loading jobs only while the panel is open.
- `app/features/scheduler/components/SchedulesPanel.tsx` — adds explicit enable/disable and retry actions and hides create/edit controls in mobile-restricted mode.
- `tests/playwright.config.ts` — defines desktop Chromium, Android Chromium, and iPhone WebKit projects without tripling the entire suite.
- `tests/mobile-composer-viewport.spec.ts` — uses the shared mobile project matrix and updated navigation entry point.
- `tests/interaction-coverage.spec.ts` — updates the old mobile overflow assertion and protects desktop header behavior.
- `tests/agent-node-management.spec.ts` — adds mobile Agent CRUD layout coverage using the existing isolated backend.
- `.github/workflows/playwright.yml` — installs WebKit in addition to Chromium.

## Task 1: Add the Cross-Browser Mobile Test Matrix

**Files:**
- Create: `tests/helpers/mobileChatFixture.ts`
- Modify: `tests/playwright.config.ts`
- Modify: `.github/workflows/playwright.yml:56-57`
- Modify: `tests/mobile-composer-viewport.spec.ts`

- [ ] **Step 1: Create a deterministic shared mobile fixture**

Create `tests/helpers/mobileChatFixture.ts` with reusable login and route setup. Keep the fixture API small so feature-specific tests can inspect captured requests:

```ts
import { expect, type Page } from '@playwright/test';

export const TEST_AGENT = {
  id: 'alpha',
  name: 'Alpha Agent',
  command: 'mock',
  args: ['--acp'],
  cwd: '/tmp',
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
```

- [ ] **Step 2: Define focused Playwright projects**

Replace `tests/playwright.config.ts` with projects that run the full legacy suite only once and run mobile specs on both browser engines:

```ts
import { defineConfig, devices } from '@playwright/test';

const mobileSpecs = [
  '**/mobile-responsive.spec.ts',
  '**/mobile-composer-viewport.spec.ts',
];

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  timeout: 180_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010',
    headless: true,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      testIgnore: mobileSpecs,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'android-chromium',
      testMatch: mobileSpecs,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'iphone-webkit',
      testMatch: mobileSpecs,
      use: { ...devices['iPhone 14 Pro Max'] },
    },
  ],
});
```

Do not add every existing spec to both mobile projects; that would approximately triple CI duration without increasing relevant coverage.

- [ ] **Step 3: Let the existing viewport test use project device settings**

In `tests/mobile-composer-viewport.spec.ts`, remove the unconditional `page.setViewportSize({ width: 428, height: 926 })`. Derive the synthetic `visualViewport` width and initial height from `window.innerWidth` and `window.innerHeight` inside `addInitScript`, while retaining the explicit simulated keyboard height and offset assertions.

Use the new left-navigation accessible name in the final drawer step:

```ts
await page.getByRole('button', { name: 'Open navigation' }).click();
```

This selector intentionally fails until Task 2 implements the dedicated header control.

- [ ] **Step 4: Install both CI browser engines**

Change `.github/workflows/playwright.yml`:

```yaml
- name: Install Playwright browsers
  run: npx playwright install --with-deps chromium webkit
```

- [ ] **Step 5: Run the existing mobile test through both projects**

Run:

```bash
npx playwright test --config tests/playwright.config.ts \
  --project=android-chromium --project=iphone-webkit \
  tests/mobile-composer-viewport.spec.ts
```

Expected: both cases fail only at `Open navigation`; viewport and composer assertions before that point pass.

- [ ] **Step 6: Commit the test infrastructure with the navigation implementation in Task 2**

Do not commit a permanently red test alone. Keep these changes staged locally until Task 2 passes the new selector.

## Task 2: Implement Dedicated Mobile Navigation and Overlay Control

**Files:**
- Create: `app/features/layout/hooks/useMobileOverlayState.ts`
- Create: `tests/mobile-responsive.spec.ts`
- Modify: `app/features/layout/components/PageHeader.tsx`
- Modify: `app/features/layout/components/ChatShell.tsx`
- Modify: `app/features/layout/components/ChatShell.css:374-497,1118-1304`
- Modify: `app/features/chat/ChatPageClient.tsx:52,97-100,224,270-276`
- Modify: `tests/interaction-coverage.spec.ts`

- [ ] **Step 1: Write failing mobile header and mutual-exclusion tests**

Create `tests/mobile-responsive.spec.ts`:

```ts
import { expect, test, type Locator } from '@playwright/test';
import {
  installMobileChatFixture,
  loginMobileFixture,
  type MobileFixture,
} from './helpers/mobileChatFixture';

let fixture: MobileFixture;
test.beforeEach(async ({ page }) => {
  fixture = await installMobileChatFixture(page);
  await loginMobileFixture(page);
});

function settingsField(dialog: Locator, name: string): Locator {
  return dialog.locator('label')
    .filter({ hasText: new RegExp(`^${name}`) })
    .locator('input')
    .first();
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
```

Update the old `mobile header exposes primary panels through the overflow menu` test in `tests/interaction-coverage.spec.ts` so it expects no Chats item and opens Chats with `Open navigation`. Add a desktop assertion that the inline `Agents`, `Nodes`, `Schedules`, Theme, Settings, and account controls remain visible at 1440px.

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npx playwright test --config tests/playwright.config.ts \
  --project=android-chromium \
  tests/mobile-responsive.spec.ts tests/mobile-composer-viewport.spec.ts
```

Expected: FAIL because `Open navigation` and the revised five-item management menu do not exist.

- [ ] **Step 3: Add the typed mobile-overlay controller**

Create `app/features/layout/hooks/useMobileOverlayState.ts`:

```ts
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const MOBILE_LAYOUT_QUERY = '(max-width: 900px)';

export type MobileOverlay =
  | 'navigation'
  | 'more'
  | 'theme'
  | 'agents'
  | 'nodes'
  | 'schedules'
  | 'settings'
  | 'account'
  | null;

export function useMobileOverlayState() {
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const [activeOverlay, setActiveOverlay] = useState<MobileOverlay>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const historyEntryRef = useRef(false);

  const close = useCallback((fromHistory = false) => {
    setActiveOverlay(null);
    const trigger = triggerRef.current;
    triggerRef.current = null;
    queueMicrotask(() => trigger?.focus());
    if (historyEntryRef.current && !fromHistory) {
      historyEntryRef.current = false;
      window.history.back();
    }
  }, []);

  const open = useCallback((overlay: Exclude<MobileOverlay, null>, trigger?: HTMLElement) => {
    triggerRef.current = trigger ?? triggerRef.current;
    if (!historyEntryRef.current) {
      window.history.pushState({ agentsChatMobileOverlay: true }, '');
      historyEntryRef.current = true;
    }
    setActiveOverlay(overlay);
  }, []);

  const toggle = useCallback((overlay: Exclude<MobileOverlay, null>, trigger?: HTMLElement) => {
    if (activeOverlay === overlay) close();
    else open(overlay, trigger);
  }, [activeOverlay, close, open]);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const sync = () => {
      setIsMobileLayout(media.matches);
      if (!media.matches && activeOverlay !== null) close();
    };
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [activeOverlay, close]);

  useEffect(() => {
    if (!isMobileLayout || activeOverlay === null) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPopState = () => {
      historyEntryRef.current = false;
      close(true);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('popstate', onPopState);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('popstate', onPopState);
    };
  }, [activeOverlay, close, isMobileLayout]);

  return { activeOverlay, isMobileLayout, open, toggle, close };
}
```

During implementation, guard `history.back()` so an overlay opened immediately after a previous overlay reuses the same transient entry. The focused tests in Task 3 verify this behavior.

- [ ] **Step 4: Make `PageHeader` use controlled mobile surfaces**

Add these props to `PageHeaderProps`:

```ts
import type { MobileOverlay } from '../hooks/useMobileOverlayState';

mobileOverlay: MobileOverlay;
isMobileLayout: boolean;
onMobileOverlayOpen: (overlay: Exclude<MobileOverlay, null>, trigger?: HTMLElement) => void;
onMobileOverlayToggle: (overlay: Exclude<MobileOverlay, null>, trigger?: HTMLElement) => void;
onMobileOverlayClose: () => void;
```

Insert the dedicated trigger before the heading:

```tsx
<button
  type="button"
  className="ghostButton mobileNavigationButton"
  aria-label={mobileOverlay === 'navigation' ? 'Close navigation' : 'Open navigation'}
  aria-expanded={mobileOverlay === 'navigation'}
  onClick={(event) => onMobileOverlayToggle('navigation', event.currentTarget)}
>
  <span aria-hidden="true">☰</span>
</button>
```

On mobile, control the More menu with `mobileOverlay === 'more'`. Its top-level items must be exactly Theme, Agents, Nodes, Schedules, and Settings. Theme opens the controlled `theme` surface containing the existing theme radio choices. Settings opens the controlled `settings` surface containing the existing remembered-agent-scope radio choices. Each nested surface provides a Back button that calls `onMobileOverlayOpen('more')`. Selecting Agents, Nodes, or Schedules calls the corresponding existing callback and passes the selected surface and trigger element to `onMobileOverlayOpen`.

Keep the current desktop inline buttons and desktop Settings/account popovers. Opening the account control on mobile uses the controlled `account` surface and closes every other mobile surface.

- [ ] **Step 5: Wire one active surface through `ChatPageClient` and `ChatShell`**

Instantiate `useMobileOverlayState()` in `ChatPageClient`. Add focused callbacks rather than adding feature logic to JSX:

```ts
const mobile = useMobileOverlayState();

const closeFeaturePanels = useCallback(() => {
  setShowChatsPanel(false);
  setShowAgentsPanel(false);
  setShowNodesPanel(false);
  setShowSchedulesPanel(false);
}, [setShowAgentsPanel, setShowChatsPanel, setShowNodesPanel]);

const openMobileFeature = useCallback((
  overlay: 'navigation' | 'agents' | 'nodes' | 'schedules',
  trigger?: HTMLElement,
) => {
  closeFeaturePanels();
  if (overlay === 'navigation') setShowChatsPanel(true);
  if (overlay === 'agents') setShowAgentsPanel(true);
  if (overlay === 'nodes') {
    setShowNodesPanel(true);
    void loadNodes();
  }
  if (overlay === 'schedules') setShowSchedulesPanel(true);
  mobile.open(overlay, trigger);
}, [closeFeaturePanels, loadNodes, mobile, setShowAgentsPanel, setShowChatsPanel, setShowNodesPanel]);
```

When `mobile.activeOverlay` becomes `null`, close mobile feature panels. Preserve the existing desktop toggle callbacks when `mobile.isMobileLayout` is false.

Change `ChatShell` props from the old `'chat' | 'agents' | 'nodes' | 'schedules' | null` union to `MobileOverlay`, and render one backdrop:

```tsx
{isMobileLayout && mobileOverlay !== null ? (
  <button
    type="button"
    className="mobilePanelBackdrop"
    aria-label="Close active panel"
    onClick={onMobileOverlayClose}
  />
) : null}
```

Add `data-mobile-overlay={mobileOverlay ?? 'none'}` to `.page`.

- [ ] **Step 6: Apply mobile header, drawer, and reduced-motion CSS**

At `max-width: 900px`:

```css
.chatPageRoot .mobileNavigationButton {
  display: inline-flex;
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  align-items: center;
  justify-content: center;
}

.chatPageRoot .participantsSidebar,
.chatPageRoot .agentsSidebar {
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
}

.chatPageRoot .agentsSidebar {
  width: min(92vw, 420px);
}
```

Above 900px, `.mobileNavigationButton` is `display: none`. Keep the existing left/right transforms and `mobilePanelVisible` classes. Ensure the header logo truncates before either control is pushed off-screen.

Add:

```css
@media (prefers-reduced-motion: reduce) {
  .chatPageRoot .participantsSidebar,
  .chatPageRoot .agentsSidebar {
    transition: none;
  }
}
```

- [ ] **Step 7: Run both mobile engines and the desktop header regression**

Run:

```bash
npx playwright test --config tests/playwright.config.ts \
  --project=android-chromium --project=iphone-webkit \
  tests/mobile-responsive.spec.ts tests/mobile-composer-viewport.spec.ts
npx playwright test --config tests/playwright.config.ts \
  --project=desktop-chromium tests/interaction-coverage.spec.ts
```

Expected: PASS. The mobile overflow contains no Chats/Files item, and desktop inline controls are unchanged.

- [ ] **Step 8: Commit Tasks 1 and 2**

```bash
git add .github/workflows/playwright.yml \
  app/features/layout/hooks/useMobileOverlayState.ts \
  app/features/layout/components/PageHeader.tsx \
  app/features/layout/components/ChatShell.tsx \
  app/features/layout/components/ChatShell.css \
  app/features/chat/ChatPageClient.tsx \
  tests/helpers/mobileChatFixture.ts \
  tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  tests/mobile-composer-viewport.spec.ts \
  tests/interaction-coverage.spec.ts
git commit -m "feat: add responsive mobile navigation" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 3: Preserve State and Complete Accessible Drawer Behavior

**Files:**
- Modify: `tests/mobile-responsive.spec.ts`
- Modify: `app/features/layout/hooks/useMobileOverlayState.ts`
- Modify: `app/features/chat/ChatPageClient.tsx:118-133,188-205,224,273-275`
- Modify: `app/features/layout/components/ChatShell.tsx`
- Modify: `app/features/layout/components/ChatShell.css`
- Modify: `app/features/files/hooks/fileWorkspaceHookTypes.ts`
- Modify: `app/features/files/hooks/useFileWorkspaceState.ts:88-115`
- Modify: `app/features/files/components/FileWorkspacePanel.tsx`
- Modify: `app/features/files/components/FileEditorPanel.tsx`

- [ ] **Step 1: Add failing preservation, closure, and browser-back tests**

Append:

```ts
test('preserves composer state while opening and closing navigation', async ({ page }) => {
  const composer = page.locator('textarea.composerTextarea');
  await composer.fill('unsent mobile draft');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await page.getByRole('button', { name: 'Close active panel' }).click();
  await expect(composer).toHaveValue('unsent mobile draft');
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
});

test('closes the drawer after selecting a file and keeps the viewer in main content', async ({ page }) => {
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('tab', { name: 'Files' }).click();
  await page.getByRole('button', { name: 'README.md' }).click();
  await expect(page.locator('.participantsSidebar')).not.toHaveClass(/mobilePanelVisible/);
  await expect(page.locator('.mdEditorInline')).toBeVisible();
  await expect(page.getByTitle('Toggle comments')).toBeVisible();
  await expect(page.getByRole('button', { name: /Save/ })).toHaveCount(0);
  await expect(page.getByText('Use the desktop interface to edit files.')).toBeVisible();
  await expect(page.locator('textarea.composerTextarea')).toHaveCount(0);
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
  await expect(page).toHaveURL(/\/$/);
});
```

Extend the fixture with the exact endpoints already consumed by the Files feature:

```ts
await page.route('**/api/markdown**', async (route) => {
  const path = new URL(route.request().url()).searchParams.get('path');
  await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(path
      ? { content: '# Mobile file', mtime: 1 }
      : { files: ['README.md', 'broken.md'] }),
  });
});
await page.route('**/api/comments**', (route) =>
  route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, comments: [] }),
  }),
);
```

- [ ] **Step 2: Run the tests to verify failure**

Run:

```bash
npx playwright test --config tests/playwright.config.ts \
  --project=android-chromium tests/mobile-responsive.spec.ts
```

Expected: FAIL where File selection leaves the drawer open or browser-back/focus behavior is incomplete.

- [ ] **Step 3: Close navigation only after successful Chat/File selection**

Update `loadChat` in `ChatPageClient`:

```ts
async function loadChat(chatId: string) {
  if (chatId !== currentChatId) {
    setOpenChatMenuId(null);
    shouldStickToBottomRef.current = true;
    setShowScrollToBottom(false);
    await runtimeLoadChat(chatId);
    requestAnimationFrame(() => {
      const element = chatContainerRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }
  setOpenChatMenuId(null);
  if (mobile.isMobileLayout) mobile.close();
  else setShowChatsPanel(false);
}
```

Extend the existing `onFileOpened` callback:

```ts
onFileOpened: async ({ agentId, filePath, restoreScrollTop }) => {
  await fileCommentsControllerRef.current?.resetForFileOpen(agentId, filePath, restoreScrollTop);
  if (mobile.isMobileLayout) mobile.close();
},
```

Do not close before a file successfully loads; failed previews must leave navigation and user context intact.

- [ ] **Step 4: Expose file-preview errors without discarding context**

Add `mdFileError: string | null` to `UseFileWorkspaceStateResult`, initialize it in `useFileWorkspaceState`, and update `openMdFileForAgent`:

```ts
setMdFileError(null);
try {
  const response = await fetch(
    `/api/markdown?agentId=${encodeURIComponent(agentId)}&path=${encodeURIComponent(filePath)}`,
  );
  const data = await response.json();
  if (!response.ok || data.content === undefined) {
    throw new Error(data.error || `Unable to preview ${filePath}`);
  }
  // Keep the existing successful state updates and onFileOpened callback.
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  setMdFileError(message);
}
```

Render the error in the tree variant of `FileWorkspacePanel`:

```tsx
<>
  {props.workspace.mdFileError ? (
    <div className="fileWorkspaceError" role="alert">
      {props.workspace.mdFileError}
    </div>
  ) : null}
  <FileTreePanel
    workspace={props.workspace}
    agents={props.agents}
    schedulerAgentId={props.schedulerAgentId}
  />
</>
```

Clear the error after a successful open and when switching Agents.

- [ ] **Step 5: Make the mobile File surface view-first**

Add `mobileReadOnly: boolean` to the editor variant of `FileWorkspacePanelProps`, pass it to `FileEditorPanel`, and pass `mobile.isMobileLayout` from `ChatPageClient`:

```tsx
<FileWorkspacePanel
  workspace={fileWorkspace}
  comments={fileCommentsController}
  selection={fileCommentsController.selection}
  mobileReadOnly={mobile.isMobileLayout}
/>
```

In `FileEditorPanel`, when `mobileReadOnly` is true:

- Render the existing review/read-only file lines instead of Split or Live Edit textareas.
- Keep the Toggle comments and Close actions.
- Do not render Split, Live Edit, or Save.
- Render `<span className="mobileDesktopHint">Use the desktop interface to edit files.</span>`.

Do not change `mdEditContent`, `mdDirty`, or desktop editor mode when entering mobile view. This preserves unsaved desktop state if the viewport changes.

- [ ] **Step 6: Finish focus, history, scroll-lock, and dialog semantics**

In `useMobileOverlayState`, use one transient history entry for any sequence of active mobile surfaces. Closing from a backdrop or Escape consumes that entry; `popstate` only changes React state and never calls `history.back()` again.

In `ChatShell`, set `aria-hidden` on the inert chat content while a modal management surface is active. In PageHeader and panels:

- Navigation drawer: `aria-label="Chats and files navigation"`.
- Right feature panels: `role="dialog"`, `aria-modal="true"`, and an accessible label.
- Chats/Files controls: `role="tab"`, `aria-selected`, and a shared `role="tablist"`.

Preserve the existing Sidebar DOM while hidden so browser scroll positions remain intact.

- [ ] **Step 7: Run iPhone and Android state tests**

Run:

```bash
npx playwright test --config tests/playwright.config.ts \
  --project=android-chromium --project=iphone-webkit \
  tests/mobile-responsive.spec.ts
```

Expected: PASS on both projects, including Escape, browser back, focus restoration, Files, and draft preservation.

- [ ] **Step 8: Commit**

```bash
git add app/features/layout/hooks/useMobileOverlayState.ts \
  app/features/layout/components/ChatShell.tsx \
  app/features/layout/components/ChatShell.css \
  app/features/chat/ChatPageClient.tsx \
  app/features/files/hooks/fileWorkspaceHookTypes.ts \
  app/features/files/hooks/useFileWorkspaceState.ts \
  app/features/files/components/FileWorkspacePanel.tsx \
  app/features/files/components/FileEditorPanel.tsx \
  tests/helpers/mobileChatFixture.ts \
  tests/mobile-responsive.spec.ts
git commit -m "feat: preserve state across mobile panels" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 4: Harden Composer and Message Content for Phones

**Files:**
- Modify: `tests/mobile-responsive.spec.ts`
- Modify: `tests/mobile-composer-viewport.spec.ts`
- Modify: `app/features/composer/components/ChatComposer.tsx`
- Modify: `app/features/composer/components/ChatComposer.css:321-380,560-638`
- Modify: `app/features/messages/components/MessageList.css:150-185,511-525`
- Modify: `app/features/chat/ChatPageClient.tsx:275`

- [ ] **Step 1: Add failing capability and overflow assertions**

Append:

```ts
test('keeps wide message content inside the viewport and hides unavailable voice input', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Start voice input' })).toHaveCount(0);
  const message = page.locator('.message.user').first();
  await expect.poll(async () => {
    const [messageBox, viewport] = await Promise.all([
      message.boundingBox(),
      page.evaluate(() => ({ width: window.innerWidth })),
    ]);
    return messageBox !== null && messageBox.x + messageBox.width <= viewport.width;
  }).toBe(true);
});
```

Extend the mocked message content with a long unbroken string, a fenced code block, an image, and a wide Markdown table. Assert the `pre` and table wrapper have `scrollWidth >= clientWidth` while `.chatContainer` has no horizontal page overflow.

- [ ] **Step 2: Run to verify the wide-table assertion fails**

Run:

```bash
npx playwright test --config tests/playwright.config.ts \
  --project=iphone-webkit tests/mobile-responsive.spec.ts
```

Expected: FAIL if the wide table expands the message/page or if an optional-action slot is rendered without a capability.

- [ ] **Step 3: Add the optional composer action API**

Add to `ChatComposerProps`:

```ts
optionalActions?: ReactNode;
```

Destructure it and render it immediately after the attachment button:

```tsx
{optionalActions ? (
  <div className="composerOptionalActions">{optionalActions}</div>
) : null}
```

In `ChatPageClient`, omit the prop for now. Do not render a disabled microphone, placeholder, or “coming soon” control. A future voice capability can pass an accessible button through this stable slot and write transcription through the existing `setInputProgrammatic`.

- [ ] **Step 4: Constrain message content and composer controls**

Add:

```css
.chatPageRoot .markdownBody {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}

.chatPageRoot .markdownBody img {
  max-width: 100%;
  height: auto;
}

.chatPageRoot .markdownBody table {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.chatPageRoot .composerOptionalActions {
  display: inline-flex;
  flex: 0 0 auto;
}
```

At 560px, retain horizontal scrolling for `.targetPills`, keep `.composerToolbarActions` at `flex: 0 0 auto`, and ensure optional actions cannot force Send/Stop outside the visible composer.

- [ ] **Step 5: Run keyboard, orientation, and content tests on both engines**

Run:

```bash
npx playwright test --config tests/playwright.config.ts \
  --project=android-chromium --project=iphone-webkit \
  tests/mobile-responsive.spec.ts tests/mobile-composer-viewport.spec.ts
```

Expected: PASS. Composer controls remain inside the synthetic visual viewport and no microphone is present.

- [ ] **Step 6: Commit**

```bash
git add app/features/composer/components/ChatComposer.tsx \
  app/features/composer/components/ChatComposer.css \
  app/features/messages/components/MessageList.css \
  app/features/chat/ChatPageClient.tsx \
  tests/mobile-responsive.spec.ts \
  tests/mobile-composer-viewport.spec.ts
git commit -m "fix: harden mobile chat and composer layout" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 5: Make Complete Agent Management Usable on Mobile

**Files:**
- Modify: `tests/helpers/mobileChatFixture.ts`
- Modify: `tests/mobile-responsive.spec.ts`
- Modify: `app/features/agents/hooks/useAgentPanelState.ts`
- Modify: `app/features/agents/components/AgentsPanel.tsx`
- Modify: `app/features/agents/components/AgentsPanel.css`
- Modify: `app/features/layout/components/ChatShell.css:1235-1245`

- [ ] **Step 1: Add a mobile Agent CRUD scenario**

Use the ACP state map in `tests/helpers/mobileChatFixture.ts` to support `create-agent`, `get-agent-config`, `update-agent-config`, `delete-agent`, `list-agent-access`, `add-agent-access`, and `remove-agent-access`. Append this scenario to `tests/mobile-responsive.spec.ts` so the configured Android and iPhone projects both run it:

```ts
test('mobile Agent management keeps full CRUD and access controls reachable', async ({ page }) => {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Agents' }).click();
  const panel = page.locator('.agentsSidebar').filter({ hasText: 'Agents' });
  await panel.getByTitle('Add agent').click();
  await page.getByRole('button', { name: /Add Agent in Server/ }).click();

  const create = page.getByRole('dialog', { name: 'Add New Agent' });
  await expect(create).toBeVisible();
  await create.getByPlaceholder('unique-agent-id').fill('mobile-managed');
  await create.getByPlaceholder('My Agent').fill('Mobile Managed');
  await create.getByPlaceholder('copilot.exe').fill('mock-agent');
  await create.getByRole('button', { name: 'Create Agent' }).click();
  await expect(panel.getByText('Mobile Managed')).toBeVisible();

  await panel.getByText('Mobile Managed').click();
  const settings = page.getByRole('dialog', { name: /Mobile Managed settings/ });
  await settingsField(settings, 'Name').fill('Mobile Managed Updated');
  await settings.getByRole('checkbox', { name: /Public/ }).uncheck();
  await settings.getByPlaceholder('user@email.com').fill('mobile@example.com');
  await settings.getByRole('button', { name: 'Grant' }).click();
  await expect(settings.getByText('mobile@example.com', { exact: true })).toBeVisible();
  await settings.getByText('mobile@example.com', { exact: true })
    .locator('..').getByRole('button').click();
  await expect(settings.getByText('mobile@example.com', { exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Save' }).click();

  await panel.getByText('Mobile Managed Updated').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('dialog', { name: /Mobile Managed Updated settings/ })
    .getByRole('button', { name: 'Delete' }).click();
  expect(fixture.agents.has('mobile-managed')).toBe(false);
});

test('mobile Agent settings retains values and reports a failed save', async ({ page }) => {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Agents' }).click();
  await page.getByText('Alpha Agent', { exact: true }).click();
  const settings = page.getByRole('dialog', { name: /Alpha Agent settings/ });
  await settingsField(settings, 'Name').fill('Unsaved Mobile Name');
  fixture.failNextAgentUpdate();
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings.getByRole('alert')).toContainText('Agent update rejected');
  await expect(settingsField(settings, 'Name')).toHaveValue('Unsaved Mobile Name');
  await expect(settings).toBeVisible();
});
```

Also assert each Agent dialog fits within the current visual viewport and that Save, Cancel, and Delete are visible after focusing the environment textarea.

- [ ] **Step 2: Run the test to verify the mobile form failure**

Run:

```bash
npx playwright test --config tests/playwright.config.ts \
  --project=android-chromium \
  tests/mobile-responsive.spec.ts -g "mobile Agent management"
```

Expected: FAIL because the modal lacks dialog labels/full-height mobile structure or its actions are not reliably reachable.

- [ ] **Step 3: Add semantic Agent dialog structure**

In `useAgentPanelState`, replace the compatibility-only `formError: null` value with real state:

```ts
const [formError, setFormError] = useState<string | null>(null);

function mutationError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
```

Clear `formError` when opening a form and before each mutation. If an ACP response has `ok !== true`, throw with `data.error` or the concrete fallback for that operation listed below. In each catch, set `formError` and leave the corresponding create/settings modal and all entered values open. Clear it only after a successful operation or explicit Cancel. Return `formError` from the hook.

Use concrete fallback messages:

- `Failed to create agent`
- `Failed to create remote agent`
- `Failed to load agent settings`
- `Failed to update agent`
- `Failed to update agent access`
- `Failed to delete agent`

For each Agent modal, add `role`, `aria-modal`, an operation-specific `aria-label`, an `.agentSheetBody` wrapper around the current fields, an error alert, and the `.agentSheetActions` class on the current action row:

```tsx
<div
  className="modal agentSettingsModal agentMobileSheet"
  role="dialog"
  aria-modal="true"
  aria-label="Add New Agent"
>
```

Place this alert immediately before each existing modal action row:

```tsx
{formError ? <div className="agentFormError" role="alert">{formError}</div> : null}
```

Use distinct labels for Add New Agent, Add Agent from Remote Node, and `${settingsAgentConfig.name} settings`. Keep all existing state and request methods in `useAgentPanelState`; do not fork mobile CRUD logic.

- [ ] **Step 4: Add full-height, keyboard-safe Agent CSS**

At `max-width: 900px`:

```css
.chatPageRoot .agentMobileSheet {
  position: fixed;
  inset: var(--app-viewport-offset-top, 0) 0 auto 0;
  width: 100%;
  height: var(--app-viewport-height, 100dvh);
  max-height: none;
  border-radius: 0;
  padding:
    calc(14px + env(safe-area-inset-top))
    14px
    calc(14px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chatPageRoot .agentSheetBody {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.chatPageRoot .agentSheetActions {
  flex: 0 0 auto;
  position: sticky;
  bottom: 0;
  padding-top: 10px;
  background: var(--panel-strong);
}
```

Make text inputs and textareas at least 16px on mobile to prevent iOS focus zoom. Stack Access Control input and Grant action below 560px. Keep destructive Delete visually separated and at least 44px high.

- [ ] **Step 5: Run mobile CRUD and existing desktop management**

Run:

```bash
npx playwright test --config tests/playwright.config.ts \
  --project=desktop-chromium tests/agent-node-management.spec.ts
npx playwright test --config tests/playwright.config.ts \
  --project=android-chromium --project=iphone-webkit \
  tests/mobile-responsive.spec.ts -g "mobile Agent management"
```

Expected: PASS. Existing desktop CRUD remains unchanged and mobile forms fit the viewport.

- [ ] **Step 6: Commit**

```bash
git add app/features/agents/components/AgentsPanel.tsx \
  app/features/agents/hooks/useAgentPanelState.ts \
  app/features/agents/components/AgentsPanel.css \
  app/features/layout/components/ChatShell.css \
  tests/helpers/mobileChatFixture.ts \
  tests/mobile-responsive.spec.ts
git commit -m "feat: support Agent management on mobile" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 6: Restrict Nodes and Add Routine Schedule Controls

**Files:**
- Modify: `tests/mobile-responsive.spec.ts`
- Modify: `app/features/nodes/hooks/useNodePanelState.ts`
- Modify: `app/features/nodes/components/NodesPanel.tsx`
- Modify: `app/features/scheduler/hooks/useSchedules.ts`
- Modify: `app/features/scheduler/components/SchedulesPanel.tsx`
- Modify: `app/features/chat/ChatPageClient.tsx:276`
- Modify: `app/features/layout/components/ChatShell.css`

- [ ] **Step 1: Add failing Nodes and Schedules scope tests**

Append:

```ts
test('mobile Nodes exposes status and refresh but defers complex setup', async ({ page }) => {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Nodes' }).click();
  const nodes = page.getByRole('dialog', { name: 'Nodes' });
  await expect(nodes.getByText('Mobile Node')).toBeVisible();
  await expect(nodes.getByText('Online')).toBeVisible();
  await expect(nodes.getByTitle('Refresh all')).toBeVisible();
  await expect(nodes.getByTitle('Add node')).toHaveCount(0);
  await expect(nodes.getByText('Use the desktop interface to configure nodes.')).toBeVisible();
});

test('mobile Nodes reports load failure and retries in the panel', async ({ page }) => {
  let fail = true;
  await page.route('**/api/nodes', async (route) => {
    if (!fail) {
      await route.fallback();
      return;
    }
    fail = false;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'Nodes unavailable' }),
    });
  });
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Nodes' }).click();
  const panel = page.getByRole('dialog', { name: 'Nodes' });
  await expect(panel.getByRole('alert')).toContainText('Nodes unavailable');
  await panel.getByRole('button', { name: 'Retry' }).click();
  await expect(panel.getByText('Mobile Node')).toBeVisible();
});

test('mobile Schedules supports status, enablement, and run history without editing', async ({ page }) => {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Schedules' }).click();
  const schedules = page.getByRole('dialog', { name: 'Schedules' });
  await expect(schedules.getByText('Daily report')).toBeVisible();
  await expect(schedules.getByTitle('Create schedule')).toHaveCount(0);
  await schedules.getByRole('switch', { name: 'Enable Daily report' }).click();
  await expect.poll(() => fixture.scheduleRequests).toContainEqual(
    expect.objectContaining({
      method: 'PATCH',
      path: '/api/schedules/schedule-1',
      body: { enabled: true },
    }),
  );
  await schedules.getByTitle('View run history').click();
  await expect(page.getByRole('dialog', { name: /Daily report runs/ })).toBeVisible();
  await expect(schedules.getByText('Use the desktop interface to create or edit schedules.')).toBeVisible();
});
```

Add a mocked 500 response branch and assert an alert with a Retry button is rendered instead of an empty successful state.

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npx playwright test --config tests/playwright.config.ts \
  --project=android-chromium tests/mobile-responsive.spec.ts \
  -g "mobile Nodes|mobile Schedules"
```

Expected: FAIL because current mobile panels expose setup/edit controls and Schedules has no direct enable switch or panel retry.

- [ ] **Step 3: Add explicit mobile restriction props**

In `useNodePanelState`, make `nodesApi` throw on non-2xx or `{ ok: false }`, add `nodesError`, clear it before and after a successful `loadNodes`, and set it in the `loadNodes` catch:

```ts
async function nodesApi(body: Record<string, unknown>) {
  const response = await fetch('/api/nodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Nodes request failed (${response.status})`);
  }
  return data;
}
```

Return `nodesError` from the hook. In `NodesPanel`, render:

```tsx
{nodesError ? (
  <div className="panelError" role="alert">
    <span>{nodesError}</span>
    <button type="button" onClick={() => void loadNodes()}>Retry</button>
  </div>
) : null}
```

Change:

```ts
export interface NodesPanelProps {
  panelState: ReturnType<typeof useNodePanelState>;
  mobileRestricted: boolean;
}
```

When `mobileRestricted` is true:

- Keep list, online/offline state, row refresh, and Refresh all.
- Do not render Add node, rename, remove, or Add Agent on Node actions.
- Render a textual or screen-reader label of `Online` or `Offline` beside each status indicator so status is not color-only.
- Render `<p className="mobileDesktopHint">Use the desktop interface to configure nodes.</p>`.

Change `SchedulesPanelProps` similarly:

```ts
mobileRestricted: boolean;
```

When true, do not render Create Schedule and do not open `ScheduleEditor` from a row. Keep Run History and the new enable switch. Pass `mobile.isMobileLayout` from `ChatPageClient`.

- [ ] **Step 4: Reuse `useSchedules` for loading, retry, and enablement**

Change the hook signature:

```ts
export function useSchedules(enabled = true) {
  // existing state
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);
  // existing methods
}
```

In `SchedulesPanel`:

```ts
const { jobs, loading, error, refresh, update } = useSchedules(isOpen);
const [updatingJobId, setUpdatingJobId] = useState<string | null>(null);
const [actionError, setActionError] = useState<string | null>(null);

async function toggleEnabled(job: CronJob) {
  setUpdatingJobId(job.id);
  setActionError(null);
  try {
    await update(job.id, { enabled: !job.enabled });
  } catch (error) {
    setActionError(error instanceof Error ? error.message : String(error));
  } finally {
    setUpdatingJobId(null);
  }
}
```

Render failure explicitly:

```tsx
{error || actionError ? (
  <div className="panelError" role="alert">
    <span>{actionError || error}</span>
    <button type="button" onClick={() => void refresh()}>Retry</button>
  </div>
) : null}
```

Render each enable control with `role="switch"`, `aria-checked`, and an accessible name. Keep the current status dot as a visual supplement, not the only state indicator.

- [ ] **Step 5: Give Run History dialog semantics**

In `RunHistory.tsx`, set:

```tsx
<div
  className="modal agentSettingsModal"
  role="dialog"
  aria-modal="true"
  aria-label={`${job?.name || jobId} runs`}
>
```

Keep the existing run-now and error behavior. The agreed mobile scope includes run history and does not prohibit manually running an existing Schedule.

- [ ] **Step 6: Run mobile scope and desktop regression tests**

Run:

```bash
npx playwright test --config tests/playwright.config.ts \
  --project=android-chromium --project=iphone-webkit \
  tests/mobile-responsive.spec.ts
npx playwright test --config tests/playwright.config.ts \
  --project=desktop-chromium \
  tests/agent-node-management.spec.ts tests/test-schedules.spec.ts
```

Expected: PASS. Desktop keeps Node and Schedule creation/editing; mobile exposes only the agreed routine controls.

- [ ] **Step 7: Commit**

```bash
git add app/features/nodes/components/NodesPanel.tsx \
  app/features/nodes/hooks/useNodePanelState.ts \
  app/features/scheduler/hooks/useSchedules.ts \
  app/features/scheduler/components/SchedulesPanel.tsx \
  app/features/scheduler/components/RunHistory.tsx \
  app/features/chat/ChatPageClient.tsx \
  app/features/layout/components/ChatShell.css \
  tests/mobile-responsive.spec.ts
git commit -m "feat: add mobile operations for nodes and schedules" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 7: Complete Cross-Platform Regression and Build Validation

**Files:**
- Modify only if validation exposes a defect tightly coupled to this feature.

- [ ] **Step 1: Run the dedicated mobile suite on Android Chromium**

Run:

```bash
npx playwright test --config tests/playwright.config.ts \
  --project=android-chromium \
  tests/mobile-responsive.spec.ts tests/mobile-composer-viewport.spec.ts
```

Expected: all tests PASS.

- [ ] **Step 2: Run the dedicated mobile suite on iPhone WebKit**

Run:

```bash
npx playwright test --config tests/playwright.config.ts \
  --project=iphone-webkit \
  tests/mobile-responsive.spec.ts tests/mobile-composer-viewport.spec.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Run focused desktop feature regressions**

Run:

```bash
npx playwright test --config tests/playwright.config.ts \
  --project=desktop-chromium \
  tests/interaction-coverage.spec.ts \
  tests/agent-node-management.spec.ts \
  tests/test-schedules.spec.ts \
  tests/test-file-comments.spec.ts
```

Expected: all tests PASS and desktop controls retain their existing behavior.

- [ ] **Step 4: Run the complete Playwright project matrix**

Run:

```bash
npx playwright test --config tests/playwright.config.ts
```

Expected: the legacy suite passes once under desktop Chromium, and mobile specs pass under Android Chromium and iPhone WebKit.

- [ ] **Step 5: Run the production build**

Run:

```bash
npm run build
```

Expected: Next.js production build and TypeScript checking complete successfully.

- [ ] **Step 6: Inspect the final diff**

Run:

```bash
git --no-pager diff --check
git status --short
```

Expected: no whitespace errors; only files listed in this plan or tightly coupled fixes are modified. No `.data`, Playwright artifacts, screenshots, or `.superpowers/brainstorm` files are staged.

- [ ] **Step 7: Resolve any tightly coupled validation failure in its owning task**

If a validation failure appears, return to the task that owns that file, add a focused regression assertion, implement the correction, rerun that task's exact command, and create a new `fix: resolve mobile responsive regression` commit containing only the files from that task. If all validation commands pass without changes, do not create an empty commit.
