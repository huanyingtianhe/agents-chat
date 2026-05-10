# Path Comment Review Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route approved file comments into one reusable review chat per file path, process them serially in that chat's normal ACP session, and queue later approvals until the current review turn finishes.

**Architecture:** Add path-review-chat helpers shared by API and UI, extend comment status with `queued`, and make approval create/reuse a deterministic review chat instead of creating one chat per comment. The frontend dispatches approved comments into the returned review chat via `dispatchToAgent(..., { chatId })`, resolves only the processing comment for that review chat, and starts the oldest queued comment next.

**Tech Stack:** Next.js App Router API routes, React client component in `app/page.tsx`, `better-sqlite3` persistence in `lib/chatStore.ts`, Playwright E2E/API tests.

---

## File structure

- Create `lib/commentReview.ts`: pure shared helpers for review chat IDs/names and prompt creation.
- Modify `lib/chatStore.ts`: add `queued` to `FileComment.status`, add query helpers for processing/queued comments, and add a helper to append a message to an existing or new review chat.
- Modify `app/api/comments/approve/route.ts`: reuse the path review chat, set status to `processing` or `queued`, and return the status.
- Modify `app/api/comments/route.ts`: add `resolve` and `start-next-queued` actions.
- Modify `app/page.tsx`: route comment dispatch to the review chat, show queued state, resolve one processing comment, and start the next queued comment after completion.
- Modify `test/test-file-comments.spec.ts`: add API coverage for reuse/queueing and UI coverage for the stuck-processing dispatch bug.

Do not run `npm run build` for this work. Use `npx tsc --noEmit` and Playwright tests.

---

### Task 1: Add failing API coverage for review chat reuse and queueing

**Files:**
- Modify: `test/test-file-comments.spec.ts`

- [ ] **Step 1: Add the failing API test**

Add this test after the existing `approve creates a chat` API test:

