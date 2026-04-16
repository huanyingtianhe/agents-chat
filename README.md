# ACP Chat

A standalone multi-agent chat UI for **ACP (Agent Client Protocol)** agents. No gateway, no openclaw — just direct communication with ACP-compatible CLI tools like GitHub Copilot CLI, Claude Code, etc.

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Configuration

Agents are configured in `agents.json` at the project root:

```json
{
  "agents": [
    {
      "id": "copilot",
      "name": "GitHub Copilot CLI",
      "command": "copilot.exe",
      "args": ["--acp"],
      "cwd": "",
      "yolo": true
    }
  ]
}
```

### Agent Fields

| Field | Description |
|-------|-------------|
| `id` | Unique agent identifier |
| `name` | Display name |
| `command` | Path to the ACP executable |
| `args` | Command line arguments (default: `["--acp"]`) |
| `cwd` | Working directory for the agent process |
| `yolo` | Auto-approve mode (adds `--yolo` flag) |

## Features

- **Multi-agent chat** — Talk to multiple ACP agents simultaneously
- **@mention** — Type `@agent-id` to direct messages to specific agents
- **Orchestration** — Discussion mode (parallel with rounds) and Pipeline mode (sequential)
- **Streaming** — Real-time response streaming with phase indicators
- **Agent management** — Add, configure, and remove agents from the UI
- **Chat history** — Persistent message history across sessions
- **New sessions** — Create new chat sessions that reset all agent contexts

## Architecture

- **Frontend**: Next.js 16 with React, styled-jsx, react-markdown
- **Backend**: Next.js API route (`/api/acp`) managing ACP processes
- **Protocol**: NDJSON-RPC over stdio (no SDK required)
- **Config**: Local `agents.json` file (no external dependencies)

## ACP Protocol Flow

1. **Spawn** — Start agent process with configured command + args
2. **Initialize** — Send `initialize` with `protocolVersion: 1`
3. **New Session** — Send `session/new` with working directory
4. **Prompt** — Send `session/prompt` with user message
5. **Stream** — Receive `session/update` notifications (thinking, tool execution, response chunks)
6. **Complete** — Prompt resolves when agent finishes

The backend handles terminal management (`terminal/create`, `terminal/output`, etc.) and file system requests (`fs/read_text_file`, `fs/write_text_file`) from agents.
