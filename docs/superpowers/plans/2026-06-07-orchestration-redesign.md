# Orchestration Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three-mode orchestration (discussion / pipeline / auto) with a single DAG-based engine. Auto-mode generates a DAG up front (with parallel + serial nodes), and users can author the same DAG shape as a JSON workflow file or in SQLite. Discussion mode is removed.

**Architecture:** One DAG executor (`lib/workflow/executor.ts`) walks nodes in topological waves, dispatching ready nodes concurrently via the existing `dispatchToAgent`. Two entry points feed it: (a) the auto scheduler converts user prompt + @-mentions → `WorkflowPlan` via one LLM call (with one-shot re-plan on failure); (b) `/wf <name>` loads a plan from `workflows/*.workflow.json` or `user_workflows` SQLite table. UI gets a horizontal `PlanProgressBar` with one pill per node.

**Tech Stack:** TypeScript / Next.js 16 App Router, React 19, `better-sqlite3`, Node test runner (`node --test` via `.test.mjs`), Playwright E2E. No new third-party libraries.

**Spec:** `docs/superpowers/specs/2026-06-07-orchestration-redesign-design.md`

**Important discovery while writing this plan:** `'discussion'` is never persisted (no DB column, no JSON serialization of orchestrationMode). It's pure runtime UI state in `useChatRuntime`. So **no `cron_jobs` migration is required** — removing the type union + UI pill is sufficient. The plan reflects this simplification.

---

## File Structure

### New files

| Path | Responsibility |
|------|---|
| `lib/workflow/workflowTypes.ts` | `WorkflowPlan`, `WorkflowNode`, `NodeStatus`, `ExecutionState` types — single source of truth for shape |
| `lib/workflow/workflowSchema.ts` | Hand-rolled validator (no AJV) — returns `{ ok: true, plan } \| { ok: false, error }`; checks fields, types, cycles, undefined-dep references, undefined template refs |
| `lib/workflow/templating.ts` | Pure: substitute `{{input}}` and `{{nodeId.output}}`; auto-append upstream outputs when no `{{}}` present |
| `lib/workflow/executor.ts` | Topological wave loop, status callbacks, dispatcher injection; pure of UI / ACP knowledge |
| `lib/workflow/repoWorkflows.ts` | Scan `workflows/*.workflow.json`, validate, in-memory cache, `fs.watch` in dev |
| `lib/workflow/workflowStore.ts` | `better-sqlite3` CRUD for `user_workflows` table |
| `lib/workflow/scheduler.ts` | `buildPlanPrompt`, `buildReplanPrompt`, `parseSchedulerPlanResponse` — pure, used by chat runtime |
| `app/api/workflows/route.ts` | `GET` list (repo + user merged), `POST` create user workflow |
| `app/api/workflows/[id]/route.ts` | `GET` one, `PUT` update, `DELETE` user workflow |
| `app/features/orchestration/components/PlanProgressBar.tsx` | Horizontal pills, status emojis, click-to-scroll, copy-as-JSON |
| `app/features/orchestration/components/PlanProgressBar.css` | Styles |
| `app/features/composer/components/WorkflowPicker.tsx` | Popover that lists `/wf` candidates; clicking inserts `/wf <name> ` into the composer |
| `workflows/.gitkeep` | Make the repo workflows directory exist |
| `workflows/code-review.workflow.json` | Demo workflow used by the E2E test |
| `test/workflow-templating.test.mjs` | Unit tests |
| `test/workflow-schema.test.mjs` | Unit tests |
| `test/workflow-executor.test.mjs` | Unit tests |
| `test/workflow-scheduler.test.mjs` | Unit tests for prompt parsing |
| `test/test-workflow-e2e.spec.ts` | Playwright E2E |

### Modified files

| Path | What changes |
|------|---|
| `app/features/chat/chatTypes.ts` | `OrchestrationMode = 'pipeline' \| 'auto' \| 'workflow'`; extend `OrchestrationState` with `plan?: WorkflowPlan` and `nodeStatuses?: Record<string, NodeStatus>` |
| `app/features/chat/runtime/chatOrchestrationService.ts` | Delete `discussion` branch (lines ~70-105); auto branch (~136-225) replaced by call to executor; new `workflow` branch loads plan and runs executor |
| `app/features/chat/runtime/chatRuntimeTypes.ts` | Drop `discussionRounds`, `setDiscussionRounds`, `discussionRoundsRef` from context type |
| `app/features/chat/runtime/useChatRuntime.ts` | Drop `discussionRounds` state + setter; pass plan-bar state observer down |
| `app/features/composer/components/ComposerTargetControls.tsx` | Drop discussion pill + rounds selector (lines 58-67); add `📋 Workflow` pill that opens `WorkflowPicker` |
| `app/features/chat/ChatPageClient.tsx` | Render `<PlanProgressBar>` above the message list when an orchestration is active |
| `lib/chatStore.ts` | Add `user_workflows` table to the `migrate` block (lines ~119-178) |

---

## Implementation Order

Each task ends with a green test suite + commit. Tasks are ordered so the dependency graph holds (executor needs templating, scheduler needs schema, UI needs executor types).

1. Types + JSON schema validator (foundation, no I/O)
2. Templating engine (pure, TDD)
3. DAG executor (pure, TDD with stub dispatcher)
4. Auto scheduler prompt builders + response parser (pure, TDD)
5. Repo workflow loader (filesystem)
6. SQLite `user_workflows` + REST API
7. Wire executor into chat orchestration; remove discussion
8. Composer pill changes + workflow picker
9. `PlanProgressBar` component
10. Save-as-workflow button on plan bar
11. Playwright E2E

---

## Task 1: Workflow Types + Schema Validator

**Files:**
- Create: `lib/workflow/workflowTypes.ts`
- Create: `lib/workflow/workflowSchema.ts`
- Create: `test/workflow-schema.test.mjs`

- [ ] **Step 1: Create the types file**

```typescript
// lib/workflow/workflowTypes.ts
export type NodeStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface WorkflowNode {
  id: string;
  agent: string;
  instruction: string;
  dependsOn: string[];
}

export interface WorkflowPlan {
  name?: string;
  version: 1;
  nodes: WorkflowNode[];
}

export interface ExecutionState {
  planId: string;
  plan: WorkflowPlan;
  nodeStatuses: Record<string, NodeStatus>;
  nodeOutputs: Record<string, string>;
  failureReason?: string;
}

export interface SchemaError {
  code:
    | 'not_object' | 'missing_field' | 'wrong_type' | 'duplicate_node_id'
    | 'unknown_dependency' | 'cycle' | 'empty_nodes' | 'unknown_template_ref';
  message: string;
  nodeId?: string;
  field?: string;
}

export type SchemaResult =
  | { ok: true; plan: WorkflowPlan }
  | { ok: false; error: SchemaError };
```

- [ ] **Step 2: Write failing tests**

