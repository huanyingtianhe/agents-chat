# File Comments with Review Sidebar

**Date:** 2026-05-09
**Status:** Approved
**Branch:** feat/file-comments

## Problem

Users working with files in the file tab have no way to annotate, review, or discuss specific parts of file content. Agents can modify files but cannot leave review comments or suggestions. There is no mechanism for asynchronous code review between agents and users within the app.

## Solution

Add a Word-style comment and review system to the file tab. Comments anchor to text ranges in files and appear in a collapsible right sidebar with visual connector lines. Both agents and users can create comments. Users can approve comments (dispatching them to the default agent for action), reject them (marking as resolved), or reply to start a discussion thread.

## Architecture

Three new pieces:

1. **Comment Sidebar Component** — a collapsible right panel inside the file viewer area, showing comment cards with connector lines to highlighted ranges in the file content.
2. **Comment Data Layer** — a new `file_comments` table in SQLite (`.data/chats.db`), keyed by `(agent_id, file_path)`, with a separate `file_comment_replies` table for threading.
3. **Agent Comment Parser** — logic in the response handler to detect JSON comment blocks in agent responses, extract them, save to SQLite, and strip from displayed output.

## Data Model

### `file_comments` table

| Column | Type | Description |
|---|---|---|
| id | TEXT PK | UUID |
| agent_id | TEXT NOT NULL | Agent that owns the file |
| file_path | TEXT NOT NULL | Path of the commented file |
| range_start_line | INTEGER | Start line of highlighted range |
| range_end_line | INTEGER | End line of highlighted range |
| range_start_char | INTEGER | Optional character offset within start line |
| range_end_char | INTEGER | Optional character offset within end line |
| content | TEXT NOT NULL | Comment text |
| author_type | TEXT NOT NULL | `'agent'` or `'user'` |
| author_name | TEXT | Agent name or user display name |
| status | TEXT DEFAULT 'active' | `'active'`, `'processing'`, or `'resolved'` |
| linked_chat_id | TEXT | Chat ID created when comment is approved |
| created_at | TEXT | Timestamp |
| updated_at | TEXT | Timestamp |

Index: `(agent_id, file_path)` for efficient lookup.

### `file_comment_replies` table

| Column | Type | Description |
|---|---|---|
| id | TEXT PK | UUID |
| comment_id | TEXT NOT NULL | FK to file_comments.id |
| content | TEXT NOT NULL | Reply text |
| author_type | TEXT NOT NULL | `'agent'` or `'user'` |
| author_name | TEXT | Display name |
| created_at | TEXT | Timestamp |

## Agent Comment Format

Agents include comments in their response text using a specially-tagged fenced code block:

~~~
```json:file-comments
[
  {
    "filePath": "src/readme.md",
    "rangeStartLine": 3,
    "rangeEndLine": 4,
    "content": "Update docs to reflect new REST endpoints"
  }
]
```
~~~

