# Claude Code + Per-Agent Env Vars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-agent environment variable support and a pre-configured Claude Code agent entry.

**Architecture:** Add an `env` JSON column to the SQLite `agents` table, thread it through configStore → API route → spawn logic, and expose it in the agent add/edit UI as a masked KEY=VALUE textarea.

**Tech Stack:** Next.js 16, React 19, better-sqlite3, TypeScript, styled-jsx

---

## File Structure

| File | Responsibility |
|------|---------------|
| `lib/configStore.ts` | DB migration for `env` column, CRUD updates, type export |
| `lib/acp/types.ts` | Add `env` to `AgentConfig` type |
| `app/api/acp/route.ts` | Pass `env` through config loading, merge into spawn env, add `env` to restart-requiring keys |
| `app/features/agents/agentTypes.ts` | Add `env` to client-side `Agent` type |
| `app/features/agents/hooks/useAgentPanelState.ts` | Add `env` to form state and save logic |
| `app/features/agents/components/AgentsPanel.tsx` | Env textarea in add-agent and settings modals |
| `agents.json` | Claude Code seed entry |

---

### Task 1: Database Migration + configStore

**Files:**
- Modify: `lib/configStore.ts`

- [ ] **Step 1: Add env column migration**

In `lib/configStore.ts`, add a new migration block after the `add_agent_model_columns` migration (around line 209). Insert before the closing `}` of `runMigrations()`:

```typescript
  const envColMigrated = db.prepare('SELECT 1 FROM migrations WHERE key = ?').get('add_env_column');
  if (!envColMigrated) {
    try {
      db.exec(`ALTER TABLE agents ADD COLUMN env TEXT NOT NULL DEFAULT '{}'`);
    } catch {
      // Column already exists if DB was created fresh with the new schema
    }
    db.prepare('INSERT OR IGNORE INTO migrations (key) VALUES (?)').run('add_env_column');
  }
```

- [ ] **Step 2: Add env to the CREATE TABLE statement**

In the `CREATE TABLE IF NOT EXISTS agents` block (around line 63-79), add after the `default_model_id` line:

```sql
      env TEXT NOT NULL DEFAULT '{}',
```

- [ ] **Step 3: Add env to AgentRecord type**

In the `AgentRecord` type (around line 23-39), add:

```typescript
  env: Record<string, string>;
```

- [ ] **Step 4: Update rowToAgent to parse env**

In the `rowToAgent` function (around line 260-279), add after the `defaultModelId` line:

```typescript
    env: parseEnv(row.env),
```

Add this helper function above `rowToAgent`:

```typescript
function parseEnv(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}
```

- [ ] **Step 5: Update createAgent to accept and store env**

In the `createAgent` function signature (around line 293-307), add to the parameter type:

```typescript
  env?: Record<string, string>;
```

In the INSERT statement (line 312-314), add `env` column and value:

```typescript
  db.prepare(`
    INSERT INTO agents (id, name, command, args, cwd, yolo, no_tools, relay, relay_connection_name, public, models, default_model_id, env, owner)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agent.id,
    agent.name || agent.id,
    agent.command || 'copilot.exe',
    JSON.stringify(agent.args || []),
    agent.cwd || '',
    agent.yolo !== false ? 1 : 0,
    agent.noTools ? 1 : 0,
    agent.relay ? 1 : 0,
    agent.relayConnectionName || '',
    agent.public ? 1 : 0,
    JSON.stringify(models),
    defaultModelId,
    JSON.stringify(agent.env || {}),
    agent.owner,
  );
```

- [ ] **Step 6: Update updateAgent to handle env**

In the `updateAgent` function's `Partial<{...}>` type (around line 332-344), add:

```typescript
  env: Record<string, string>;
```

In the field-update logic block (after line 360, after the `public` check), add:

```typescript
  if (updates.env !== undefined) { fields.push('env = ?'); values.push(JSON.stringify(updates.env)); }