```ts
  test('approve reuses one review chat per file path and queues while processing', async ({ page }) => {
    async function createComment(content: string) {
      return page.evaluate(async ({ agentId, filePath, content }: { agentId: string; filePath: string; content: string }) => {
        const r = await fetch('/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create',
            agentId,
            filePath,
            rangeStartLine: 1,
            rangeEndLine: 1,
            content,
            authorType: 'user',
          }),
        });
        return r.json();
      }, { agentId: TEST_AGENT, filePath: TEST_FILE, content });
    }

    const firstCreate = await createComment('First queued review comment');
    const secondCreate = await createComment('Second queued review comment');
    expect(firstCreate.ok).toBe(true);
    expect(secondCreate.ok).toBe(true);

    const firstApprove = await page.evaluate(async ({ commentId }: { commentId: string }) => {
      const r = await fetch('/api/comments/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId, fileContent: 'line1\nline2\nline3' }),
      });
      return r.json();
    }, { commentId: firstCreate.id });

    expect(firstApprove.ok).toBe(true);
    expect(firstApprove.status).toBe('processing');
    expect(firstApprove.chatId).toContain('comment-review:');
    expect(firstApprove.chatName).toBe(`Review: ${TEST_FILE}`);
    expect(firstApprove.prompt).toContain('First queued review comment');

    const secondApprove = await page.evaluate(async ({ commentId }: { commentId: string }) => {
      const r = await fetch('/api/comments/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId, fileContent: 'line1\nline2\nline3' }),
      });
      return r.json();
    }, { commentId: secondCreate.id });

    expect(secondApprove.ok).toBe(true);
    expect(secondApprove.chatId).toBe(firstApprove.chatId);
    expect(secondApprove.status).toBe('queued');
    expect(secondApprove.prompt).toContain('Second queued review comment');

    const chatBefore = await page.evaluate(async (chatId: string) => {
      const r = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`);
      return r.json();
    }, firstApprove.chatId);
    expect(chatBefore.ok).toBe(true);
    expect(chatBefore.chat.messages.filter((m: { type: string }) => m.type === 'user')).toHaveLength(1);

    const listedBefore = await page.evaluate(async ({ agentId, filePath }: { agentId: string; filePath: string }) => {
      const r = await fetch(`/api/comments?agentId=${encodeURIComponent(agentId)}&filePath=${encodeURIComponent(filePath)}`);
      return r.json();
    }, { agentId: TEST_AGENT, filePath: TEST_FILE });
    const firstBefore = listedBefore.comments.find((c: { id: string }) => c.id === firstCreate.id);
    const secondBefore = listedBefore.comments.find((c: { id: string }) => c.id === secondCreate.id);
    expect(firstBefore.status).toBe('processing');
    expect(secondBefore.status).toBe('queued');

    const resolveRes = await page.evaluate(async (commentId: string) => {
      const r = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', commentId }),
      });
      return r.json();
    }, firstCreate.id);
    expect(resolveRes.ok).toBe(true);

    const startNext = await page.evaluate(async ({ chatId }: { chatId: string }) => {
      const r = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start-next-queued', chatId, fileContent: 'line1\nline2\nline3' }),
      });
      return r.json();
    }, { chatId: firstApprove.chatId });

    expect(startNext.ok).toBe(true);
    expect(startNext.started).toBe(true);
    expect(startNext.commentId).toBe(secondCreate.id);
    expect(startNext.status).toBe('processing');
    expect(startNext.chatId).toBe(firstApprove.chatId);

    const chatAfter = await page.evaluate(async (chatId: string) => {
      const r = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`);
      return r.json();
    }, firstApprove.chatId);
    expect(chatAfter.chat.messages.filter((m: { type: string }) => m.type === 'user')).toHaveLength(2);

    for (const id of [firstCreate.id, secondCreate.id]) {
      await page.evaluate(async (commentId: string) => {
        await fetch('/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete', commentId }),
        });
      }, id);
    }
  });
```

- [ ] **Step 2: Run the API test and verify it fails**

Run:

```powershell
npx playwright test --config test\playwright.config.ts --grep "approve reuses one review chat"
```

Expected: FAIL because `/api/comments/approve` still creates a per-comment chat and `/api/comments` does not know `resolve` or `start-next-queued`.

- [ ] **Step 3: Commit the failing test**

```powershell
git add test\test-file-comments.spec.ts
git commit -m "test: cover queued path review comments`n`nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Add shared review-chat helpers and comment queue storage helpers

**Files:**
- Create: `lib/commentReview.ts`
- Modify: `lib/chatStore.ts`

- [ ] **Step 1: Create `lib/commentReview.ts`**

```ts
import type { FileComment, StoredMessage } from './chatStore';

export const COMMENT_REVIEW_CHAT_PREFIX = 'comment-review:';

export function normalizeReviewFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function getCommentReviewChatId(filePath: string): string {
  return `${COMMENT_REVIEW_CHAT_PREFIX}${encodeURIComponent(normalizeReviewFilePath(filePath))}`;
}

export function getCommentReviewChatName(filePath: string): string {
  const normalized = normalizeReviewFilePath(filePath);
  const displayPath = normalized.length > 90 ? `...${normalized.slice(-87)}` : normalized;
  return `Review: ${displayPath}`;
}

export function buildCommentReviewPrompt(comment: Pick<FileComment, 'filePath' | 'rangeStartLine' | 'rangeEndLine' | 'content'>, fileContent?: string): string {
  const rangeLabel = comment.rangeStartLine != null
    ? comment.rangeEndLine != null && comment.rangeEndLine !== comment.rangeStartLine
      ? `lines ${comment.rangeStartLine}-${comment.rangeEndLine}`
      : `line ${comment.rangeStartLine}`
    : 'the file';

  const contextSnippet = fileContent
    ? `\n\nRelevant file content (${comment.filePath}):\n\`\`\`\n${fileContent}\n\`\`\``
    : '';

  return `Review comment on ${comment.filePath} (${rangeLabel}):\n\n"${comment.content}"${contextSnippet}\n\nPlease address this comment by making the necessary changes.`;
}

export function createCommentReviewUserMessage(prompt: string, now = Date.now()): StoredMessage {
  return {
    id: `comment-review-${now}`,
    type: 'user',
    content: prompt,
    ts: now,
  };
}
```

- [ ] **Step 2: Update comment status types in `lib/chatStore.ts`**

Change both `FileComment.status` and `updateFileCommentStatus` to include `queued`:

```ts
status: 'active' | 'queued' | 'processing' | 'resolved';
```

```ts
status: 'active' | 'queued' | 'processing' | 'resolved',
```

- [ ] **Step 3: Add chat/comment helpers to `lib/chatStore.ts`**

Add these exports after `saveChat`:

```ts
export async function appendMessageToChat(userId: string, chat: Pick<StoredChat, 'id' | 'name'>, message: StoredMessage): Promise<StoredChat> {
  const existing = await getChat(userId, chat.id);
  const next: StoredChat = existing
    ? {
        ...existing,
        name: existing.name || chat.name,
        ts: existing.ts,
        messages: [...existing.messages, message],
      }
    : {
        id: chat.id,
        name: chat.name,
        ts: Date.now(),
        messages: [message],
        agentSessions: {},
      };
  await saveChat(userId, next);
  return next;
}

export async function ensureChat(userId: string, chat: Pick<StoredChat, 'id' | 'name'>): Promise<StoredChat> {
  const existing = await getChat(userId, chat.id);
  if (existing) return existing;
  const next: StoredChat = { id: chat.id, name: chat.name, ts: Date.now(), messages: [], agentSessions: {} };
  await saveChat(userId, next);
  return next;
}
```

Add these exports after `updateFileCommentStatus`:

```ts
function mapFileCommentRow(r: any, replies: FileCommentReply[] = []): FileComment {
  return {
    id: r.id,
    agentId: r.agent_id,
    filePath: r.file_path,
    rangeStartLine: r.range_start_line,
    rangeEndLine: r.range_end_line,
    rangeStartChar: r.range_start_char,
    rangeEndChar: r.range_end_char,
    content: r.content,
    authorType: r.author_type,
    authorName: r.author_name,
    status: r.status,
    linkedChatId: r.linked_chat_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    replies,
  };
}

export async function getProcessingCommentForChat(chatId: string): Promise<FileComment | null> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM file_comments WHERE linked_chat_id = ? AND status = 'processing' ORDER BY updated_at ASC LIMIT 1").get(chatId) as any;
  return row ? mapFileCommentRow(row) : null;
}

export async function getOldestQueuedCommentForChat(chatId: string): Promise<FileComment | null> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM file_comments WHERE linked_chat_id = ? AND status = 'queued' ORDER BY updated_at ASC, created_at ASC LIMIT 1").get(chatId) as any;
  return row ? mapFileCommentRow(row) : null;
}
```

Then update `listFileComments` and `getFileComment` to use `mapFileCommentRow` to avoid duplicate mapping code:

```ts
return rows.map(r => mapFileCommentRow(r, (replyStmt.all(r.id) as any[]).map(rp => ({
  id: rp.id,
  commentId: rp.comment_id,
  content: rp.content,
  authorType: rp.author_type,
  authorName: rp.author_name,
  createdAt: rp.created_at,
}))));
```

```ts
return mapFileCommentRow(r, replies);
```

- [ ] **Step 4: Run TypeScript**

Run:

```powershell
npx tsc --noEmit
```

Expected: PASS. If it fails on implicit `any`, type the local row variables as `any` consistently with the existing file.

- [ ] **Step 5: Commit store helpers**

```powershell
git add lib\commentReview.ts lib\chatStore.ts
git commit -m "feat: add comment review chat storage helpers`n`nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Implement review-chat approval and queued-comment API actions

