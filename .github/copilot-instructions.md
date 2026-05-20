# Copilot Instructions

## Build & Run

```bash
npm install
npm run dev          # starts on port 3010
npm run build        # production build
```

### Tests (Playwright E2E)

```bash
npx playwright test --config test/playwright.config.ts              # all specs
npx playwright test --config test/playwright.config.ts test/test-ui.spec.ts  # single file
npx playwright test --config test/playwright.config.ts -g "test name"        # single test by title
```

Tests expect the app running on `localhost:3010`. No unit test framework is configured.

## Architecture

This is a **Next.js 16** app (App Router, React 19) that provides a multi-agent chat UI for ACP (Agent Client Protocol) agents.

### Key components

- **`app/page.tsx`** — Thin route shell. Just renders `<ChatPageClient />`. Do not add logic here.
- **`app/features/chat/ChatPageClient.tsx`** — Top-level client component that wires runtime, layout, sidebar, composer, and message list together. Keep it as a composition layer — push new logic into the appropriate `features/<domain>/` folder.
- **`app/features/`** — Domain-organized client code. Each feature owns its own `components/`, hooks, helpers, and types:
  - `chat/` — chat runtime hooks (`runtime/`), API client (`chatApi.ts`), helpers, types, and the `ChatPageClient` shell.
  - `composer/` — message composer UI, attachment helpers and types.
  - `messages/` — message rendering, markdown helpers, display helpers.
  - `agents/` — agents panel and per-agent model picker UI (`AgentsPanel.css`, `AgentModelSelect.tsx`, …).
  - `layout/` — `PageLayout`, `PageHeader`, header overflow menu, and shared layout chrome.
  - `files/` — file workspace panel and supporting helpers.
  - `nodes/` — nodes panel UI.
  - `theme/` — theme tokens (`themes.ts`) and the theme menu.
- **`app/api/acp/route.ts`** — The core backend. Manages agent child processes, NDJSON-RPC communication over stdio, session lifecycle, and streaming responses back to the client via SSE (`ReadableStream`).
- **`lib/chatStore.ts`** — Server-side persistence using `better-sqlite3`. Stores chats and shared conversations in `.data/chats.db`.
- **`agents.json`** — Runtime agent configuration (not checked in with real data). Defines which ACP executables to spawn, their working directories, and flags.
- **`middleware.ts`** — Auth gate using `next-auth`. Redirects unauthenticated requests to `/login`.

### Protocol flow (ACP over NDJSON-RPC)

The backend spawns agent processes and communicates via newline-delimited JSON-RPC on stdin/stdout:
1. `initialize` → `session/new` → `session/prompt` (send user message)
2. Agent streams `session/update` notifications (thinking, tool execution, text chunks)
3. Agent may issue server-side requests (`terminal/create`, `fs/read_text_file`, etc.) which the backend handles and responds to

### Data storage

- Chat history: `.data/chats.db` (SQLite, auto-created)
- Agent config: `agents.json` (project root)
- Migration from legacy JSON files: `npx tsx lib/migrate.ts`

## Development Workflow

Follow TDD when implementing new features:
1. Write unit tests for the logic first (tests should fail initially)
2. Implement the feature to make tests pass
3. Add Playwright E2E tests for user-facing behavior

Testing expectations by change type:
- UX / frontend behavior changes must include or update Playwright E2E coverage.
- Backend / API behavior changes must include or update API tests.
- If a change crosses both boundaries, include both E2E and API coverage where practical.

## Code Structure Guardrails

Keep files focused and prevent large "god files." When a change adds a new responsibility, extract it into the appropriate `app/features/<domain>/` folder instead of expanding an existing file.

Domain layout under `app/features/`:
- Each feature folder owns its own UI (`components/`), hooks, helpers (`*Helpers.ts`), and types (`*Types.ts`).
- Cross-feature reuse goes through named exports; do not import a feature's internal `components/` from another feature without an explicit re-export.
- CSS for a feature lives next to its components (e.g. `agents/components/AgentsPanel.css`).

Next.js / App Router best practices:
- Prefer **Server Components by default**. Add `"use client"` only for components that need browser APIs, event handlers, local state, refs, effects, or client-only libraries.
- Keep `app/**/page.tsx` and `app/**/layout.tsx` as route composition shells. `app/page.tsx` should stay a one-liner that renders `ChatPageClient`.
- Put new chat-runtime state/effects under `app/features/chat/runtime/` as focused hooks. Put feature-local hooks beside the feature.
- Move pure helpers, protocol parsing, persistence helpers, and shared TypeScript types into `lib/` (cross-cutting) or the feature's `*Helpers.ts` / `*Types.ts` files.
- Keep API route handlers thin. Route files in `app/api/**/route.ts` should validate HTTP input, call focused server-side helpers, and return responses; place complex business logic in `lib/`.
- Co-locate code that changes together, but split files when responsibilities differ. A file should have one clear reason to change.
- Do not add new functionality to `app/page.tsx` or to `ChatPageClient.tsx`'s body beyond composition. Extract any new component, hook, or helper into the right `features/<domain>/` location.
- Prefer named exports for shared components/helpers and explicit TypeScript types at module boundaries.

## Conventions

- **No CSS modules or Tailwind** — styling is `styled-jsx` inside components or per-feature `.css` files co-located with their components (e.g. `app/features/agents/components/AgentsPanel.css`); global styles live in `globals.css`.
- **Page composition** — `app/page.tsx` stays a one-liner; `ChatPageClient` composes feature components and runtime hooks. Add new behavior to the relevant `app/features/<domain>/` folder, not to the page or composition shell.
- **Auth**: NextAuth with Azure AD (optional) + local credentials provider. Admin detection via JWT `role` field or `ADMIN_EMAILS` env var.
- **API routes** use Next.js App Router conventions (`app/api/*/route.ts` with named exports `GET`/`POST`).
- **No ORM** — direct `better-sqlite3` usage with raw SQL in `lib/chatStore.ts`.
- **TypeScript strict** — project uses TypeScript with no separate lint/format tooling configured.
- **Environment config** — see `.env.example` for required variables (`NEXTAUTH_SECRET`, optional Azure AD and admin credentials).
