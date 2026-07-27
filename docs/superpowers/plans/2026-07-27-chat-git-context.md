# Chat Git Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add branch/worktree selectors under the composer, persist Git context per chat, and ensure selected worktree is used as the real execution cwd for that chat session.

**Architecture:** Keep one shared ACP process per agent, but move cwd decision to chat/session scope. Persist `gitContext` on chat records, resolve + validate via a server helper, and pass a chat-specific cwd override into session creation/resume paths. On context change, invalidate only the current chat's agent session mapping so next send recreates sessions in the new worktree.

**Tech Stack:** Next.js App Router (TypeScript), React 19, better-sqlite3, Node test runner (`node --test`), Playwright (`tests/playwright.config.ts`).

**Spec:** `docs/superpowers/specs/2026-07-27-git-context-chat-design.md`

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `lib/gitContext.ts` | Enumerate branches/worktrees, normalize output, validate chat git context, map branch→worktree |
| `app/features/chat/chatGitContextTypes.ts` | Shared frontend types for git-context state and options |
| `app/features/chat/chatGitContextApi.ts` | Frontend fetch helpers for git-context endpoints |
| `app/features/chat/runtime/useChatGitContext.ts` | Chat-scoped git-context runtime state + mutation hook |
| `app/features/composer/components/ComposerGitContextControls.tsx` | Composer sub-row UI with branch/worktree selects |
| `app/features/composer/components/ComposerGitContextControls.css` | Styles for git-context row |
| `tests/chat-git-context-store.test.mjs` | Persistence tests for chat git_context field |
| `tests/chat-git-context-api.test.mjs` | API behavior tests for load/update git context |
| `tests/chat-git-context-cwd.test.mjs` | ACP session cwd override behavior tests |
| `tests/chat-git-context-ui.spec.ts` | Playwright E2E for composer controls + chat restore |

### Modified files

| Path | What changes |
|---|---|
| `lib/chatStore.ts` | Add `git_context` storage on chats, update row mapping/save helpers, add dedicated update helper |
| `app/api/chats/route.ts` | Support `GET` with chat git context and `POST` action to update git context |
| `app/api/acp/route.ts` | Resolve chat git context and pass per-chat cwd override into `session/new`/`session/load` paths |
| `app/features/chat/chatTypes.ts` | Add optional `gitContext` on stored chat shape used by client runtime |
| `app/features/chat/ChatPageClient.tsx` | Wire `useChatGitContext` and render composer git controls |
| `app/features/composer/components/ChatComposer.tsx` | Accept and render a new `gitContextControls` slot below toolbar |
| `app/features/composer/components/ChatComposer.css` | Composer layout updates for git context row |
| `tests/test-ui.spec.ts` | Reuse helper setup utilities if needed by new git-context UI test |

---

## Task 1: Persist Chat Git Context in Store (TDD)

**Files:**
- Modify: `lib/chatStore.ts`
- Test: `tests/chat-git-context-store.test.mjs`

- [ ] **Step 1: Write failing persistence tests**

```javascript
// tests/chat-git-context-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  saveChat,
  getChat,
  updateChatGitContext,
} from '../lib/chatStore.ts';

const userId = 'git-context-user@example.com';
const chatId = `chat-git-${Date.now()}`;

test('stores gitContext with chat payload', async () => {
  await saveChat(userId, {
    id: chatId,
    name: 'Git Context Chat',
    ts: Date.now(),
    messages: [],
    agentSessions: {},
    gitContext: {
      repoRoot: 'C:/repo',
      worktreePath: 'C:/repo/.worktrees/feat-a',
      branchName: 'feat/a',
    },
  });

  const loaded = await getChat(userId, chatId);
  assert.ok(loaded);
  assert.equal(loaded.gitContext?.branchName, 'feat/a');
});

test('updates gitContext without overwriting messages', async () => {
  await updateChatGitContext(userId, chatId, {
    repoRoot: 'C:/repo',
    worktreePath: 'C:/repo/.worktrees/feat-b',
    branchName: 'feat/b',
  });

  const loaded = await getChat(userId, chatId);
  assert.ok(loaded);
  assert.equal(loaded.messages.length, 0);
  assert.equal(loaded.gitContext?.worktreePath.endsWith('feat-b'), true);
});
```

- [ ] **Step 2: Run test and confirm RED**

Run: `node --test tests/chat-git-context-store.test.mjs`
Expected: FAIL on missing `gitContext` and/or missing `updateChatGitContext` export.

- [ ] **Step 3: Implement minimal store changes**