```

- [ ] **Step 7: Update agents.json migration to import env**

In the migration loop where agents are imported from `agents.json` (around line 127-135), update the insert to include env. Change the INSERT to:

```typescript
      const insert = db.prepare(`
        INSERT OR IGNORE INTO agents (id, name, command, args, cwd, yolo, no_tools, relay, relay_connection_name, public, models, default_model_id, env, owner)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
```

And update the `insert.run(...)` call to add `JSON.stringify(a.env || {})` before `defaultOwner`:

```typescript
          insert.run(
            a.id,
            a.name || a.id,
            a.command || 'copilot.exe',
            JSON.stringify(a.args || []),
            a.cwd || '',
            a.yolo ? 1 : 0,
            a.noTools ? 1 : 0,
            a.relay ? 1 : 0,
            a.relayConnectionName || '',
            a.id === 'copilot' ? 1 : 0,
            JSON.stringify(models),
            normalizeDefaultModelId(a.defaultModelId, models),
            JSON.stringify(a.env || {}),
            defaultOwner,
          );
```

- [ ] **Step 8: Verify build compiles**

Run: `cd agents-chat && npx tsc --noEmit`
Expected: No errors related to configStore

- [ ] **Step 9: Commit**

```bash
git add lib/configStore.ts
git commit -m "feat: add env column to agents table with migration and CRUD support"
```

---

### Task 2: Backend Types + Spawn Logic

**Files:**
- Modify: `lib/acp/types.ts`
- Modify: `app/api/acp/route.ts`

- [ ] **Step 1: Add env to AgentConfig type**

In `lib/acp/types.ts`, in the `AgentConfig` type (around line 96-108), add after `defaultModelId`:

```typescript
  env?: string; // JSON string: '{"KEY":"value"}'
```

- [ ] **Step 2: Update getAgentById in route.ts to include env**

In `app/api/acp/route.ts`, in the `getAgentById` function (around line 59-75), add `env` to the returned object:

```typescript
function getAgentById(agentId: string): AgentConfig | null {
  const a = configStore.getAgentById(agentId);
  if (!a) return null;
  return {
    id: a.id,
    name: a.name,
    command: a.command,
    args: a.args,
    cwd: a.cwd,
    yolo: a.yolo,
    noTools: a.noTools,
    relay: a.relay,
    relayConnectionName: a.relayConnectionName,
    models: a.models,
    defaultModelId: a.defaultModelId,
    env: JSON.stringify(a.env || {}),
  };
}
```

- [ ] **Step 3: Update spawn logic to merge agent env vars**

In `app/api/acp/route.ts`, replace the spawn call (around line 225-231):

```typescript
      // Parse per-agent env vars and merge with process.env
      let agentEnv: Record<string, string> = {};
      try {
        if (config.env) agentEnv = JSON.parse(config.env);
      } catch { /* ignore parse errors */ }

      console.log(`[ACP:${agentId}] Spawning ${command} ${args.join(' ')} (cwd: ${cwd})`);
      const cp = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env: { ...process.env, ...agentEnv },
        windowsHide: true,
        shell: true,
      });
```

- [ ] **Step 4: Add env to the update-agent-config action**

In the `update-agent-config` handler (around line 1504-1513), add `env` to the `configStore.updateAgent` call:

```typescript
      configStore.updateAgent(agentId, {
        name: updates.name,
        command: updates.command,
        args: updates.args,
        cwd: updates.cwd,
        yolo: updates.yolo,
        public: (body?.updates as any)?.public,
        models: updates.models,
        defaultModelId: updates.defaultModelId,
        env: (body?.updates as any)?.env,
      });
```

- [ ] **Step 5: Add env to restart-requiring keys**

In the restart logic (around line 1519), add `'env'` to the set:

```typescript
      const restartRequiringKeys = new Set(['name', 'command', 'args', 'cwd', 'yolo', 'public', 'env']);
```

- [ ] **Step 6: Add env to create-agent action**

In the `create-agent` handler (around line 1557-1569), add `env` to the `configStore.createAgent` call. Parse the env from the incoming agent config:

```typescript
      const rawEnv = (body?.agent as any)?.env;
      const parsedEnv: Record<string, string> = (typeof rawEnv === 'object' && rawEnv !== null && !Array.isArray(rawEnv))
        ? Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => typeof v === 'string'))
        : {};

      const entry = configStore.createAgent({
        id: newAgent.id,
        name: newAgent.name || newAgent.id,
        command: newAgent.command || 'copilot.exe',
        args: newAgent.args || ['--acp'],
        cwd: newAgent.cwd || '',
        yolo: newAgent.yolo ?? true,
        relay: newAgent.relay,
        relayConnectionName: newAgent.relayConnectionName || (newAgent.relay ? newAgent.id : ''),
        models: newAgent.models,
        defaultModelId: newAgent.defaultModelId,
        env: parsedEnv,
        owner: ownerEmail,
      });
```

- [ ] **Step 7: Include env in get-agent-config response**

The `get-agent-config` handler (line 1471-1476) already returns the full `agent` object from `getAgentById`. Since we added `env` to that function in Step 2, the settings modal will receive it. However, we need to return it as a parsed object for the frontend. Update the handler:

```typescript
    if (action === 'get-agent-config') {
      if (!agentId) return NextResponse.json({ ok: false, error: 'missing_agentId' }, { status: 400 });
      const agent = getAgentById(agentId);
      if (!agent) return NextResponse.json({ ok: false, error: 'agent_not_found' }, { status: 404 });
      // Return env as parsed object for the UI
      let envObj: Record<string, string> = {};
      try { if (agent.env) envObj = JSON.parse(agent.env); } catch { /* ignore */ }
      return NextResponse.json({ ok: true, agent: { ...agent, env: envObj } });
    }
```

- [ ] **Step 8: Verify build compiles**

Run: `cd agents-chat && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add lib/acp/types.ts app/api/acp/route.ts
git commit -m "feat: thread env vars through backend spawn and API actions"
```

---

### Task 3: Frontend Types + Hook State

**Files:**
- Modify: `app/features/agents/agentTypes.ts`
- Modify: `app/features/agents/hooks/useAgentPanelState.ts`

- [ ] **Step 1: Add env to Agent type**

In `app/features/agents/agentTypes.ts`, add to the `Agent` type:

```typescript
  env?: Record<string, string>;
```

- [ ] **Step 2: Add env to newAgentForm state**

In `app/features/agents/hooks/useAgentPanelState.ts`, update the `newAgentForm` initial state (line 54-56):

```typescript
  const [newAgentForm, setNewAgentForm] = useState({
    id: '', name: '', command: '', args: '', cwd: DEFAULT_CWD, yolo: true, env: '',
  });
```

- [ ] **Step 3: Update closeAddAgent to reset env**

In the `closeAddAgent` function (line 79-80), the reset already sets the full object. Update it:

```typescript
  function closeAddAgent() {
    setShowAddAgent(false);
    setNewAgentForm({ id: '', name: '', command: '', args: '', cwd: DEFAULT_CWD, yolo: true, env: '' });
  }
```

- [ ] **Step 4: Update createAgent to send env**

In the `createAgent` function (line 83-113), parse the env textarea value and include it in the API call. Update the `acp` call:

```typescript
  async function createAgent() {
    const { id, name, command, args, cwd, yolo, env } = newAgentForm;
    const trimmedId = id.trim();
    if (!trimmedId) return;
    setAddAgentLoading(true);
    try {
      // Parse KEY=VALUE lines into object
      const envObj: Record<string, string> = {};
      for (const line of env.split('\n')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = line.slice(0, eqIdx).trim();
        const value = line.slice(eqIdx + 1).trim();
        if (key) envObj[key] = value;
      }

      const data = await acp({
        action: 'create-agent',
        agent: {
          id: trimmedId,
          name: name.trim() || trimmedId,
          command: command.trim() || 'copilot.exe',
          args: args.trim() ? args.trim().split(/\s+/) : ['--acp'],
          cwd: cwd.trim(),
          yolo,
          env: envObj,
        },
      });
      if (data.ok) {
        await loadAgents();
        addMessage({ type: 'system', content: `✅ Agent "${name.trim() || trimmedId}" created` });
        setShowAddAgent(false);
        setNewAgentForm({ id: '', name: '', command: '', args: '', cwd: DEFAULT_CWD, yolo: true, env: '' });
      } else {
        addMessage({ type: 'system', content: `❌ Failed: ${data.error}` });
      }
    } catch {
      addMessage({ type: 'system', content: '❌ Failed to create agent' });
    } finally {
      setAddAgentLoading(false);
    }
  }
```

- [ ] **Step 5: Update saveAgentSettings to include env**

In the `saveAgentSettings` function (line 192-217), update the `updates` object to include `env`. The `settingsAgentConfig.env` is already a `Record<string, string>` from the API:

```typescript
  async function saveAgentSettings() {
    if (!settingsAgentId || !settingsAgentConfig) return;
    setAgentSettingsLoading(true);
    try {
      const data = await acp({
        action: 'update-agent-config', agentId: settingsAgentId,
        updates: {
          name: settingsAgentConfig.name,
          command: settingsAgentConfig.command,
          args: settingsAgentConfig.args,
          cwd: settingsAgentConfig.cwd,
          yolo: settingsAgentConfig.yolo,
          public: settingsAgentConfig.public,
          env: settingsAgentConfig.env,
        },
      });
      if (data.ok) {
        setShowAgentSettings(false);
        await loadAgents();
        addMessage({ type: 'system', content: data.restarted ? `⚙️ ${settingsAgentConfig.name} settings updated, restarting...` : `⚙️ ${settingsAgentConfig.name} settings saved` });
      }
    } catch (err) {
      console.error('Failed to save agent settings', err);
    } finally {
      setAgentSettingsLoading(false);
    }
  }
```

- [ ] **Step 6: Update Escape handler to reset env**

In the `handleKey` function (around line 253), update the escape handler for `showAddAgent`:

```typescript
      if (showAddAgent) { setShowAddAgent(false); setNewAgentForm({ id: '', name: '', command: '', args: '', cwd: DEFAULT_CWD, yolo: true, env: '' }); return; }
```

- [ ] **Step 7: Verify build compiles**

Run: `cd agents-chat && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add app/features/agents/agentTypes.ts app/features/agents/hooks/useAgentPanelState.ts
git commit -m "feat: add env to frontend agent types and hook state"
```

---

### Task 4: UI — Env Vars Textarea in Modals

**Files:**
- Modify: `app/features/agents/components/AgentsPanel.tsx`

- [ ] **Step 1: Add env textarea to the "Add New Agent" modal**

In `AgentsPanel.tsx`, inside the "Add New Agent" modal (after the yolo checkbox, around line 329), add:

```tsx
            <label>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                Environment Variables
                <button
                  type="button"
                  onClick={(e) => {
                    const textarea = (e.currentTarget.closest('label') as HTMLElement)?.querySelector('textarea');
                    if (textarea) textarea.style.filter = textarea.style.filter ? '' : 'blur(4px)';
                  }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', padding: 0 }}
                  title="Toggle visibility"
                >👁</button>
              </span>
              <textarea
                value={newAgentForm.env}
                onChange={(e) => setNewAgentForm((f) => ({ ...f, env: e.target.value }))}
                placeholder={"ANTHROPIC_API_KEY=sk-ant-...\nOTHER_VAR=value"}
                rows={3}
                style={{ filter: 'blur(4px)', fontFamily: 'monospace', fontSize: '12px' }}
              />
              <span className="fieldHint">One per line: KEY=VALUE. Used for API keys and agent config.</span>
            </label>
```

- [ ] **Step 2: Add env textarea to the "Agent Settings" modal**

In the settings modal (after the yolo checkbox, around line 244, before the Access Control section), add an env textarea. This one needs to convert between `Record<string, string>` and textarea text:

```tsx
            {!settingsAgentConfig.relay && (
              <label>
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  Environment Variables
                  <button
                    type="button"
                    onClick={(e) => {
                      const textarea = (e.currentTarget.closest('label') as HTMLElement)?.querySelector('textarea');
                      if (textarea) textarea.style.filter = textarea.style.filter ? '' : 'blur(4px)';
                    }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', padding: 0 }}
                    title="Toggle visibility"
                  >👁</button>
                </span>
                <textarea
                  value={Object.entries(settingsAgentConfig.env || {}).map(([k, v]) => `${k}=${v}`).join('\n')}
                  onChange={(e) => {
                    const envObj: Record<string, string> = {};
                    for (const line of e.target.value.split('\n')) {
                      const eqIdx = line.indexOf('=');
                      if (eqIdx <= 0) continue;
                      const key = line.slice(0, eqIdx).trim();
                      const value = line.slice(eqIdx + 1).trim();
                      if (key) envObj[key] = value;
                    }
                    setSettingsAgentConfig((c) => c ? { ...c, env: envObj } : c);
                  }}
                  placeholder={"ANTHROPIC_API_KEY=sk-ant-...\nOTHER_VAR=value"}
                  rows={3}
                  style={{ filter: 'blur(4px)', fontFamily: 'monospace', fontSize: '12px' }}
                />
                <span className="fieldHint">One per line: KEY=VALUE. Used for API keys and agent config.</span>
              </label>
            )}
```

- [ ] **Step 3: Verify build compiles**

Run: `cd agents-chat && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add app/features/agents/components/AgentsPanel.tsx
git commit -m "feat: add masked env var textarea to agent add/settings modals"
```

---

### Task 5: Claude Code Seed Entry

**Files:**
- Modify: `agents.json`

- [ ] **Step 1: Add Claude Code to agents.json**

Replace the contents of `agents.json`:

```json
{
  "agents": [
    {
      "id": "claude-code",
      "name": "Claude Code",
      "command": "npx",
      "args": ["@agentclientprotocol/claude-agent-acp@latest"],
      "cwd": "",
      "yolo": true,
      "env": {
        "ANTHROPIC_API_KEY": ""
      }
    }
  ]
}
```

Note: This seed is only imported on first DB initialization. Existing installations that already ran the `agents_json_import` migration won't re-import. Users can add Claude Code manually through the UI.

- [ ] **Step 2: Commit**

```bash
git add agents.json
git commit -m "feat: add Claude Code as default agent in agents.json seed"
```

---

### Task 6: Manual Verification

- [ ] **Step 1: Delete existing config.db to test fresh migration**

```bash
Remove-Item .data/config.db -ErrorAction SilentlyContinue
```

- [ ] **Step 2: Start the dev server**

Run: `npm run dev`

Expected: Server starts on https://localhost:3010. Console shows:
```
[ConfigStore] Migrated 1 agents from agents.json (owner=...)
```

- [ ] **Step 3: Verify Claude Code agent appears**

Open https://localhost:3010, open the Agents panel. "Claude Code" should appear in the list.

- [ ] **Step 4: Verify env vars in settings**

Click Claude Code → Settings modal opens. Verify:
- "Environment Variables" textarea is visible (blurred)
- Click 👁 to reveal — shows `ANTHROPIC_API_KEY=`
- Edit the value, save, reopen settings — value persists

- [ ] **Step 5: Verify env passed to spawn**

Set a test env var (e.g. `TEST_VAR=hello`), save, and check the server console log. The spawn should include the merged env (visible if you add a temporary `console.log` or check via the agent's behavior).

- [ ] **Step 6: Test adding a new agent with env vars**

Click + → Add Agent in Server:
- Fill in ID, name, command
- Add env vars in the textarea
- Create → verify agent appears and env persists in settings

- [ ] **Step 7: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: address issues found during manual verification"
```

---

### Task 7: Build Verification

- [ ] **Step 1: Run production build**

Run: `cd agents-chat && npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 2: Commit any build fixes**

If the build revealed issues, fix and commit them.
