# Orchestration Node Persistence — Design

**Date:** 2026-06-08
**Status:** Approved
**Branch:** `feat/orchestration-impl`

## Problem

Workflow orchestration state is currently persisted as a single JSON blob per
orchestration (`orchestrations.state_json`). Every node-status change rewrites
the entire blob. This has two practical issues:

1. **Lost-update risk** when multiple writers (multiple tabs, or concurrent
   node finishes in rapid succession) POST the whole blob — last write wins
   and intermediate updates can be clobbered.
2. **Wasteful writes** — the full DAG plus every node's status and result is
   rewritten for any single node flip.

We also lack a clean way to distinguish "user pressed Stop" from "agent
errored" — both are currently recorded as `failed`.

## Goals

- Atomic per-node writes that cannot clobber each other.
- Distinguish `stopped` from `failed` in the node-status model.
- Preserve current behavior: page reload restores the workflow, and any node
  that was running when the tab died becomes recoverable via the inline
  follow-up card.
- No cross-tab live sync (out of scope; user explicitly deferred).
- No backend orchestration loop (out of scope; user explicitly deferred).

## Non-Goals

- Live multi-tab synchronization.
- Moving the DAG orchestrator to a backend worker.
- Replan-on-failure (`MAX_REPLANS`) — tracked separately.
- Migration of existing `orchestrations.state_json` rows (dev only; drop &
  recreate is acceptable).

## Architecture

### Schema (`lib/chatStore.ts`)

Replace the single-blob table with a parent + child split:

```sql
DROP TABLE IF EXISTS orchestrations;

CREATE TABLE orchestrations (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  chat_id         TEXT NOT NULL,
  mode            TEXT NOT NULL,           -- 'workflow' | 'auto' | 'pipeline'
  plan_json       TEXT NOT NULL,           -- workflowPlan + immutable metadata
  summary_started INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_orchestrations_user_chat ON orchestrations(user_id, chat_id);

CREATE TABLE orchestration_nodes (
  orchestration_id TEXT NOT NULL,
  node_id          TEXT NOT NULL,
  status           TEXT NOT NULL,
  result           TEXT,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (orchestration_id, node_id),
  FOREIGN KEY (orchestration_id) REFERENCES orchestrations(id) ON DELETE CASCADE
);
```

`PRAGMA foreign_keys = ON;` must be set on connection open for the cascade
to fire. Verify and enable if missing.

`plan_json` stores the immutable parts of `OrchestrationState`: workflow
plan, mode metadata, `sourceChatId`, creation timestamp, etc. Anything that
changes during a run lives in either `summary_started` or per-node rows.

### Node Status Model

Extend `NodeStatus` to add `stopped`:

```ts
type NodeStatus =
  | 'pending'
  | 'running'
  | 'awaiting-input'
  | 'ok'
  | 'failed'    // agent error
  | 'skipped'   // never ran (dep failure/stop, or user typed "skip")
  | 'stopped';  // user pressed Stop while node was running/awaiting-input
```

Terminal-state predicate becomes:

```ts
const isTerminal = (s: NodeStatus) =>
  s === 'ok' || s === 'failed' || s === 'skipped' || s === 'stopped';
```

`PlanProgressBar` gets a `.planNode-stopped` style (neutral grey, ⏹ icon)
and `STATUS_LABEL['stopped'] = 'stopped'`.

### API (`app/api/orchestrations/`)

All routes are NextAuth-gated and use the existing
`next-auth.session-token` cookie path.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/orchestrations?chatId=<id>` | Load all orchestrations for a chat. Server joins parent + node rows and returns rebuilt `OrchestrationState[]`. |
| `PUT` | `/api/orchestrations/:id` | UPSERT parent row. Body: `{ chatId, mode, plan, summaryStarted }`. Called on first persist and when `summaryStarted` flips. |
| `PATCH` | `/api/orchestrations/:id/nodes/:nodeId` | UPSERT a single node row. Body: `{ status, result }`. Hot path. |
| `DELETE` | `/api/orchestrations?id=<id>` | Delete one orchestration (cascade kills nodes). |
| `DELETE` | `/api/orchestrations?chatId=<id>` | Bulk delete all orchestrations for a chat. |

The client never calls DELETE itself — it's used by the chat-deletion
server route only.

File layout:

```
app/api/orchestrations/route.ts                      -- GET, PUT, DELETE
app/api/orchestrations/[id]/nodes/[nodeId]/route.ts  -- PATCH
```

### Client Persistence (`app/features/orchestration/orchestrationPersistence.ts`)

Module-scoped caches (one per browser tab, survive hook remounts):

```ts
type NodeSnapshot = Record<string, { status: NodeStatus; result: string | null }>;
type ParentSnapshot = { mode: string; summaryStarted: boolean; planHash: string };

