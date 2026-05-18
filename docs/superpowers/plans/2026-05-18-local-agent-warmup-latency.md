# Local Agent Warmup Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warm local ACP agent processes when the app loads so the first user prompt no longer pays the process spawn and initialize cost.

**Architecture:** Add a no-session backend action named `warm-local-agents` that starts every configured local agent with the existing `bootAgent()` path and skips relay, ready, or already booting agents. Call this action once from the frontend after `list-agents` succeeds; keep the request non-blocking and preserve the existing `send` fallback if warmup fails.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, ACP over NDJSON-RPC, Node `assert` source-shape tests, Playwright E2E.

---

## File structure

- Modify `app/api/acp/route.ts`: add the backend warmup helper and the `warm-local-agents` API action before the existing runtime actions that require `agentId`.
- Modify `app/page.tsx`: add a module-level one-shot frontend warmup helper and call it from `loadAgents()` after agents are loaded.
- Modify `test/agent-user-request-route.test.mjs`: add regression assertions for backend filtering, idempotency, action placement, and no session creation.
- Modify `test/test-ui.spec.ts`: add a default warmup stub for unrelated tests and one focused Playwright test proving warmup is triggered after agent load without blocking send.

---

### Task 1: Backend warmup action

**Files:**
- Modify: `test/agent-user-request-route.test.mjs`
- Modify: `app/api/acp/route.ts`

- [ ] **Step 1: Add failing backend route-shape assertions**

In `test/agent-user-request-route.test.mjs`, add these constants after `freeformQueuedInNoToolsBranch`:

```js
const warmLocalAgentsActionStart = routeSource.indexOf("if (action === 'warm-local-agents')");
const warmLocalAgentsActionEnd = warmLocalAgentsActionStart >= 0
  ? routeSource.indexOf("if (action === 'get-agent-config')", warmLocalAgentsActionStart)
  : -1;
const warmLocalAgentsActionSource = warmLocalAgentsActionStart >= 0 && warmLocalAgentsActionEnd >= 0
  ? routeSource.slice(warmLocalAgentsActionStart, warmLocalAgentsActionEnd)
  : '';
const runtimeActionsStart = routeSource.indexOf('// ─── Agent runtime actions (require agentId + userId) ───');
```

In the same file, add these assertions immediately before `console.log('agent user request route shape checks passed');`:

```js
assert.match(
  routeSource,
  /type\s+WarmLocalAgentStatus\s*=[\s\S]*?['"]ready['"][\s\S]*?['"]booting['"][\s\S]*?['"]started['"][\s\S]*?['"]failed['"][\s\S]*?['"]skipped_remote['"]/,
  'route.ts should define explicit warmup status values for local agent warmup summaries',
);

assert.match(
  routeSource,
  /async\s+function\s+warmLocalAgents\(\):\s*Promise<WarmLocalAgentResult\[]>[\s\S]*?readAgentsConfig\(\)[\s\S]*?if\s*\(agent\.relay\)[\s\S]*?status:\s*['"]skipped_remote['"][\s\S]*?getAgentProcess\(agent\.id,\s*agent\)[\s\S]*?proc\.ready[\s\S]*?status:\s*['"]ready['"][\s\S]*?proc\.booting[\s\S]*?status:\s*['"]booting['"][\s\S]*?await\s+bootAgent\(agent\.id\)[\s\S]*?status:\s*['"]started['"][\s\S]*?catch[\s\S]*?console\.error[\s\S]*?status:\s*['"]failed['"]/,
  'warmLocalAgents should skip relay/ready/booting agents, boot unready local agents, and report failures per agent',
);

assert.ok(
  warmLocalAgentsActionStart >= 0 && runtimeActionsStart >= 0 && warmLocalAgentsActionStart < runtimeActionsStart,
  'warm-local-agents should be handled before the shared runtime action guard that requires agentId',
);

assert.match(
  warmLocalAgentsActionSource,
  /const\s+agents\s*=\s*await\s+warmLocalAgents\(\);[\s\S]*?const\s+warmed\s*=\s*agents\.filter\([\s\S]*?status\s*===\s*['"]started['"][\s\S]*?NextResponse\.json\(\{\s*ok:\s*true,\s*warmed,\s*agents\s*\}\)/,
  'warm-local-agents action should return an ok response with warmed count and per-agent summary',
);

assert.doesNotMatch(
  warmLocalAgentsActionSource,
  /session\/new|session\/load|getUserSession|ensureUserSession/,
  'warm-local-agents action should not create, load, or attach chat sessions',
);
```

- [ ] **Step 2: Run the backend source test and verify it fails**

Run:

```powershell
node test\agent-user-request-route.test.mjs
```

