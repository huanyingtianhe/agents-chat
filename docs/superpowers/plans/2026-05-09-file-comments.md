# File Comments with Review Sidebar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Word-style comment/review system to the file tab with a collapsible right sidebar, threaded replies, and approve-to-agent workflow.

**Architecture:** Three layers — (1) SQLite data layer for comments in `lib/chatStore.ts`, (2) REST API endpoints at `app/api/comments/`, (3) Frontend comment sidebar with gutter dots, highlights, connector lines, and action buttons in `app/page.tsx`. Agent comments arrive as tagged JSON blocks in agent responses, parsed by the existing polling loop.

**Tech Stack:** Next.js 16 App Router, React 19, better-sqlite3, styled-jsx, crypto.randomBytes for IDs

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/chatStore.ts` | Add `file_comments` + `file_comment_replies` tables; CRUD functions |
| `app/api/comments/route.ts` | New — GET (list) + POST (create/reply/reject/delete) |
| `app/api/comments/approve/route.ts` | New — POST approve flow (create chat + dispatch agent) |
| `app/page.tsx` | Comment sidebar UI, gutter dots, highlights, SVG connectors, text selection, agent comment parser, state management, CSS |

---

### Task 1: Comment Data Layer — SQLite Tables + CRUD

**Files:**
- Modify: `lib/chatStore.ts`

- [ ] **Step 1: Add table creation SQL to `getDb()`**

In `lib/chatStore.ts`, inside the `_db.exec(...)` block (after line 82, before the closing `);` on line 83), add:

```sql
CREATE TABLE IF NOT EXISTS file_comments (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  range_start_line INTEGER,
  range_end_line INTEGER,
  range_start_char INTEGER,
  range_end_char INTEGER,
  content TEXT NOT NULL,
  author_type TEXT NOT NULL,
  author_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  linked_chat_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_file_comments_agent_file ON file_comments(agent_id, file_path);

CREATE TABLE IF NOT EXISTS file_comment_replies (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES file_comments(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  author_type TEXT NOT NULL,
  author_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_file_comment_replies_comment ON file_comment_replies(comment_id);
```

- [ ] **Step 2: Add exported types**

After the `SharedChat` type (after line 41), add:

```ts
export type FileComment = {
  id: string;
  agentId: string;
  filePath: string;
  rangeStartLine: number | null;
  rangeEndLine: number | null;
  rangeStartChar: number | null;
  rangeEndChar: number | null;
  content: string;
  authorType: 'agent' | 'user';
  authorName: string | null;
  status: 'active' | 'processing' | 'resolved';
  linkedChatId: string | null;
  createdAt: string;
  updatedAt: string;
  replies: FileCommentReply[];
};

export type FileCommentReply = {
  id: string;
  commentId: string;
  content: string;
  authorType: 'agent' | 'user';
  authorName: string | null;
  createdAt: string;
};
```

- [ ] **Step 3: Add CRUD functions**

After the `setLastChatId` function (after line 195), add the following block before the migration section:

```ts
/* ─────────── File comments ─────────── */

/** List all comments for a given agent + file, with replies. */
export async function listFileComments(agentId: string, filePath: string): Promise<FileComment[]> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM file_comments WHERE agent_id = ? AND file_path = ? ORDER BY range_start_line ASC, created_at ASC'
  ).all(agentId, filePath) as any[];

  const replyStmt = db.prepare(
    'SELECT * FROM file_comment_replies WHERE comment_id = ? ORDER BY created_at ASC'
  );

  return rows.map(r => ({
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
    replies: (replyStmt.all(r.id) as any[]).map(rp => ({
      id: rp.id,
      commentId: rp.comment_id,
      content: rp.content,
      authorType: rp.author_type,
      authorName: rp.author_name,
      createdAt: rp.created_at,
    })),
  }));
}

/** Create a new file comment. Returns the created comment ID. */
export async function createFileComment(comment: {
  agentId: string;
  filePath: string;
  rangeStartLine?: number;
  rangeEndLine?: number;
  rangeStartChar?: number;
  rangeEndChar?: number;
  content: string;
  authorType: 'agent' | 'user';
  authorName?: string;
}): Promise<string> {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO file_comments (id, agent_id, file_path, range_start_line, range_end_line, range_start_char, range_end_char, content, author_type, author_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    comment.agentId,
    comment.filePath,
    comment.rangeStartLine ?? null,
    comment.rangeEndLine ?? null,
    comment.rangeStartChar ?? null,
    comment.rangeEndChar ?? null,
    comment.content,
    comment.authorType,
    comment.authorName ?? null,
  );
  return id;
}

/** Add a reply to a comment. Returns the reply ID. */
export async function addFileCommentReply(reply: {
  commentId: string;
  content: string;
  authorType: 'agent' | 'user';
  authorName?: string;
}): Promise<string> {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO file_comment_replies (id, comment_id, content, author_type, author_name)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, reply.commentId, reply.content, reply.authorType, reply.authorName ?? null);
  // Touch parent comment updated_at
  db.prepare("UPDATE file_comments SET updated_at = datetime('now') WHERE id = ?").run(reply.commentId);
  return id;
}