```javascript
// test/workflow-schema.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflowPlan } from '../lib/workflow/workflowSchema.js';

test('accepts a valid 2-node plan', () => {
  const res = validateWorkflowPlan({
    version: 1,
    nodes: [
      { id: 'a', agent: 'x', instruction: 'do', dependsOn: [] },
      { id: 'b', agent: 'y', instruction: 'use {{a.output}}', dependsOn: ['a'] },
    ],
  });
  assert.equal(res.ok, true);
});

test('rejects non-object input', () => {
  const res = validateWorkflowPlan('hello');
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'not_object');
});

test('rejects empty nodes array', () => {
  const res = validateWorkflowPlan({ version: 1, nodes: [] });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'empty_nodes');
});

test('rejects duplicate node ids', () => {
  const res = validateWorkflowPlan({
    version: 1,
    nodes: [
      { id: 'a', agent: 'x', instruction: 'i', dependsOn: [] },
      { id: 'a', agent: 'y', instruction: 'j', dependsOn: [] },
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'duplicate_node_id');
});

test('rejects unknown dependency', () => {
  const res = validateWorkflowPlan({
    version: 1,
    nodes: [{ id: 'a', agent: 'x', instruction: 'i', dependsOn: ['ghost'] }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'unknown_dependency');
});

test('rejects cycles', () => {
  const res = validateWorkflowPlan({
    version: 1,
    nodes: [
      { id: 'a', agent: 'x', instruction: 'i', dependsOn: ['b'] },
      { id: 'b', agent: 'y', instruction: 'j', dependsOn: ['a'] },
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'cycle');
});

test('rejects template references to nodes that are not transitive deps', () => {
  const res = validateWorkflowPlan({
    version: 1,
    nodes: [
      { id: 'a', agent: 'x', instruction: 'i', dependsOn: [] },
      { id: 'b', agent: 'y', instruction: 'use {{a.output}}', dependsOn: [] },
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'unknown_template_ref');
});

test('accepts {{input}} reference without it being a dependency', () => {
  const res = validateWorkflowPlan({
    version: 1,
    nodes: [{ id: 'a', agent: 'x', instruction: 'hi {{input}}', dependsOn: [] }],
  });
  assert.equal(res.ok, true);
});
```

- [ ] **Step 3: Verify tests fail**

Run: `node --test test/workflow-schema.test.mjs`
Expected: All fail with `Cannot find module '../lib/workflow/workflowSchema.js'`

- [ ] **Step 4: Implement the validator**

```typescript
// lib/workflow/workflowSchema.ts
import type { WorkflowPlan, WorkflowNode, SchemaResult, SchemaError } from './workflowTypes.js';

const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_-]+)\.output\s*\}\}/g;

function err(error: SchemaError): SchemaResult { return { ok: false, error }; }

export function validateWorkflowPlan(raw: unknown): SchemaResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return err({ code: 'not_object', message: 'Plan must be a JSON object' });
  }
  const p = raw as Record<string, unknown>;
  if (p.version !== 1) return err({ code: 'wrong_type', field: 'version', message: 'version must be 1' });
  if (!Array.isArray(p.nodes)) return err({ code: 'wrong_type', field: 'nodes', message: 'nodes must be an array' });
  if (p.nodes.length === 0) return err({ code: 'empty_nodes', message: 'nodes must not be empty' });

  const seen = new Set<string>();
  const nodes: WorkflowNode[] = [];
  for (const n of p.nodes as unknown[]) {
    if (!n || typeof n !== 'object') return err({ code: 'wrong_type', field: 'node', message: 'node must be an object' });
    const node = n as Record<string, unknown>;
    for (const f of ['id', 'agent', 'instruction'] as const) {
      if (typeof node[f] !== 'string' || !(node[f] as string).length) {
        return err({ code: 'missing_field', field: f, message: `node.${f} required (string)` });
      }
    }
    if (!Array.isArray(node.dependsOn)) return err({ code: 'wrong_type', field: 'dependsOn', message: 'dependsOn must be an array', nodeId: node.id as string });
    if ((node.dependsOn as unknown[]).some((d) => typeof d !== 'string')) {
      return err({ code: 'wrong_type', field: 'dependsOn', message: 'dependsOn entries must be strings', nodeId: node.id as string });
    }
    const id = node.id as string;
    if (seen.has(id)) return err({ code: 'duplicate_node_id', message: `duplicate node id "${id}"`, nodeId: id });
    seen.add(id);
    nodes.push({ id, agent: node.agent as string, instruction: node.instruction as string, dependsOn: node.dependsOn as string[] });
  }

  for (const n of nodes) {
    for (const d of n.dependsOn) {
      if (!seen.has(d)) return err({ code: 'unknown_dependency', message: `node "${n.id}" depends on unknown "${d}"`, nodeId: n.id });
    }
  }

  // Cycle / topological order check (Kahn).
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, n.dependsOn.length]));
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const n of nodes) for (const d of n.dependsOn) adj.get(d)!.push(n.id);
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const topo: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topo.push(id);
    for (const next of adj.get(id)!) {
      indeg.set(next, indeg.get(next)! - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (topo.length !== nodes.length) return err({ code: 'cycle', message: 'workflow contains a cycle' });

  // Transitive dep set for each node — template refs must target a transitive dep (or {{input}}).
  const transitive = new Map<string, Set<string>>();
  for (const id of topo) {
    const node = nodes.find((n) => n.id === id)!;
    const set = new Set<string>(node.dependsOn);
    for (const d of node.dependsOn) for (const t of transitive.get(d)!) set.add(t);
    transitive.set(id, set);
  }
  for (const n of nodes) {
    TEMPLATE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TEMPLATE_RE.exec(n.instruction))) {
      const ref = m[1];
      if (!transitive.get(n.id)!.has(ref)) {
        return err({ code: 'unknown_template_ref', message: `node "${n.id}" references {{${ref}.output}} but ${ref} is not a (transitive) dependency`, nodeId: n.id });
      }
    }
  }

  const plan: WorkflowPlan = { version: 1, nodes };
  if (typeof p.name === 'string') plan.name = p.name;
  return { ok: true, plan };
}
```

- [ ] **Step 5: Verify tests pass**

Run: `node --test test/workflow-schema.test.mjs`
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add lib/workflow/workflowTypes.ts lib/workflow/workflowSchema.ts test/workflow-schema.test.mjs
git commit -m "feat(workflow): add WorkflowPlan types and schema validator with cycle + template ref checks

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Templating Engine

**Files:**
- Create: `lib/workflow/templating.ts`
- Create: `test/workflow-templating.test.mjs`

- [ ] **Step 1: Write failing tests**

```javascript
// test/workflow-templating.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderInstruction } from '../lib/workflow/templating.js';

test('substitutes {{input}}', () => {
  const out = renderInstruction('hi {{input}}', 'hello', {}, []);
  assert.equal(out, 'hi hello');
});

test('substitutes {{node.output}} when provided', () => {
  const out = renderInstruction('use {{a.output}}', '', { a: 'foo' }, ['a']);
  assert.equal(out, 'use foo');
});

test('throws on unknown template variable', () => {
  assert.throws(
    () => renderInstruction('hi {{ghost.output}}', '', {}, []),
    /unknown template/i,
  );
});

test('auto-appends upstream outputs when instruction has no {{}}', () => {
  const out = renderInstruction(
    'summarize',
    'orig',
    { a: 'first', b: 'second' },
    ['a', 'b'],
  );
  assert.match(out, /summarize/);
  assert.match(out, /--- a\.output ---\nfirst/);
  assert.match(out, /--- b\.output ---\nsecond/);
});

test('does not auto-append when instruction has {{}}', () => {
  const out = renderInstruction(
    'use just {{a.output}}',
    '',
    { a: 'A', b: 'B' },
    ['a', 'b'],
  );
  assert.equal(out, 'use just A');
  assert.doesNotMatch(out, /---/);
});

test('handles multiple substitutions of same var', () => {
  const out = renderInstruction('{{a.output}} and {{a.output}}', '', { a: 'X' }, ['a']);
  assert.equal(out, 'X and X');
});
```

- [ ] **Step 2: Verify tests fail**

Run: `node --test test/workflow-templating.test.mjs`
Expected: all fail (module missing).

- [ ] **Step 3: Implement templating**

