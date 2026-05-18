# Agents-Chat Agent Model Selection Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add agent-aware model selection to the WSL Agents-Chat sandbox so each agent’s supported models are stored in SQLite, exposed through `/api/acp`, selectable in the UI, and sent to the backend when prompting an ACP agent.

**Architecture:** Persist model metadata on the existing SQLite-backed `agents` table, round-trip it through the existing agent config API actions, and keep frontend selection per agent. When a prompt is sent with `modelId`, the ACP route should validate it against the configured agent models and attempt the ACP session model switch after session creation/load and before `session/prompt`.

**Tech Stack:** Next.js App Router, React/TypeScript, `better-sqlite3`, ACP JSON-RPC/NDJSON, Playwright E2E, existing Node `.mjs` backend/source tests.

---

## Current Context / Assumptions

- Work only in WSL sandbox: `/home/wulei/Agents-Chat`.
- Do not modify the Q: drive repo directly.
- Current config storage is in `lib/configStore.ts`, table `agents`.
- Current API route is `app/api/acp/route.ts`.
- Current main UI is `app/page.tsx`.
- User preference: backend/API changes need API/source regression tests; UX changes need Playwright E2E.
- Upstream `acp-ui` model flow uses `session/new` response `models` and `unstable_setSessionModel({ sessionId, modelId })`. In this project, normal agent selection should read model lists from SQLite; future auto-detection can populate SQLite but is not required for this first implementation.
- Some ACP agents may not support runtime model switching. The backend must fail clearly or use a documented fallback; it must not silently ignore a chosen model.

## Target Data Shape

```ts
type AgentModel = {
  modelId: string;
  name?: string;
  description?: string;
};

type AgentRecord = {
  // existing fields...
  models: AgentModel[];
  defaultModelId: string;
};
```

SQLite columns on `agents`:

```sql
models TEXT NOT NULL DEFAULT '[]',
default_model_id TEXT NOT NULL DEFAULT ''
```

Frontend model resolution:

```ts
selectedModelByAgent[agentId]
  || agent.defaultModelId
  || agent.models?.[0]?.modelId
  || undefined
```

Send payload:

```json
{
  "action": "send",
  "agentId": "alpha",
  "modelId": "alpha-large",
  "text": "..."
}
```

---

## Task 1: Baseline and RED Backend Test for SQLite Agent Models

**Objective:** Capture expected persistence/API model behavior before production code changes.

**Files:**
- Inspect/modify: `test/agent-model-config.test.mjs`
- Read-only reference: `lib/configStore.ts`, `app/api/acp/route.ts`

**Step 1: Inspect existing test file**

Run:

```bash
cd /home/wulei/Agents-Chat
sed -n '1,240p' test/agent-model-config.test.mjs
```

Expected: file may already contain a source-check style test copied from earlier work.

**Step 2: Replace/extend it with focused source/API guard checks**

Test should assert all of these source-level invariants until a stronger route harness exists:

- `lib/configStore.ts` defines `AgentModel`.
- `AgentRecord` contains `models` and `defaultModelId`.
- Fresh schema includes `models TEXT` and `default_model_id TEXT`.
- Migration adds both columns for existing DBs.
- JSON import from `agents.json` persists `a.models` and `a.defaultModelId`.
- `rowToAgent` parses `row.models` and maps `row.default_model_id`.
- `createAgent` accepts/writes `models` and `defaultModelId`.
- `updateAgent` accepts/writes `models` and `defaultModelId`.
- `app/api/acp/route.ts` `AgentConfig` includes `models` and `defaultModelId`.
- `readAgentsConfig()` and route `getAgentById()` expose model fields.
- `create-agent` and `update-agent-config` pass model fields into `configStore`.
- `send` reads `modelId` and calls a model-switch helper before `sendPrompt`.

**Step 3: Run RED**

Run:

```bash
cd /home/wulei/Agents-Chat
node test/agent-model-config.test.mjs
```

Expected: FAIL for missing model persistence/API support.

**Step 4: Commit test only**

```bash
git add test/agent-model-config.test.mjs
git commit -m "test: add agent model selection backend guard"
```

---

## Task 2: Implement SQLite Model Persistence in `configStore`

**Objective:** Store, normalize, and read per-agent model metadata from SQLite.

**Files:**
- Modify: `lib/configStore.ts`
- Test: `test/agent-model-config.test.mjs`

