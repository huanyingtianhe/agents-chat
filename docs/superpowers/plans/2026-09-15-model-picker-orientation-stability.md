# Model Picker and Mobile Orientation Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure only the Model picker that the user clicked opens, synchronize its selected value across surfaces, and prevent repeated mobile orientation changes from automatically enlarging the page without disabling pinch zoom.

**Architecture:** Give every model menu a surface-scoped identity while retaining the existing shared per-agent model registry. Add CSS-only mobile zoom safeguards at the application root, leaving visual viewport synchronization and viewport metadata responsible only for layout fitting.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, feature-local React components, global responsive CSS, Playwright desktop Chromium, Android Chromium, and iPhone WebKit.

---

### Task 1: Add Failing Model Picker Isolation Coverage

**Files:**
- Modify: `tests/agent-composer-default-model.spec.ts:44-146`

- [ ] **Step 1: Arrange a chat scoped to Alpha Agent**

In `composer model picker saves the selected model as a user preference`, after
`resetChats(page)`, select Alpha Agent through the existing chat filter before
creating the chat:

```ts
  await resetChats(page);
  await page.getByRole('button', { name: 'Filter chats by primary agent' }).click();
  await page.getByRole('listbox', { name: 'Filter chats by primary agent' })
    .getByRole('option', { name: 'Alpha Agent', exact: true })
    .click();
  await ensureActiveChat(page);
  await page.waitForTimeout(500);

  const textarea = page.locator('textarea.composerTextarea');
  await textarea.fill('use pane-selected model');
```

This guarantees both the Composer and Agents pane render a Model control for
the same agent.

- [ ] **Step 2: Replace the Composer-only selection assertions with pane isolation assertions**

Open the Agents pane and use surface-scoped locators:

```ts
  const composerModel = page.locator('.chatInputDock')
    .getByRole('button', { name: 'Model for alpha' });
  await expect(composerModel.locator('.agentModelSelectLabel'))
    .toHaveText('Claude Sonnet 4.6');

  await page.locator('button[title="Agents"]').click();
  const paneModel = page.locator('.agentsSidebar')
    .getByRole('button', { name: 'Model for alpha' });
  await expect(paneModel).toBeVisible();
  await paneModel.click();

  const modelMenus = page.getByRole('listbox', { name: 'Model for alpha' });
  await expect(modelMenus).toHaveCount(1);
  await expect(paneModel).toHaveAttribute('aria-expanded', 'true');
  await expect(composerModel).toHaveAttribute('aria-expanded', 'false');
```

Then select the model from the one visible pane menu and verify shared value
synchronization:

```ts
  await modelMenus.getByRole('option', { name: 'GPT-5.2', exact: true }).click();
  await expect(modelMenus).toHaveCount(0);
  await expect(paneModel.locator('.agentModelSelectLabel')).toHaveText('GPT-5.2');
  await expect(composerModel.locator('.agentModelSelectLabel')).toHaveText('GPT-5.2');
  await expect.poll(() =>
    modelPrefRequests.map((request) => `${request.agentId}:${request.modelId}`)
  ).toEqual(['alpha:gpt-5.2']);
```

Keep the existing settings-dialog assertions, send the message, and retain:

```ts
  await expect.poll(() =>
    sent.map((request) => `${request.agentId}:${request.modelId}`)
  ).toEqual(['alpha:gpt-5.2']);
```

- [ ] **Step 3: Verify Escape and outside-click still close the pane menu**

Before selecting GPT-5.2, add two close/reopen checks:

```ts
  await page.keyboard.press('Escape');
  await expect(modelMenus).toHaveCount(0);
  await expect(paneModel).toHaveAttribute('aria-expanded', 'false');

  await paneModel.click();
  await expect(modelMenus).toHaveCount(1);
  await page.locator('.agentsSidebarHeader').click();
  await expect(modelMenus).toHaveCount(0);

  await paneModel.click();
  await expect(modelMenus).toHaveCount(1);
```

- [ ] **Step 4: Run the desktop test and verify the duplicate-menu failure**

Start the temporary server:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 NEXTAUTH_URL=http://localhost:3011 \
  npm run dev -- --port 3011
```

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/agent-composer-default-model.spec.ts \
  --project=desktop-chromium
```

Expected: FAIL at `toHaveCount(1)` because both same-agent
`AgentModelSelect` instances currently portal a listbox.

- [ ] **Step 5: Commit the failing regression test**