```typescript
// lib/workflow/templating.ts
const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_-]+)\.output\s*\}\}/g;
const INPUT_RE = /\{\{\s*input\s*\}\}/g;

export function renderInstruction(
  instruction: string,
  userInput: string,
  upstreamOutputs: Record<string, string>,
  dependsOn: string[],
): string {
  const hasTemplate = /\{\{[^}]+\}\}/.test(instruction);
  let result = instruction.replace(INPUT_RE, userInput);
  result = result.replace(TEMPLATE_RE, (_full, name: string) => {
    if (!(name in upstreamOutputs)) {
      throw new Error(`unknown template variable: {{${name}.output}}`);
    }
    return upstreamOutputs[name];
  });
  if (!hasTemplate && dependsOn.length > 0) {
    const parts = dependsOn
      .filter((d) => d in upstreamOutputs)
      .map((d) => `--- ${d}.output ---\n${upstreamOutputs[d]}`);
    if (parts.length) result = `${result}\n\n${parts.join('\n\n')}`;
  }
  return result;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `node --test test/workflow-templating.test.mjs`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/workflow/templating.ts test/workflow-templating.test.mjs
git commit -m "feat(workflow): add template renderer for {{input}} and {{nodeId.output}}

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: DAG Executor

**Files:**
- Create: `lib/workflow/executor.ts`
- Create: `test/workflow-executor.test.mjs`

- [ ] **Step 1: Write failing tests**

```javascript
// test/workflow-executor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../lib/workflow/executor.js';

const plan2parallel1join = {
  version: 1,
  nodes: [
    { id: 'a', agent: 'x', instruction: 'A', dependsOn: [] },
    { id: 'b', agent: 'x', instruction: 'B', dependsOn: [] },
    { id: 'c', agent: 'x', instruction: 'C uses {{a.output}} {{b.output}}', dependsOn: ['a', 'b'] },
  ],
};