**Step 1: Add model type and fields**

In `lib/configStore.ts`, near existing `AgentRecord`, add:

```ts
export type AgentModel = {
  modelId: string;
  name?: string;
  description?: string;
};
```

Add to `AgentRecord`:

```ts
models: AgentModel[];
defaultModelId: string;
```

**Step 2: Add normalization helpers**

Add helpers near `rowToAgent`:

```ts
function normalizeAgentModels(input: unknown): AgentModel[] {
  const raw = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const models: AgentModel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const modelId = typeof rec.modelId === 'string' ? rec.modelId.trim() : '';
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const model: AgentModel = { modelId };
    if (typeof rec.name === 'string' && rec.name.trim()) model.name = rec.name.trim();
    if (typeof rec.description === 'string' && rec.description.trim()) model.description = rec.description.trim();
    models.push(model);
  }
  return models;
}

function parseAgentModels(raw: unknown): AgentModel[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    return normalizeAgentModels(JSON.parse(raw));
  } catch {
    return [];
  }
}

function normalizeDefaultModelId(input: unknown, models: AgentModel[]): string {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!value) return '';
  if (models.length > 0 && !models.some((model) => model.modelId === value)) return '';
  return value;
}
```

**Step 3: Add fresh schema columns**

In the `CREATE TABLE IF NOT EXISTS agents` block, add:

```sql
models TEXT NOT NULL DEFAULT '[]',
default_model_id TEXT NOT NULL DEFAULT '',
```

Place after `owner` or before timestamps.

**Step 4: Add existing-DB migration**

In `runMigrations()`, after the public-column migration, add a migration key such as `add_agent_model_columns`:

```ts
const modelColsMigrated = db.prepare('SELECT 1 FROM migrations WHERE key = ?').get('add_agent_model_columns');
if (!modelColsMigrated) {
  try { db.exec("ALTER TABLE agents ADD COLUMN models TEXT NOT NULL DEFAULT '[]'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE agents ADD COLUMN default_model_id TEXT NOT NULL DEFAULT ''"); } catch { /* already exists */ }
  db.prepare('INSERT OR IGNORE INTO migrations (key) VALUES (?)').run('add_agent_model_columns');
}
```

**Step 5: Persist models during JSON import**

Update the `INSERT OR IGNORE INTO agents (...) VALUES (...)` statement for `agents.json` migration to include `models` and `default_model_id`.

Use normalized values:

```ts
const models = normalizeAgentModels(a.models);
const defaultModelId = normalizeDefaultModelId(a.defaultModelId, models);
```

Insert `JSON.stringify(models)` and `defaultModelId`.

**Step 6: Map row to record**

Update `rowToAgent(row)`:

```ts
const models = parseAgentModels(row.models);
return {
  // existing fields...
  models,
  defaultModelId: normalizeDefaultModelId(row.default_model_id, models),
};
```

**Step 7: Extend create/update signatures**

Add optional `models?: AgentModel[]; defaultModelId?: string;` to `createAgent` input and `updateAgent` input.

In `createAgent`, normalize and write both fields.

In `updateAgent`, when `updates.models !== undefined`, normalize and write `models = ?`. When `updates.defaultModelId !== undefined`, normalize it against either updated models or existing models and write `default_model_id = ?`.

**Step 8: Run GREEN for backend guard subset**

```bash
cd /home/wulei/Agents-Chat
node test/agent-model-config.test.mjs
```

Expected: remaining failures should now point at API route/frontend, not `configStore` persistence.

**Step 9: Commit**

```bash
git add lib/configStore.ts test/agent-model-config.test.mjs
git commit -m "feat: persist agent model metadata in sqlite"
```

---

## Task 3: Expose Models Through `/api/acp` Agent Config Actions

**Objective:** Round-trip `models` and `defaultModelId` through existing agent list/get/create/update APIs.

**Files:**
- Modify: `app/api/acp/route.ts`
- Test: `test/agent-model-config.test.mjs`

**Step 1: Extend route-local `AgentConfig`**

At `app/api/acp/route.ts`, extend the existing `AgentConfig` type:

```ts
type AgentModel = {
  modelId: string;
  name?: string;
  description?: string;
};

type AgentConfig = {
  // existing fields...
  models?: AgentModel[];
  defaultModelId?: string;
};
```

**Step 2: Return models from list/get mappers**

