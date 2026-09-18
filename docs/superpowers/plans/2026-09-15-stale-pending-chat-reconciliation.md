# Stale Pending Chat Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically mark persisted pending Agent messages as interrupted after session restoration proves that no live turn exists.

**Architecture:** Add a pure feature-local reconciliation helper that transforms pending messages only for explicitly confirmed Agent IDs. Invoke it once after the current Chat's resume requests settle, then persist only when the helper reports a change; rejected resume requests and Agents with live turns remain untouched.

**Tech Stack:** React 19 hooks, strict TypeScript, Next.js 16 App Router, Node assertions through `tsx`, Playwright E2E.

---

## File Map

- Create `app/features/chat/runtime/reconcileStalePendingMessages.ts`: pure message reconciliation and result type.
- Create `tests/stale-pending-reconciliation.test.ts`: focused helper contract tests.
- Modify `app/features/chat/runtime/useChatRuntime.ts`: collect definitive resume outcomes, apply reconciliation, and persist without changing Chat order.
- Create `tests/stale-pending-reconciliation.spec.ts`: browser-level restoration and persistence regression.
- Modify `docs/superpowers/specs/2026-09-15-stale-pending-chat-reconciliation-design.md`: record final verification status only if implementation behavior differs from the approved wording.

### Task 1: Pure stale-message reconciliation

**Files:**
- Create: `tests/stale-pending-reconciliation.test.ts`
- Create: `app/features/chat/runtime/reconcileStalePendingMessages.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `tests/stale-pending-reconciliation.test.ts`:

```ts
import assert from 'node:assert/strict';
import type { ChatMessage } from '../app/features/chat/chatTypes';
import { reconcileStalePendingMessages } from '../app/features/chat/runtime/reconcileStalePendingMessages';

const messages: ChatMessage[] = [
  {
    id: 'stale-with-content',
    type: 'agent',
    agentId: 'alpha',
    content: 'Partial answer',
    ts: 1,
    pending: true,
    statusText: 'Reading shell output',
    ptyPhase: 'thinking',
    parts: [{ kind: 'tool', toolName: 'Reading shell output', done: true, result: 'partial result' }],
  },
  {
    id: 'stale-empty',
    type: 'agent',
    agentId: 'alpha',
    content: '',
    ts: 2,
    pending: true,
    statusText: 'Thinking',
  },
  {
    id: 'other-agent',
    type: 'agent',
    agentId: 'beta',
    content: '',
    ts: 3,
    pending: true,
    statusText: 'Running',
  },
  {
    id: 'completed',
    type: 'agent',
    agentId: 'alpha',
    content: 'Done',
    ts: 4,
    pending: false,
  },
];

const result = reconcileStalePendingMessages(messages, new Set(['alpha']));
assert.equal(result.changed, true);
assert.notEqual(result.messages, messages);
assert.deepEqual(result.messages[0], {
  ...messages[0],
  pending: false,
  statusText: 'Interrupted',
  ptyPhase: undefined,
  userRequest: undefined,
});
assert.equal(result.messages[0].parts, messages[0].parts);
assert.equal(result.messages[1].content, '⏹ Interrupted');
assert.equal(result.messages[1].pending, false);
assert.equal(result.messages[1].statusText, 'Interrupted');
assert.equal(result.messages[2], messages[2]);
assert.equal(result.messages[3], messages[3]);

const unchanged = reconcileStalePendingMessages(messages, new Set());
assert.equal(unchanged.changed, false);
assert.equal(unchanged.messages, messages);

console.log('stale pending reconciliation tests passed');
```

- [ ] **Step 2: Run the helper test and verify it fails**

Run:

```bash
npx tsx tests/stale-pending-reconciliation.test.ts
```

Expected: FAIL because `reconcileStalePendingMessages.ts` does not exist.

- [ ] **Step 3: Implement the pure helper**

Create `app/features/chat/runtime/reconcileStalePendingMessages.ts`:

```ts
import type { ChatMessage } from '../chatTypes';

export type StalePendingReconciliation = {
  messages: ChatMessage[];
  changed: boolean;
};

export function reconcileStalePendingMessages(
  messages: ChatMessage[],
  interruptedAgentIds: ReadonlySet<string>,
): StalePendingReconciliation {
  let changed = false;
  const reconciled = messages.map((message) => {
    if (
      message.type !== 'agent'
      || !message.pending
      || !message.agentId
      || !interruptedAgentIds.has(message.agentId)
    ) {
      return message;
    }

    changed = true;
    return {
      ...message,
      content: message.content.trim() ? message.content : '⏹ Interrupted',
      pending: false,
      statusText: 'Interrupted',
      ptyPhase: undefined,
      userRequest: undefined,
    };
  });

  return {
    messages: changed ? reconciled : messages,
    changed,
  };
}
```

- [ ] **Step 4: Run the helper test**

Run:

```bash
npx tsx tests/stale-pending-reconciliation.test.ts
```

Expected: `stale pending reconciliation tests passed`.

- [ ] **Step 5: Commit the helper**

```bash
git add app/features/chat/runtime/reconcileStalePendingMessages.ts tests/stale-pending-reconciliation.test.ts
git commit -m "test: define stale pending reconciliation"
```

### Task 2: Integrate reconciliation with session restoration

**Files:**
- Modify: `app/features/chat/runtime/useChatRuntime.ts:615-670`
- Test: `tests/stale-pending-reconciliation.test.ts`

- [ ] **Step 1: Extend the helper test for live and failed resume outcome selection**

Add a second export to the test import and these assertions:

```ts
import {
  collectInterruptedAgentIds,
  reconcileStalePendingMessages,
  type AgentResumeOutcome,
} from '../app/features/chat/runtime/reconcileStalePendingMessages';