The frontend detects `` ```json:file-comments `` blocks during response processing, extracts the comment array, saves each comment to the database with `author_type: 'agent'`, and strips the block from the rendered message.

## API Endpoints

Three new routes under `app/api/comments/`:

### `GET /api/comments?agentId=X&filePath=Y`

Returns all comments for a given agent + file. Includes nested replies.

### `POST /api/comments`

Create, update, or delete comments and replies. Request body includes an `action` field:

- `action: 'create'` — new comment with agentId, filePath, range, content, authorType, authorName
- `action: 'reply'` — new reply with commentId, content, authorType, authorName
- `action: 'reject'` — sets comment status to `'resolved'`
- `action: 'delete'` — removes a comment and its replies

### `POST /api/comments/approve`

Approves a comment and dispatches to the default agent:

1. Creates a new chat in `chatStore`
2. Composes a prompt including the comment text and file content around the highlighted range
3. Dispatches to the default agent using existing ACP infrastructure
4. Sets comment status to `'processing'` and stores `linked_chat_id`
5. When the agent completes, status updates to `'resolved'`

## Frontend Design

### Comment Sidebar

- Renders to the right of the file editor area, inside the file viewer layout
- Collapsible: collapsed state shows a vertical "COMMENTS" label + badge count + expand button
- Expanded state shows a scrollable list of comment cards
- Header has filter controls: All / Active / Resolved
- Sidebar open/collapsed state persisted to localStorage

### Comment Card

Each card displays:
- Author indicator (🤖 Agent or 👤 User) with name
- Line range label (e.g., "L5-8")
- Comment text content
- Action buttons: ✓ Approve, ✗ Reject, 💬 Reply
- Reply thread (collapsed by default, showing "N replies" link)

### Comment States

| State | Card Appearance | Gutter | Actions |
|---|---|---|---|
| Active | Full opacity, colored border | Colored dot | Approve, Reject, Reply |
| Processing | Spinner + "Processing..." link | Colored dot | Click to view chat |
| Resolved | 35% opacity, strikethrough, muted | No indicator | None |

### Visual Density Rules

When **no comment is selected**:
- File content renders normally (clean reading view)
- Small colored gutter dots next to commented lines
- Sidebar badge shows comment count

When **a comment is selected** (clicked in sidebar or gutter dot clicked):
- Selected comment's range gets full highlight with colored left border
- SVG connector line drawn from the highlight to the comment card
- Comment card expands with glow shadow and all action buttons
- Other comments remain compact (1-line truncated text, no highlight)

When **comment is unselected** (click elsewhere):
- Returns to the clean state with gutter dots only

### Adding Comments (User Flow)

1. User selects a text range in the file viewer
2. A floating "💬 Add Comment" button appears near the selection
3. Clicking opens a comment input form in the sidebar (or inline below the button)
4. User types comment text and clicks Submit
5. Comment is saved via `POST /api/comments` and appears in the sidebar

### Approve Flow

1. User clicks ✓ Approve on a comment
2. Frontend calls `POST /api/comments/approve` with the comment ID
3. Comment card shows spinner + "Processing..." (clickable to navigate to the created chat)
4. The new chat runs in the background; user stays on the file tab
5. When the agent finishes, the comment status updates to "resolved"

### Connector Lines

- Implemented as an SVG overlay positioned between the file content and the sidebar
- Only the selected comment draws a connector line
- Line connects the vertical midpoint of the highlighted range to the corresponding comment card
- Repositioned on scroll events in both the file content and sidebar

## Persistence

- Comments stored in `.data/chats.db` (same SQLite database as chats)
- Tables auto-created on first use (migration in `lib/chatStore.ts`)
- Comments persist across sessions, keyed by `(agent_id, file_path)`
- Reply threads stored in separate table with FK to parent comment

## Edge Cases

- **Stale comments after file edits:** If a file is modified and line numbers shift, existing comments may point to wrong ranges. For v1, comments display based on their stored line numbers — no auto-adjustment. If content at the stored range no longer matches, the gutter dot still appears but the highlight may be visually off. Users can delete stale comments manually.
- **Concurrent comments:** Multiple agents may comment on the same file. Comments are stored independently and all appear in the sidebar. No deduplication — each agent's comments are separate entries.
- **Large files:** Gutter dots and sidebar cards scale linearly with comment count. The filter controls (All/Active/Resolved) help manage volume. No pagination for v1 — assume reasonable comment counts per file.

## Files to Modify

| File | Changes |
|---|---|
| `lib/chatStore.ts` | Add `file_comments` and `file_comment_replies` tables, CRUD functions |
| `app/api/comments/route.ts` | New — GET/POST endpoints for comment CRUD |
| `app/api/comments/approve/route.ts` | New — approve endpoint that creates chat + dispatches agent |
| `app/page.tsx` | Comment sidebar component, highlight rendering, text selection handler, gutter dots, SVG connectors, state management, agent response parser for `json:file-comments` blocks |