/** Update a comment's status and optionally set linked_chat_id. */
export async function updateFileCommentStatus(
  commentId: string,
  status: 'active' | 'processing' | 'resolved',
  linkedChatId?: string,
): Promise<void> {
  const db = getDb();
  if (linkedChatId !== undefined) {
    db.prepare("UPDATE file_comments SET status = ?, linked_chat_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, linkedChatId, commentId);
  } else {
    db.prepare("UPDATE file_comments SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, commentId);
  }
}

/** Get a single comment by ID (with replies). */
export async function getFileComment(commentId: string): Promise<FileComment | null> {
  const db = getDb();
  const r = db.prepare('SELECT * FROM file_comments WHERE id = ?').get(commentId) as any;
  if (!r) return null;
  const replies = (db.prepare('SELECT * FROM file_comment_replies WHERE comment_id = ? ORDER BY created_at ASC').all(commentId) as any[])
    .map(rp => ({
      id: rp.id, commentId: rp.comment_id, content: rp.content,
      authorType: rp.author_type, authorName: rp.author_name, createdAt: rp.created_at,
    }));
  return {
    id: r.id, agentId: r.agent_id, filePath: r.file_path,
    rangeStartLine: r.range_start_line, rangeEndLine: r.range_end_line,
    rangeStartChar: r.range_start_char, rangeEndChar: r.range_end_char,
    content: r.content, authorType: r.author_type, authorName: r.author_name,
    status: r.status, linkedChatId: r.linked_chat_id,
    createdAt: r.created_at, updatedAt: r.updated_at, replies,
  };
}

/** Delete a comment and all its replies. */
export async function deleteFileComment(commentId: string): Promise<void> {
  const db = getDb();
  db.prepare('DELETE FROM file_comment_replies WHERE comment_id = ?').run(commentId);
  db.prepare('DELETE FROM file_comments WHERE id = ?').run(commentId);
}
```

- [ ] **Step 4: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No type errors related to chatStore

- [ ] **Step 5: Commit**

```bash
git add lib/chatStore.ts
git commit -m "feat: add file_comments tables and CRUD to chatStore"
```

---

### Task 2: Comments API — GET + POST CRUD Endpoints

**Files:**
- Create: `app/api/comments/route.ts`

- [ ] **Step 1: Create the comments API route**

Create `app/api/comments/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import {
  listFileComments,
  createFileComment,
  addFileCommentReply,
  updateFileCommentStatus,
  deleteFileComment,
} from '@/lib/chatStore';

export const dynamic = 'force-dynamic';

function getUserName(token: any): string {
  return token?.name || token?.email || 'anonymous';
}

export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const agentId = req.nextUrl.searchParams.get('agentId');
  const filePath = req.nextUrl.searchParams.get('filePath');
  if (!agentId || !filePath) {
    return NextResponse.json({ ok: false, error: 'agentId and filePath required' }, { status: 400 });
  }

  const comments = await listFileComments(agentId, filePath);
  return NextResponse.json({ ok: true, comments });
}

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { action } = body;

  if (action === 'create') {
    const { agentId, filePath, rangeStartLine, rangeEndLine, rangeStartChar, rangeEndChar, content, authorType, authorName } = body;
    if (!agentId || !filePath || !content || !authorType) {
      return NextResponse.json({ ok: false, error: 'missing required fields' }, { status: 400 });
    }
    const id = await createFileComment({
      agentId, filePath,
      rangeStartLine, rangeEndLine, rangeStartChar, rangeEndChar,
      content,
      authorType,
      authorName: authorName || getUserName(token),
    });
    return NextResponse.json({ ok: true, id });
  }

  if (action === 'reply') {
    const { commentId, content, authorType, authorName } = body;
    if (!commentId || !content || !authorType) {
      return NextResponse.json({ ok: false, error: 'missing required fields' }, { status: 400 });
    }
    const id = await addFileCommentReply({
      commentId, content, authorType,
      authorName: authorName || getUserName(token),
    });
    return NextResponse.json({ ok: true, id });
  }

  if (action === 'reject') {
    const { commentId } = body;
    if (!commentId) return NextResponse.json({ ok: false, error: 'commentId required' }, { status: 400 });
    await updateFileCommentStatus(commentId, 'resolved');
    return NextResponse.json({ ok: true });
  }

  if (action === 'delete') {
    const { commentId } = body;
    if (!commentId) return NextResponse.json({ ok: false, error: 'commentId required' }, { status: 400 });
    await deleteFileComment(commentId);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add app/api/comments/route.ts
git commit -m "feat: add comments API route (CRUD)"
```

---

### Task 3: Approve API — Create Chat + Dispatch Agent

**Files:**
- Create: `app/api/comments/approve/route.ts`

- [ ] **Step 1: Create the approve API route**

Create `app/api/comments/approve/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import {
  getFileComment,
  updateFileCommentStatus,
  saveChat,
  StoredChat,
} from '@/lib/chatStore';

export const dynamic = 'force-dynamic';

function getUserId(token: any): string {
  return token?.email || token?.name || token?.sub || 'anonymous';
}

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { commentId, fileContent } = body;
  if (!commentId) {
    return NextResponse.json({ ok: false, error: 'commentId required' }, { status: 400 });
  }

  const comment = await getFileComment(commentId);
  if (!comment) {
    return NextResponse.json({ ok: false, error: 'comment not found' }, { status: 404 });
  }

  // Build the prompt from comment + file context
  const rangeLabel = comment.rangeStartLine != null
    ? comment.rangeEndLine != null && comment.rangeEndLine !== comment.rangeStartLine
      ? `lines ${comment.rangeStartLine}-${comment.rangeEndLine}`
      : `line ${comment.rangeStartLine}`
    : 'the file';

  const contextSnippet = fileContent
    ? `\n\nRelevant file content (${comment.filePath}):\n\`\`\`\n${fileContent}\n\`\`\``
    : '';

  const prompt = `Review comment on ${comment.filePath} (${rangeLabel}):\n\n"${comment.content}"${contextSnippet}\n\nPlease address this comment by making the necessary changes.`;

  // Create a new chat
  const userId = getUserId(token);
  const chatId = `chat-${Date.now()}-comment`;
  const chatName = `Comment: ${comment.content.slice(0, 50)}${comment.content.length > 50 ? '…' : ''}`;
  const now = Date.now();

  const chat: StoredChat = {
    id: chatId,
    name: chatName,
    ts: now,
    messages: [
      { id: `msg-${now}`, type: 'user', content: prompt, ts: now },
    ],
    agentSessions: {},
  };

  await saveChat(userId, chat);

  // Update comment status to processing with linked chat
  await updateFileCommentStatus(commentId, 'processing', chatId);

  return NextResponse.json({
    ok: true,
    chatId,
    chatName,
    prompt,
    agentId: comment.agentId,
  });
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add app/api/comments/approve/route.ts
git commit -m "feat: add comment approve API (creates chat for agent)"
```

---

### Task 4: Frontend State + Comment Fetching

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Add FileComment/FileCommentReply types**

After the `MdConflictState` type definition (after line 120 in `app/page.tsx`), add:

```ts
type FileComment = {
  id: string;
  agentId: string;
  filePath: string;
  rangeStartLine: number | null;
  rangeEndLine: number | null;
  rangeStartChar: number | null;
  rangeEndChar: number | null;
  content: string;
  authorType: 'agent' | 'user';
  authorName: string | null;
  status: 'active' | 'processing' | 'resolved';
  linkedChatId: string | null;
  createdAt: string;
  updatedAt: string;
  replies: FileCommentReply[];
};

type FileCommentReply = {
  id: string;
  commentId: string;
  content: string;
  authorType: 'agent' | 'user';
  authorName: string | null;
  createdAt: string;
};
```

- [ ] **Step 2: Add state variables**

After the file-tab state variables (after the `mdDiffOnly` state around line 574), add:

```ts
// Comment sidebar state
const [commentSidebarOpen, setCommentSidebarOpen] = useState(false);
const [fileComments, setFileComments] = useState<FileComment[]>([]);
const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
const [commentFilter, setCommentFilter] = useState<'all' | 'active' | 'resolved'>('all');
const [commentInput, setCommentInput] = useState('');
const [commentAddRange, setCommentAddRange] = useState<{ startLine: number; endLine: number } | null>(null);
const [showCommentInput, setShowCommentInput] = useState(false);
const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(null);
const [replyInput, setReplyInput] = useState('');
const [expandedReplyIds, setExpandedReplyIds] = useState<Set<string>>(new Set());
const commentSidebarRef = useRef<HTMLDivElement>(null);
const fileContentRef = useRef<HTMLDivElement>(null);
```

- [ ] **Step 3: Add comment fetch function**

After the file-tab helper functions (near `loadMdFiles` around line 928), add:

```ts
async function loadFileComments(agentId: string, filePath: string) {
  try {
    const res = await fetch(`/api/comments?agentId=${encodeURIComponent(agentId)}&filePath=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (data.ok) setFileComments(data.comments);
  } catch { /* ignore */ }
}
```

- [ ] **Step 4: Trigger comment loading when a file is opened**

In the `openMdFile` function (around line 949-969), add a call to `loadFileComments` after the file content is loaded. Find the line where `setMdEditorOpen(true)` is called and add after it:

```ts
void loadFileComments(agentId, path);
```

- [ ] **Step 5: Add localStorage persistence for sidebar state**

In the existing localStorage initialization `useEffect` (the one that reads `sidebarCollapsed` around line 667-673), add:

```ts
const savedCommentSidebar = localStorage.getItem('commentSidebarOpen');
if (savedCommentSidebar !== null) setCommentSidebarOpen(savedCommentSidebar === 'true');
```

And add a `useEffect` to persist `commentSidebarOpen`:

```ts
useEffect(() => {
  localStorage.setItem('commentSidebarOpen', String(commentSidebarOpen));
}, [commentSidebarOpen]);
```

- [ ] **Step 6: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No type errors (warnings about unused variables are OK at this stage)

- [ ] **Step 7: Commit**

```bash
git add app/page.tsx
git commit -m "feat: add comment state variables and fetch logic"
```

---

### Task 5: Comment Action Handlers

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Add comment CRUD action handlers**

After the `loadFileComments` function added in Task 4, add:

```ts
async function handleCreateComment() {
  if (!mdSelectedAgentId || !mdSelectedFile || !commentInput.trim() || !commentAddRange) return;
  try {
    const res = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        agentId: mdSelectedAgentId,
        filePath: mdSelectedFile,
        rangeStartLine: commentAddRange.startLine,
        rangeEndLine: commentAddRange.endLine,
        content: commentInput.trim(),
        authorType: 'user',
      }),
    });
    const data = await res.json();
    if (data.ok) {
      setCommentInput('');
      setShowCommentInput(false);
      setCommentAddRange(null);
      void loadFileComments(mdSelectedAgentId, mdSelectedFile);
      if (!commentSidebarOpen) setCommentSidebarOpen(true);
    }
  } catch { /* ignore */ }
}

async function handleRejectComment(commentId: string) {
  try {
    await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject', commentId }),
    });
    if (mdSelectedAgentId && mdSelectedFile) void loadFileComments(mdSelectedAgentId, mdSelectedFile);
  } catch { /* ignore */ }
}

async function handleDeleteComment(commentId: string) {
  try {
    await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', commentId }),
    });
    if (selectedCommentId === commentId) setSelectedCommentId(null);
    if (mdSelectedAgentId && mdSelectedFile) void loadFileComments(mdSelectedAgentId, mdSelectedFile);
  } catch { /* ignore */ }
}

async function handleReplyComment(commentId: string) {
  if (!replyInput.trim()) return;
  try {
    await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'reply',
        commentId,
        content: replyInput.trim(),
        authorType: 'user',
      }),
    });
    setReplyInput('');
    setReplyingToCommentId(null);
    if (mdSelectedAgentId && mdSelectedFile) void loadFileComments(mdSelectedAgentId, mdSelectedFile);
  } catch { /* ignore */ }
}

async function handleApproveComment(commentId: string) {
  const comment = fileComments.find(c => c.id === commentId);
  if (!comment) return;

  // Extract file content around the highlighted range for context
  const lines = mdFileContent.split('\n');
  const startLine = Math.max(0, (comment.rangeStartLine ?? 1) - 3);
  const endLine = Math.min(lines.length, (comment.rangeEndLine ?? comment.rangeStartLine ?? 1) + 3);
  const contextContent = lines.slice(startLine, endLine).join('\n');

  try {
    const res = await fetch('/api/comments/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commentId, fileContent: contextContent }),
    });
    const data = await res.json();
    if (data.ok) {
      // Update local state to show processing
      setFileComments(prev => prev.map(c =>
        c.id === commentId ? { ...c, status: 'processing' as const, linkedChatId: data.chatId } : c
      ));
      // Dispatch agent in background
      if (data.agentId) {
        void dispatchToAgent(data.agentId, data.prompt, data.chatId);
      }
    }
  } catch { /* ignore */ }
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add app/page.tsx
git commit -m "feat: add comment action handlers (create, reject, reply, approve)"
```

---

### Task 6: Comment Sidebar UI

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Add the comment sidebar rendering**

Inside the `mdEditorInline` div (after the file content rendering sections but before the closing `</div>` of `mdEditorInline`, around line 2557), add the comment sidebar:

```tsx
{/* ── Comment sidebar ── */}
{commentSidebarOpen ? (
  <div className="commentSidebar" ref={commentSidebarRef}>
    <div className="commentSidebarHeader">
      <span>Comments</span>
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
        <select
          className="commentFilterSelect"
          value={commentFilter}
          onChange={(e) => setCommentFilter(e.target.value as 'all' | 'active' | 'resolved')}
        >
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="resolved">Resolved</option>
        </select>
        <button className="sidebarToggle" onClick={() => setCommentSidebarOpen(false)} title="Collapse comments">◀</button>
      </div>
    </div>
    <div className="commentSidebarList">
      {fileComments
        .filter(c => commentFilter === 'all' || (commentFilter === 'active' ? c.status !== 'resolved' : c.status === 'resolved'))
        .map(c => {
          const isSelected = selectedCommentId === c.id;
          const isReplying = replyingToCommentId === c.id;
          const repliesExpanded = expandedReplyIds.has(c.id);
          return (
            <div
              key={c.id}
              className={`commentCard ${isSelected ? 'selected' : ''} ${c.status === 'resolved' ? 'resolved' : ''} ${c.status === 'processing' ? 'processing' : ''}`}
              onClick={() => setSelectedCommentId(isSelected ? null : c.id)}
            >
              <div className="commentCardHeader">
                <span className="commentAuthor">
                  {c.authorType === 'agent' ? '🤖' : '👤'} {c.authorName || c.authorType}
                </span>
                <span className="commentLineRange">
                  {c.rangeStartLine != null ? (c.rangeEndLine != null && c.rangeEndLine !== c.rangeStartLine ? `L${c.rangeStartLine}-${c.rangeEndLine}` : `L${c.rangeStartLine}`) : ''}
                </span>
              </div>
              {isSelected || c.status === 'processing' ? (
                <>
                  <div className="commentContent">{c.content}</div>
                  {c.status === 'active' && (
                    <div className="commentActions">
                      <button className="commentActionBtn approve" onClick={(e) => { e.stopPropagation(); void handleApproveComment(c.id); }}>✓ Approve</button>
                      <button className="commentActionBtn reject" onClick={(e) => { e.stopPropagation(); void handleRejectComment(c.id); }}>✗ Reject</button>
                      <button className="commentActionBtn reply" onClick={(e) => { e.stopPropagation(); setReplyingToCommentId(isReplying ? null : c.id); setReplyInput(''); }}>💬 Reply</button>
                    </div>
                  )}
                  {c.status === 'processing' && (
                    <div className="commentProcessing" onClick={(e) => {
                      e.stopPropagation();
                      if (c.linkedChatId) {
                        setLeftSidebarTab('chats');
                        // Navigate to the linked chat
                        const entry = chatHistory.find(ch => ch.id === c.linkedChatId);
                        if (entry) void loadChat(c.linkedChatId);
                      }
                    }}>
                      <span className="commentSpinner" />
                      <span>Processing… (click to view)</span>
                    </div>
                  )}
                  {c.status === 'resolved' && (
                    <div className="commentResolved">✓ Resolved</div>
                  )}
                  {/* Reply thread */}
                  {c.replies.length > 0 && (
                    <div className="commentReplies">
                      {!repliesExpanded && c.replies.length > 1 ? (
                        <button className="commentShowReplies" onClick={(e) => { e.stopPropagation(); setExpandedReplyIds(prev => new Set(prev).add(c.id)); }}>
                          {c.replies.length} replies
                        </button>
                      ) : (
                        c.replies.map(rp => (
                          <div key={rp.id} className="commentReply">
                            <span className="commentReplyAuthor">{rp.authorType === 'agent' ? '🤖' : '👤'} {rp.authorName || rp.authorType}</span>
                            <span className="commentReplyText">{rp.content}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                  {/* Reply input */}
                  {isReplying && (
                    <div className="commentReplyInput" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        value={replyInput}
                        onChange={(e) => setReplyInput(e.target.value)}
                        placeholder="Reply…"
                        onKeyDown={(e) => { if (e.key === 'Enter') void handleReplyComment(c.id); }}
                        autoFocus
                      />
                      <button onClick={() => void handleReplyComment(c.id)}>Send</button>
                    </div>
                  )}
                </>
              ) : (
                <div className="commentContentCompact">{c.content}</div>
              )}
            </div>
          );
        })}
      {fileComments.filter(c => commentFilter === 'all' || (commentFilter === 'active' ? c.status !== 'resolved' : c.status === 'resolved')).length === 0 && (
        <div className="muted" style={{ padding: 20, textAlign: 'center', fontSize: 13 }}>
          No comments
        </div>
      )}
      {/* Add comment form */}
      {showCommentInput && commentAddRange && (
        <div className="commentAddForm">
          <div className="commentAddLabel">New comment on L{commentAddRange.startLine}{commentAddRange.endLine !== commentAddRange.startLine ? `-${commentAddRange.endLine}` : ''}</div>
          <textarea
            className="commentAddTextarea"
            value={commentInput}
            onChange={(e) => setCommentInput(e.target.value)}
            placeholder="Write a comment…"
            autoFocus
          />
          <div className="commentAddActions">
            <button className="commentActionBtn" onClick={() => { setShowCommentInput(false); setCommentAddRange(null); setCommentInput(''); }}>Cancel</button>
            <button className="commentActionBtn approve" onClick={() => void handleCreateComment()} disabled={!commentInput.trim()}>Submit</button>
          </div>
        </div>
      )}
    </div>
  </div>
) : (
  fileComments.length > 0 && (
    <div className="commentSidebarCollapsed" onClick={() => setCommentSidebarOpen(true)} title="Open comments">
      <span className="commentSidebarCollapsedLabel">COMMENTS</span>
      <span className="commentBadge">{fileComments.filter(c => c.status === 'active').length}</span>
      <span className="commentExpandBtn">▶</span>
    </div>
  )
)}
```

- [ ] **Step 2: Add comment toggle button to the editor toolbar**

In the `mdEditorToolbarRight` div (around line 2473-2501), add a comment toggle button before the Save button:

```tsx
<button
  className={`mdEditorBtn ${commentSidebarOpen ? 'active' : ''}`}
  onClick={() => setCommentSidebarOpen(p => !p)}
  title="Toggle comments"
>
  💬 {fileComments.filter(c => c.status === 'active').length || ''}
</button>
```

- [ ] **Step 3: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat: add comment sidebar UI with card rendering"
```

---

### Task 7: File Content Gutter Dots + Highlights + Text Selection

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Create a line-number file viewer for non-edit mode**

The current file viewer uses `<textarea>` for editing and `<ReactMarkdown>` for preview. For the comment system, we need line-aware rendering. Add a read-only viewer component that wraps the plain text display with line numbers and gutter dots.

After the comment action handlers (from Task 5), add this helper:

```ts
function getCommentedLines(): Map<number, FileComment> {
  const map = new Map<number, FileComment>();
  for (const c of fileComments) {
    if (c.status === 'resolved' || c.rangeStartLine == null) continue;
    const end = c.rangeEndLine ?? c.rangeStartLine;
    for (let i = c.rangeStartLine; i <= end; i++) {
      if (!map.has(i)) map.set(i, c);
    }
  }
  return map;
}

function handleTextSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !fileContentRef.current) return;

  const range = sel.getRangeAt(0);
  const container = fileContentRef.current;
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return;

  // Find line numbers from data attributes
  const startLineEl = range.startContainer.parentElement?.closest('[data-line-num]');
  const endLineEl = range.endContainer.parentElement?.closest('[data-line-num]');
  if (!startLineEl || !endLineEl) return;

  const startLine = parseInt(startLineEl.getAttribute('data-line-num') || '0', 10);
  const endLine = parseInt(endLineEl.getAttribute('data-line-num') || '0', 10);
  if (startLine > 0 && endLine > 0) {
    setCommentAddRange({ startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine) });
  }
}
```

- [ ] **Step 2: Replace the plain text `<textarea>` with a line-aware viewer**

Replace the plain text fallback section (the `<div className="mdEditorSimple">` block around line 2549-2556) with a line-aware read/write view:

```tsx
<div className="mdEditorSimple">
  <div className="fileContentWithLines" ref={fileContentRef} onMouseUp={handleTextSelection}>
    {mdEditContent.split('\n').map((line, idx) => {
      const lineNum = idx + 1;
      const commentedLines = getCommentedLines();
      const commentForLine = commentedLines.get(lineNum);
      const isHighlighted = selectedCommentId && commentForLine && commentForLine.id === selectedCommentId;
      return (
        <div
          key={idx}
          className={`fileLine ${isHighlighted ? 'highlighted' : ''} ${commentForLine && !isHighlighted ? 'has-comment' : ''}`}
          data-line-num={lineNum}
        >
          <span className="fileLineGutter">
            {commentForLine && commentForLine.status !== 'resolved' && !isHighlighted && (
              <span
                className="gutterDot"
                style={{ background: commentForLine.authorType === 'agent' ? 'var(--comment-agent-color)' : 'var(--comment-user-color)' }}
                onClick={(e) => { e.stopPropagation(); setSelectedCommentId(commentForLine.id); if (!commentSidebarOpen) setCommentSidebarOpen(true); }}
                title={commentForLine.content}
              />
            )}
            <span className="fileLineNum">{lineNum}</span>
          </span>
          <span className="fileLineText">{line || ' '}</span>
        </div>
      );
    })}
  </div>
  {commentAddRange && !showCommentInput && (
    <button
      className="addCommentFloatingBtn"
      style={{ position: 'absolute', right: commentSidebarOpen ? '280px' : '40px', top: `${(commentAddRange.startLine - 1) * 20 + 40}px` }}
      onClick={() => { setShowCommentInput(true); if (!commentSidebarOpen) setCommentSidebarOpen(true); }}
    >
      💬 Add Comment
    </button>
  )}
</div>
```

- [ ] **Step 3: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat: add line-aware file viewer with gutter dots and highlights"
```

---

### Task 8: SVG Connector Lines

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Add SVG connector overlay**

After the comment sidebar (added in Task 6), inside the `mdEditorInline` div, add the SVG overlay. This goes right before the comment sidebar:

```tsx
{/* SVG connector line */}
{selectedCommentId && commentSidebarOpen && (() => {
  const comment = fileComments.find(c => c.id === selectedCommentId);
  if (!comment || comment.rangeStartLine == null) return null;
  const lineHeight = 20; // matches CSS .fileLine height
  const headerOffset = 45; // toolbar height
  const startLine = comment.rangeStartLine;
  const endLine = comment.rangeEndLine ?? startLine;
  const midY = headerOffset + ((startLine + endLine) / 2 - 0.5) * lineHeight;

  // Find the comment card position in the sidebar
  const cardEl = commentSidebarRef.current?.querySelector(`[data-comment-id="${selectedCommentId}"]`);
  const cardY = cardEl ? (cardEl as HTMLElement).offsetTop + (cardEl as HTMLElement).offsetHeight / 2 : midY;

  return (
    <svg className="commentConnectorSvg" style={{ position: 'absolute', top: 0, right: commentSidebarOpen ? '260px' : '0', width: '24px', height: '100%', pointerEvents: 'none', zIndex: 5 }}>
      <path
        d={`M 0 ${midY} C 12 ${midY}, 12 ${cardY}, 24 ${cardY}`}
        stroke="var(--accent)"
        strokeWidth="1.5"
        fill="none"
        opacity="0.6"
      />
    </svg>
  );
})()}
```

- [ ] **Step 2: Add `data-comment-id` attribute to comment cards**

In the comment card rendering (Task 6), add `data-comment-id={c.id}` to the `.commentCard` div:

Change:
```tsx
<div
  key={c.id}
  className={`commentCard ${isSelected ? 'selected' : ''} ${c.status === 'resolved' ? 'resolved' : ''} ${c.status === 'processing' ? 'processing' : ''}`}
  onClick={() => setSelectedCommentId(isSelected ? null : c.id)}
>
```

To:
```tsx
<div
  key={c.id}
  data-comment-id={c.id}
  className={`commentCard ${isSelected ? 'selected' : ''} ${c.status === 'resolved' ? 'resolved' : ''} ${c.status === 'processing' ? 'processing' : ''}`}
  onClick={() => setSelectedCommentId(isSelected ? null : c.id)}
>
```

- [ ] **Step 3: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat: add SVG connector lines between highlights and sidebar"
```

---

### Task 9: Agent Comment Parser

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Add comment extraction function**

After the `handleTextSelection` helper (Task 7), add:

```ts
function extractFileComments(text: string, agentId: string): { cleanText: string; comments: { filePath: string; rangeStartLine?: number; rangeEndLine?: number; content: string }[] } {
  const commentBlockRegex = /```json:file-comments\s*\n([\s\S]*?)```/g;
  const comments: { filePath: string; rangeStartLine?: number; rangeEndLine?: number; content: string }[] = [];
  let cleanText = text;

  let match;
  while ((match = commentBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.filePath && item.content) {
            comments.push({
              filePath: item.filePath,
              rangeStartLine: item.rangeStartLine,
              rangeEndLine: item.rangeEndLine,
              content: item.content,
            });
          }
        }
      }
    } catch { /* invalid JSON, skip */ }
    cleanText = cleanText.replace(match[0], '').trim();
  }

  return { cleanText, comments };
}