Expected: FAIL with an assertion mentioning missing `WarmLocalAgentStatus`, missing `warmLocalAgents`, or missing `warm-local-agents`.

- [ ] **Step 3: Add warmup result types and helper**

In `app/api/acp/route.ts`, insert this block after `getActiveTurnForResume()` and before `/* ─────────────── ACP Lifecycle ─────────────── */`:

```ts
type WarmLocalAgentStatus = 'ready' | 'booting' | 'started' | 'failed' | 'skipped_remote';

type WarmLocalAgentResult = {
  agentId: string;
  status: WarmLocalAgentStatus;
  error?: string;
};

async function warmLocalAgents(): Promise<WarmLocalAgentResult[]> {
  const agents = readAgentsConfig();
  return Promise.all(agents.map(async (agent): Promise<WarmLocalAgentResult> => {
    if (agent.relay) {
      return { agentId: agent.id, status: 'skipped_remote' };
    }

    const proc = getAgentProcess(agent.id, agent);
    if (proc.ready) {
      return { agentId: agent.id, status: 'ready' };
    }
    if (proc.booting) {
      return { agentId: agent.id, status: 'booting' };
    }

    try {
      await bootAgent(agent.id);
      return { agentId: agent.id, status: 'started' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[ACP:${agent.id}] Warmup failed:`, error);
      return { agentId: agent.id, status: 'failed', error };
    }
  }));
}
```

- [ ] **Step 4: Add the `warm-local-agents` API action**

In `app/api/acp/route.ts`, insert this action after the existing `list-agents` block and before `if (action === 'get-agent-config')`:

```ts
    if (action === 'warm-local-agents') {
      const agents = await warmLocalAgents();
      const warmed = agents.filter(agent => agent.status === 'started').length;
      return NextResponse.json({ ok: true, warmed, agents });
    }
```

- [ ] **Step 5: Run the backend source test and verify it passes**

Run:

```powershell
node test\agent-user-request-route.test.mjs
```

Expected: PASS with `agent user request route shape checks passed`.

- [ ] **Step 6: Commit backend warmup action**

Run:

```powershell
git add app\api\acp\route.ts test\agent-user-request-route.test.mjs
git commit -m "feat: add local agent warmup action" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds with two modified files.

---

### Task 2: Frontend warmup trigger and E2E coverage

**Files:**
- Modify: `test/test-ui.spec.ts`
- Modify: `app/page.tsx`

- [ ] **Step 1: Add a default Playwright warmup stub**

In `test/test-ui.spec.ts`, add this at the start of `test.beforeEach`, before `await login(page);`:

```ts
    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.action === 'warm-local-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, warmed: 0, agents: [] }),
        });
        return;
      }
      await route.fallback();
    });
```

This prevents unrelated UI tests from spawning real local agents during their shared setup. Tests that register their own `**/api/acp` route later still take precedence.

- [ ] **Step 2: Add a failing Playwright test for app-load warmup**

In `test/test-ui.spec.ts`, add this test inside `test.describe('Chat UI', () => { ... })`, after the existing `Claude theme keeps the send button warm and readable` test:

```ts
  test('warms local agents after loading agents without blocking send', async ({ page }) => {
    const actions: string[] = [];
    const sent: any[] = [];
    let warmupRequested = false;
    let warmupSawListCompleted = false;
    let warmupCompleted = false;
    let releaseWarmup: () => void = () => {};
    const warmupCanFinish = new Promise<void>((resolve) => {
      releaseWarmup = resolve;
    });

    await page.route('**/api/acp', async (route) => {
      const body = route.request().postDataJSON() as any;
      actions.push(String(body?.action || ''));

      if (body?.action === 'list-agents') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            agents: [
              { id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: false, relay: false },
              { id: 'remote', name: 'Remote Agent', cwd: '', running: false, relay: true, relayConnectionName: 'remote-node' },
            ],
          }),
        });
        return;
      }

      if (body?.action === 'get-model-prefs') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, prefs: {} }) });
        return;
      }

      if (body?.action === 'warm-local-agents') {
        warmupRequested = true;
        warmupSawListCompleted = actions.includes('list-agents');
        await warmupCanFinish;
        warmupCompleted = true;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            warmed: 1,
            agents: [
              { agentId: 'alpha', status: 'started' },
              { agentId: 'remote', status: 'skipped_remote' },
            ],
          }),
        });
        return;
      }

      if (body?.action === 'send') {
        sent.push(body);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, phase: 'thinking', sessionId: `session-${body.agentId}`, turn: { id: `turn-${body.agentId}` } }),
        });
        return;
      }

      if (body?.action === 'poll') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            phase: 'idle',
            ready: true,
            booting: false,
            activeTurn: {
              id: `turn-${body.agentId}`,
              fullText: `reply from ${body.agentId}`,
              done: true,
              phase: 'done',
              events: [{ type: 'text_chunk', ts: Date.now(), text: `reply from ${body.agentId}` }],
            },
          }),
        });
        return;
      }

      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 30000 });
    await ensureActiveChat(page);

    await expect.poll(() => warmupRequested).toBe(true);
    expect(warmupSawListCompleted).toBe(true);
    await page.locator('textarea[placeholder="Message Agents Chat"]').fill('send while warmup pending');
    await expect(page.locator('button[aria-label="Send message"]')).toBeEnabled();
    await page.click('button[aria-label="Send message"]');
    await expect.poll(() => sent.map((request) => request.agentId)).toEqual(['alpha']);
    expect(warmupCompleted).toBe(false);

    releaseWarmup();
    await expect.poll(() => warmupCompleted).toBe(true);
    expect(actions.indexOf('warm-local-agents')).toBeGreaterThan(actions.indexOf('list-agents'));
    expect(actions.filter((action) => action === 'warm-local-agents')).toHaveLength(1);
  });
```