test('runs nodes in topological order; parallel layer dispatched concurrently', async () => {
  const dispatched = [];
  let inFlight = 0;
  let maxParallel = 0;
  const dispatcher = async (node) => {
    inFlight++;
    maxParallel = Math.max(maxParallel, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    dispatched.push(node.id);
    return `out-${node.id}`;
  };
  const state = await runWorkflow(plan2parallel1join, 'orig', dispatcher);
  assert.equal(state.nodeStatuses.a, 'ok');
  assert.equal(state.nodeStatuses.b, 'ok');
  assert.equal(state.nodeStatuses.c, 'ok');
  assert.equal(state.nodeOutputs.c, 'out-c');
  assert.deepEqual(dispatched.slice(-1), ['c']); // c always last
  assert.equal(maxParallel, 2, 'a and b should run concurrently');
});

test('skips downstream when upstream fails', async () => {
  const dispatcher = async (node) => {
    if (node.id === 'a') throw new Error('A blew up');
    return `out-${node.id}`;
  };
  const state = await runWorkflow(plan2parallel1join, 'orig', dispatcher);
  assert.equal(state.nodeStatuses.a, 'failed');
  assert.equal(state.nodeStatuses.b, 'ok');
  assert.equal(state.nodeStatuses.c, 'skipped');
});

test('substitutes templates with upstream outputs in dispatched instruction', async () => {
  const seen = {};
  const dispatcher = async (node, rendered) => {
    seen[node.id] = rendered;
    return `out-${node.id}`;
  };
  await runWorkflow(plan2parallel1join, 'orig', dispatcher);
  assert.equal(seen.c, 'C uses out-a out-b');
});

test('emits status callback for each transition', async () => {
  const events = [];
  const dispatcher = async (node) => `out-${node.id}`;
  await runWorkflow(plan2parallel1join, 'orig', dispatcher, {
    onStatusChange: (nodeId, status) => events.push(`${nodeId}=${status}`),
  });
  for (const id of ['a', 'b', 'c']) {
    assert.ok(events.includes(`${id}=running`), `expected ${id}=running`);
    assert.ok(events.includes(`${id}=ok`), `expected ${id}=ok`);
  }
});

test('substitutes {{input}}', async () => {
  const seen = {};
  const plan = {
    version: 1,
    nodes: [{ id: 'a', agent: 'x', instruction: 'hi {{input}}', dependsOn: [] }],
  };
  await runWorkflow(plan, 'world', async (node, rendered) => {
    seen[node.id] = rendered;
    return 'out';
  });
  assert.equal(seen.a, 'hi world');
});
```

- [ ] **Step 2: Verify failing**

Run: `node --test test/workflow-executor.test.mjs`
Expected: all fail (module missing).

- [ ] **Step 3: Implement executor**

```typescript
// lib/workflow/executor.ts
import type { WorkflowPlan, WorkflowNode, NodeStatus, ExecutionState } from './workflowTypes.js';
import { renderInstruction } from './templating.js';

export type Dispatcher = (node: WorkflowNode, renderedInstruction: string) => Promise<string>;

export interface ExecutorOptions {
  planId?: string;
  onStatusChange?: (nodeId: string, status: NodeStatus, output?: string, error?: string) => void;
  initialState?: ExecutionState;
}

export async function runWorkflow(
  plan: WorkflowPlan,
  userInput: string,
  dispatch: Dispatcher,
  opts: ExecutorOptions = {},
): Promise<ExecutionState> {
  const state: ExecutionState = opts.initialState ?? {
    planId: opts.planId ?? `plan-${Date.now()}`,
    plan,
    nodeStatuses: Object.fromEntries(plan.nodes.map((n) => [n.id, 'pending' as NodeStatus])),
    nodeOutputs: {},
  };
  const setStatus = (id: string, status: NodeStatus, output?: string, error?: string) => {
    state.nodeStatuses[id] = status;
    if (output !== undefined) state.nodeOutputs[id] = output;
    opts.onStatusChange?.(id, status, output, error);
  };

  const byId = new Map(plan.nodes.map((n) => [n.id, n]));

  while (true) {
    const ready = plan.nodes.filter((n) => {
      if (state.nodeStatuses[n.id] !== 'pending') return false;
      return n.dependsOn.every((d) => state.nodeStatuses[d] === 'ok');
    });
    // Skip nodes whose any upstream is failed/skipped.
    for (const n of plan.nodes) {
      if (state.nodeStatuses[n.id] !== 'pending') continue;
      if (n.dependsOn.some((d) => ['failed', 'skipped'].includes(state.nodeStatuses[d]))) {
        setStatus(n.id, 'skipped');
      }
    }
    if (ready.length === 0) {
      const stillPending = plan.nodes.some((n) => state.nodeStatuses[n.id] === 'pending' || state.nodeStatuses[n.id] === 'running');
      if (!stillPending) break;
      // Should not happen — defensive.
      throw new Error('executor deadlock: no ready nodes but pending remain');
    }
    await Promise.all(ready.map(async (node) => {
      setStatus(node.id, 'running');
      try {
        const rendered = renderInstruction(node.instruction, userInput, state.nodeOutputs, node.dependsOn);
        const output = await dispatch(node, rendered);
        setStatus(node.id, 'ok', output);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(node.id, 'failed', undefined, msg);
        state.failureReason = `node "${node.id}" failed: ${msg}`;
      }
    }));
  }

  return state;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `node --test test/workflow-executor.test.mjs`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/workflow/executor.ts test/workflow-executor.test.mjs
git commit -m "feat(workflow): add topological-wave DAG executor with parallel dispatch + skip-on-fail

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Auto Scheduler Prompts + Parser

**Files:**
- Create: `lib/workflow/scheduler.ts`
- Create: `test/workflow-scheduler.test.mjs`

- [ ] **Step 1: Write failing tests**

```javascript
// test/workflow-scheduler.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanPrompt, buildReplanPrompt, parseSchedulerPlanResponse } from '../lib/workflow/scheduler.js';

test('plan prompt includes user message and agent list', () => {
  const p = buildPlanPrompt({
    userMessage: 'fix bug X',
    agents: [{ id: 'coder', description: 'writes code' }, { id: 'tester', description: 'tests' }],
  });
  assert.match(p, /fix bug X/);
  assert.match(p, /coder.*writes code/);
  assert.match(p, /tester.*tests/);
  assert.match(p, /JSON/i);
});

test('replan prompt includes original, failed node, and completed outputs', () => {
  const p = buildReplanPrompt({
    userMessage: 'review pr',
    agents: [{ id: 'r', description: 'reviewer' }],
    originalPlan: { version: 1, nodes: [{ id: 'a', agent: 'r', instruction: 'go', dependsOn: [] }] },
    failedNodeId: 'a',
    failureMessage: 'agent timeout',
    completedOutputs: { x: 'done earlier' },
  });
  assert.match(p, /review pr/);
  assert.match(p, /a/);
  assert.match(p, /agent timeout/);
  assert.match(p, /done earlier/);
});

test('parses scheduler response wrapped in code fences', () => {
  const raw = 'Sure!\n```json\n{"version":1,"nodes":[{"id":"a","agent":"x","instruction":"i","dependsOn":[]}]}\n```\nlet me know.';
  const res = parseSchedulerPlanResponse(raw);
  assert.equal(res.ok, true);
  assert.equal(res.plan.nodes.length, 1);
});

test('parses bare JSON response', () => {
  const raw = '{"version":1,"nodes":[{"id":"a","agent":"x","instruction":"i","dependsOn":[]}]}';
  const res = parseSchedulerPlanResponse(raw);
  assert.equal(res.ok, true);
});

test('returns error on invalid JSON', () => {
  const res = parseSchedulerPlanResponse('not json at all');
  assert.equal(res.ok, false);
  assert.match(res.error, /parse/i);
});

test('returns error on invalid plan shape', () => {
  const res = parseSchedulerPlanResponse('{"version":1,"nodes":[]}');
  assert.equal(res.ok, false);
});
```

- [ ] **Step 2: Verify failing**

Run: `node --test test/workflow-scheduler.test.mjs`
Expected: all fail (module missing).

- [ ] **Step 3: Implement**

```typescript
// lib/workflow/scheduler.ts
import type { WorkflowPlan } from './workflowTypes.js';
import { validateWorkflowPlan } from './workflowSchema.js';

export interface AgentDescriptor { id: string; description: string }

export interface PlanPromptArgs {
  userMessage: string;
  agents: AgentDescriptor[];
}

export interface ReplanPromptArgs extends PlanPromptArgs {
  originalPlan: WorkflowPlan;
  failedNodeId: string;
  failureMessage: string;
  completedOutputs: Record<string, string>;
}

const PLAN_RULES = `Output a JSON workflow with this shape:
{ "version": 1, "nodes": [ { "id": "<id>", "agent": "<agent-id>", "instruction": "<text>", "dependsOn": ["<id>", ...] } ] }

Rules:
- Use {{input}} to reference the user's original message inside an instruction.
- Use {{<nodeId>.output}} to reference an upstream node's output. The referenced node MUST be in dependsOn (transitively).
- Maximize parallelism: ONLY add a dependsOn entry when the downstream node actually needs the upstream output.
- Use agent ids from the list below — do NOT invent agents.
- Node ids are short, kebab-case, unique.
- Return JSON ONLY — no prose, no commentary.`;

function agentBlock(agents: AgentDescriptor[]): string {
  return agents.map((a) => `- ${a.id}: ${a.description}`).join('\n');
}

export function buildPlanPrompt(args: PlanPromptArgs): string {
  return `You are a workflow planner.

User message:
${args.userMessage}

Available agents:
${agentBlock(args.agents)}

${PLAN_RULES}`;
}

export function buildReplanPrompt(args: ReplanPromptArgs): string {
  const completedBlock = Object.entries(args.completedOutputs)
    .map(([id, out]) => `### ${id}\n${out}`).join('\n\n') || '(none)';
  return `You are a workflow planner. A previous plan failed at one node and you must produce a REVISED plan for the remaining work.

Original user message:
${args.userMessage}

Available agents:
${agentBlock(args.agents)}

Previous plan:
${JSON.stringify(args.originalPlan, null, 2)}

Failed node id: ${args.failedNodeId}
Failure message: ${args.failureMessage}

Outputs already produced (these will be reused — do not recompute them; you may reference {{<id>.output}} if your new nodes dependsOn them):
${completedBlock}

${PLAN_RULES}`;
}

export interface ParseResult {
  ok: boolean;
  plan?: WorkflowPlan;
  error?: string;
}

export function parseSchedulerPlanResponse(raw: string): ParseResult {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  let parsed: unknown;
  try { parsed = JSON.parse(candidate); }
  catch (e) {
    return { ok: false, error: `failed to parse scheduler response as JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const res = validateWorkflowPlan(parsed);
  if (!res.ok) return { ok: false, error: `invalid plan: ${res.error.message}` };
  return { ok: true, plan: res.plan };
}
```

- [ ] **Step 4: Verify tests pass**

Run: `node --test test/workflow-scheduler.test.mjs`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/workflow/scheduler.ts test/workflow-scheduler.test.mjs
git commit -m "feat(workflow): add scheduler prompt builders + plan response parser

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Repo Workflow Loader

**Files:**
- Create: `lib/workflow/repoWorkflows.ts`
- Create: `workflows/.gitkeep` (empty file)
- Create: `workflows/code-review.workflow.json` (demo)
- Create: `test/workflow-repoworkflows.test.mjs`

- [ ] **Step 1: Create demo workflow**

```json
// workflows/code-review.workflow.json
{
  "name": "code-review",
  "version": 1,
  "nodes": [
    {
      "id": "lint",
      "agent": "stub-agent",
      "instruction": "Lint {{input}} and list issues.",
      "dependsOn": []
    },
    {
      "id": "test",
      "agent": "stub-agent",
      "instruction": "Run unit tests for {{input}}.",
      "dependsOn": []
    },
    {
      "id": "review",
      "agent": "stub-agent",
      "instruction": "Summarize review based on:\nLint: {{lint.output}}\nTests: {{test.output}}",
      "dependsOn": ["lint", "test"]
    }
  ]
}
```

- [ ] **Step 2: Create `.gitkeep`**

```bash
ni workflows/.gitkeep
```

- [ ] **Step 3: Write failing tests**

```javascript
// test/workflow-repoworkflows.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRepoWorkflows } from '../lib/workflow/repoWorkflows.js';

test('loads the demo code-review workflow', async () => {
  const list = await loadRepoWorkflows();
  const cr = list.find((w) => w.name === 'code-review');
  assert.ok(cr, 'code-review workflow should be loaded');
  assert.equal(cr.source, 'repo');
  assert.equal(cr.plan.nodes.length, 3);
});

test('skips invalid workflow files without throwing', async () => {
  const list = await loadRepoWorkflows();
  assert.ok(Array.isArray(list));
});
```

- [ ] **Step 4: Verify failing**

Run: `node --test test/workflow-repoworkflows.test.mjs`
Expected: all fail (module missing).

- [ ] **Step 5: Implement loader**

```typescript
// lib/workflow/repoWorkflows.ts
import { readdir, readFile } from 'fs/promises';
import path from 'path';
import type { WorkflowPlan } from './workflowTypes.js';
import { validateWorkflowPlan } from './workflowSchema.js';

export interface RepoWorkflow {
  name: string;
  source: 'repo';
  filePath: string;
  plan: WorkflowPlan;
}

const WORKFLOWS_DIR = path.join(process.cwd(), 'workflows');

export async function loadRepoWorkflows(): Promise<RepoWorkflow[]> {
  let entries: string[] = [];
  try { entries = await readdir(WORKFLOWS_DIR); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const files = entries.filter((e) => e.endsWith('.workflow.json'));
  const out: RepoWorkflow[] = [];
  for (const f of files) {
    const full = path.join(WORKFLOWS_DIR, f);
    try {
      const raw = await readFile(full, 'utf-8');
      const parsed = JSON.parse(raw);
      const res = validateWorkflowPlan(parsed);
      if (!res.ok) {
        console.warn(`[repoWorkflows] skipping ${f}: ${res.error.message}`);
        continue;
      }
      const name = res.plan.name ?? f.replace(/\.workflow\.json$/, '');
      out.push({ name, source: 'repo', filePath: full, plan: { ...res.plan, name } });
    } catch (err) {
      console.warn(`[repoWorkflows] failed to load ${f}:`, err);
    }
  }
  return out;
}
```

- [ ] **Step 6: Verify tests pass**

Run: `node --test test/workflow-repoworkflows.test.mjs`
Expected: 2 passed.

- [ ] **Step 7: Commit**

```bash
git add lib/workflow/repoWorkflows.ts workflows/.gitkeep workflows/code-review.workflow.json test/workflow-repoworkflows.test.mjs
git commit -m "feat(workflow): repo workflow loader + demo code-review.workflow.json

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: SQLite user_workflows + REST API

**Files:**
- Modify: `lib/chatStore.ts` (add table to `migrate` block)
- Create: `lib/workflow/workflowStore.ts`
- Create: `app/api/workflows/route.ts`
- Create: `app/api/workflows/[id]/route.ts`

- [ ] **Step 1: Add `user_workflows` table**

Open `lib/chatStore.ts`. After the existing `CREATE TABLE IF NOT EXISTS file_comment_replies (...)` block (around line 178), add inside the same `_db.exec(\`...\`)` call:

```sql
CREATE TABLE IF NOT EXISTS user_workflows (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_user_workflows_user ON user_workflows(user_id);
```

- [ ] **Step 2: Create the store**

```typescript
// lib/workflow/workflowStore.ts
import { randomUUID } from 'crypto';
import { getDb } from '../chatStore.js';
import type { WorkflowPlan } from './workflowTypes.js';
import { validateWorkflowPlan } from './workflowSchema.js';

export interface UserWorkflowRow {
  id: string;
  userId: string;
  name: string;
  plan: WorkflowPlan;
  createdAt: number;
  updatedAt: number;
}

function rowToUserWorkflow(r: any): UserWorkflowRow {
  return {
    id: r.id, userId: r.user_id, name: r.name,
    plan: JSON.parse(r.plan_json),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function listUserWorkflows(userId: string): UserWorkflowRow[] {
  const db = getDb();
  return (db.prepare('SELECT * FROM user_workflows WHERE user_id = ? ORDER BY name').all(userId) as any[]).map(rowToUserWorkflow);
}

export function getUserWorkflow(userId: string, id: string): UserWorkflowRow | null {
  const db = getDb();
  const r = db.prepare('SELECT * FROM user_workflows WHERE user_id = ? AND id = ?').get(userId, id) as any;
  return r ? rowToUserWorkflow(r) : null;
}

export function getUserWorkflowByName(userId: string, name: string): UserWorkflowRow | null {
  const db = getDb();
  const r = db.prepare('SELECT * FROM user_workflows WHERE user_id = ? AND name = ?').get(userId, name) as any;
  return r ? rowToUserWorkflow(r) : null;
}

export interface CreateInput { name: string; plan: unknown }

export function createUserWorkflow(userId: string, input: CreateInput): { ok: true; row: UserWorkflowRow } | { ok: false; error: string } {
  const valid = validateWorkflowPlan(input.plan);
  if (!valid.ok) return { ok: false, error: valid.error.message };
  if (!input.name || !/^[a-z0-9][a-z0-9-]*$/.test(input.name)) return { ok: false, error: 'name must be lowercase kebab-case' };
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  try {
    db.prepare(
      'INSERT INTO user_workflows (id, user_id, name, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, userId, input.name, JSON.stringify({ ...valid.plan, name: input.name }), now, now);
  } catch (e) {
    return { ok: false, error: `failed to insert: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, row: getUserWorkflow(userId, id)! };
}

export function updateUserWorkflow(userId: string, id: string, input: Partial<CreateInput>): { ok: true; row: UserWorkflowRow } | { ok: false; error: string } {
  const existing = getUserWorkflow(userId, id);
  if (!existing) return { ok: false, error: 'not found' };
  const newName = input.name ?? existing.name;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(newName)) return { ok: false, error: 'name must be lowercase kebab-case' };
  let planJson = JSON.stringify(existing.plan);
  if (input.plan !== undefined) {
    const valid = validateWorkflowPlan(input.plan);
    if (!valid.ok) return { ok: false, error: valid.error.message };
    planJson = JSON.stringify({ ...valid.plan, name: newName });
  }
  const db = getDb();
  db.prepare('UPDATE user_workflows SET name = ?, plan_json = ?, updated_at = ? WHERE user_id = ? AND id = ?')
    .run(newName, planJson, Date.now(), userId, id);
  return { ok: true, row: getUserWorkflow(userId, id)! };
}

export function deleteUserWorkflow(userId: string, id: string): boolean {
  const db = getDb();
  return db.prepare('DELETE FROM user_workflows WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}
```

Note: if `getDb()` is not the existing exported name for the better-sqlite3 handle in `lib/chatStore.ts`, look at the existing helpers (`getChats`, `saveChat`, etc.) and follow the same access pattern. Add `export function getDb(): Database.Database { ensureInit(); return _db!; }` if needed.

- [ ] **Step 3: Create REST route — list + create**

```typescript
// app/api/workflows/route.ts
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../lib/authOptions';
import { listUserWorkflows, createUserWorkflow } from '../../../lib/workflow/workflowStore';
import { loadRepoWorkflows } from '../../../lib/workflow/repoWorkflows';

export const dynamic = 'force-dynamic';

function userIdFrom(session: any): string | null {
  return session?.user?.email ?? null;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = userIdFrom(session);
  if (!userId) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const repo = await loadRepoWorkflows();
  const user = listUserWorkflows(userId);
  // User entries override repo entries by name.
  const userNames = new Set(user.map((u) => u.name));
  const merged = [
    ...user.map((u) => ({ id: u.id, name: u.name, source: 'user' as const, plan: u.plan })),
    ...repo.filter((r) => !userNames.has(r.name)).map((r) => ({ id: r.filePath, name: r.name, source: 'repo' as const, plan: r.plan })),
  ];
  return NextResponse.json({ ok: true, workflows: merged });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = userIdFrom(session);
  if (!userId) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.name !== 'string') {
    return NextResponse.json({ ok: false, error: 'name and plan required' }, { status: 400 });
  }
  const res = createUserWorkflow(userId, { name: body.name, plan: body.plan });
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, workflow: res.row });
}
```

- [ ] **Step 4: Create REST route — single workflow (GET/PUT/DELETE)**

```typescript
// app/api/workflows/[id]/route.ts
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../../lib/authOptions';
import { getUserWorkflow, updateUserWorkflow, deleteUserWorkflow } from '../../../../lib/workflow/workflowStore';

export const dynamic = 'force-dynamic';

async function uid() {
  const s = await getServerSession(authOptions);
  return s?.user?.email ?? null;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const userId = await uid();
  if (!userId) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const row = getUserWorkflow(userId, params.id);
  if (!row) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, workflow: row });
}

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const userId = await uid();
  if (!userId) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ ok: false, error: 'json body required' }, { status: 400 });
  const res = updateUserWorkflow(userId, params.id, { name: body.name, plan: body.plan });
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, workflow: res.row });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const userId = await uid();
  if (!userId) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const ok = deleteUserWorkflow(userId, params.id);
  if (!ok) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