**Files:**
- Modify: `app/api/comments/approve/route.ts`
- Modify: `app/api/comments/route.ts`

- [ ] **Step 1: Replace approve route imports**

In `app/api/comments/approve/route.ts`, use:

```ts
import {
  appendMessageToChat,
  ensureChat,
  getFileComment,
  getProcessingCommentForChat,
  updateFileCommentStatus,
} from '@/lib/chatStore';
import {
  buildCommentReviewPrompt,
  createCommentReviewUserMessage,
  getCommentReviewChatId,
  getCommentReviewChatName,
} from '@/lib/commentReview';
```

Remove `saveChat` and `StoredChat` imports.

- [ ] **Step 2: Replace the approve implementation after `comment` is loaded**

Replace the prompt/chat creation block with:

```ts
  const userId = getUserId(token);
  const chatId = getCommentReviewChatId(comment.filePath);
  const chatName = getCommentReviewChatName(comment.filePath);
  const prompt = buildCommentReviewPrompt(comment, fileContent);
  const existingProcessingComment = await getProcessingCommentForChat(chatId);
  const status = existingProcessingComment ? 'queued' : 'processing';

  if (status === 'processing') {
    await appendMessageToChat(userId, { id: chatId, name: chatName }, createCommentReviewUserMessage(prompt));
  } else {
    await ensureChat(userId, { id: chatId, name: chatName });
  }

  await updateFileCommentStatus(commentId, status, chatId);

  return NextResponse.json({
    ok: true,
    chatId,
    chatName,
    prompt,
    agentId: comment.agentId,
    status,
  });
```