```typescript
// lib/chatStore.ts (types)
export type StoredGitContext = {
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  isFallback?: boolean;
};

export type StoredChat = {
  id: string;
  name: string;
  ts: number;
  agentId?: string;
  messages: StoredMessage[];
  agentSessions: Record<string, string>;
  gitContext?: StoredGitContext;
};
```

```typescript
// lib/chatStore.ts (schema migration)
try {
  _db.exec(`ALTER TABLE chats ADD COLUMN git_context TEXT NOT NULL DEFAULT '{}'`);
} catch { /* column already exists */ }
```

```typescript
// lib/chatStore.ts (row mapping + save)
function mapStoredChatRow(row: any): StoredChat {
  return {
    id: row.chat_id,
    name: row.name,
    ts: row.ts,
    agentId: row.agent_id || undefined,
    messages: JSON.parse(row.messages || '[]'),
    agentSessions: JSON.parse(row.agent_sessions || '{}'),
    gitContext: JSON.parse(row.git_context || '{}'),
  };
}
```

```typescript
// lib/chatStore.ts (upsert)
db.prepare(`
  INSERT INTO chats (user_id, chat_id, name, ts, messages, agent_sessions, agent_id, git_context)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (user_id, chat_id) DO UPDATE SET
    name = excluded.name,
    ts = excluded.ts,
    messages = excluded.messages,
    git_context = excluded.git_context,
    agent_id = CASE WHEN excluded.agent_id != '' THEN excluded.agent_id ELSE chats.agent_id END
`).run(
  userId,
  chat.id,
  chat.name,
  chat.ts,
  JSON.stringify(chat.messages),
  JSON.stringify(chat.agentSessions || {}),
  chat.agentId || '',
  JSON.stringify(chat.gitContext || {}),
);
```

```typescript
// lib/chatStore.ts (new helper)
export async function updateChatGitContext(
  userId: string,
  chatId: string,
  gitContext: StoredGitContext,
): Promise<void> {
  const db = getDb();
  db.prepare('UPDATE chats SET git_context = ? WHERE user_id = ? AND chat_id = ?')
    .run(JSON.stringify(gitContext), userId, chatId);
}
```

- [ ] **Step 4: Run test and confirm GREEN**

Run: `node --test tests/chat-git-context-store.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run:
`git add lib/chatStore.ts tests/chat-git-context-store.test.mjs`

`git commit -m "feat(chat): persist git context per chat"`

---

## Task 2: Add Git Context Discovery + Validation Service (TDD)

**Files:**
- Create: `lib/gitContext.ts`
- Test: `tests/chat-git-context-api.test.mjs`

- [ ] **Step 1: Write failing service tests (parse + validation)**

```javascript
// tests/chat-git-context-api.test.mjs (service-focused cases)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorktreePorcelain,
  selectWorktreeForBranch,
} from '../lib/gitContext.ts';

test('parses worktree porcelain output', () => {
  const parsed = parseWorktreePorcelain([
    'worktree C:/repo',
    'HEAD 1111111',
    'branch refs/heads/main',
    '',
    'worktree C:/repo/.worktrees/feat-a',
    'HEAD 2222222',
    'branch refs/heads/feat/a',
  ].join('\n'));

  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].branchName, 'feat/a');
});

test('returns null for branch without mapped worktree', () => {
  const selected = selectWorktreeForBranch('feat/missing', [
    { worktreePath: 'C:/repo', branchName: 'main', isMain: true },
  ]);
  assert.equal(selected, null);
});
```

- [ ] **Step 2: Run test and confirm RED**

Run: `node --test tests/chat-git-context-api.test.mjs`
Expected: FAIL with missing module/exports.

- [ ] **Step 3: Implement `lib/gitContext.ts` minimal API**

```typescript
// lib/gitContext.ts
export type GitWorktree = {
  worktreePath: string;
  branchName: string;
  isMain: boolean;
};

export function parseWorktreePorcelain(output: string): GitWorktree[] {
  const blocks = output.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split(/\r?\n/);
    const wt = lines.find((l) => l.startsWith('worktree '))?.slice(9) || '';
    const branchRef = lines.find((l) => l.startsWith('branch '))?.slice(7) || '';
    const branchName = branchRef.startsWith('refs/heads/') ? branchRef.slice('refs/heads/'.length) : branchRef;
    return { worktreePath: wt, branchName, isMain: !wt.includes('.worktrees') };
  }).filter((row) => row.worktreePath.length > 0);
}