const outcomes: AgentResumeOutcome[] = [
  { agentId: 'no-turn', status: 'fulfilled', activeTurn: null },
  { agentId: 'done-turn', status: 'fulfilled', activeTurn: { done: true } },
  { agentId: 'live-turn', status: 'fulfilled', activeTurn: { done: false } },
  { agentId: 'failed-resume', status: 'rejected' },
];

assert.deepEqual(
  [...collectInterruptedAgentIds(outcomes)],
  ['no-turn', 'done-turn'],
);
```

- [ ] **Step 2: Run the test and verify the new assertion fails**

Run:

```bash
npx tsx tests/stale-pending-reconciliation.test.ts
```

Expected: FAIL because `collectInterruptedAgentIds` and `AgentResumeOutcome` are not exported.

- [ ] **Step 3: Add typed resume-outcome selection**

Add to `app/features/chat/runtime/reconcileStalePendingMessages.ts`:

```ts
export type AgentResumeOutcome =
  | {
      agentId: string;
      status: 'fulfilled';
      activeTurn?: { done?: boolean } | null;
    }
  | {
      agentId: string;
      status: 'rejected';
    };

export function collectInterruptedAgentIds(
  outcomes: AgentResumeOutcome[],
): Set<string> {
  return new Set(
    outcomes
      .filter((outcome): outcome is Extract<AgentResumeOutcome, { status: 'fulfilled' }> =>
        outcome.status === 'fulfilled'
        && (!outcome.activeTurn || outcome.activeTurn.done === true))
      .map((outcome) => outcome.agentId),
  );
}
```

- [ ] **Step 4: Wire the helper into the resume effect**

Import the helper in `app/features/chat/runtime/useChatRuntime.ts`:

```ts
import {
  collectInterruptedAgentIds,
  reconcileStalePendingMessages,
  type AgentResumeOutcome,
} from './reconcileStalePendingMessages';
```

Inside the async resume block, create outcomes from `Promise.allSettled`, retain the existing live-turn and recovered-message processing, then reconcile after the loop:

```ts
const outcomes: AgentResumeOutcome[] = results.map((result, index) => {
  const agentId = entries[index][0];
  if (result.status === 'rejected') {
    return { agentId, status: 'rejected' };
  }
  return {
    agentId,
    status: 'fulfilled',
    activeTurn: result.value?.activeTurn ?? null,
  };
});

// Existing result loop remains here. Unfinished active turns still call
// acpHandlers.resumeActiveTurn before stale messages are considered.

const interruptedAgentIds = collectInterruptedAgentIds(outcomes);
const currentMessages = chatMessagesRef.current[activeChatId]
  || (currentChatIdRef.current === activeChatId ? messagesRef.current : []);
const reconciliation = reconcileStalePendingMessages(
  currentMessages,
  interruptedAgentIds,
);
if (reconciliation.changed) {
  setMessagesForChat(activeChatId, reconciliation.messages);
  await persistHandlers.saveCurrentChatToHistory(true);
}
```

Do not reconcile in the `entries.length === 0` branch: without an Agent resume response, there is no proof that a persisted pending message is stale.

- [ ] **Step 5: Run focused tests and TypeScript**

Run:

```bash
npx tsx tests/stale-pending-reconciliation.test.ts
npx tsc --noEmit
```

Expected: helper test passes and TypeScript exits 0.

- [ ] **Step 6: Commit the integration**

```bash
git add app/features/chat/runtime/useChatRuntime.ts app/features/chat/runtime/reconcileStalePendingMessages.ts tests/stale-pending-reconciliation.test.ts
git commit -m "fix: reconcile interrupted chat turns"
```

### Task 3: Browser persistence regression

**Files:**
- Create: `tests/stale-pending-reconciliation.spec.ts`

- [ ] **Step 1: Create the Playwright fixture and failing scenario**

Create `tests/stale-pending-reconciliation.spec.ts`. Use an in-memory Chat route that records POST writes and returns the latest saved Chat on reload:

```ts
import { expect, test, type Page } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';
const staleChat = {
  id: 'stale-chat',
  name: 'Interrupted shell task',
  ts: 100,
  agentId: 'alpha',
  agentSessions: { alpha: 'missing-session' },
  messages: [{
    id: 'stale-agent-message',
    type: 'agent',
    agentId: 'alpha',
    content: '',
    ts: 101,
    pending: true,
    statusText: 'Reading shell output',
    ptyPhase: 'thinking',
    parts: [{ kind: 'tool', toolName: 'Reading shell output', done: true, result: 'last output' }],
  }],
};

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  const username = page.getByPlaceholder('Admin username');
  const password = page.getByPlaceholder('Password');
  const submit = page.locator('button[type="submit"]');
  await expect(async () => {
    await username.fill(process.env.ADMIN_USERNAME || 'admin');
    await password.fill(process.env.ADMIN_PASSWORD || 'admin123');
    await expect(submit).toBeEnabled();
  }).toPass({ timeout: 30_000 });
  await submit.click();
}

