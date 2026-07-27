# Chat Git Context Selection — Design

**Date:** 2026-07-27
**Status:** Draft

## Problem

The composer currently has no way to bind a conversation to a specific Git
branch or worktree. Users can mention branch names in text, but that does not
change the actual execution context used by the backend. As a result, agents
and tools still run against the default working directory from `agents.json`,
which makes branch-specific or worktree-specific work unreliable.

## Goals

- Let users choose `branch` and `worktree` directly under the composer.
- Persist the selected Git context per chat.
- Ensure the selected worktree becomes the real backend execution context for
  subsequent agent and tool activity in that chat.
- Restore the saved Git context when the user switches back to a chat.
- Keep the first version limited to selecting existing branches and worktrees.

## Non-Goals

- Automatically creating a new worktree when a branch has none.
- Managing multiple repositories in one chat.
- Hot-switching the working directory of an already-running child process.
- Redesigning the chat shell or agent picker beyond the composer context area.

## Product Decisions

- Scope: Git context is stored per chat.
- Execution model: the selected worktree changes the real backend working
  directory for that chat.
- UX model: both `branch` and `worktree` are visible in the composer, but the
  selected worktree is the source of truth for execution.
- Branch/worktree consistency: selecting a worktree also updates the displayed
  branch to the branch currently checked out in that worktree.
- Version 1 only supports selecting existing worktrees. If a branch exists but
  has no matching worktree, the UI shows that state explicitly instead of
  creating one implicitly.

## User Experience

### Composer Controls

Add a new composer sub-row below the message textarea toolbar area for Git
context controls.

The row contains:

- A `Branch` selector.
- A `Worktree` selector.
- A compact status label when the current context is unavailable or stale.

Expected behavior:

- When a chat has no saved Git context, the controls default to the primary
  repository root and its current branch/worktree.
- When the user switches chats, the controls update to that chat's saved Git
  context.
- Selecting a worktree immediately updates the branch display to match that
  worktree.
- Selecting a branch attempts to map to an existing worktree for that branch.
  If one exists, that worktree becomes selected. If none exists, the UI keeps
  the current worktree and surfaces a small explanatory message such as
  `No existing worktree for this branch`.
- The controls do not block sending a message unless the user picked a now-
  invalid saved context and has not yet resolved it. In that case, the UI falls
  back to the default repo context and makes the fallback visible.

### Invalid or Unavailable State

If Git metadata cannot be loaded, the controls render in a disabled state with
  short copy such as `Git context unavailable`.

This includes:

- `git` is not installed.
- The configured repository root is not a Git repository.
- The previously saved worktree path no longer exists.

In these cases chat usage still works; only Git context selection degrades.

## Data Model

Add chat-level Git context storage with the minimum persisted shape:

```ts
type ChatGitContext = {
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  isFallback?: boolean;
};
```

`worktreePath` is the authoritative execution target.

`branchName` is persisted for fast restore and UI display, but the backend may
recompute it from the selected worktree during validation.

`isFallback` is optional persisted or computed metadata indicating the saved
context could not be restored exactly and the system had to fall back.

## Backend Architecture

### Git Metadata Service

Create a focused server-side helper that enumerates Git state for the repo used
by chat execution.

Responsibilities:

- Return repository root metadata.
- Return available branches.
- Return available worktrees from `git worktree list --porcelain`.
- Return branch-to-worktree mappings.
- Validate a persisted `ChatGitContext`.

Suggested module placement:

- `lib/gitContext.ts` for Git discovery, normalization, and validation.

The helper should return normalized data rather than raw command output.

### Chat Persistence

Persist `gitContext` alongside other chat metadata in server-side chat storage.

This requires:

- Load `gitContext` when fetching a chat.
- Save `gitContext` via a focused API endpoint or existing chat update route.
- Preserve backward compatibility for older chats with no saved context.

### Session Execution Context

When a chat has a valid `gitContext.worktreePath`, that path overrides the
default agent working directory for that chat's session.

This applies to:

- ACP session creation.
- Agent child-process working directory selection.
- Tool requests that rely on the active working directory.