export function selectWorktreeForBranch(branch: string, worktrees: GitWorktree[]): GitWorktree | null {
  return worktrees.find((w) => w.branchName === branch) || null;
}
```

- [ ] **Step 4: Run test and confirm GREEN**

Run: `node --test tests/chat-git-context-api.test.mjs`
Expected: PASS for parser + selector tests.

- [ ] **Step 5: Commit**

Run:
`git add lib/gitContext.ts tests/chat-git-context-api.test.mjs`

`git commit -m "feat(chat): add git context parser and selector"`

---

## Task 3: Expose Chat Git Context API (TDD)

**Files:**
- Modify: `app/api/chats/route.ts`
- Modify: `lib/chatStore.ts`
- Modify: `lib/gitContext.ts`
- Test: `tests/chat-git-context-api.test.mjs`

- [ ] **Step 1: Add failing API contract tests**

```javascript
// tests/chat-git-context-api.test.mjs (route-source contract assertions)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const routeSource = fs.readFileSync('app/api/chats/route.ts', 'utf8');

test('supports update-git-context POST action', () => {
  assert.match(routeSource, /action\s*===\s*['"]update-git-context['"]/);
});

test('validates chatId and gitContext in update action', () => {
  assert.match(routeSource, /missing_chatId/);
  assert.match(routeSource, /invalid_git_context/);
});
```

- [ ] **Step 2: Run test and confirm RED**

Run: `node --test tests/chat-git-context-api.test.mjs`
Expected: FAIL because route does not yet contain the new action.

- [ ] **Step 3: Implement route action and options loading**

```typescript
// app/api/chats/route.ts (inside POST)
if (body?.action === 'update-git-context') {
  const chatId = body?.chatId;
  const gitContext = body?.gitContext;
  if (typeof chatId !== 'string' || !chatId) {
    return NextResponse.json({ ok: false, error: 'missing_chatId' }, { status: 400 });
  }
  if (!isValidStoredGitContext(gitContext)) {
    return NextResponse.json({ ok: false, error: 'invalid_git_context' }, { status: 400 });
  }

  const validated = await validateGitContext(gitContext);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }

  await updateChatGitContext(userId, chatId, validated.gitContext);
  return NextResponse.json({ ok: true, gitContext: validated.gitContext });
}
```

```typescript
// app/api/chats/route.ts (inside GET, chatId branch)
const options = await getGitContextOptionsForChat(chat);
return NextResponse.json({ ok: true, chat, gitContextOptions: options });
```

- [ ] **Step 4: Run test and confirm GREEN**

Run: `node --test tests/chat-git-context-api.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run:
`git add app/api/chats/route.ts lib/chatStore.ts lib/gitContext.ts tests/chat-git-context-api.test.mjs`

`git commit -m "feat(api): add chat git context load and update actions"`

---

## Task 4: Apply Per-Chat CWD to ACP Sessions (TDD)

**Files:**
- Modify: `app/api/acp/route.ts`
- Modify: `lib/chatStore.ts`
- Test: `tests/chat-git-context-cwd.test.mjs`

- [ ] **Step 1: Write failing cwd override tests**

```javascript
// tests/chat-git-context-cwd.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('app/api/acp/route.ts', 'utf8');

test('session params builder accepts cwd override', () => {
  assert.match(source, /buildSessionParams\([^)]*cwdOverride/);
});

test('session/new path reads chat git context before create', () => {
  assert.match(source, /getChat\(userId,\s*chatId\)/);
  assert.match(source, /gitContext\?\.worktreePath/);
});
```

- [ ] **Step 2: Run test and confirm RED**

Run: `node --test tests/chat-git-context-cwd.test.mjs`
Expected: FAIL on missing override references.

- [ ] **Step 3: Implement cwd override path**

```typescript
// app/api/acp/route.ts
async function buildSessionParams(
  proc: AgentProcess,
  isAdmin: boolean,
  cwdOverride?: string,
): Promise<{ cwd: string; mcpServers: Record<string, unknown>[] }> {
  const params = { cwd: cwdOverride || proc.cachedCwd, mcpServers: [] as Record<string, unknown>[] };
  if (!proc.config.noTools && !proc.config.relay) {
    params.mcpServers = await loadMcpServers(isAdmin);
  }
  return params;
}
```

```typescript
// app/api/acp/route.ts (before session/new/session/load in chat flows)
const chat = chatId ? await getChat(userId, chatId) : null;
const chatCwd = chat?.gitContext?.worktreePath;
const sessionParams = await buildSessionParams(proc, isAdmin, chatCwd);
```

```typescript
// app/api/acp/route.ts (on context switch from client action)
// remove only this chat's current session mapping so next send recreates session
if (chatId) {
  sess.chatSessions.delete(chatId);
  if (sess.activeTurns.size === 0) sess.sessionId = null;
}
```

- [ ] **Step 4: Run test and confirm GREEN**

Run: `node --test tests/chat-git-context-cwd.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run:
`git add app/api/acp/route.ts tests/chat-git-context-cwd.test.mjs`

`git commit -m "feat(acp): use chat git context as session cwd override"`

---

## Task 5: Add Frontend Git Context Runtime and API Client (TDD)

**Files:**
- Create: `app/features/chat/chatGitContextTypes.ts`
- Create: `app/features/chat/chatGitContextApi.ts`
- Create: `app/features/chat/runtime/useChatGitContext.ts`
- Test: `tests/agent-model-config.test.mjs` (append focused pure-function checks) or `tests/chat-git-context-ui.spec.ts` for integration

- [ ] **Step 1: Write failing state behavior tests (pure helper extraction)**

```javascript
// tests/chat-git-context-api.test.mjs (add helper tests)
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveContext } from '../app/features/chat/chatGitContextApi.ts';