test('marks a missing restored turn interrupted and persists it', async ({ page }) => {
  let savedChat = structuredClone(staleChat);
  let saveCount = 0;

  await page.route('**/api/chats**', async (route) => {
    const request = route.request();
    const id = new URL(request.url()).searchParams.get('id');
    if (request.method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(id
          ? { ok: true, chat: savedChat }
          : {
              ok: true,
              chats: [{ id: savedChat.id, name: savedChat.name, ts: savedChat.ts, agentId: 'alpha' }],
              lastChatId: savedChat.id,
            }),
      });
      return;
    }
    const body = request.postDataJSON();
    if (body.chat) {
      savedChat = body.chat;
      saveCount += 1;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route('**/api/orchestrations**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }));

  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'list-agents') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          agents: [{
            id: 'alpha',
            name: 'Alpha',
            canTalk: true,
            canModify: true,
            public: true,
            models: [],
          }],
        }),
      });
      return;
    }
    if (body.action === 'resume-session') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          loaded: false,
          sessionId: 'replacement-session',
          activeTurn: null,
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, phase: 'idle', activeTurn: null }),
    });
  });

  await login(page);
  await expect(page.getByText('⏹ Interrupted')).toBeVisible();
  await expect(page.getByText('Reading shell output')).toHaveCount(0);
  await expect.poll(() => saveCount).toBe(1);

  await page.reload();
  await expect(page.getByText('⏹ Interrupted')).toBeVisible();
  await expect.poll(() => saveCount).toBe(1);
});
```

- [ ] **Step 2: Run the scenario against the pre-change build**

Start the app with test credentials on an unused port, then run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD=admin123 \
npx playwright test \
  --config tests/playwright.config.ts \
  tests/stale-pending-reconciliation.spec.ts \
  --project=desktop-chromium
```

Expected before Task 2 integration: FAIL because `Reading shell output` remains.

- [ ] **Step 3: Run the scenario after Task 2**

Run the same Playwright command.

Expected: 1 passed. Confirm `saveCount` remains 1 after reload, proving reconciliation is idempotent.

- [ ] **Step 4: Commit the E2E regression**

```bash
git add tests/stale-pending-reconciliation.spec.ts
git commit -m "test: cover interrupted chat restoration"
```

### Task 4: Final validation and deployment

**Files:**
- Verify: `app/features/chat/runtime/reconcileStalePendingMessages.ts`
- Verify: `app/features/chat/runtime/useChatRuntime.ts`
- Verify: `tests/stale-pending-reconciliation.test.ts`
- Verify: `tests/stale-pending-reconciliation.spec.ts`

- [ ] **Step 1: Run targeted and related tests**

```bash
npx tsx tests/stale-pending-reconciliation.test.ts
npx tsx tests/auth-allowlist.test.ts
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD=admin123 \
npx playwright test \
  --config tests/playwright.config.ts \
  tests/stale-pending-reconciliation.spec.ts \
  tests/mobile-responsive.spec.ts \
  --project=android-chromium \
  --project=iphone-webkit
```

Expected: all selected Node and Playwright tests pass.

- [ ] **Step 2: Build production output**

Stop `agents-chat.service` before replacing `.next`, then run:

```bash
npm run build
```

Expected: production build and TypeScript pass. Existing Next.js middleware/NFT warnings may remain, but no new errors are allowed.

- [ ] **Step 3: Restart and verify the service**

```bash
sudo systemctl start agents-chat.service
systemctl is-active agents-chat.service
curl --fail --silent --output /dev/null http://localhost:3010/login
```

Expected: service reports `active`; login request exits 0.

- [ ] **Step 4: Verify the reported Chat**

Open the `mobile style` Chat. Expected:

- `Reading shell output` no longer appears as a running state.
- The interrupted message and historical tool output remain.
- The Chat sidebar is no longer marked running.
- Refreshing the page preserves `Interrupted`.

- [ ] **Step 5: Commit any final documentation adjustment**

Only if observed behavior required changing the approved spec:

```bash
git add docs/superpowers/specs/2026-09-15-stale-pending-chat-reconciliation-design.md
git commit -m "docs: record stale pending reconciliation"
```