```

If the project uses a different auth-options import (look at any other `app/api/**/route.ts` for the actual path — e.g. `'@/lib/authOptions'` or `'../../../../lib/auth'`), match that import.

- [ ] **Step 5: Verify tsc**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add lib/chatStore.ts lib/workflow/workflowStore.ts app/api/workflows
git commit -m "feat(workflow): user_workflows SQLite table + REST CRUD merging repo + user workflows

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 7: Wire Executor Into Chat Orchestration; Remove Discussion

**Files:**
- Modify: `app/features/chat/chatTypes.ts`
- Modify: `app/features/chat/runtime/chatOrchestrationService.ts`
- Modify: `app/features/chat/runtime/chatRuntimeTypes.ts`
- Modify: `app/features/chat/runtime/useChatRuntime.ts`

- [ ] **Step 1: Update `OrchestrationMode` and `OrchestrationState`**

In `app/features/chat/chatTypes.ts`:

```typescript
// Replace existing OrchestrationMode line (~95):
export type OrchestrationMode = 'pipeline' | 'auto' | 'workflow';

// Replace existing OrchestrationState (~120):
import type { WorkflowPlan, NodeStatus } from '../../../lib/workflow/workflowTypes';

export type OrchestrationState = {
  id: string;
  mode: OrchestrationMode;
  agentIds: string[];
  originalTask: string;
  results: Record<string, string>;
  nextIndex: number;
  summaryStarted: boolean;
  round: number;
  maxRounds: number;
  sourceUserMessageId?: string;
  sourceChatId?: string;
  sourceAgentIds?: string[];
  sourceMessage?: string;
  sourceAttachments?: ChatAttachment[];
  // New: live DAG state for workflow & auto modes.
  plan?: WorkflowPlan;
  nodeStatuses?: Record<string, NodeStatus>;
  replanCount?: number;
};
```

- [ ] **Step 2: Drop discussion + add workflow path in orchestration service**

Open `app/features/chat/runtime/chatOrchestrationService.ts`:

- Delete lines 70-105 (the `if (state.mode === 'discussion')` block).
- Delete lines 136-225 (the `if (state.mode === 'auto')` block) and the helper `runAutoOrchestration`.
- In the context type, remove `discussionRoundsRef`.
- Replace the dispatch switch in `runOrchestration` (~lines 268-322):

```typescript
import { runWorkflow } from '../../../../lib/workflow/executor';
import { buildPlanPrompt, buildReplanPrompt, parseSchedulerPlanResponse } from '../../../../lib/workflow/scheduler';
import type { WorkflowPlan } from '../../../../lib/workflow/workflowTypes';