In `readAgentsConfig()` and route `getAgentById(agentId)`, include:

```ts
models: a.models,
defaultModelId: a.defaultModelId,
```

**Step 3: Pass models through create/update actions**

Find POST action branches for:

- `list-agents`
- `get-agent-config`
- `create-agent`
- `update-agent-config`

Ensure create/update include `models` and `defaultModelId` in the object passed to `configStore.createAgent()` / `configStore.updateAgent()`.

Do not trust arbitrary shape beyond `configStore` normalization.

**Step 4: Run guard test**

```bash
cd /home/wulei/Agents-Chat
node test/agent-model-config.test.mjs
```

Expected: failures, if any, should now be about `send` model switch.

**Step 5: Commit**

```bash
git add app/api/acp/route.ts test/agent-model-config.test.mjs
git commit -m "feat: expose agent model config through acp api"
```

---

## Task 4: Add Backend Model Selection on Send

**Objective:** Accept `modelId` in `/api/acp` `send` and apply it before `session/prompt`.

**Files:**
- Modify: `app/api/acp/route.ts`
- Test: `test/agent-model-config.test.mjs`

**Step 1: Add model validation helper**

Add near session helpers:

```ts
function validateRequestedModel(config: AgentConfig, rawModelId: unknown): string {
  const modelId = typeof rawModelId === 'string' ? rawModelId.trim() : '';
  if (!modelId) return '';
  const models = Array.isArray(config.models) ? config.models : [];
  if (models.length > 0 && !models.some((model) => model.modelId === modelId)) {
    throw new Error(`unsupported_model:${modelId}`);
  }
  return modelId;
}
```

**Step 2: Add ACP model switch helper**

Add an async helper before `sendPrompt`:

```ts
async function applySessionModelIfRequested(proc: AgentProcess, sessionId: string | null, modelId: string): Promise<void> {
  if (!modelId || !sessionId) return;
  if (!proc.rpc) throw new Error('Agent process not ready');
  try {
    await proc.rpc.send('session/set_model', { sessionId, modelId }, 30_000);
  } catch (firstErr) {
    try {
      await proc.rpc.send('unstable/session/set_model', { sessionId, modelId }, 30_000);
    } catch (secondErr) {
      const first = firstErr instanceof Error ? firstErr.message : String(firstErr);
      const second = secondErr instanceof Error ? secondErr.message : String(secondErr);
      throw new Error(`model_switch_failed:${modelId}:${second || first}`);
    }
  }
}
```

Notes:
- Use the final verified method name if ACP SDK/wrapper confirms a different raw JSON-RPC method.
- If project conventions prefer only one method, remove fallback and document why.
- Do not silently continue after switch failure when user explicitly selected a model.

**Step 3: Read and validate `modelId` in `send`**

Inside `if (action === 'send')`, after text/attachment parsing and before prompt creation:

```ts
let requestedModelId = '';
try {
  requestedModelId = validateRequestedModel(config, body?.modelId);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}
```

**Step 4: Apply model after session is ensured**

After `await ensureUserSession(...)` and before `sendPrompt(...)`, call:

```ts
try {
  await applySessionModelIfRequested(proc, sess.sessionId, requestedModelId);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}
```

**Step 5: Optional: include model in turn serialization later**

Do not expand scope unless needed. The minimum acceptance is that chosen `modelId` reaches backend and model switch runs before prompt.

**Step 6: Run backend guard**

```bash
cd /home/wulei/Agents-Chat
node test/agent-model-config.test.mjs
```

Expected: PASS.

**Step 7: Run existing API/source regressions**

```bash
cd /home/wulei/Agents-Chat
node test/session-mcp-routing.test.mjs
node test/session-prompt-stop-reason.test.mjs
node test/agent-user-request-route.test.mjs
```

Expected: PASS.

**Step 8: Commit**

```bash
git add app/api/acp/route.ts test/agent-model-config.test.mjs
git commit -m "feat: apply selected agent model before prompt"
```

---

## Task 5: Add RED Playwright E2E for Composer Model Selection

**Objective:** Specify the UI behavior: model dropdown appears for agents with models and selected model is sent in `/api/acp` request.

**Files:**
- Modify: `test/test-ui.spec.ts`
- Later modify: `app/page.tsx`

**Step 1: Add or extend ACP route mock**

