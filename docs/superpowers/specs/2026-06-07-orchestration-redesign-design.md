# Orchestration Redesign — DAG-based Multi-Agent Workflows

**Status:** Draft (pending user review)
**Date:** 2026-06-07
**Branch:** `feat/orchestration-redesign`

---

## 1. Goals

1. **Remove `discussion` mode** — it duplicates `auto` and adds a third pill without clear differentiation.
2. **Upgrade `auto` mode** — the scheduler should plan an entire multi-step task up front and dispatch sub-tasks that may run **in parallel or sequentially** based on data dependencies.
3. **Support user-authored workflows** — users can define a multi-agent task as a JSON file (or via the UI) and re-run it on demand.

All three goals are unified by a **single DAG execution model**: auto mode generates a DAG, and a workflow file *is* a DAG. One executor, two entry points.

## 2. Non-Goals

- No new graph visualization library (no React Flow / Mermaid in this iteration). Progress shown via a horizontal pill bar.
- No dynamic mid-flight DAG editing in the UI. Edit JSON → re-run.
- No conditional / branching primitives (`if`, `switch`) in v1. A node either runs (deps satisfied + ok) or is skipped (upstream failed).
- No retries with policy in v1. A failed node triggers re-planning by the scheduler, not an automatic retry of the same node.

---

## 3. Core Concepts

### 3.1 The DAG (`WorkflowPlan`)

A workflow plan is a directed acyclic graph of typed nodes. Same shape whether produced by the auto scheduler or loaded from a JSON file.

```jsonc
{
  "$schema": "workflow.schema.json",
  "name": "code-review",                       // optional, for saved workflows
  "version": 1,
  "nodes": [
    {
      "id": "lint",
      "agent": "code-agent",                    // agent id from agents.json or user registry
      "instruction": "Lint {{input}} and list issues.",
      "dependsOn": []                           // empty = runs first
    },
    {
      "id": "test",
      "agent": "test-agent",
      "instruction": "Run unit tests on {{input}}.",
      "dependsOn": []                           // runs in parallel with `lint`
    },
    {
      "id": "review",
      "agent": "review-agent",
      "instruction": "Review based on:\nLint: {{lint.output}}\nTests: {{test.output}}",
      "dependsOn": ["lint", "test"]             // waits for both → joins
    }
  ]
}
```

### 3.2 Execution semantics

- A node is **ready** when all `dependsOn` nodes are `done` (status `ok`).
- The executor walks ready nodes in waves and dispatches each via `dispatchToAgent` concurrently.
- A node is **skipped** if any upstream is `failed`.
- The DAG is **done** when every node is in a terminal state (`ok` / `failed` / `skipped`).
- **Topological cycle check** at load time → reject with a clear error.

### 3.3 Template substitution (`{{nodeId.output}}`)

Before dispatching a node:

1. Replace `{{input}}` with the original user message text (the message that triggered the workflow).
2. Replace `{{<depId>.output}}` with the textual output of node `<depId>`.
3. If the instruction contains **no** `{{}}` references **and** the node has dependencies, automatically append all upstream outputs in a deterministic format (compat with simple instructions like `"summarize"`).

```
--- <depId1>.output ---
<text>

--- <depId2>.output ---
<text>
```

Unknown template variables → fail the node (clear error), do not silently substitute empty string.

### 3.4 Failure → re-plan loop (auto mode only)

- User-authored workflows: a failed node halts the DAG; downstream nodes are skipped; UI shows the failure.
- Auto-generated plans: when a node fails, the executor calls the scheduler **once** with `{ originalRequest, originalPlan, failedNodeId, failureOutput, completedNodes }` and asks for a **revised remainder DAG**. Successful nodes' outputs are passed in so re-planning can reuse them. Re-plan attempts capped at **2** per DAG; after that, fail terminally.

---

## 4. Storage & Discovery

### 4.1 Repository workflows (system-wide)

- Location: `workflows/*.workflow.json` at repo root.
- Loaded at server startup; watched for changes in dev (`fs.watch`).
- Validated against a JSON schema (see §3.1). Invalid files logged and skipped.
- Shared by every user; tracked in git.

### 4.2 Personal workflows (per-user)

