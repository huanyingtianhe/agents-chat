# Chat Selection Loading UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mobile Chat selection close navigation immediately and give both mobile and desktop an unambiguous, non-interactive loading state with deterministic latest-selection-wins behavior.

**Architecture:** Add a focused selection-transition hook that owns loading identity and a monotonically increasing token. Pass an `isCurrentSelection` guard into the persistence service so superseded async loads cannot commit UI state, and replace the central messages-plus-Composer region with an accessible loading view while the latest selection is pending.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, existing feature CSS, Playwright E2E, `tsx` assertion tests.

---

### Task 1: Add the Chat Selection Transition State Machine

**Files:**
- Create: `app/features/chat/hooks/chatSelectionTransitionHelpers.ts`
- Create: `app/features/chat/hooks/useChatSelectionTransition.ts`
- Create: `tests/chat-selection-transition.test.ts`

- [ ] **Step 1: Write the failing transition helper test**

Create `tests/chat-selection-transition.test.ts`:

```ts
import assert from 'node:assert/strict';
import { createChatSelectionToken } from '../app/features/chat/hooks/chatSelectionTransitionHelpers';

const sequence = { current: 0 };
const first = createChatSelectionToken(sequence, 'chat-a');
assert.equal(first.chatId, 'chat-a');
assert.equal(first.isCurrent(), true);

const second = createChatSelectionToken(sequence, 'chat-b');
assert.equal(first.isCurrent(), false);
assert.equal(second.isCurrent(), true);

second.invalidate();
assert.equal(second.isCurrent(), false);

console.log('chat selection transition tests passed');
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npx tsx tests/chat-selection-transition.test.ts
```

Expected: FAIL because `chatSelectionTransitionHelpers` does not exist.

- [ ] **Step 3: Implement the pure token helper**

Create `app/features/chat/hooks/chatSelectionTransitionHelpers.ts`:

```ts
import type { MutableRefObject } from 'react';

export type ChatSelectionToken = {
  chatId: string;
  isCurrent: () => boolean;
  invalidate: () => void;
};

export function createChatSelectionToken(
  sequenceRef: Pick<MutableRefObject<number>, 'current'>,
  chatId: string,
): ChatSelectionToken {
  const sequence = ++sequenceRef.current;
  return {
    chatId,
    isCurrent: () => sequenceRef.current === sequence,
    invalidate: () => {
      if (sequenceRef.current === sequence) sequenceRef.current++;
    },
  };
}
```

- [ ] **Step 4: Implement the React transition hook**

Create `app/features/chat/hooks/useChatSelectionTransition.ts`:

```ts
'use client';

import { useCallback, useRef, useState } from 'react';
import {
  createChatSelectionToken,
  type ChatSelectionToken,
} from './chatSelectionTransitionHelpers';

export type LoadingChatSelection = {
  chatId: string;
  chatName: string;
};

export function useChatSelectionTransition() {
  const sequenceRef = useRef(0);
  const [loadingSelection, setLoadingSelection] = useState<LoadingChatSelection | null>(null);

  const begin = useCallback((chatId: string, chatName: string) => {
    const token = createChatSelectionToken(sequenceRef, chatId);
    setLoadingSelection({ chatId, chatName });
    return token;
  }, []);

  const finish = useCallback((token: ChatSelectionToken) => {
    if (!token.isCurrent()) return false;
    setLoadingSelection(null);
    return true;
  }, []);

  return { loadingSelection, begin, finish };
}
```

- [ ] **Step 5: Run the helper test and TypeScript**

Run:

```bash
npx tsx tests/chat-selection-transition.test.ts
npx tsc --noEmit
```

Expected: both commands PASS.

- [ ] **Step 6: Commit the state machine**

```bash
git add app/features/chat/hooks/chatSelectionTransitionHelpers.ts \
  app/features/chat/hooks/useChatSelectionTransition.ts \
  tests/chat-selection-transition.test.ts
git commit -m "feat: add chat selection transition state"
```

Include the required `Co-authored-by` trailer.

### Task 2: Make Chat Loading Latest-Selection-Wins

**Files:**
- Modify: `app/features/chat/runtime/chatPersistenceService.ts:5-36,146-272`
- Modify: `app/features/chat/runtime/useChatRuntime.ts:264-274`
- Modify: `app/features/chat/runtime/chatRuntimeTypes.ts:29-35`
- Create: `tests/chat-selection-load-guard.test.ts`