- [ ] **Step 3: Add imports to `app/api/comments/route.ts`**

Extend the existing `@/lib/chatStore` import:

```ts
  appendMessageToChat,
  getOldestQueuedCommentForChat,
  updateFileCommentStatus,
```

Add:

```ts
import {
  buildCommentReviewPrompt,
  createCommentReviewUserMessage,
  getCommentReviewChatName,
} from '@/lib/commentReview';
```

Add this helper near `getUserName`:

```ts
function getUserId(token: any): string {
  return token?.email || token?.name || token?.sub || 'anonymous';
}
```

- [ ] **Step 4: Add `resolve` action**

Insert before the existing `reject` action:

```ts
  if (action === 'resolve') {
    const { commentId } = body;
    if (!commentId) return NextResponse.json({ ok: false, error: 'commentId required' }, { status: 400 });
    await updateFileCommentStatus(commentId, 'resolved');
    return NextResponse.json({ ok: true });
  }
```

- [ ] **Step 5: Add `start-next-queued` action**

Insert before the final `unknown action` response:

```ts
  if (action === 'start-next-queued') {
    const { chatId, fileContent } = body;
    if (typeof chatId !== 'string' || !chatId) {
      return NextResponse.json({ ok: false, error: 'chatId required' }, { status: 400 });
    }

    const nextComment = await getOldestQueuedCommentForChat(chatId);
    if (!nextComment) {
      return NextResponse.json({ ok: true, started: false });
    }

    const prompt = buildCommentReviewPrompt(nextComment, typeof fileContent === 'string' ? fileContent : undefined);
    const chatName = getCommentReviewChatName(nextComment.filePath);
    await appendMessageToChat(getUserId(token), { id: chatId, name: chatName }, createCommentReviewUserMessage(prompt));
    await updateFileCommentStatus(nextComment.id, 'processing', chatId);

    return NextResponse.json({
      ok: true,
      started: true,
      commentId: nextComment.id,
      chatId,
      chatName,
      prompt,
      agentId: nextComment.agentId,
      status: 'processing',
    });
  }
```

- [ ] **Step 6: Run the API test**

Run:

```powershell
npx playwright test --config test\playwright.config.ts --grep "approve reuses one review chat"
```

Expected: PASS.

- [ ] **Step 7: Commit API implementation**