- New SQLite table `user_workflows`:
  ```sql
  CREATE TABLE user_workflows (
    id TEXT PRIMARY KEY,            -- uuid
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,             -- unique per user
    plan_json TEXT NOT NULL,        -- the DAG
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, name)
  );
  ```
- CRUD via `/api/workflows` (`GET` list, `POST` create, `PUT` update, `DELETE`).
- UI in v1: minimal — list, import-from-JSON textarea, delete. No graphical editor.
- Personal workflows of the same name as a repo workflow **override** the repo one for that user.

### 4.3 Triggering

- Composer slash command: `/wf <name>` opens a popup listing all available workflows (repo + personal, marked by source). Selecting one inserts `/wf <name>` and the user types the input.
- On send, `/wf <name> <rest>`: server resolves the workflow plan, sets `{{input}}` to `<rest>`, dispatches the DAG.
- Workflows also become a saved type alongside `auto` and `pipeline`.

---

## 5. UI Changes

### 5.1 Composer pill row (`ComposerTargetControls.tsx`)

**Before:** `[🧠 Auto] [🔀 Pipeline] [💬 Discussion (3 rounds)]`
**After:** `[🧠 Auto] [🔀 Pipeline] [📋 Workflow ▾]`

- `💬 Discussion` and `discussionRounds` selector — **removed**.
- `📋 Workflow` opens a small popover with the list of `/wf` workflows; selecting one fills the input prefix.

### 5.2 Plan bar (new component `PlanProgressBar.tsx`)

Rendered above the active message stream when an orchestration is running. Horizontal flex of pills, one per node:

```
[✓ lint] [🔄 test] [⏸ review]
```

- Status emoji + color: `⏸ pending` / `🔄 running` / `✓ ok` / `✗ failed` / `⊘ skipped`.
- Parallel-runnable nodes (same dependency layer) share a colored top border to visually group them.
- Click a pill → scroll the chat to that node's messages (each dispatched message tagged with `nodeId` in metadata).
- A `📋` icon on the bar copies the current plan JSON to clipboard ("Save as workflow" affordance).
- When re-planning happens, replaced/added tail pills animate in with a subtle highlight.

### 5.3 No DAG graph view

Stretch goal; not in v1.

---

## 6. Implementation Outline

### 6.1 New / changed files

**New:**
- `lib/workflow/types.ts` — `WorkflowPlan`, `WorkflowNode`, `NodeStatus`, `ExecutionState` types.
- `lib/workflow/schema.json` — JSON Schema for `*.workflow.json` validation.
- `lib/workflow/loadRepoWorkflows.ts` — scan `workflows/`, validate, cache, watch in dev.
- `lib/workflow/workflowStore.ts` — SQLite CRUD for `user_workflows`.
- `lib/workflow/templating.ts` — `{{nodeId.output}}` substitution + auto-append fallback.
- `lib/workflow/executor.ts` — topological wave executor + status callbacks.
- `lib/workflow/scheduler.ts` — auto-mode prompt builders: `buildPlanPrompt`, `buildReplanPrompt`, `parseSchedulerPlanResponse`.
- `app/api/workflows/route.ts` + `app/api/workflows/[id]/route.ts` — CRUD.
- `app/features/orchestration/PlanProgressBar.tsx` + `.css` — new plan bar.
- `app/features/composer/components/WorkflowPicker.tsx` — popover list for `/wf`.

**Changed:**
- `app/features/chat/runtime/chatOrchestrationService.ts` — replace `discussion`/`pipeline`/`auto` branches with: (a) sequential `pipeline` kept as-is; (b) `auto` calls scheduler once → executor; (c) new `workflow` kind calls executor directly.
- `app/features/chat/chatTypes.ts` — `OrchestrationMode = 'pipeline' | 'auto' | 'workflow'`. Add `OrchestrationState.plan: WorkflowPlan` and `nodeStatuses: Record<string, NodeStatus>`.
- `app/features/composer/components/ComposerTargetControls.tsx` — drop discussion pill; add workflow picker pill.
- `app/features/chat/runtime/chatRuntimeTypes.ts` — drop `discussionRounds` from context.
- `lib/scheduler/scheduleStore.ts` (or wherever schedules are persisted) — migration: any schedule with `mode = 'discussion'` rewritten to `mode = 'auto'`, plus a one-time system message on first run after upgrade.
- `lib/chatStore.ts` — schema bump if needed; add `user_workflows` table.