- [ ] **Step 3: Run the focused Playwright test and verify it fails**

Run while the app is running on `localhost:3010`:

```powershell
npx playwright test --config test\playwright.config.ts test\test-ui.spec.ts -g "warms local agents after loading agents without blocking send"
```

Expected: FAIL because no `warm-local-agents` request is sent yet.

- [ ] **Step 4: Add the frontend one-shot warmup helper**

In `app/page.tsx`, add this module-level state and helper immediately after `acpApi()`:

```ts
let localAgentsWarmupStarted = false;

function warmLocalAgentsOnce(
  acpCall: (body: Record<string, unknown>) => Promise<unknown>,
  loadedAgents: Agent[],
) {
  if (localAgentsWarmupStarted) return;
  if (!loadedAgents.some(agent => !agent.relay)) return;

  localAgentsWarmupStarted = true;
  void acpCall({ action: 'warm-local-agents' }).catch((err) => {
    console.error('Failed to warm local agents', err);
  });
}
```

- [ ] **Step 5: Trigger warmup after agents load**

In `app/page.tsx`, replace this block inside `loadAgents()`:

```ts
      if (agentsData.ok && Array.isArray(agentsData.agents)) {
        setAgents(agentsData.agents);
      }
```

with:

```ts
      if (agentsData.ok && Array.isArray(agentsData.agents)) {
        const loadedAgents = agentsData.agents as Agent[];
        setAgents(loadedAgents);
        warmLocalAgentsOnce(acp, loadedAgents);
      }
```

- [ ] **Step 6: Run the focused Playwright test and verify it passes**

Run while the app is running on `localhost:3010`:

```powershell
npx playwright test --config test\playwright.config.ts test\test-ui.spec.ts -g "warms local agents after loading agents without blocking send"
```

Expected: PASS.

- [ ] **Step 7: Commit frontend warmup trigger**

Run:

```powershell
git add app\page.tsx test\test-ui.spec.ts
git commit -m "feat: warm local agents on app load" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds with two modified files.

---

### Task 3: Final validation

**Files:**
- Validate: `app/api/acp/route.ts`
- Validate: `app/page.tsx`
- Validate: `test/agent-user-request-route.test.mjs`
- Validate: `test/test-ui.spec.ts`

- [ ] **Step 1: Run backend source-shape regression**

Run:

```powershell
node test\agent-user-request-route.test.mjs
```

Expected: PASS with `agent user request route shape checks passed`.

- [ ] **Step 2: Run focused E2E warmup regression**

Run while the app is running on `localhost:3010`:

```powershell
npx playwright test --config test\playwright.config.ts test\test-ui.spec.ts -g "warms local agents after loading agents without blocking send"
```

Expected: PASS.

- [ ] **Step 3: Run production build**

Run:

```powershell
npm run build
```

Expected: build exits successfully. If `next-env.d.ts` changes only because the build rewrote `.next` type paths, restore that generated change before committing final results:

```powershell
git checkout-index -f -- next-env.d.ts
```

- [ ] **Step 4: Inspect final diff**

Run:

```powershell
git status --short
git --no-pager diff --stat origin/main...HEAD
```

Expected: only the spec, plan, backend route, frontend page, and tests are changed by this branch.

---

## Self-review checklist

- Spec coverage: Task 1 implements the backend action, local-only filtering, summary, failure logging, and no session creation. Task 2 implements app-load trigger, non-blocking behavior, and UI test protection. Task 3 validates the requested behavior.
- Placeholder scan: no task contains deferred requirements; every code step includes concrete code.
- Type consistency: backend uses `WarmLocalAgentResult[]` and frontend uses existing `Agent` plus `Record<string, unknown>` API calls consistently.