const MAX_REPLANS = 2;

async function dispatchPlan(orchestrationId: string, plan: WorkflowPlan, userInput: string, chatId: string, attachments: ChatAttachment[]) {
  const state = ctx.orchestrationsRef.current[orchestrationId];
  if (!state) return;
  state.plan = plan;
  state.nodeStatuses = Object.fromEntries(plan.nodes.map((n) => [n.id, 'pending' as const]));
  ctx.notifyRunStateChanged();

  const dispatcher = async (node, rendered) => {
    const out = await ctx.dispatchToAgent(node.agent, rendered, orchestrationId, 'worker', {
      chatId, relation: `Node: ${node.id}`, attachments,
    });
    return out;
  };

  const result = await runWorkflow(plan, userInput, dispatcher, {
    planId: orchestrationId,
    onStatusChange: (id, status, output) => {
      if (state.nodeStatuses) state.nodeStatuses[id] = status;
      if (output !== undefined) state.results[id] = output;
      ctx.notifyRunStateChanged();
    },
  });
  return result;
}
```

Then in the mode switch, replace the auto/discussion branches with:

```typescript
if (orchestrationMode === 'workflow') {
  // effectiveMessage is the {{input}} body. Plan was resolved upstream and attached to state.
  const plan = (state as any).plan as WorkflowPlan | undefined;
  if (!plan) throw new Error('workflow mode requires a plan');
  await dispatchPlan(orchestrationId, plan, effectiveMessage, effectiveChatId, promptAttachments);
} else if (orchestrationMode === 'auto') {
  const schedulerAgentId = SCHEDULER_AGENT_ID;
  const planText = await ctx.dispatchToAgent(
    schedulerAgentId,
    buildPlanPrompt({
      userMessage: originalText,
      agents: agentIds.map((id) => ({
        id,
        description: ctx.agentsRef.current.find((a) => a.id === id)?.description ?? '',
      })),
    }),
    orchestrationId, 'worker', { chatId: effectiveChatId, relation: 'Auto: planning' },
  );
  const parsed = parseSchedulerPlanResponse(planText);
  if (!parsed.ok || !parsed.plan) {
    ctx.addMessage({ type: 'system', content: `⚠️ Scheduler failed to produce a valid plan: ${parsed.error}` });
    return;
  }
  let plan = parsed.plan;
  let replans = 0;
  while (true) {
    const result = await dispatchPlan(orchestrationId, plan, originalText, effectiveChatId, promptAttachments);
    const failed = result && Object.entries(result.nodeStatuses).find(([, s]) => s === 'failed');
    if (!failed) break;
    if (replans >= MAX_REPLANS) {
      ctx.addMessage({ type: 'system', content: `⚠️ Workflow halted after ${MAX_REPLANS} replans; node "${failed[0]}" still failing.` });
      break;
    }
    replans++;
    const replanText = await ctx.dispatchToAgent(
      schedulerAgentId,
      buildReplanPrompt({
        userMessage: originalText,
        agents: agentIds.map((id) => ({ id, description: ctx.agentsRef.current.find((a) => a.id === id)?.description ?? '' })),
        originalPlan: plan,
        failedNodeId: failed[0],
        failureMessage: result.failureReason ?? 'unknown',
        completedOutputs: result.nodeOutputs,
      }),
      orchestrationId, 'worker', { chatId: effectiveChatId, relation: `Auto: replanning (${replans})` },
    );
    const reparsed = parseSchedulerPlanResponse(replanText);
    if (!reparsed.ok || !reparsed.plan) {
      ctx.addMessage({ type: 'system', content: `⚠️ Replan failed: ${reparsed.error}` });
      break;
    }
    plan = reparsed.plan;
  }
} else {
  // pipeline — unchanged
  // … existing pipeline code …
}
```

- [ ] **Step 3: Drop discussionRounds from runtime types**

In `app/features/chat/runtime/chatRuntimeTypes.ts`, remove the three lines around 66-68:

```typescript
// REMOVE:
discussionRounds: number;
setDiscussionRounds: (n: number) => void;
```

In `app/features/chat/runtime/useChatRuntime.ts`, remove the `discussionRounds` state, ref, setter, and any references to them.

- [ ] **Step 4: Verify type-check**

Run: `npx tsc --noEmit`
Expected: 0 errors. If there are stray references, remove them.

- [ ] **Step 5: Commit**

```bash
git add app/features/chat
git commit -m "feat(orchestration): replace discussion/pipeline/auto branches with DAG executor + replan loop

- OrchestrationMode is now 'pipeline' | 'auto' | 'workflow'
- Auto mode generates a WorkflowPlan via scheduler.buildPlanPrompt and runs it through the DAG executor
- Node failures trigger up to 2 replans before halting
- Discussion mode removed entirely (it was never persisted — pure runtime UI state)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 8: Composer Pill Changes + Workflow Picker

**Files:**
- Modify: `app/features/composer/components/ComposerTargetControls.tsx`
- Create: `app/features/composer/components/WorkflowPicker.tsx`
- Modify: `app/features/composer/components/ChatComposer.tsx` (if it owns the workflow picker open state) — only if needed

- [ ] **Step 1: Drop discussion pill, add workflow pill**

In `ComposerTargetControls.tsx`, find lines 58-67 (the discussion pill and rounds selector) and replace with:

```tsx
<button
  type="button"
  className={`targetPill orchPill ${orchestrationMode === 'workflow' ? 'orchPillActive' : ''}`}
  onClick={() => setShowWorkflowPicker((v) => !v)}
  title="Workflow: run a saved DAG of agent tasks"
>
  📋 Workflow
</button>
{showWorkflowPicker && (
  <WorkflowPicker
    onClose={() => setShowWorkflowPicker(false)}
    onPick={(name) => {
      setShowWorkflowPicker(false);
      setOrchestrationMode('workflow');
      onWorkflowPicked?.(name);
    }}
  />
)}
```

Add to props:

```typescript
onWorkflowPicked?: (name: string) => void;
```

Add at top of component body:

```typescript
const [showWorkflowPicker, setShowWorkflowPicker] = useState(false);
```

