# Claude Code Integration + Per-Agent Environment Variables

**Date:** 2026-05-20  
**Status:** Approved

## Summary

Add support for per-agent environment variables and pre-configure a Claude Code agent using `@agentclientprotocol/claude-agent-acp@latest`. This enables users to pass API keys (e.g., `ANTHROPIC_API_KEY`) and other configuration to any ACP agent directly from the UI.

## Motivation

The app currently spawns agents with `env: process.env`, meaning all agents inherit the server's environment but have no way to receive agent-specific secrets or configuration. Claude Code (via the `@agentclientprotocol/claude-agent-acp` package) requires an `ANTHROPIC_API_KEY` to function. Other agents (Gemini, Qwen, etc.) have similar needs. A generic per-agent env var system solves this for all agents.

## Design

### 1. Data Layer

#### DB Schema Migration

Add a column to the existing `agents` table:

```sql
ALTER TABLE agents ADD COLUMN env TEXT NOT NULL DEFAULT '{}';
```

The `env` column stores a JSON object: `{ "KEY": "value", ... }`.

#### agents.json Seed Entry

Add Claude Code to the seed config so new installations get it automatically:

```json
{
  "id": "claude-code",
  "name": "Claude Code",
  "command": "npx",
  "args": ["@agentclientprotocol/claude-agent-acp@latest"],
  "cwd": "",
  "yolo": true,
  "env": { "ANTHROPIC_API_KEY": "" }
}
```

#### configStore.ts Changes

- Add `env: Record<string, string>` to the `AgentRecord` type.
- Update `getAgent()`, `getAllAgents()`, `createAgent()`, `updateAgent()` to read/write the `env` column (parse/stringify JSON).
- Update the `agents.json` migration to import the `env` field when present.

### 2. Backend — Spawn Logic

In `app/api/acp/route.ts`, update the `spawn()` call:

```typescript
const agentEnv: Record<string, string> = {};
try {
  Object.assign(agentEnv, JSON.parse(config.env || '{}'));
} catch { /* ignore parse errors */ }

const cp = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd,
  env: { ...process.env, ...agentEnv },
  windowsHide: true,
  shell: true,
});
```

Only non-empty values are merged — empty string values are included (allows overriding to empty).

#### AgentConfig Type Update

In `lib/acp/types.ts`, add to `AgentConfig`:

```typescript
env?: string; // JSON string of { key: value } pairs
```

### 3. Frontend Types

In `app/features/agents/agentTypes.ts`, add:

```typescript
env?: Record<string, string>;
```

The API responses already pass through agent config fields; the `env` field will be included in GET/POST agent endpoints.

### 4. UI — Environment Variables Editor

#### Location

Added to both:
- The "Add New Agent" modal
- The "Agent Settings" modal (for editing existing agents)

#### Appearance

- A `<textarea>` labeled "Environment Variables"
- Format: one `KEY=VALUE` per line
- Helper text: "One per line: KEY=VALUE. Used for API keys and agent config."
- Values masked by default using CSS `filter: blur(4px)` on the textarea
- A 👁 toggle button next to the label reveals/hides values
- On save: parsed into `{ key: value }` object; on load: serialized back to `KEY=VALUE\n` lines

#### Parsing Rules

- Lines without `=` are ignored
- First `=` splits key from value (values may contain `=`)
- Leading/trailing whitespace on keys and values is trimmed
- Empty lines are skipped
- Keys must be non-empty after trimming

### 5. API Surface

No new endpoints. The existing agent CRUD endpoints (`POST /api/agents`, `PUT /api/agents/:id`) accept and return the `env` field as a JSON object.

The agent config endpoint that returns agent details to the settings modal includes `env` in the response.

### 6. Security Considerations

- Env vars are stored in plaintext in SQLite (same security model as the rest of the config DB). The DB file is server-local in `.data/config.db`.
- The frontend masks values visually but they are still transmitted as plaintext over the HTTPS connection.
- The GET endpoint that lists agents for non-admin users should NOT include env values — only the settings modal (admin/owner) should see them.

### 7. Files to Change

| File | Change |
|------|--------|
| `lib/configStore.ts` | Add `env` column migration, update CRUD, update types |
| `lib/acp/types.ts` | Add `env` to `AgentConfig` |
| `app/api/acp/route.ts` | Merge agent env into spawn env; pass env in config loading |
| `app/features/agents/agentTypes.ts` | Add `env` to `Agent` type |
| `app/features/agents/components/AgentsPanel.tsx` | Add env textarea to add/settings modals |
| `app/features/agents/hooks/useAgentPanelState.ts` | Add env to form state |
| `agents.json` | Add Claude Code seed entry |

### 8. Testing

- **E2E (Playwright):** Add/edit an agent with env vars, verify they persist across settings open/close.
- **Manual:** Spawn Claude Code with a valid `ANTHROPIC_API_KEY`, verify it responds.

## Out of Scope

- Encryption at rest for env var values (acceptable for a local-first app)
- Per-user env var overrides (all users sharing an agent share the same env)
- Env var validation (no checking if keys are valid identifiers)