```bash
git add tests/agent-composer-default-model.spec.ts
git commit -m "test: cover model picker surface isolation" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Scope Model Menus by Surface

**Files:**
- Create: `app/features/agents/agentModelMenuHelpers.ts`
- Modify: `app/features/agents/hooks/useAgentPanelState.ts:53-58,328-359,420-431`
- Modify: `app/features/agents/components/AgentsPanel.tsx:1-10,80-95,181-203`
- Modify: `app/features/composer/components/ComposerTargetControls.tsx:1-46`
- Modify: `app/features/chat/ChatPageClient.tsx:314`
- Test: `tests/agent-composer-default-model.spec.ts`

- [ ] **Step 1: Add a typed menu identity helper**

Create `app/features/agents/agentModelMenuHelpers.ts`:

```ts
export type AgentModelMenuSurface = 'composer' | 'panel';

export function getAgentModelMenuKey(
  surface: AgentModelMenuSurface,
  agentId: string,
): string {
  return `${surface}:${agentId}`;
}
```

- [ ] **Step 2: Rename the shared open state to reflect scoped keys**

In `useAgentPanelState.ts`, replace:

```ts
  const [openModelMenuAgentId, setOpenModelMenuAgentId] = useState<string | null>(null);
```

with:

```ts
  const [openModelMenuKey, setOpenModelMenuKey] = useState<string | null>(null);
```

Rename all state references in that hook:

```ts
  function openModelSettings(menuKey: string) { setOpenModelMenuKey(menuKey); }
  function closeModelSettings() { setOpenModelMenuKey(null); }
```

The outside-click/Escape effect must use the scoped key:

```ts
  useEffect(() => {
    const anyOpen = openModelMenuKey || showAgentSettings || showAddAgent || showAddRemoteAgent || showAgentAddMenu;
    if (!anyOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (!openModelMenuKey) return;
      const wrap = modelMenuRefs.current.get(openModelMenuKey);
      if (wrap && !wrap.contains(event.target as Node)) {
        setOpenModelMenuKey(null);
      }
    }
    function handleKey(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (openModelMenuKey) { event.stopImmediatePropagation(); setOpenModelMenuKey(null); return; }
      if (showAgentSettings) { event.stopImmediatePropagation(); closeAgentSettings(); return; }
      if (showAddAgent) { event.stopImmediatePropagation(); closeAddAgent(); return; }
      if (showAddRemoteAgent) { event.stopImmediatePropagation(); closeAddRemoteAgent(); return; }
      if (showAgentAddMenu) { event.stopImmediatePropagation(); setShowAgentAddMenu(false); return; }
    }
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKey, { capture: true });
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKey, { capture: true });
    };
  }, [openModelMenuKey, showAgentSettings, showAddAgent, showAddRemoteAgent, showAgentAddMenu]);
```

Return `openModelMenuKey` and `setOpenModelMenuKey` instead of the old names.
Keep `modelMenuRefs` as the one map used by the effect.

- [ ] **Step 3: Give the Agents pane picker a panel-scoped identity**

Import the helper in `AgentsPanel.tsx`:

```ts
import { getAgentModelMenuKey } from '../agentModelMenuHelpers';
```

Destructure the renamed state:

```ts
    openModelMenuKey,
    setOpenModelMenuKey,
    modelMenuRefs,
```

In the `selectedAgentFilter` block, derive and use the pane key:

```tsx
            const menuKey = getAgentModelMenuKey('panel', activeAgent!.id);
            return (
              <div className="agentSidebarModelRow">
                <span className="agentSidebarModelLabel">Model</span>
                <AgentModelSelect
                  agentId={activeAgent!.id}
                  models={models}
                  selectedModelId={selectedAgentModels[activeAgent!.id] || ''}
                  isOpen={openModelMenuKey === menuKey}
                  onToggle={() => setOpenModelMenuKey((current) => (
                    current === menuKey ? null : menuKey
                  ))}
                  onSelectModel={(modelId) => {
                    setSelectedModelForAgent(activeAgent!.id, modelId);
                    setOpenModelMenuKey(null);
                  }}
                  wrapRef={(element) => modelMenuRefs.current.set(menuKey, element)}
                  isEnsuring={ensuringAgentModels[activeAgent!.id]}
                />
              </div>
            );
```

- [ ] **Step 4: Give every Composer picker a composer-scoped identity**

Import the helper in `ComposerTargetControls.tsx`:

```ts
import { getAgentModelMenuKey } from '../../agents/agentModelMenuHelpers';
```

Rename the props and destructured values to:

```ts
  openModelMenuKey: string | null;
  setOpenModelMenuKey: Dispatch<SetStateAction<string | null>>;