const nodeCache = new Map<string, NodeSnapshot>();
const parentCache = new Map<string, ParentSnapshot>();
```

Exported functions:

```ts
persistOrchestrationDiff(state: OrchestrationState): Promise<void>
loadPersistedOrchestrations(chatId: string): Promise<OrchestrationState[]>
```

`persistOrchestrationDiff` only acts when `state.mode === 'workflow'`.
Algorithm:

1. Compare `(mode, summaryStarted, planHash)` against `parentCache[id]`.
   If absent or changed → `PUT /api/orchestrations/:id`. On 2xx, update
   parent cache. `planHash = hash(JSON.stringify(plan))`.
2. For each node in `state.nodeStatuses`, compare `(status, result)`
   against `nodeCache[id][nodeId]`. Collect changed entries.
3. Issue all changed-node PATCHes in parallel via `Promise.all`.
4. For each PATCH that returns 2xx, update `nodeCache[id][nodeId]`. Failed
   PATCHes leave the cache untouched so the next notify retries them.

`loadPersistedOrchestrations` seeds both caches from the loaded state so
the very next persist diff observes no spurious changes.

### Runtime Wiring (`useChatRuntime.ts`)

The existing `notifyRunStateChanged` → `scheduleOrchestrationPersist`
debounce (120ms) is kept. Internal implementation switches from
`persistOrchestration` (full blob) to `persistOrchestrationDiff`.

```ts
const scheduleOrchestrationPersist = (id: string) => {
  if (orchPersistTimerRef.current[id]) clearTimeout(orchPersistTimerRef.current[id]);
  orchPersistTimerRef.current[id] = setTimeout(() => {
    const orch = orchestrationsRef.current[id];
    if (orch && orch.mode === 'workflow') void persistOrchestrationDiff(orch);
  }, 120);
};
```

### Hydration

`hydrateOrchestrationsForChat(chatId)` is called from `wrappedLoadChat`
and from the initial-mount last-chat restore (existing code paths).

```ts
const orchs = await loadPersistedOrchestrations(chatId);
for (const o of orchs) {
  // Interrupted-by-reload recovery (option C):
  // Any node still 'running' when the tab died becomes 'awaiting-input'
  // with a synthetic prompt. The inline follow-up card reappears so the
  // user can retry or skip.
  for (const nodeId of Object.keys(o.nodeStatuses)) {
    if (o.nodeStatuses[nodeId] === 'running') {
      o.nodeStatuses[nodeId] = 'awaiting-input';
      o.results[nodeId] = o.results[nodeId] ||
        '⚠️ This node was interrupted by a page reload. ' +
        'Reply to retry, or type "skip" to skip.';
    }
  }
  o.summaryStarted = (o.workflowPlan?.nodes ?? []).every(n =>
    isTerminal(o.nodeStatuses[n.id])
  );
  orchestrationsRef.current[o.id] = o;
}
setRunVersion(v => v + 1);
```

`awaiting-input` already pauses dependents, so `maybeAdvanceOrchestration`
need not be invoked at the end of hydration. The recovery write-back is
picked up by the next normal persist diff.

### "skip" Reply Handling

The inline follow-up card's send handler recognizes a literal `"skip"`
reply (case-insensitive, trimmed):

- If `text.toLowerCase().trim() === 'skip'` → flip node to `skipped`,
  call `maybeAdvanceOrchestration`. No agent dispatch.
- Otherwise → existing resume path (re-dispatch the node).

This applies to both reload-recovery awaiting-input and the existing
question-from-agent awaiting-input.

### Stop Button

`handleStop` rewrites the cascade:

- Workflow nodes currently `running` or `awaiting-input` → `stopped`
  with result `"⏹ Stopped"`.
- Dependents that haven't reached terminal yet → `skipped`.
- `summaryStarted = true`.
- Status bar is preserved (existing behavior).

All these mutations flow through normal `notifyRunStateChanged` →
diff persist. No special "stop API" call.

### Chat Deletion

`DELETE /api/chats?id=<chatId>` already calls
`deleteOrchestrationsForChat(userId, chatId)`. Update that helper to
delete from the new parent table; cascade handles node rows.

## Data Flow

**Write path (single node finishes):**

```
chatAcpService.finalizeRun
  → orch.nodeStatuses[id] = 'ok'
  → orch.results[id]      = '...'
  → notifyRunStateChanged()
    → scheduleOrchestrationPersist(orchId) [debounced 120ms]
      → persistOrchestrationDiff(state)
        → diff vs nodeCache → 1 changed entry
        → PATCH /api/orchestrations/:id/nodes/:nodeId
        → on 2xx, update nodeCache