### 6.2 Migration script (one-shot at server boot)

In the SQLite open path:

```ts
db.exec(`
  UPDATE schedules SET mode = 'auto', migration_note = 'migrated_from_discussion'
  WHERE mode = 'discussion';
`);
```

The first time a migrated schedule runs, the system message
> "This schedule used the deprecated discussion mode and now runs in auto mode."
is emitted into its chat. The flag is then cleared.

### 6.3 Scheduler prompt sketch (auto plan)

```
You are a workflow planner. The user said:
<original message>

They @-mentioned these agents:
- code-agent: Writes & edits code
- test-agent: Runs tests
- review-agent: Reviews diffs

Output a JSON workflow with nodes that have {id, agent, instruction, dependsOn}.
Use {{input}} for the user's text. Use {{nodeId.output}} to reference upstream outputs.
Maximize parallelism: only add a dependency if the downstream node actually needs the upstream output.
Return JSON only, no prose.
```

`buildReplanPrompt` adds the original plan, completed outputs, and failed node info.

### 6.4 Tests

- **Unit (`lib/workflow/*.test.mjs`)**: topological readiness; cycle detection; template substitution including unknown var failure + auto-append fallback; skip-on-upstream-failure; re-plan token budget cap.
- **Integration**: executor with a stub dispatcher running a 3-node DAG with one parallel layer; failure → re-plan path.
- **E2E (Playwright)**: send `/wf <name>` with a fixture workflow + stub agent; verify plan bar pills transition `pending → running → ok` and final summary appears.
- **Migration test**: open SQLite with a `discussion` schedule row, run open, verify row becomes `auto` + flag present; emit system message on first run.

---

## 7. Data Flow Diagram

```
User message ─────┐
                  ├──▶ orchestrationService.runOrchestration
@mentions ────────┤        │
                  │        ├─ mode='pipeline'  ──▶ existing linear loop
                  │        ├─ mode='auto'      ──▶ scheduler.buildPlanPrompt
                  │        │                       └─▶ executor.run(plan)
                  │        └─ mode='workflow'  ──▶ load plan ──▶ executor.run(plan)
                  │
                  ▼
        ┌──────────────────────────────┐
        │   workflow/executor          │
        │   - topo wave loop           │
        │   - per-node dispatch        │
        │   - status callbacks ───────┼──▶ PlanProgressBar (subscribed via context)
        │   - on failure (auto only): │
        │     scheduler.buildReplan   │
        │     → splice tail of plan   │
        └──────────────────────────────┘
```

---

## 8. Edge Cases & Open Questions

| Concern | Resolution |
|---|---|
| Cyclic JSON workflow | Reject at load with `WorkflowValidationError`; tested. |
| Agent referenced in node missing | Mark node failed, skip downstream, emit system message. |
| Template references future node (`B` references `{{C.output}}` but C deps on B) | Caught by static analysis at executor start (every template var must reference a node that topologically precedes it). |
| Node output is huge (e.g. 50KB log) | v1: pass as-is. v2: add `{{node.output \| truncate:N}}`. |
| Re-plan loop runs forever | Hard cap 2 re-plans per DAG. |
| User edits a workflow while it's running | Workflows are loaded into the orchestration state at start; in-flight runs are immutable. |
| `auto` plan with 0 nodes (scheduler bug) | Treat as error, surface to user, do not silently no-op. |
| Save-as-workflow from a re-planned auto DAG | Save the **final** DAG (after re-plans), so the saved template represents what actually worked. |

---

## 9. Out of Scope (Future)

- Graphical DAG editor.
- Conditional / branching nodes.
- Per-node retry policies, timeouts, fallbacks.
- Sharing personal workflows between users / publishing to a workflow registry.
- Streaming partial outputs from a still-running node into downstream nodes' templates.
- Cost / token budgeting per workflow run.

---

## 10. Rollout

1. Land DAG executor + templating + tests (no UI yet).
2. Migrate auto mode to use the executor; keep current scheduler logic adapted to produce a one-shot plan.
3. Add migration of legacy `discussion` schedules.
4. Add plan bar + composer pill changes.
5. Add repo workflow loader + `/wf` picker.
6. Add personal workflows CRUD + UI list.
7. Save-as-workflow affordance.

Each step ships independently and is testable in isolation.