```powershell
git add app\api\comments\approve\route.ts app\api\comments\route.ts
git commit -m "feat: queue comments in path review chats`n`nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Add failing UI regression for dispatching approved comments into the review chat

**Files:**
- Modify: `test/test-file-comments.spec.ts`

- [ ] **Step 1: Add UI regression test**

Add this test in the `File Comments UI` describe block:

```ts
  test('approved comment dispatches to the path review chat instead of the current chat', async ({ page }) => {
    let sendBody: Record<string, unknown> | null = null;

    await page.route('**/api/acp', async route => {
      const body = route.request().postDataJSON() as { action?: string } | null;
      if (body?.action === 'list-agents') {
        await route.fulfill({
          json: {
            ok: true,
            agents: [{ id: 'review-agent', name: 'Review Agent', cwd: 'Q:\\Repos\\Agents-Chat' }],
          },
        });
        return;
      }
      if (body?.action === 'send') {
        sendBody = body as Record<string, unknown>;
        await route.fulfill({
          json: {
            ok: true,
            sessionId: 'review-session',
            turn: { id: 'turn-review' },
          },
        });
        return;
      }
      if (body?.action === 'poll') {
        await route.fulfill({
          json: {
            ok: true,
            activeTurn: {
              done: true,
              fullText: 'Handled the review comment.',
              phase: 'replying',
              events: [{ type: 'text_chunk', ts: Date.now(), text: 'Handled the review comment.' }],
            },
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.route('**/api/markdown?**', async route => {
      const url = new URL(route.request().url());
      const filePath = url.searchParams.get('path');
      if (filePath) {
        await route.fulfill({
          json: {
            path: filePath,
            content: 'line one\nline two\nline three',
            kind: 'markdown',
            mtime: new Date().toISOString(),
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          files: [{ path: 'review-path.md', name: 'review-path.md', mtime: new Date().toISOString() }],
        },
      });
    });

    const reviewChatId = 'comment-review:review-path.md';
    const comments = [{
      id: 'comment-dispatch-id',
      agentId: 'review-agent',
      filePath: 'review-path.md',
      rangeStartLine: 1,
      rangeEndLine: 1,
      rangeStartChar: null,
      rangeEndChar: null,
      content: 'Please handle this comment',
      authorType: 'user',
      authorName: 'Test User',
      status: 'active',
      linkedChatId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      replies: [],
    }];

    await page.route('**/api/comments**', async route => {
      if (route.request().url().includes('/api/comments/approve')) {
        await route.fulfill({
          json: {
            ok: true,
            chatId: reviewChatId,
            chatName: 'Review: review-path.md',
            prompt: 'Review comment on review-path.md (line 1):\n\n"Please handle this comment"\n\nPlease address this comment by making the necessary changes.',
            agentId: 'review-agent',
            status: 'processing',
          },
        });
        return;
      }
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, comments } });
        return;
      }
      const body = route.request().postDataJSON() as { action?: string; commentId?: string };
      if (body.action === 'resolve' && body.commentId === 'comment-dispatch-id') {
        comments[0] = { ...comments[0], status: 'resolved', linkedChatId: reviewChatId };
      }
      await route.fulfill({ json: { ok: true } });
    });

    await page.goto(`${BASE}/login`);
    await page.fill('input[placeholder="Admin username"]', ADMIN_USER);
    await page.fill('input[placeholder="Password"]', ADMIN_PASS);
    await page.click('button[type="submit"]');
    await page.waitForSelector('.chatContainer', { timeout: 30000 });

    const currentChatId = await page.evaluate(() => (window as any).__TEST_getCurrentChatId?.());
    expect(currentChatId).toBeTruthy();
    expect(currentChatId).not.toBe(reviewChatId);

    await page.click('button.leftSidebarTab:has-text("Files")');
    await page.selectOption('.remoteAgentSelect', 'review-agent');
    await page.locator('.mdTreeFile', { hasText: 'review-path.md' }).click();
    await page.locator('.mdEditorToolbarRight .mdEditorBtn', { hasText: '💬' }).click();
    await page.locator('.commentCard', { hasText: 'Please handle this comment' }).click();
    await page.locator('.commentActionBtn.approve').click();

    await expect.poll(() => sendBody?.chatId).toBe(reviewChatId);
    expect(sendBody?.chatId).not.toBe(currentChatId);
    await expect(page.locator('.commentResolved')).toContainText('Resolved');
  });
```

- [ ] **Step 2: Run the UI regression and verify it fails**

Run:

```powershell
npx playwright test --config test\playwright.config.ts --grep "approved comment dispatches to the path review chat"
```

Expected before the frontend fix: FAIL because `sendBody.chatId` is the current chat id, not `reviewChatId`.

- [ ] **Step 3: Commit the failing UI test**

```powershell
git add test\test-file-comments.spec.ts
git commit -m "test: cover review chat dispatch for approved comments`n`nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Implement frontend queue handling and precise resolution

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Update `FileComment.status` type**

Change the type near the top of `app/page.tsx`:

```ts
status: 'active' | 'queued' | 'processing' | 'resolved';
```

- [ ] **Step 2: Add a current comments ref**

After the `fileComments` state:

```ts
  const [fileComments, setFileComments] = useState<FileComment[]>([]);
  const fileCommentsRef = useRef<FileComment[]>([]);
  fileCommentsRef.current = fileComments;
```

- [ ] **Step 3: Add helper to load a chat into frontend cache**

Add after `updateMessage`:

```ts
  async function loadChatIntoCache(chatId: string) {
    try {
      const res = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`);
      const data = await res.json();
      if (data.ok && data.chat) {
        setMessagesForChat(chatId, data.chat.messages || []);
        setChatHistory(prev => {
          const entry = {
            id: data.chat.id,
            name: data.chat.name || chatId,
            ts: data.chat.ts || Date.now(),
            agentSessions: data.chat.agentSessions || {},
          };
          if (prev.some(c => c.id === chatId)) return prev.map(c => c.id === chatId ? entry : c);
          return normalizeChatHistory([entry, ...prev]);
        });
      }
    } catch (err) {
      console.error('Failed to load review chat', err);
    }
  }
