# ACP Chat

A standalone multi-agent chat UI for **ACP (Agent Client Protocol)** agents. No gateway, no openclaw — just direct communication with ACP-compatible CLI tools like GitHub Copilot CLI, Claude Code, etc.

## Quick Start

```bash
npm install
npm run dev          # starts on https://localhost:3010
```

Open [https://localhost:3010](https://localhost:3010).

> **Note:** `npm run dev` enables HTTPS via `--experimental-https`. Accept the self-signed cert on first load.

## Production

```bash
npm run build
npm start            # serves on port 3000
# or
.\start.ps1          # builds + serves with a Dev Tunnel (permanent URL)
.\start.ps1 -Cloudflare  # builds + serves with a Cloudflare quick tunnel
```

## Configuration

### Agents

Agents are stored in SQLite (`.data/config.db`) and managed through the UI. On first boot the app auto-migrates any existing `agents.json` file.

To seed agents without the UI, create `agents.json` at the project root before first boot:

```json
{
  "agents": [
    {
      "id": "copilot",
      "name": "GitHub Copilot CLI",
      "command": "copilot.exe",
      "args": ["--acp"],
      "cwd": "C:\\work",
      "yolo": true
    }
  ]
}
```

#### Agent Fields

| Field | Description |
|-------|-------------|
| `id` | Unique agent identifier |
| `name` | Display name |
| `command` | Path to the ACP executable |
| `args` | Command line arguments (default: `["--acp"]`) |
| `cwd` | Working directory for the agent process |
| `yolo` | Auto-approve mode (adds `--yolo` flag) |
| `noTools` | Disable tool calls — agent responds as chat-only (faster) |
| `relay` | Connect via Azure Relay WebSocket instead of local process |
| `relayConnectionName` | Azure Relay hybrid connection name (required when `relay: true`) |
| `public` | Allow all authenticated users to talk to this agent (default: owner-only) |

### Environment Variables

Copy `.env.example` to `.env.local` and fill in the required values:

```bash
cp .env.example .env.local
```

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXTAUTH_SECRET` | ✅ | Random secret for signing JWTs |
| `NEXTAUTH_URL` | ✅ | Public URL of the app (e.g. `https://localhost:3010`) |
| `AZURE_AD_CLIENT_ID` | Optional | Azure AD app client ID — enables SSO login |
| `AZURE_AD_CLIENT_SECRET` | Optional | Azure AD client secret |
| `AZURE_AD_TENANT_ID` | Optional | Tenant ID (default: `common`) |
| `ADMIN_USERNAME` | Optional | Local admin username for credentials login |
| `ADMIN_PASSWORD` | Optional | Local admin password |
| `ADMIN_EMAILS` | Optional | Comma-separated emails granted admin role (Azure AD users) |
| `RELAY_SEND_CONNECTION_STRING` | Optional | Azure Relay send connection string — required for relay agents and node probing |
| `RELAY_SUBSCRIPTION_ID` | Optional | Azure subscription ID — enables auto-discovery of relay nodes via ARM API |
| `RELAY_RESOURCE_GROUP` | Optional | Azure resource group containing the Relay namespace |
| `RELAY_NAMESPACE` | Optional | Azure Relay namespace name |

## Features

- **Multi-agent chat** — Talk to multiple ACP agents simultaneously
- **@mention** — Type `@agent-id` to direct messages to specific agents
- **Orchestration** — Discussion mode (parallel with rounds) and Pipeline mode (sequential)
- **Multi-turn queue** — Send follow-up messages while an agent is still processing; turns are queued and executed in order
- **Streaming** — Real-time response streaming with phase indicators (thinking, tool execution, replying)
- **Agent management** — Add, configure, and remove agents from the UI; per-agent access control
- **Relay agents** — Connect to remote agents running on other machines via Azure Relay
- **Node registry** — Register and discover remote agent nodes; auto-discovers Azure Relay hybrid connections
- **Chat history** — Persistent message history stored in SQLite (`.data/chats.db`)
- **Session resume** — Reloading a chat reloads the agent session context via `session/load`
- **Shared chats** — Generate a read-only share link for any conversation

## Architecture

- **Frontend**: Next.js 16 (App Router) with React 19, styled-jsx, react-markdown
- **Backend**: Next.js API routes managing ACP processes, chat persistence, and auth
- **Protocol**: NDJSON-RPC over stdio for local agents; WebSocket for relay agents (no SDK required)
- **Storage**: SQLite — `.data/chats.db` for chat history, `.data/config.db` for agent/node config

## ACP Protocol Flow

1. **Spawn** — Start agent process with configured command + args (or connect via Azure Relay)
2. **Initialize** — Send `initialize` with `protocolVersion: 1`
3. **New Session** — Send `session/new` with working directory and MCP server list
4. **Prompt** — Send `session/prompt` with user message
5. **Stream** — Receive `session/update` notifications (thinking, tool execution, response chunks)
6. **Complete** — Prompt resolves when agent finishes; next queued turn starts automatically
7. **Resume** — On reconnect, send `session/load` to restore prior session context

The backend handles server-side requests from agents: terminal management (`terminal/create`, `terminal/output`, `terminal/wait_for_exit`, etc.) and file system access (`fs/read_text_file`, `fs/write_text_file`).

## Data Migration

If migrating from a legacy JSON-file setup:

```bash
npx tsx lib/migrate.ts
```

## Tests

Tests are Playwright E2E and expect the app running on `localhost:3010`.

```bash
npx playwright test --config test/playwright.config.ts              # all tests
npx playwright test --config test/playwright.config.ts test/test-ui.spec.ts  # single file
npx playwright test --config test/playwright.config.ts -g "test name"        # by title
```