```

Replace `modelSelect` with:

```tsx
  const modelSelect = (agentId: string) => {
    const menuKey = getAgentModelMenuKey('composer', agentId);
    return (
      <AgentModelSelect
        agentId={agentId}
        models={getAgentModels(agentId)}
        selectedModelId={getSelectedModelIdForAgent(agentId)}
        isOpen={openModelMenuKey === menuKey}
        onToggle={() => setOpenModelMenuKey((current) => (
          current === menuKey ? null : menuKey
        ))}
        onSelectModel={(modelId) => {
          setSelectedModelForAgent(agentId, modelId);
          setOpenModelMenuKey(null);
        }}
        wrapRef={(element) => modelMenuRefs.current.set(menuKey, element)}
      />
    );
  };
```

- [ ] **Step 5: Wire the renamed controlled state through the composition shell**

In the `ComposerTargetControls` call in `ChatPageClient.tsx`, replace the two
old props with:

```tsx
openModelMenuKey={agentPanelState.openModelMenuKey}
setOpenModelMenuKey={agentPanelState.setOpenModelMenuKey}
```

Do not add local state or behavior to `ChatPageClient`.

- [ ] **Step 6: Run the targeted desktop regression test**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/agent-composer-default-model.spec.ts \
  --project=desktop-chromium
```

Expected: PASS. Exactly one pane listbox opens, both labels synchronize, and
the sent request contains `modelId: "gpt-5.2"`.

- [ ] **Step 7: Run related model tests**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/agent-composer-default-model.spec.ts \
  tests/agent-composer-ensure-models.spec.ts \
  tests/agent-model-selection-video.spec.ts \
  --project=desktop-chromium
```

Expected: 3 tests pass.

- [ ] **Step 8: Commit the scoped identity implementation**

```bash
git add \
  app/features/agents/agentModelMenuHelpers.ts \
  app/features/agents/hooks/useAgentPanelState.ts \
  app/features/agents/components/AgentsPanel.tsx \
  app/features/composer/components/ComposerTargetControls.tsx \
  app/features/chat/ChatPageClient.tsx
git commit -m "fix: isolate model pickers by surface" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Add Failing Mobile Auto-Zoom Coverage

**Files:**
- Modify: `tests/mobile-responsive.spec.ts:178-204`

- [ ] **Step 1: Add repeated orientation coverage**

Add this test after `keeps navigation, composer, and overlays usable in
landscape`:

```ts
test('prevents automatic zoom across repeated orientation changes', async ({ page }) => {
  const textarea = page.locator('textarea.composerTextarea');
  await textarea.fill('orientation-safe draft');
  await textarea.focus();

  const viewportContent = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewportContent).not.toMatch(/maximum-scale=1|user-scalable=no/);
  await expect(page.locator('.chatPageRoot')).toHaveCSS('-webkit-text-size-adjust', '100%');
  await expect.poll(() => textarea.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize)
  )).toBeGreaterThanOrEqual(16);

  await page.getByRole('button', { name: 'Open navigation' }).click();
  const navigation = page.getByRole('dialog', { name: 'Chats and files navigation' });

  for (const viewport of [
    { width: 844, height: 390 },
    { width: 430, height: 760 },
    { width: 844, height: 390 },
    { width: 430, height: 760 },
  ]) {
    await page.setViewportSize(viewport);
    await setTestVisualViewport(page, viewport.height, 0);
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));

    await expect(navigation).toBeVisible();
    await expect.poll(() => page.locator('.chatPageRoot .page').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    })).toEqual({ left: 0, top: 0, width: viewport.width, height: viewport.height });
  }

  await page.getByRole('button', { name: 'Close navigation' }).click();
  await expect(textarea).toHaveValue('orientation-safe draft');
});
```

- [ ] **Step 2: Verify all currently rendered editable controls meet the iOS threshold**

Before opening navigation, add:

```ts
  await expect.poll(() => page.locator(
    '.chatPageRoot input:visible, .chatPageRoot textarea:visible, .chatPageRoot select:visible',
  ).evaluateAll((elements) =>
    elements.every((element) => Number.parseFloat(getComputedStyle(element).fontSize) >= 16)
  )).toBe(true);
```

- [ ] **Step 3: Run Android and iPhone tests and verify the CSS failure**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=android-chromium \
  -g "prevents automatic zoom"