Also remove `discussionRounds` / `setDiscussionRounds` from this component's props and destructure.

- [ ] **Step 2: Create the picker**

```tsx
// app/features/composer/components/WorkflowPicker.tsx
import { useEffect, useState } from 'react';

interface WorkflowEntry { id: string; name: string; source: 'user' | 'repo'; }

interface Props {
  onClose: () => void;
  onPick: (name: string) => void;
}

export function WorkflowPicker({ onClose, onPick }: Props) {
  const [items, setItems] = useState<WorkflowEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/workflows')
      .then((r) => r.json())
      .then((data) => {
        if (data?.ok) setItems(data.workflows);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="workflowPickerOverlay" onClick={onClose}>
      <div className="workflowPickerPopover" onClick={(e) => e.stopPropagation()}>
        <div className="workflowPickerHeader">Select a workflow</div>
        {loading && <div className="workflowPickerEmpty">Loading…</div>}
        {!loading && items.length === 0 && <div className="workflowPickerEmpty">No workflows. Add one in workflows/ or via the API.</div>}
        {items.map((w) => (
          <button key={`${w.source}:${w.id}`} className="workflowPickerItem" onClick={() => onPick(w.name)}>
            <span className="workflowPickerName">{w.name}</span>
            <span className="workflowPickerSource">{w.source}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

Add minimal styles (append to nearest co-located CSS, e.g. `ChatComposer.css`):

```css
.chatPageRoot .workflowPickerOverlay {
  position: fixed; inset: 0; z-index: 80; background: transparent;
}
.chatPageRoot .workflowPickerPopover {
  position: absolute; bottom: 56px; left: 16px;
  background: var(--panel-strong); border: 1px solid var(--border);
  border-radius: 10px; padding: 6px; min-width: 240px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.32);
}
.chatPageRoot .workflowPickerHeader {
  font-size: 11px; color: var(--muted); padding: 6px 8px;
}
.chatPageRoot .workflowPickerEmpty {
  padding: 12px; color: var(--muted); font-size: 12px;
}
.chatPageRoot .workflowPickerItem {
  display: flex; justify-content: space-between; align-items: center;
  width: 100%; padding: 8px 10px; border: 0; background: transparent;
  color: var(--text); border-radius: 6px; cursor: pointer; font: inherit;
}
.chatPageRoot .workflowPickerItem:hover { background: rgba(255,255,255,0.06); }
.chatPageRoot .workflowPickerName { font-size: 13px; }
.chatPageRoot .workflowPickerSource {
  font-size: 10px; color: var(--muted); text-transform: uppercase;
}
```

- [ ] **Step 3: Wire `onWorkflowPicked` to chat runtime**

In whichever parent owns the composer (`ChatComposer.tsx` or `ChatPageClient.tsx`), pass an `onWorkflowPicked` that:
1. Sets pending workflow name in runtime state.
2. On next send, resolves the workflow via `/api/workflows`, attaches the plan to the orchestration state, dispatches as `workflow` mode.

Concrete addition to `useChatRuntime.ts`:

```typescript
const [pendingWorkflowName, setPendingWorkflowName] = useState<string | null>(null);
const pendingWorkflowRef = useRef<string | null>(null);
useEffect(() => { pendingWorkflowRef.current = pendingWorkflowName; }, [pendingWorkflowName]);
```

In the send handler (where `runOrchestration` is invoked), if `orchestrationModeRef.current === 'workflow'` and `pendingWorkflowRef.current` is set, fetch + resolve before dispatching:

```typescript
if (orchestrationModeRef.current === 'workflow' && pendingWorkflowRef.current) {
  const resp = await fetch(`/api/workflows`).then((r) => r.json());
  const wf = resp?.workflows?.find((w: any) => w.name === pendingWorkflowRef.current);
  if (!wf) {
    addMessage({ type: 'system', content: `⚠️ Workflow "${pendingWorkflowRef.current}" not found.` });
    return;
  }
  // Attach plan to orchestration state before runOrchestration consumes mode.
  (orchestrationsRef.current[newOrchestrationId] ??= { /* init */ } as any).plan = wf.plan;
  setPendingWorkflowName(null);
}
```

(Adapt to actual variable names. The point: by the time `runOrchestration` sees `mode === 'workflow'`, `state.plan` must already be set.)

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add app/features/composer app/features/chat/runtime
git commit -m "feat(composer): drop discussion pill, add workflow picker pill that loads via /api/workflows

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 9: PlanProgressBar Component

**Files:**
- Create: `app/features/orchestration/components/PlanProgressBar.tsx`
- Create: `app/features/orchestration/components/PlanProgressBar.css`
- Modify: `app/features/chat/ChatPageClient.tsx` (mount it)

- [ ] **Step 1: Component**

```tsx
// app/features/orchestration/components/PlanProgressBar.tsx
import './PlanProgressBar.css';
import type { WorkflowPlan, NodeStatus } from '../../../../lib/workflow/workflowTypes';

interface Props {
  plan: WorkflowPlan;
  nodeStatuses: Record<string, NodeStatus>;
  onNodeClick?: (nodeId: string) => void;
  onCopyJson?: () => void;
}

const EMOJI: Record<NodeStatus, string> = {
  pending: '⏸', running: '🔄', ok: '✓', failed: '✗', skipped: '⊘',
};

// Group nodes into topological layers for visual grouping (parallel layer = same border color).
function layerize(plan: WorkflowPlan): string[][] {
  const layerOf = new Map<string, number>();
  for (const n of plan.nodes) {
    const max = n.dependsOn.reduce((m, d) => Math.max(m, (layerOf.get(d) ?? 0) + 1), 0);
    layerOf.set(n.id, max);
  }
  const layers: string[][] = [];
  for (const [id, l] of layerOf.entries()) {
    (layers[l] ??= []).push(id);
  }
  return layers;
}