Add a new helper or extend `mockTwoAgentsAcp` so `list-agents` returns one agent with models:

```ts
{
  id: 'alpha',
  name: 'Alpha Agent',
  command: 'mock',
  args: [],
  cwd: '',
  running: true,
  models: [
    { modelId: 'alpha-small', name: 'Alpha Small' },
    { modelId: 'alpha-large', name: 'Alpha Large' },
  ],
  defaultModelId: 'alpha-small',
}
```

**Step 2: Add E2E test**

Add a test under `test.describe('Chat UI', ...)`:

```ts
test('lets the user choose an agent model and sends modelId with the prompt', async ({ page }) => {
  const sent: any[] = [];
  await mockTwoAgentsAcp(page, sent); // adjusted to include models or use a new helper
  await page.reload();
  await page.waitForSelector('.chatContainer', { timeout: 30000 });

  const modelSelect = page.locator('select[aria-label="Model for alpha"]');
  await expect(modelSelect).toBeVisible();
  await expect(modelSelect).toHaveValue('alpha-small');
  await modelSelect.selectOption('alpha-large');

  await page.locator('textarea[placeholder="Message Agents Chat"]').fill('use selected model');
  await page.click('button[aria-label="Send message"]');

  await expect.poll(() => sent.find((request) => request.text === 'use selected model')?.modelId).toBe('alpha-large');
});
```

**Step 3: Run RED**

Requires dev server. In one terminal/process:

```bash
cd /home/wulei/Agents-Chat
NEXT_PUBLIC_E2E_TESTS=1 npm run dev
```

Then run:

```bash
cd /home/wulei/Agents-Chat
PLAYWRIGHT_BASE_URL=https://localhost:3010 NODE_TLS_REJECT_UNAUTHORIZED=0 \
  npx playwright test --config test/playwright.config.ts test/test-ui.spec.ts \
  --grep "lets the user choose an agent model" --reporter=line
```

Expected: FAIL because UI selector does not exist or payload lacks `modelId`.

If dev server fails with Next lockfile permission/connection refused, record as environment blocker and still keep the test.

**Step 4: Commit test only**

```bash
git add test/test-ui.spec.ts
git commit -m "test: cover composer agent model selection"
```

---

## Task 6: Implement Frontend Agent Model Types and Selection State

**Objective:** Add per-agent model state and send selected model ID with prompt.

**Files:**
- Modify: `app/page.tsx`
- Test: `test/test-ui.spec.ts`

**Step 1: Extend frontend types**

Near `type Agent`, add:

```ts
type AgentModel = {
  modelId: string;
  name?: string;
  description?: string;
};
```

Add to `Agent`:

```ts
models?: AgentModel[];
defaultModelId?: string;
```

**Step 2: Add selected model state**

Near existing state declarations:

```ts
const [selectedModelByAgent, setSelectedModelByAgent] = useState<Record<string, string>>({});
```

**Step 3: Add resolver helpers**

Near derived helpers:

```ts
function getAgentSelectedModelId(agent: Agent | undefined): string {
  if (!agent) return '';
  const models = Array.isArray(agent.models) ? agent.models : [];
  const selected = selectedModelByAgent[agent.id];
  if (selected && models.some((model) => model.modelId === selected)) return selected;
  if (agent.defaultModelId && models.some((model) => model.modelId === agent.defaultModelId)) return agent.defaultModelId;
  return models[0]?.modelId || '';
}

function getSelectedModelForAgentId(agentId: string): string {
  return getAgentSelectedModelId(agents.find((agent) => agent.id === agentId));
}
```

**Step 4: Prune stale selections after agents load**

Add `useEffect` that removes selected model IDs that are no longer valid for their agent.

**Step 5: Include model in `sendAcpPrompt`**

In `sendAcpPrompt`, when building `sendBody`, add:

```ts
const modelId = getSelectedModelForAgentId(agentId);
if (modelId) sendBody.modelId = modelId;
```

Make sure `sendAcpPrompt` has access to latest `agents`/model state. If stale closure risk appears, use refs for `agents` and `selectedModelByAgent`.

**Step 6: Run targeted E2E**

Run same command from Task 5. Expected: may still fail until UI exists, but source should compile.

**Step 7: Commit**

```bash
git add app/page.tsx
git commit -m "feat: track selected model per agent"
```

---

## Task 7: Add Composer Model Selector UI