```

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=iphone-webkit \
  -g "prevents automatic zoom"
```

Expected: both fail because the root text adjustment is `auto` and the
Composer font size is 15px.

- [ ] **Step 4: Commit the failing orientation regression test**

```bash
git add tests/mobile-responsive.spec.ts
git commit -m "test: cover repeated mobile orientation changes" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Prevent Mobile Automatic Zoom Without Disabling Pinch Zoom

**Files:**
- Modify: `app/globals.css:1-45`
- Test: `tests/mobile-responsive.spec.ts`

- [ ] **Step 1: Stabilize text sizing on the application root**

Add after the global `*` rule in `app/globals.css`:

```css
.chatPageRoot {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
```

- [ ] **Step 2: Enforce the iOS editable-control threshold only on mobile**

Add:

```css
@media (max-width: 900px) {
  .chatPageRoot input,
  .chatPageRoot textarea,
  .chatPageRoot select {
    font-size: 16px !important;
  }
}
```

The `!important` is intentional: form rules are spread across several feature
stylesheets with higher specificity. This one mobile safety invariant must win
without duplicating overrides throughout every feature. Do not apply it to
buttons or static content.

- [ ] **Step 3: Run the targeted Android and iPhone tests**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=android-chromium \
  -g "prevents automatic zoom"
```

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=iphone-webkit \
  -g "prevents automatic zoom"
```

Expected: both pass across two portrait/landscape cycles. The meta viewport
still lacks scale-disabling directives.

- [ ] **Step 4: Run the existing mobile viewport test**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-composer-viewport.spec.ts
```

Expected: the Android and iPhone projects pass, including visual viewport
height/offset fitting and model dropdown placement.

- [ ] **Step 5: Commit the mobile zoom safeguard**

```bash
git add app/globals.css
git commit -m "fix: prevent mobile orientation auto-zoom" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Full Validation and Production Deployment

**Files:**
- Verify: `app/features/agents/agentModelMenuHelpers.ts`
- Verify: `app/features/agents/hooks/useAgentPanelState.ts`
- Verify: `app/features/agents/components/AgentsPanel.tsx`
- Verify: `app/features/composer/components/ComposerTargetControls.tsx`
- Verify: `app/globals.css`
- Verify: `tests/agent-composer-default-model.spec.ts`
- Verify: `tests/mobile-responsive.spec.ts`

- [ ] **Step 1: Run TypeScript and diff validation**

```bash
npx tsc --noEmit
git diff --check
```

Expected: both commands exit 0.

- [ ] **Step 2: Run the complete Android mobile suite**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts tests/mobile-composer-viewport.spec.ts \
  --project=android-chromium
```

Expected: all Android tests pass.

- [ ] **Step 3: Run the complete iPhone mobile suite**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts tests/mobile-composer-viewport.spec.ts \
  --project=iphone-webkit
```

Expected: all iPhone tests pass.

- [ ] **Step 4: Restore generated Next.js type reference if needed**

If development changed `next-env.d.ts` to:

```ts
import "./.next/dev/types/routes.d.ts";
```

restore it to:

```ts
import "./.next/types/routes.d.ts";
```

Do not commit a generated `next-env.d.ts` change.

- [ ] **Step 5: Stop the temporary development server**

Stop the specific 3011 process started in Task 1. Do not use `pkill` or
`killall`.

- [ ] **Step 6: Stop production before rebuilding `.next`**

Ask the user to run:

```bash
sudo systemctl stop agents-chat.service
```

Confirm:

```bash
systemctl is-active agents-chat.service
```

Expected: `inactive`.

- [ ] **Step 7: Build production**

```bash
npm run build
```

Expected: Next.js production build and TypeScript checks succeed. Existing NFT
trace and middleware deprecation warnings may remain, but no errors are
allowed.

- [ ] **Step 8: Restart and verify production**

Ask the user to run:

```bash
sudo systemctl start agents-chat.service
```

Verify:

```bash
systemctl is-active agents-chat.service
systemctl show agents-chat.service --property=MainPID,User --no-pager
curl --silent --show-error --output /dev/null \
  --write-out 'HTTP %{http_code}\n' http://localhost:3010/login
```

Expected:

```text
active
User=xujx
HTTP 200
```

- [ ] **Step 9: Verify the final worktree**

```bash
git status --short
git log -6 --oneline
```

Expected: no tracked changes remain. The pre-existing untracked
`.agents-chat-storage.json` remains uncommitted.