async function saveAgentComments(agentId: string, comments: { filePath: string; rangeStartLine?: number; rangeEndLine?: number; content: string }[], agentName?: string) {
  for (const c of comments) {
    await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        agentId,
        filePath: c.filePath,
        rangeStartLine: c.rangeStartLine,
        rangeEndLine: c.rangeEndLine,
        content: c.content,
        authorType: 'agent',
        authorName: agentName,
      }),
    }).catch(() => { /* ignore */ });
  }
}
```

- [ ] **Step 2: Integrate into `pollAcpAgent` response processing**

In the `pollAcpAgent` function, find the block where `turn.done` is true (around line 1361-1370). After the line `current.currentText = serverText;` (line 1362), add comment extraction:

```ts
// Extract and save agent comments
const { cleanText: textWithoutComments, comments: agentComments } = extractFileComments(serverText, agentId);
if (agentComments.length > 0) {
  const agentName = agents.find(a => a.id === agentId)?.name;
  void saveAgentComments(agentId, agentComments, agentName);
  // Use cleaned text (without comment blocks) for display
  current.currentText = textWithoutComments;
}
```

Then update the `updateMessage` call to use `current.currentText` instead of `serverText` for the content:

Change:
```ts
updateMessage(current.pendingId, {
  content: serverText || (turn.error ? `⚠️ ${turn.error}` : ''),
```

To:
```ts
updateMessage(current.pendingId, {
  content: current.currentText || (turn.error ? `⚠️ ${turn.error}` : ''),
```

- [ ] **Step 3: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat: parse agent file-comments from responses"
```

---

### Task 10: Styled-JSX CSS for Comment System

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Add CSS custom properties**

In the CSS variables section (search for `:root` or the theme variables), add:

```css
--comment-agent-color: #f0c040;
--comment-user-color: #58a6ff;
```

- [ ] **Step 2: Add comment sidebar and card CSS**

Inside the `<style jsx>` block (after the `.mdEditorSimple` CSS around line 4753), add:

```css
/* ── Comment sidebar ── */
.commentSidebar {
  width: 260px;
  min-width: 260px;
  border-left: 1px solid var(--border);
  background: var(--panel-bg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.commentSidebarHeader {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-soft);
}
.commentFilterSelect {
  background: var(--panel-strong);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-soft);
  font-size: 11px;
  padding: 2px 4px;
  cursor: pointer;
}
.commentSidebarList {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.commentCard {
  background: var(--panel-strong);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  margin-bottom: 6px;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, opacity 0.15s;
}
.commentCard.selected {
  border-color: var(--accent);
  box-shadow: 0 0 8px rgba(88, 166, 255, 0.2);
}
.commentCard.resolved {
  opacity: 0.35;
}
.commentCard.processing {
  border-color: #d29922;
}
.commentCardHeader {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.commentAuthor {
  font-size: 11px;
  color: var(--text-soft);
}
.commentLineRange {
  font-size: 10px;
  color: var(--text-soft);
  opacity: 0.6;
}
.commentContent {
  color: var(--text);
  margin: 4px 0;
  line-height: 1.4;
}
.commentContentCompact {
  color: var(--text-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.commentActions {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}
.commentActionBtn {
  padding: 2px 8px;
  border-radius: 4px;
  border: none;
  font-size: 11px;
  cursor: pointer;
  background: var(--panel-strong);
  color: var(--text-soft);
}
.commentActionBtn.approve {
  background: #238636;
  color: white;
}
.commentActionBtn.reject {
  background: #da3633;
  color: white;
}
.commentActionBtn.reply {
  background: var(--panel-strong);
  color: var(--text-soft);
}
.commentActionBtn:hover { opacity: 0.85; }
.commentActionBtn:disabled { opacity: 0.4; cursor: default; }
.commentProcessing {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  color: #d29922;
  font-size: 11px;
  cursor: pointer;
}
.commentSpinner {
  width: 12px;
  height: 12px;
  border: 2px solid #d29922;
  border-top-color: transparent;
  border-radius: 50%;
  display: inline-block;
  animation: commentSpin 1s linear infinite;
}
@keyframes commentSpin { to { transform: rotate(360deg); } }
.commentResolved {
  color: var(--text-soft);
  font-size: 11px;
  margin-top: 4px;
}
.commentReplies {
  border-top: 1px solid var(--border);
  margin-top: 6px;
  padding-top: 6px;
}
.commentShowReplies {
  background: none;
  border: none;
  color: var(--accent);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
}
.commentReply {
  border-left: 2px solid var(--border);
  padding-left: 8px;
  margin-bottom: 4px;
  font-size: 11px;
}
.commentReplyAuthor {
  color: var(--text-soft);
  font-size: 10px;
  display: block;
}
.commentReplyText {
  color: var(--text-soft);
}
.commentReplyInput {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}
.commentReplyInput input {
  flex: 1;
  background: var(--bg-accent);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  color: var(--text);
  font-size: 11px;
}
.commentReplyInput button {
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 11px;
  cursor: pointer;
}
.commentAddForm {
  background: var(--panel-strong);
  border: 1px solid var(--accent);
  border-radius: 6px;
  padding: 8px;
  margin-top: 8px;
}
.commentAddLabel {
  font-size: 11px;
  color: var(--text-soft);
  margin-bottom: 4px;
}
.commentAddTextarea {
  width: 100%;
  min-height: 50px;
  background: var(--bg-accent);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px;
  color: var(--text);
  font-size: 12px;
  resize: vertical;
  box-sizing: border-box;
}
.commentAddActions {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 6px;
}

/* ── Collapsed sidebar ── */
.commentSidebarCollapsed {
  width: 28px;
  min-width: 28px;
  background: var(--panel-bg);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 12px;
  gap: 8px;
  cursor: pointer;
}
.commentSidebarCollapsedLabel {
  writing-mode: vertical-rl;
  font-size: 10px;
  color: var(--text-soft);
  letter-spacing: 0.05em;
}
.commentBadge {
  background: var(--accent);
  color: #fff;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  text-align: center;
  line-height: 18px;
  font-size: 10px;
  font-weight: 600;
}
.commentExpandBtn {
  color: var(--text-soft);
  font-size: 12px;
}

/* ── File line viewer ── */
.fileContentWithLines {
  flex: 1;
  overflow: auto;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 13px;
  line-height: 20px;
  padding: 8px 0;
  position: relative;
}
.fileLine {
  display: flex;
  min-height: 20px;
  padding: 0 12px 0 0;
}
.fileLine.highlighted {
  background: rgba(88, 166, 255, 0.12);
  border-left: 3px solid var(--accent);
}
.fileLine.has-comment {
  /* subtle — just the gutter dot, no line highlight */
}
.fileLineGutter {
  width: 60px;
  min-width: 60px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  padding-right: 12px;
  user-select: none;
}
.fileLineNum {
  color: var(--text-soft);
  opacity: 0.4;
  font-size: 12px;
}
.gutterDot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
  cursor: pointer;
  flex-shrink: 0;
}
.fileLineText {
  white-space: pre;
  color: var(--text);
  flex: 1;
}
.addCommentFloatingBtn {
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  z-index: 10;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}
.addCommentFloatingBtn:hover { opacity: 0.85; }

/* ── Editor layout update ── */
.mdEditorInline {
  display: flex;
  flex-direction: row;
  height: 100%;
  overflow: hidden;
  position: relative;
}
.mdEditorInline > .mdEditorToolbar,
.mdEditorInline > .mdEditorSplit,
.mdEditorInline > .mdEditorLive,
.mdEditorInline > .mdEditorSimple,
.mdEditorInline > .mdConflictBackdrop,
.mdEditorInline > .mdConflictDiffPage,
.mdEditorInline > .mdHtmlPreviewWrap {
  flex: 1;
  min-width: 0;
}
```

- [ ] **Step 3: Update `.mdEditorInline` layout to accommodate sidebar**

The original `.mdEditorInline` CSS (around line 4474) uses `flex-direction: column`. We need to wrap the file content and toolbar in a container and keep the sidebar as a sibling. Update the existing rule:

Change the existing `.mdEditorInline` from:
```css
.mdEditorInline {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  position: relative;
}
```

To:
```css
.mdEditorInline {
  display: flex;
  flex-direction: row;
  height: 100%;
  overflow: hidden;
  position: relative;
}
.mdEditorContent {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
```

- [ ] **Step 4: Wrap existing file editor content in `.mdEditorContent` div**

In the JSX, wrap the toolbar and editor content (everything inside `.mdEditorInline` except the comment sidebar and SVG connector) in a new `<div className="mdEditorContent">`.

The structure becomes:
```tsx
<div className="mdEditorInline">
  <div className="mdEditorContent">
    {/* conflict UI */}
    {/* toolbar */}
    {/* editor/viewer content */}
  </div>
  {/* SVG connector */}
  {/* comment sidebar */}
</div>
```

- [ ] **Step 5: Verify the build compiles and renders**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add app/page.tsx
git commit -m "feat: add comment system CSS and layout"
```

---

### Task 11: Approve Flow — Poll Agent + Auto-Resolve

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Add polling completion callback**

In the `pollAcpAgent` function, after the `finalizeRun(runKey)` call when `turn.done` is true (around line 1369), add a check for comment-linked chats:

```ts
// Auto-resolve comments linked to this chat
if (effectiveChatId) {
  setFileComments(prev => prev.map(c =>
    c.linkedChatId === effectiveChatId && c.status === 'processing'
      ? { ...c, status: 'resolved' as const }
      : c
  ));
  // Persist the resolved status
  const commentToResolve = fileComments.find(c => c.linkedChatId === effectiveChatId && c.status === 'processing');
  if (commentToResolve) {
    void fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject', commentId: commentToResolve.id }),
    });
  }
}
```

- [ ] **Step 2: Reset comments when switching files**

In the `openMdFile` function, before loading new file comments, clear existing state:

```ts
setFileComments([]);
setSelectedCommentId(null);
setShowCommentInput(false);
setCommentAddRange(null);
```

- [ ] **Step 3: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat: auto-resolve comments when agent completes"
```

---

### Task 12: Build Verification + Manual Test

**Files:**
- No changes — verification only

- [ ] **Step 1: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run production build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Manual smoke test**

Start the dev server: `npm run dev`

Test the following:
1. Open the Files tab, select an agent, open a file
2. Verify the comment toggle button appears in the toolbar (💬)
3. Click the comment toggle — sidebar should appear (empty)
4. Select text in the file viewer → "Add Comment" button should appear
5. Submit a comment — it should appear in the sidebar with a gutter dot
6. Click the gutter dot — comment should highlight, connector line appears
7. Click Reject — comment grays out
8. Click Reply — thread input appears, submit reply
9. Click Approve — spinner appears on the comment card

- [ ] **Step 4: Commit any fixes from manual testing**

```bash
git add -A
git commit -m "fix: address issues from manual testing"
```

---

### Task 13: Playwright E2E Test

**Files:**
- Create: `test/test-file-comments.spec.ts`

- [ ] **Step 1: Write E2E test**

Create `test/test-file-comments.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test.describe('File Comments', () => {
  test.beforeEach(async ({ page }) => {
    // Login (matches existing test pattern)
    await page.goto('/');
    // Wait for app to load
    await page.waitForSelector('.page', { timeout: 10000 });
  });

  test('comment sidebar toggle appears in file editor toolbar', async ({ page }) => {
    // Switch to Files tab
    await page.click('button:has-text("Files")');
    await page.waitForTimeout(500);

    // Select an agent if available
    const agentSelect = page.locator('.mdAgentSelect');
    if (await agentSelect.count() > 0) {
      await agentSelect.selectOption({ index: 0 });
      await page.waitForTimeout(1000);
    }

    // Open a file if available
    const fileItem = page.locator('.mdFileItem').first();
    if (await fileItem.count() > 0) {
      await fileItem.click();
      await page.waitForTimeout(500);

      // Verify comment toggle button exists
      const commentToggle = page.locator('button:has-text("💬")');
      await expect(commentToggle).toBeVisible();
    }
  });

  test('comment sidebar opens and closes', async ({ page }) => {
    await page.click('button:has-text("Files")');
    await page.waitForTimeout(500);

    const agentSelect = page.locator('.mdAgentSelect');
    if (await agentSelect.count() > 0) {
      await agentSelect.selectOption({ index: 0 });
      await page.waitForTimeout(1000);
    }

    const fileItem = page.locator('.mdFileItem').first();
    if (await fileItem.count() > 0) {
      await fileItem.click();
      await page.waitForTimeout(500);

      // Open sidebar
      const commentToggle = page.locator('button:has-text("💬")');
      await commentToggle.click();
      await expect(page.locator('.commentSidebar')).toBeVisible();

      // Close sidebar
      await page.locator('.commentSidebarHeader button:has-text("◀")').click();
      await expect(page.locator('.commentSidebar')).not.toBeVisible();
    }
  });
});
```

- [ ] **Step 2: Run the E2E test**

Run: `npx playwright test --config test/playwright.config.ts test/test-file-comments.spec.ts`
Expected: Tests pass (or skip gracefully if no agents are configured in the test environment)

- [ ] **Step 3: Commit**

```bash
git add test/test-file-comments.spec.ts
git commit -m "test: add file comments E2E tests"
```