**Objective:** Let users choose the model for the current effective composer target.

**Files:**
- Modify: `app/page.tsx`
- Test: `test/test-ui.spec.ts`

**Step 1: Determine UI placement**

In the composer shell near `.rememberedAgentPill` / target pills, show a compact `<select>` when exactly one effective agent is targeted and that agent has at least two models.

For this first version:
- Show selector for `effectiveComposerAgentId` when no explicit mentions exist.
- For explicit single mention, optionally show selector for that mentioned agent.
- For multi-agent orchestration, hide selector or show disabled helper text; do not invent multi-agent model UI yet.

**Step 2: Add UI code**

Near target pills inside `.composerShell`, compute:

```ts
const composerModelAgentId = mentionedAgentIds.length === 1 ? mentionedAgentIds[0] : effectiveComposerAgentId;
const composerModelAgent = agents.find((agent) => agent.id === composerModelAgentId);
const composerModels = composerModelAgent?.models || [];
```

If needed, compute these as `useMemo` near other derived values.

Render:

```tsx
{composerModelAgent && composerModels.length > 1 ? (
  <label className="modelSelectPill">
    <span>Model</span>
    <select
      aria-label={`Model for ${composerModelAgent.id}`}
      value={getAgentSelectedModelId(composerModelAgent)}
      onChange={(e) => setSelectedModelByAgent((current) => ({ ...current, [composerModelAgent.id]: e.target.value }))}
    >
      {composerModels.map((model) => (
        <option key={model.modelId} value={model.modelId} title={model.description || model.name || model.modelId}>
          {model.name || model.modelId}
        </option>
      ))}
    </select>
  </label>
) : null}
```

**Step 3: Add styles**

In `<style jsx>`, add compact styles:

```css
.modelSelectPill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--panel-strong);
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}
.modelSelectPill select {
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
```

**Step 4: Run targeted E2E**

```bash
cd /home/wulei/Agents-Chat
PLAYWRIGHT_BASE_URL=https://localhost:3010 NODE_TLS_REJECT_UNAUTHORIZED=0 \
  npx playwright test --config test/playwright.config.ts test/test-ui.spec.ts \
  --grep "lets the user choose an agent model" --reporter=line
```

Expected: PASS if dev server is healthy.

**Step 5: Commit**

```bash
git add app/page.tsx test/test-ui.spec.ts
git commit -m "feat: add composer model selector"
```

---

## Task 8: Add Model Editing in Agent Settings / Add Agent Modal

**Objective:** Allow admins/owners to manually populate SQLite model lists when adding or editing agents.

**Files:**
- Modify: `app/page.tsx`
- Test: extend `test/test-ui.spec.ts` if practical, otherwise rely on API guard plus typecheck.

**Step 1: Decide minimal input format**

Use a textarea with one model per line:

```txt
model-id | Display Name | Optional description
```

Rationale: fast to implement, no complex dynamic list UI.

**Step 2: Add parser/formatter helpers**

Near frontend helpers:

```ts
function parseModelsText(text: string): AgentModel[] {
  const seen = new Set<string>();
  return text.split('\n').flatMap((line) => {
    const [rawId, rawName, rawDescription] = line.split('|').map((part) => part.trim());
    if (!rawId || seen.has(rawId)) return [];
    seen.add(rawId);
    return [{
      modelId: rawId,
      ...(rawName ? { name: rawName } : {}),
      ...(rawDescription ? { description: rawDescription } : {}),
    }];
  });
}

function formatModelsText(models: AgentModel[] | undefined): string {
  return (models || []).map((model) => [model.modelId, model.name || '', model.description || ''].join(' | ').replace(/(?:\s\|\s)*$/g, '')).join('\n');
}
```

**Step 3: Extend add-agent form state**

Add fields:

```ts
modelsText: '';
defaultModelId: '';
```

When creating agent, pass:

```ts
models: parseModelsText(newAgentForm.modelsText),
defaultModelId: newAgentForm.defaultModelId.trim(),
```

Reset these fields after create.

**Step 4: Add fields to Add Agent modal**

Add textarea and default model input below arguments/cwd:

```tsx
<label>
  <span>Supported Models</span>
  <textarea ... placeholder="gpt-4.1 | GPT-4.1\nclaude-sonnet-4 | Claude Sonnet 4" />
  <span className="fieldHint">One per line: modelId | name | description</span>
</label>
<label>
  <span>Default Model ID</span>
  <input ... placeholder="optional; must match a modelId above" />
</label>
```