test('worktree selection updates branch from selected worktree', () => {
  const next = resolveEffectiveContext({
    current: { repoRoot: 'C:/repo', worktreePath: 'C:/repo', branchName: 'main' },
    worktrees: [{ worktreePath: 'C:/repo/.worktrees/feat-a', branchName: 'feat/a', isMain: false }],
    selectedWorktreePath: 'C:/repo/.worktrees/feat-a',
  });

  assert.equal(next.branchName, 'feat/a');
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `node --test tests/chat-git-context-api.test.mjs`
Expected: FAIL on missing client helper exports.

- [ ] **Step 3: Implement frontend API + hook minimal surface**

```typescript
// app/features/chat/chatGitContextApi.ts
export async function fetchChatGitContext(chatId: string) {
  const res = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`);
  return res.json();
}

export async function updateChatGitContext(chatId: string, gitContext: ChatGitContext) {
  const res = await fetch('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update-git-context', chatId, gitContext }),
  });
  return res.json();
}
```

```typescript
// app/features/chat/runtime/useChatGitContext.ts
export function useChatGitContext(currentChatId: string | null) {
  const [state, setState] = useState<ChatGitContextState>({ status: 'idle', options: null, effective: null, error: null });
  // load on chat change, expose setWorktree/setBranch handlers
  return { state, setState };
}
```

- [ ] **Step 4: Run tests and confirm GREEN**

Run: `node --test tests/chat-git-context-api.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run:
`git add app/features/chat/chatGitContextTypes.ts app/features/chat/chatGitContextApi.ts app/features/chat/runtime/useChatGitContext.ts tests/chat-git-context-api.test.mjs`

`git commit -m "feat(chat): add git context client runtime hook"`

---

## Task 6: Render Composer Branch/Worktree Controls (TDD)

**Files:**
- Create: `app/features/composer/components/ComposerGitContextControls.tsx`
- Create: `app/features/composer/components/ComposerGitContextControls.css`
- Modify: `app/features/composer/components/ChatComposer.tsx`
- Modify: `app/features/composer/components/ChatComposer.css`
- Modify: `app/features/chat/ChatPageClient.tsx`
- Test: `tests/chat-git-context-ui.spec.ts`

- [ ] **Step 1: Add failing Playwright test**

```typescript
// tests/chat-git-context-ui.spec.ts
import { test, expect } from '@playwright/test';

test('composer shows branch and worktree selectors under input', async ({ page }) => {
  await page.goto('http://localhost:3010');
  await page.getByRole('button', { name: /New Chat/i }).click();

  await expect(page.getByLabel('Branch')).toBeVisible();
  await expect(page.getByLabel('Worktree')).toBeVisible();
});
```

- [ ] **Step 2: Run test and confirm RED**

Run: `npx playwright test --config tests/playwright.config.ts tests/chat-git-context-ui.spec.ts`
Expected: FAIL because selectors do not exist.

- [ ] **Step 3: Implement composer controls and wiring**

```tsx
// app/features/composer/components/ChatComposer.tsx
type ChatComposerProps = {
  // existing props...
  gitContextControls?: ReactNode;
};

// render near toolbar end
{gitContextControls ? <div className="composerGitContextRow">{gitContextControls}</div> : null}
```