- [ ] **Step 1: Write a failing source contract test for guarded commits**

Create `tests/chat-selection-load-guard.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../app/features/chat/runtime/chatPersistenceService.ts', import.meta.url),
  'utf8',
);

assert.match(source, /export type LoadChatResult = 'loaded' \| 'failed' \| 'superseded'/);
assert.match(source, /isCurrentSelection: \(\) => boolean/);
assert.match(source, /if \(!isCurrentSelection\(\)\) return 'superseded'/);

console.log('chat selection load guard tests passed');
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run:

```bash
npx tsx tests/chat-selection-load-guard.test.ts
```

Expected: FAIL because `LoadChatResult` and `isCurrentSelection` are absent.

- [ ] **Step 3: Add the explicit load result and guard signature**

In `app/features/chat/runtime/chatPersistenceService.ts`, add:

```ts
export type LoadChatResult = 'loaded' | 'failed' | 'superseded';
```

Change the function signature to:

```ts
async function loadChat(
  chatId: string,
  isCurrentSelection: () => boolean = () => true,
): Promise<LoadChatResult> {
```

Keep the current-chat early return explicit:

```ts
if (chatId === currentChatId) return 'loaded';
```

- [ ] **Step 4: Guard every post-await selection commit**

After `saveCurrentChatToHistory(true)`, after the Chat fetch/JSON read, after
`prepareResume`, and after session resume, add:

```ts
if (!isCurrentSelection()) return 'superseded';
```

Before every target-specific state group, check the guard. On fetch or parsing
failure, only report the error if the selection is still current:

```ts
if (!isCurrentSelection()) return 'superseded';
ctx.addMessage({
  type: 'system',
  content: `Failed to load chat: ${data.error || 'not found'}`,
});
ctx.setActiveSidebarChatId(currentChatId);
return 'failed';
```

At the successful end return:

```ts
return isCurrentSelection() ? 'loaded' : 'superseded';
```

Do not remove session resume, stale pending reconciliation, workflow
preparation/finalization, input-history backfill, or scroll-related state.

- [ ] **Step 5: Thread the guard through the runtime boundary**

In `app/features/chat/runtime/useChatRuntime.ts`, replace `wrappedLoadChat` with:

```ts
const wrappedLoadChat = (
  chatId: string,
  isCurrentSelection?: () => boolean,
) => persistHandlers.loadChat(chatId, isCurrentSelection);
```

Update the runtime interface to expose:

```ts
loadChat: (
  chatId: string,
  isCurrentSelection?: () => boolean,
) => Promise<LoadChatResult>;
```

Import `LoadChatResult` with `import type` from `chatPersistenceService`.

- [ ] **Step 6: Run contract and type checks**

Run:

```bash
npx tsx tests/chat-selection-load-guard.test.ts
npx tsc --noEmit
```

Expected: both commands PASS.

- [ ] **Step 7: Commit guarded loading**

```bash
git add app/features/chat/runtime/chatPersistenceService.ts \
  app/features/chat/runtime/useChatRuntime.ts \
  app/features/chat/runtime/chatRuntimeTypes.ts \
  tests/chat-selection-load-guard.test.ts
git commit -m "fix: make chat selection latest-wins"
```

Include the required `Co-authored-by` trailer.

### Task 3: Add the Shared Loading View and Immediate Mobile Close

**Files:**
- Create: `app/features/chat/components/ChatLoadingView.tsx`
- Create: `app/features/chat/components/ChatLoadingView.css`
- Modify: `app/features/chat/ChatPageClient.tsx:1-25,136-151,245-255,297-303`
- Modify: `tests/mobile-responsive.spec.ts:256-284`
- Create: `tests/chat-selection-loading.spec.ts`
- Modify: `tests/playwright.config.ts:3-6`

- [ ] **Step 1: Update the mobile test to hold loading and require immediate close**

Replace the existing delayed-close tests in `tests/mobile-responsive.spec.ts`
with a held Chat response:

```ts
test('closes navigation immediately and masks chat while selection loads', async ({ page }) => {
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });

  await page.route('**/api/chats?id=second-mobile-chat', async (route) => {
    await loadGate;
    await route.fallback();
  });

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Second mobile chat' }).click();

  await expect(page.locator('.participantsSidebar')).not.toHaveClass(/mobilePanelVisible/);
  await expect(page.getByRole('status', { name: 'Loading Second mobile chat' })).toBeVisible();
  await expect(page.locator('textarea.composerTextarea')).toHaveCount(0);
  await expect(page.getByText('First chat message')).toHaveCount(0);

  releaseLoad();
  await expect(page.getByText('Second chat message')).toBeVisible();
  await expect(page.locator('.chatContainer')).toBeFocused();
  await expect(page.locator('textarea.composerTextarea')).not.toBeFocused();
});
```

Update the failed-selection test to expect the navigation to close immediately,
the loading view to disappear, and the previous Chat to return with the existing
error message.

- [ ] **Step 2: Add desktop masking and latest-wins Playwright tests**

Create `tests/chat-selection-loading.spec.ts` using the repository's existing
admin login and in-memory `/api/chats` route patterns. Seed three Chats named
`First loading chat`, `Slow loading chat`, and `Latest loading chat`.

The desktop masking test must:

```ts
await slowChatRow.click();
await expect(page.getByRole('status', { name: 'Loading Slow loading chat' })).toBeVisible();
await expect(page.getByText('First chat body')).toHaveCount(0);
await expect(page.locator('textarea.composerTextarea')).toHaveCount(0);
releaseSlowChat();
await expect(page.getByText('Slow chat body')).toBeVisible();
```

The latest-wins test must hold both target GET requests, select slow then latest,
release latest first, and release slow last:

```ts
await slowChatRow.click();
await latestChatRow.click();
releaseLatestChat();
await expect(page.getByText('Latest chat body')).toBeVisible();
releaseSlowChat();
await expect(page.getByText('Latest chat body')).toBeVisible();
await expect(page.getByText('Slow chat body')).toHaveCount(0);
```

Add this spec to `mobileSpecs` only if it contains mobile viewport assertions;
otherwise keep it in the desktop Chromium project.

- [ ] **Step 3: Run the targeted Playwright tests and verify they fail**

Run against the temporary development server:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 NEXTAUTH_URL=http://localhost:3011 \
  npm run dev -- --port 3011
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts tests/chat-selection-loading.spec.ts \
  --project=android-chromium --project=desktop-chromium
```