**Step 5: Add fields to Agent Settings modal**

Use `formatModelsText(settingsAgentConfig.models)` for textarea value and parse on change.

Default model input binds to `settingsAgentConfig.defaultModelId`.

Update `saveAgentSettings()` to include:

```ts
models: settingsAgentConfig.models || [],
defaultModelId: settingsAgentConfig.defaultModelId || '',
```

**Step 6: Add focused E2E if stable**

Optional but preferred:
- Open agent settings with mocked `get-agent-config` response containing models.
- Assert textarea/default field display values.
- Change default model and save.
- Assert mocked `update-agent-config` receives `models` and `defaultModelId`.

**Step 7: Run E2E and typecheck later in final verification**

**Step 8: Commit**

```bash
git add app/page.tsx test/test-ui.spec.ts
git commit -m "feat: edit supported models in agent settings"
```

---

## Task 9: Full Verification

**Objective:** Prove backend, frontend, and build health.

**Files:**
- No code changes unless failures require fixes.

**Step 1: Run backend/source tests**

```bash
cd /home/wulei/Agents-Chat
node test/agent-model-config.test.mjs
node test/session-mcp-routing.test.mjs
node test/session-prompt-stop-reason.test.mjs
node test/agent-user-request-route.test.mjs
```

Expected: PASS.

**Step 2: Run typecheck**

```bash
cd /home/wulei/Agents-Chat
npx tsc --noEmit
```

Expected: PASS.

**Step 3: Run lint if configured**

```bash
cd /home/wulei/Agents-Chat
npm run lint
```

Expected: PASS or document existing lint config/status.

**Step 4: Run targeted Playwright**

Start server if not running:

```bash
cd /home/wulei/Agents-Chat
NEXT_PUBLIC_E2E_TESTS=1 npm run dev
```

Then:

```bash
cd /home/wulei/Agents-Chat
PLAYWRIGHT_BASE_URL=https://localhost:3010 NODE_TLS_REJECT_UNAUTHORIZED=0 \
  npx playwright test --config test/playwright.config.ts test/test-ui.spec.ts \
  --grep "lets the user choose an agent model" --reporter=line
```

Expected: PASS. If dev server cannot start due WSL/Next lockfile permission error, document exact error as environment blocker.

**Step 5: Run build**

```bash
cd /home/wulei/Agents-Chat
npm run build
```

Expected: PASS.

**Step 6: Check diff hygiene**

```bash
cd /home/wulei/Agents-Chat
git diff --check
```

Expected: no whitespace errors.

**Step 7: Final commit if fixes were made**

```bash
git status --short
git add <changed-files>
git commit -m "test: verify agent model selection"
```

---

## Risks / Tradeoffs / Open Questions

1. **ACP method name uncertainty:** Upstream UI calls `unstable_setSessionModel` at the client API layer, but raw JSON-RPC method name should be verified against the ACP SDK/wrapper before finalizing. If uncertain, implement a tiny helper with one verified method and a clear error; do not silently ignore failure.
2. **Unsupported agents:** Some agents may return an unsupported-method JSON-RPC error. Current plan returns a clear `model_switch_failed` send error when a user explicitly picked a model.
3. **Multi-agent orchestration:** First UI pass supports one visible composer selector for one target. Multi-agent orchestration can use each agent’s remembered/default selected model, but no complex per-agent orchestration UI is planned.
4. **Manual model editing UX:** Textarea is YAGNI-friendly but less polished. A future task can add `Detect models` using temporary ACP `initialize + session/new`.
5. **Source-check vs real API tests:** Existing route is not easily unit-testable. This plan starts with source/API guard tests consistent with current repo patterns; if time allows, add a real route harness later.

## Acceptance Criteria

- SQLite stores `models` and `defaultModelId` per agent.
- `/api/acp` list/get/create/update round-trip model fields.
- UI shows a model selector for agents with multiple models.
- Sending a prompt includes selected `modelId` in `/api/acp` request.
- Backend validates requested model and attempts session model switch before `session/prompt`.
- Backend/source tests pass.
- Targeted Playwright model-selection test passes or has documented environment blocker.
- `npx tsc --noEmit`, `npm run build`, and `git diff --check` pass.