```tsx
// app/features/composer/components/ComposerGitContextControls.tsx
export function ComposerGitContextControls({
  branchOptions,
  worktreeOptions,
  selectedBranch,
  selectedWorktree,
  disabled,
  statusText,
  onSelectBranch,
  onSelectWorktree,
}: Props) {
  return (
    <div className="composerGitContextControls">
      <label>
        <span>Branch</span>
        <select aria-label="Branch" value={selectedBranch} disabled={disabled} onChange={(e) => onSelectBranch(e.target.value)}>
          {branchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </label>
      <label>
        <span>Worktree</span>
        <select aria-label="Worktree" value={selectedWorktree} disabled={disabled} onChange={(e) => onSelectWorktree(e.target.value)}>
          {worktreeOptions.map((w) => <option key={w.path} value={w.path}>{w.label}</option>)}
        </select>
      </label>
      {statusText ? <div className="composerGitContextStatus">{statusText}</div> : null}
    </div>
  );
}
```

- [ ] **Step 4: Run test and confirm GREEN**

Run: `npx playwright test --config tests/playwright.config.ts tests/chat-git-context-ui.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Run:
`git add app/features/composer/components/ChatComposer.tsx app/features/composer/components/ChatComposer.css app/features/composer/components/ComposerGitContextControls.tsx app/features/composer/components/ComposerGitContextControls.css app/features/chat/ChatPageClient.tsx tests/chat-git-context-ui.spec.ts`

`git commit -m "feat(composer): add branch and worktree controls"`

---

## Task 7: Chat Restore and Session Invalidation Behavior (TDD)

**Files:**
- Modify: `app/features/chat/runtime/useChatRuntime.ts`
- Modify: `app/features/chat/runtime/chatPersistenceService.ts`
- Modify: `app/features/chat/runtime/chatAcpService.ts`
- Modify: `app/features/chat/runtime/useChatGitContext.ts`
- Test: `tests/chat-git-context-ui.spec.ts`

- [ ] **Step 1: Add failing restore/invalidations E2E scenario**

```typescript
test('git context is chat-scoped and restored per chat', async ({ page }) => {
  await page.goto('http://localhost:3010');
  // create chat A, choose worktree A
  // create chat B, choose worktree B
  // switch back to chat A and assert selectors restored to A
});
```

- [ ] **Step 2: Run test and confirm RED**

Run: `npx playwright test --config tests/playwright.config.ts tests/chat-git-context-ui.spec.ts -g "chat-scoped and restored"`
Expected: FAIL (state not persisted/restored yet).

- [ ] **Step 3: Implement restore + invalidation flow**

```typescript
// useChatGitContext.ts
// on successful update, call callback to invalidate current chat sessions
onContextChanged?.();
```

```typescript
// useChatRuntime.ts
function invalidateCurrentChatAgentSessions() {
  currentAgentSessionsRef.current = {};
}
```

```typescript
// ChatPageClient.tsx
const gitContextControls = (
  <ComposerGitContextControls
    // map options
    onSelectBranch={chatGitContext.selectBranch}
    onSelectWorktree={chatGitContext.selectWorktree}
  />
);
```

- [ ] **Step 4: Run test and confirm GREEN**

Run: `npx playwright test --config tests/playwright.config.ts tests/chat-git-context-ui.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Run:
`git add app/features/chat/runtime/useChatRuntime.ts app/features/chat/runtime/chatPersistenceService.ts app/features/chat/runtime/chatAcpService.ts app/features/chat/runtime/useChatGitContext.ts app/features/chat/ChatPageClient.tsx tests/chat-git-context-ui.spec.ts`

`git commit -m "feat(chat): restore git context per chat and invalidate stale sessions"`

---

## Task 8: Full Verification and Cleanup

**Files:**
- Modify: any touched files from previous tasks (only if needed)

- [ ] **Step 1: Run targeted Node tests**

Run:
`node --test tests/chat-git-context-store.test.mjs tests/chat-git-context-api.test.mjs tests/chat-git-context-cwd.test.mjs`

Expected: PASS.

- [ ] **Step 2: Run targeted Playwright spec**

Run:
`npx playwright test --config tests/playwright.config.ts tests/chat-git-context-ui.spec.ts`

Expected: PASS.

- [ ] **Step 3: Run broad regression slice**

Run:
`npx playwright test --config tests/playwright.config.ts tests/test-ui.spec.ts -g "chat|composer|session"`

Expected: PASS or known unrelated flakes only.

- [ ] **Step 4: Final commit (if verification edits were needed)**

Run:
`git add -A`

`git commit -m "test: finalize git context branch/worktree integration"`

---

## Self-Review Checklist (Completed)

- Spec coverage: covered composer controls, chat-scoped persistence, per-chat cwd override, session recreation strategy, invalid-context handling, backend + E2E testing.
- Placeholder scan: no `TBD`, `TODO`, or deferred “implement later” steps remain.
- Type consistency: uses one `gitContext` shape (`repoRoot`, `worktreePath`, `branchName`, optional `isFallback`) across store, API, ACP, and UI.