Expected: the new loading-state and immediate-close assertions FAIL.

- [ ] **Step 4: Implement the loading component**

Create `app/features/chat/components/ChatLoadingView.tsx`:

```tsx
'use client';

import { forwardRef } from 'react';
import './ChatLoadingView.css';

export const ChatLoadingView = forwardRef<HTMLDivElement, { chatName: string }>(
  function ChatLoadingView({ chatName }, ref) {
    const label = `Loading ${chatName}`;
    return (
      <div
        ref={ref}
        className="chatLoadingView"
        role="status"
        aria-label={label}
        aria-live="polite"
        aria-busy="true"
        tabIndex={-1}
      >
        <span className="chatLoadingSpinner" aria-hidden="true" />
        <span className="chatLoadingLabel">{label}...</span>
      </div>
    );
  },
);
```

Create `app/features/chat/components/ChatLoadingView.css`:

```css
.chatPageRoot .chatLoadingView {
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 12px;
  color: var(--text-muted);
  background: var(--bg);
  outline: none;
}

.chatPageRoot .chatLoadingSpinner {
  width: 22px;
  height: 22px;
  border: 2px solid color-mix(in srgb, var(--text-muted) 28%, transparent);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: chatLoadingSpin 700ms linear infinite;
}

.chatPageRoot .chatLoadingLabel {
  max-width: min(80vw, 420px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

@keyframes chatLoadingSpin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .chatPageRoot .chatLoadingSpinner { animation: none; }
}
```

- [ ] **Step 5: Compose the transition in `ChatPageClient`**

Import and initialize:

```ts
const chatSelection = useChatSelectionTransition();
const chatLoadingRef = useRef<HTMLDivElement | null>(null);
```

Replace `loadChat` with an expanded function:

```ts
async function loadChat(chatId: string) {
  setOpenChatMenuId(null);
  if (chatId === currentChatId) {
    if (mobile.isMobileLayout) mobile.close();
    requestAnimationFrame(() => chatContainerRef.current?.focus({ preventScroll: true }));
    return;
  }

  const selectedName = chatHistory.find((chat) => chat.id === chatId)?.name || chatId;
  const token = chatSelection.begin(chatId, selectedName);
  shouldStickToBottomRef.current = true;
  setShowScrollToBottom(false);

  if (mobile.isMobileLayout) mobile.close();
  requestAnimationFrame(() => chatLoadingRef.current?.focus({ preventScroll: true }));

  try {
    const result = await runtimeLoadChat(chatId, token.isCurrent);
    if (!chatSelection.finish(token) || result !== 'loaded') return;
    requestAnimationFrame(() => {
      const container = chatContainerRef.current;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
      container.focus({ preventScroll: true });
    });
  } catch {
    chatSelection.finish(token);
  }
}
```

Add `tabIndex={-1}` to `.chatContainer`.

While `chatSelection.loadingSelection` is non-null, pass:

```tsx
messages={
  chatSelection.loadingSelection
    ? <ChatLoadingView
        ref={chatLoadingRef}
        chatName={chatSelection.loadingSelection.chatName}
      />
    : existingMessagesNode
}
composer={chatSelection.loadingSelection ? null : existingComposerNode}
```

Extract `existingMessagesNode` and `existingComposerNode` above the return so
`ChatPageClient` remains a composition layer instead of adding nested render
branches to the existing JSX.

- [ ] **Step 6: Run desktop and mobile Playwright coverage**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts tests/chat-selection-loading.spec.ts
```

Expected: all selected desktop Chromium, Android Chromium, and iPhone WebKit
projects PASS.

- [ ] **Step 7: Commit the UI behavior**

```bash
git add app/features/chat/components/ChatLoadingView.tsx \
  app/features/chat/components/ChatLoadingView.css \
  app/features/chat/ChatPageClient.tsx \
  tests/mobile-responsive.spec.ts \
  tests/chat-selection-loading.spec.ts \
  tests/playwright.config.ts
git commit -m "feat: add responsive chat selection loading"
```

Include the required `Co-authored-by` trailer.

### Task 4: Validate, Build, and Deploy

**Files:**
- Verify: `app/features/chat/`
- Verify: `app/features/chat/runtime/`
- Verify: `tests/mobile-responsive.spec.ts`
- Verify: `tests/chat-selection-loading.spec.ts`

- [ ] **Step 1: Run all focused non-browser checks**

```bash
npx tsx tests/chat-selection-transition.test.ts
npx tsx tests/chat-selection-load-guard.test.ts
npx tsc --noEmit
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Run the focused cross-browser suite**

With the temporary server on port 3011:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts tests/chat-selection-loading.spec.ts
```

Expected: all applicable desktop Chromium, Android Chromium, and iPhone WebKit
tests PASS.

- [ ] **Step 3: Stop the temporary development server**

Stop the exact process through the shell session that started it. Verify:

```bash
curl --silent --output /dev/null --write-out '%{http_code}' http://localhost:3011/login
```

Expected: connection failure because the temporary server is stopped.

- [ ] **Step 4: Stop production before rebuilding `.next`**

Ask the user to run:

```bash
sudo systemctl stop agents-chat.service
```

Do not ask the user to send their sudo password. Verify:

```bash
systemctl is-active agents-chat.service
```

Expected: `inactive`.

- [ ] **Step 5: Build production**

```bash
npm run build
```

Expected: optimized production build and TypeScript checks complete
successfully. Existing NFT tracing warnings may remain, but no build error is
accepted.

- [ ] **Step 6: Start and verify production**

Ask the user to run:

```bash
sudo systemctl start agents-chat.service
```

Then run:

```bash
systemctl is-active agents-chat.service
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  http://localhost:3010/login
```

Expected: service is `active` and HTTP status is `200`.

- [ ] **Step 7: Perform the final UX check**

On mobile:

1. Open Chats.
2. Select a different Chat.
3. Confirm Chats closes immediately.
4. Confirm loading appears without opening the keyboard.
5. Confirm the selected conversation replaces loading.

On desktop:

1. Select a different Chat.
2. Confirm old messages and Composer disappear immediately.
3. Confirm the sidebar remains usable.
4. Confirm the selected conversation appears after loading.

- [ ] **Step 8: Commit any final test-only adjustments**

If validation required selector or timing corrections, commit only those
corrections:

```bash
git add tests/mobile-responsive.spec.ts tests/chat-selection-loading.spec.ts
git commit -m "test: stabilize chat selection loading coverage"
```

Include the required `Co-authored-by` trailer. If no files changed, do not create
an empty commit.