```

- [ ] **Step 4: Add helpers to resolve and start queued comments**

Add after `handleApproveComment` or just before it:

```ts
  function getContextForComment(comment: FileComment) {
    const lines = mdFileContent.split('\n');
    const startLine = Math.max(0, (comment.rangeStartLine ?? 1) - 3);
    const endLine = Math.min(lines.length, (comment.rangeEndLine ?? comment.rangeStartLine ?? 1) + 3);
    return lines.slice(startLine, endLine).join('\n');
  }

  async function startNextQueuedComment(chatId: string) {
    const queuedComment = fileCommentsRef.current.find(c => c.linkedChatId === chatId && c.status === 'queued');
    const fileContent = queuedComment ? getContextForComment(queuedComment) : mdFileContent;
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start-next-queued', chatId, fileContent }),
      });
      const data = await res.json();
      if (!data.ok || !data.started) return;
      setFileComments(prev => prev.map(c =>
        c.id === data.commentId ? { ...c, status: 'processing' as const, linkedChatId: data.chatId } : c
      ));
      await loadChatIntoCache(data.chatId);
      if (data.agentId && data.prompt) {
        await dispatchToAgent(data.agentId, data.prompt, `comment-${data.commentId}`, 'worker', { chatId: data.chatId });
      }
    } catch (err) {
      console.error('Failed to start queued comment', err);
    }
  }

  async function resolveProcessingCommentForChat(chatId: string) {
    const commentToResolve = fileCommentsRef.current.find(c => c.linkedChatId === chatId && c.status === 'processing');
    if (!commentToResolve) return;
    setFileComments(prev => prev.map(c =>
      c.id === commentToResolve.id ? { ...c, status: 'resolved' as const } : c
    ));
    try {
      await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', commentId: commentToResolve.id }),
      });
    } catch (err) {
      console.error('Failed to resolve comment', err);
    }
    await startNextQueuedComment(chatId);
  }
```

- [ ] **Step 5: Replace `handleApproveComment` body**

Use the context helper and route dispatch to the returned review chat:

```ts
  async function handleApproveComment(commentId: string) {
    const comment = fileComments.find(c => c.id === commentId);
    if (!comment) return;

    const contextContent = getContextForComment(comment);

    try {
      const res = await fetch('/api/comments/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId, fileContent: contextContent }),
      });
      const data = await res.json();
      if (!data.ok) {
        console.error('Failed to approve comment', data.error || 'unknown error');
        return;
      }

      setFileComments(prev => prev.map(c =>
        c.id === commentId ? { ...c, status: data.status as FileComment['status'], linkedChatId: data.chatId } : c
      ));
      await loadChatIntoCache(data.chatId);

      if (data.status === 'processing' && data.agentId && data.prompt) {
        await dispatchToAgent(data.agentId, data.prompt, `comment-${commentId}`, 'worker', { chatId: data.chatId });
      }
    } catch (err) {
      console.error('Failed to approve comment', err);
    }
  }