```

**Read path (page reload):**

```
initial mount → useEffect → fetch last-chat
  → wrappedLoadChat(lastChatId)
    → persistHandlers.loadChat(chatId)   [messages, etc.]
    → hydrateOrchestrationsForChat(chatId)
      → GET /api/orchestrations?chatId=...
      → rebuild OrchestrationState[]
      → seed caches
      → demote 'running' → 'awaiting-input'
      → write into orchestrationsRef
      → bump runVersion → UI re-renders
```

## Error Handling

- **PATCH failure** (network / 5xx): cache entry not updated; next notify
  retries. No user-visible error.
- **PUT failure**: same behavior; parent cache not updated; retried on
  next change.
- **GET failure** during hydration: log, continue with empty
  orchestrations (current behavior preserved). User sees an empty status
  bar, can resend.
- **Parent row missing when PATCH arrives** (shouldn't happen since PUT
  precedes PATCH): server returns 404, client retries PUT on next diff.

## Testing

### Unit tests (`node:test`)

- **`test/workflow-hydration.test.mjs`** — covers the pure recovery helper
  `recoverInterruptedOrchestration(state)`:
  - A node in ``running`` becomes ``awaiting-input`` with the synthetic
    reload-recovery prompt — the inline follow-up card therefore reappears
    on the next render, and replying to it routes through the existing
    resume path so retry continues the workflow.
  - Existing partial result text is preserved (synthetic prompt only fills
    when result is empty).
  - Non-running statuses (``pending``, ``awaiting-input``, ``ok``,
    ``failed``, ``skipped``) are not touched.
  - ``summaryStarted`` is recomputed: ``true`` iff all plan nodes are
    terminal (``ok|failed|skipped|stopped``).
  - The input state object is not mutated.

### Manual end-to-end

1. 3-node workflow runs to completion → refresh → all nodes `ok`, bar gone.
2. While node 1 is `running`, refresh → node 1 = `awaiting-input` with
   reload-prompt; card visible; nodes 2/3 still `pending`. Reply to the
   card → node 1 retries and finishes, node 2 fires (covered by the
   unit test above at the state-shape level; manual run confirms the
   UI loop).
3. Reply to reload-prompt with normal text → node 1 retries, finishes,
   node 2 fires.
4. Reply with `skip` → node 1 = `skipped`, dependents cascade-skip.
5. Click Stop while node 1 running → node 1 = `stopped` (⏹), nodes 2/3 =
   `skipped`, status bar persists.
6. Refresh after Stop → state preserved exactly.
7. Delete chat → orchestration + node rows gone
   (`SELECT COUNT(*) FROM orchestration_nodes`).
8. Two tabs on same chat: run in tab A, refresh tab B → tab B shows
   current state from DB. (Live sync not expected.)

## Migration

Destructive: `DROP TABLE IF EXISTS orchestrations;` then `CREATE TABLE`
new parent + child. In-flight runs are wiped. Acceptable in dev (no prod
data).

Also verify `PRAGMA foreign_keys = ON;` on connection open.

## Open Questions

None — all clarifying questions resolved during brainstorming.

## Out of Scope / Follow-ups

- Cross-tab live sync (SSE / WebSocket push of node updates).
- Backend orchestration worker (workflows survive tab close / laptop
  sleep). Requires its own spec.
- Replan-on-failure (`MAX_REPLANS`).
- Periodic cleanup of old terminal orchestrations.