export function PlanProgressBar({ plan, nodeStatuses, onNodeClick, onCopyJson }: Props) {
  const layers = layerize(plan);
  return (
    <div className="planProgressBar" role="region" aria-label="Workflow progress">
      {layers.map((layer, li) => (
        <div key={li} className={`planLayer ${layer.length > 1 ? 'planLayerParallel' : ''}`}>
          {layer.map((id) => {
            const n = plan.nodes.find((x) => x.id === id)!;
            const status = nodeStatuses[id] ?? 'pending';
            return (
              <button
                key={id}
                className={`planPill planPill-${status}`}
                onClick={() => onNodeClick?.(id)}
                title={`${id} (${n.agent}) — ${status}`}
              >
                <span className="planPillIcon">{EMOJI[status]}</span>
                <span className="planPillLabel">{id}</span>
              </button>
            );
          })}
          {li < layers.length - 1 && <span className="planArrow">→</span>}
        </div>
      ))}
      <button className="planCopyBtn" onClick={onCopyJson} title="Copy plan as JSON">📋</button>
    </div>
  );
}
```

- [ ] **Step 2: Styles**

```css
/* app/features/orchestration/components/PlanProgressBar.css */
.chatPageRoot .planProgressBar {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  padding: 6px 10px; margin: 4px 12px; border-radius: 10px;
  background: color-mix(in srgb, var(--panel-soft) 80%, transparent);
  border: 1px solid var(--border); font-size: 12px;
}
.chatPageRoot .planLayer {
  display: flex; align-items: center; gap: 4px;
  padding: 2px; border-radius: 6px;
}
.chatPageRoot .planLayerParallel {
  border: 1px dashed color-mix(in srgb, var(--accent) 50%, transparent);
}
.chatPageRoot .planArrow { color: var(--muted); margin: 0 2px; }
.chatPageRoot .planPill {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 8px; border-radius: 999px; border: 1px solid var(--border);
  background: var(--panel-strong); color: var(--text);
  font: inherit; cursor: pointer;
  transition: all 0.15s ease;
}
.chatPageRoot .planPill:hover { background: var(--hover, rgba(255,255,255,0.06)); }
.chatPageRoot .planPill-pending { color: var(--muted); }
.chatPageRoot .planPill-running { color: var(--accent); border-color: var(--accent); }
.chatPageRoot .planPill-ok { color: var(--success, #38b2ac); border-color: var(--success, #38b2ac); }
.chatPageRoot .planPill-failed { color: #e53e3e; border-color: #e53e3e; }
.chatPageRoot .planPill-skipped { color: var(--muted); opacity: 0.55; }
.chatPageRoot .planPillIcon { font-size: 11px; }
.chatPageRoot .planPillLabel { font-weight: 600; }
.chatPageRoot .planCopyBtn {
  margin-left: auto; padding: 2px 6px; border: 0; background: transparent;
  color: var(--muted); cursor: pointer; font-size: 13px; border-radius: 4px;
}
.chatPageRoot .planCopyBtn:hover { background: rgba(255,255,255,0.06); color: var(--text); }
```

- [ ] **Step 3: Mount in `ChatPageClient.tsx`**

Just above the message list:

```tsx
import { PlanProgressBar } from '../orchestration/components/PlanProgressBar';

// inside the chat render, before message list:
{activeOrchestration?.plan && activeOrchestration.nodeStatuses && (
  <PlanProgressBar
    plan={activeOrchestration.plan}
    nodeStatuses={activeOrchestration.nodeStatuses}
    onCopyJson={() => navigator.clipboard.writeText(JSON.stringify(activeOrchestration.plan, null, 2))}
  />
)}
```

`activeOrchestration` should come from the chat runtime: the latest entry in `orchestrationsRef.current` for the current chat (or expose it via `useChatRuntime` return value). If there's no neat selector yet, add one to `useChatRuntime`:

```typescript
const activeOrchestration = useMemo(() => {
  const all = Object.values(orchestrationsRef.current);
  return all.find((o) => o.sourceChatId === currentChatId && o.plan) ?? null;
}, [/* re-evaluate via notifyRunStateChanged trigger */]);
```

To get this to re-render on `notifyRunStateChanged`, bump a counter state inside `useChatRuntime`:

```typescript
const [runStateVersion, setRunStateVersion] = useState(0);
const notifyRunStateChanged = useCallback(() => setRunStateVersion((v) => v + 1), []);
// then include runStateVersion in the useMemo deps.
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Manual smoke test**

```bash
npm run dev
```

Open http://localhost:3010, send a message with `🧠 Auto` mode targeting 2+ agents. Expect to see the pill bar transition `pending → running → ok` for each node.

- [ ] **Step 6: Commit**

```bash
git add app/features/orchestration app/features/chat/ChatPageClient.tsx app/features/chat/runtime
git commit -m "feat(orchestration): PlanProgressBar — horizontal pill row showing live DAG node status

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 10: Save-as-Workflow Affordance

**Files:**
- Modify: `app/features/orchestration/components/PlanProgressBar.tsx`

- [ ] **Step 1: Add save button + minimal prompt UI**

Extend the bar:

```tsx
import { useState } from 'react';
// inside component:
const [saving, setSaving] = useState(false);
const allOk = plan.nodes.every((n) => nodeStatuses[n.id] === 'ok');

async function saveAs() {
  const name = window.prompt('Save workflow as (kebab-case):');
  if (!name) return;
  setSaving(true);
  try {
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, plan: { ...plan, name } }),
    });
    const data = await res.json();
    if (!data.ok) window.alert(`Save failed: ${data.error}`);
    else window.alert(`Saved as "${name}".`);
  } finally { setSaving(false); }
}

// in JSX, after the copy button:
{allOk && (
  <button className="planCopyBtn" disabled={saving} onClick={saveAs} title="Save this plan as a personal workflow">💾</button>
)}
```

- [ ] **Step 2: Manual smoke test**

After running auto mode, click 💾, enter a name, refresh. The new workflow should appear in `/api/workflows`.

- [ ] **Step 3: Commit**

```bash
git add app/features/orchestration/components/PlanProgressBar.tsx
git commit -m "feat(orchestration): save-as-workflow button on the plan bar when run completes successfully

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 11: Playwright E2E

**Files:**
- Create: `test/test-workflow-e2e.spec.ts`

- [ ] **Step 1: Write the test**

```typescript
// test/test-workflow-e2e.spec.ts
import { test, expect } from '@playwright/test';

test.describe('workflow e2e', () => {
  test('can run the code-review workflow from the picker and see plan bar progress', async ({ page }) => {
    // Assumes a stub-agent is configured in agents.json that just echoes back. If not, this test is documentation-only.
    test.skip(!process.env.RUN_WORKFLOW_E2E, 'Set RUN_WORKFLOW_E2E=1 with a stub agent configured to run this test.');

    await page.goto('http://localhost:3010');

    // Open workflow picker
    await page.getByRole('button', { name: /Workflow/ }).click();
    await page.getByText('code-review').click();

    // Type input and send
    const composer = page.locator('[data-testid="chat-composer-input"], textarea').first();
    await composer.fill('the codebase');
    await page.keyboard.press('Control+Enter');

    // Plan bar should show 3 pills, lint + test running in parallel.
    const planBar = page.locator('.planProgressBar');
    await expect(planBar).toBeVisible();
    await expect(planBar.locator('.planPill', { hasText: 'lint' })).toBeVisible();
    await expect(planBar.locator('.planPill', { hasText: 'test' })).toBeVisible();
    await expect(planBar.locator('.planPill', { hasText: 'review' })).toBeVisible();

    // Eventually all should turn ok.
    await expect(planBar.locator('.planPill-ok', { hasText: 'review' })).toBeVisible({ timeout: 30_000 });
  });
});
```

- [ ] **Step 2: Run the (skipped-by-default) test to confirm parse**

Run: `npx playwright test --config test/playwright.config.ts test/test-workflow-e2e.spec.ts`
Expected: 1 skipped (because env var unset).

- [ ] **Step 3: Commit**

```bash
git add test/test-workflow-e2e.spec.ts
git commit -m "test(workflow): playwright E2E for workflow picker + plan bar progress (skip-by-default)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review Notes

Run through the spec one more time before declaring done:

- ✅ Goal 1 (drop discussion): Task 7 removes the type union member and the orchestration service branch; Task 8 removes the UI pill. No migration needed (verified discussion is never persisted).
- ✅ Goal 2 (auto with parallel/serial): Tasks 1-4 build the DAG engine; Task 7 wires the scheduler.buildPlanPrompt → executor → replan loop.
- ✅ Goal 3 (user workflow JSON): Task 5 (repo) + Task 6 (user SQLite + API) + Task 8 (picker UI).
- ✅ Spec §3.3 templating: Task 2.
- ✅ Spec §3.4 replan loop (cap 2): Task 7 step 2 (`MAX_REPLANS = 2`).
- ✅ Spec §4.1 repo workflows: Task 5.
- ✅ Spec §4.2 user workflows: Task 6.
- ✅ Spec §5.2 plan bar: Task 9.
- ✅ Spec §8 edge cases — cycles, unknown deps, unknown template refs, missing agent: all covered by schema validator (Task 1) + executor failure path (Task 3). Save-as-workflow uses final DAG: Task 10 captures the live `plan` ref which is the in-effect DAG (replaced by replan if any).
- ⚠️ `fs.watch` for repo workflows in dev (mentioned in spec §4.1) is **not implemented** — `loadRepoWorkflows` is invoked per request, so changes are picked up at next call. This is intentionally simpler. If true hot-reload becomes needed, add a `chokidar`-based watcher later.
- ⚠️ Pipeline mode preserved by leaving the existing pipeline branch untouched in Task 7 step 2. Make sure not to delete it when surgically removing discussion.

If the engineer hits a snag implementing Task 7 (the orchestration wiring is the densest change), they should pause and re-read the file's actual structure before applying; the line numbers in this plan are approximate.