```

- [ ] **Step 6: Replace auto-resolve block in `pollAcpAgent`**

Replace the current block that maps every processing comment linked to `effectiveChatId` with:

```ts
          if (effectiveChatId) {
            void resolveProcessingCommentForChat(effectiveChatId);
          }
```

- [ ] **Step 7: Update queued comment rendering**

Change the card class:

```tsx
className={`commentCard ${isSelected ? 'selected' : ''} ${c.status === 'resolved' ? 'resolved' : ''} ${c.status === 'processing' ? 'processing' : ''} ${c.status === 'queued' ? 'queued' : ''}`}
```

Change the expanded condition:

```tsx
{isSelected || c.status === 'processing' || c.status === 'queued' ? (
```

Add queued display after the processing block:

```tsx
                                {c.status === 'queued' && (
                                  <div className="commentProcessing queued" onClick={(e) => {
                                    e.stopPropagation();
                                    if (c.linkedChatId) {
                                      setLeftSidebarTab('chats');
                                      const entry = chatHistory.find(ch => ch.id === c.linkedChatId);
                                      if (entry) void loadChat(c.linkedChatId!);
                                    }
                                  }}>
                                    <span>⏳ Queued… (click to view)</span>
                                  </div>
                                )}
```

Add CSS near `.commentCard.processing`:

```css
        .commentCard.queued {
          border-color: rgba(245, 158, 11, 0.45);
          background: rgba(245, 158, 11, 0.08);
        }
        .commentProcessing.queued {
          color: var(--text-secondary);
        }
```

- [ ] **Step 8: Run the UI regression**

Run:

```powershell
npx playwright test --config test\playwright.config.ts --grep "approved comment dispatches to the path review chat"
```

Expected: PASS.

- [ ] **Step 9: Run TypeScript**

Run:

```powershell
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 10: Commit frontend implementation**

```powershell
git add app\page.tsx
git commit -m "fix: route approved comments to review chats`n`nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Validate the full file comments flow and push

**Files:**
- Test: `test/test-file-comments.spec.ts`
- Verify: `app/page.tsx`, `app/api/comments/approve/route.ts`, `app/api/comments/route.ts`, `lib/chatStore.ts`, `lib/commentReview.ts`

- [ ] **Step 1: Run focused API tests**

```powershell
npx playwright test --config test\playwright.config.ts --grep "approve reuses one review chat"
```

Expected: 1 passed.

- [ ] **Step 2: Run focused UI regression**

```powershell
npx playwright test --config test\playwright.config.ts --grep "approved comment dispatches to the path review chat"
```

Expected: 1 passed.

- [ ] **Step 3: Run the file comments suite**

```powershell
npx playwright test --config test\playwright.config.ts test\test-file-comments.spec.ts
```

Expected: all tests in `test-file-comments.spec.ts` pass.

- [ ] **Step 4: Run TypeScript**

```powershell
npx tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 5: Confirm no generated file noise**

```powershell
git --no-pager status --short
```

Expected: only intentional source/test files are modified. If `next-env.d.ts` changes, restore only that generated file before committing:

```powershell
git restore -- next-env.d.ts
```

- [ ] **Step 6: Commit remaining verification-safe changes**

If any changes remain after the previous task commits, commit them:

```powershell
git add app\page.tsx app\api\comments\approve\route.ts app\api\comments\route.ts lib\chatStore.ts lib\commentReview.ts test\test-file-comments.spec.ts
git commit -m "test: verify path review comment queue`n`nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 7: Push**

```powershell
git push origin feat/file-comments
```

Expected: push succeeds.