To avoid inconsistent behavior inside an already-running process, changing the
chat Git context does not mutate an active session in place. Instead:

- The current chat's agent sessions are marked stale.
- The next send from that chat recreates the relevant session(s) using the new
  `worktreePath`.

This keeps execution semantics simple and testable.

### Shared-Agent Constraint and Session Scope

The current ACP runtime shares one in-memory `AgentProcess` per `agentId`.
Its `cachedCwd` field is process-level, not chat-level. This means changing that
shared field to satisfy one chat would risk changing execution context for other
chats using the same agent process.

For this feature, working directory selection must be scoped to chat/session,
not to the shared process object:

- Keep `AgentProcess` reusable across chats.
- Store selected Git context per chat.
- Resolve effective cwd per chat when creating or reloading that chat's session.
- After context change, recreate only the affected chat's session on next send.

This preserves multi-chat isolation while still allowing one agent binary/process
to serve multiple concurrent chats.

## API Surface

Add focused backend endpoints for Git context data and per-chat persistence.

Suggested endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/git-context/options?chatId=<id>` | Return repo root, branches, worktrees, and the effective context for the chat. |
| `PUT` | `/api/chats/:id/git-context` | Persist the selected chat-level Git context after validation. |

Validation rules:

- `worktreePath` must belong to the allowed repository root.
- `branchName` must either match the selected worktree or be resolvable to an
  existing worktree for branch-driven selection.
- Invalid inputs return a typed validation error rather than silently coercing
  to another worktree.

## Frontend Architecture

### Feature Placement

Keep `ChatPageClient` as a composition shell.

Add Git context behavior under feature folders rather than embedding logic in
the page shell:

- A composer UI component for Git selectors.
- A small chat runtime hook for loading and updating Git context.
- A typed API client helper for Git context endpoints.

Suggested files:

- `app/features/composer/components/ComposerGitContextControls.tsx`
- `app/features/composer/components/ComposerGitContextControls.css`
- `app/features/chat/chatGitContextApi.ts`
- `app/features/chat/runtime/useChatGitContext.ts`
- `app/features/chat/chatGitContextTypes.ts`

### UI Wiring

`ChatPageClient` loads Git context state for the active chat and passes a small
rendered control node into `ChatComposer`, similar to the existing target
controls flow.

`ChatComposer` renders the Git control row below the existing toolbar so the
new feature stays visually attached to the composer without expanding the page
shell's responsibility.

## State and Data Flow

1. User opens a chat.
2. The client fetches effective Git context options and the saved chat context.
3. The composer renders the selected branch and worktree.
4. User changes worktree or branch.
5. The client validates and persists the new `gitContext` via API.
6. The runtime marks active agent sessions for that chat as stale.
7. On the next send, ACP session creation uses the selected `worktreePath` as
   the session working directory.

## Error Handling

The design should handle failure explicitly:

- If Git option loading fails, disable the controls and surface a compact
  non-blocking error.
- If persisted chat context is stale, mark it invalid, show a warning, and
  expose the fallback context.
- If context saving fails, keep the prior selection in UI state and show a
  local error; do not assume backend success.
- If session recreation fails after a context change, sending should fail with
  the existing chat error handling path rather than silently reverting to the
  old worktree.

## Testing Strategy

### Backend Tests

Add server-side tests for:

- Git branch/worktree enumeration and normalization.
- Validation of persisted `ChatGitContext`.
- Chat persistence and reload of Git context.
- Stale worktree fallback behavior.
- Session invalidation or recreation behavior after a Git context change.

### Frontend and E2E Tests

Add user-facing coverage for:

- Composer renders branch and worktree controls under the input area.
- Switching chats restores each chat's saved Git context.
- Selecting a worktree updates the branch display.
- Selecting a branch with no existing worktree surfaces a visible message.
- After context change, the next message runs under the new worktree context.

## Rollout Notes

Version 1 should favor correctness over automation.

In particular:

- Do not auto-create worktrees.
- Do not support multiple repos per chat.
- Do not attempt in-process cwd switching.

These constraints keep the first implementation narrow enough to integrate with
the existing chat runtime safely.