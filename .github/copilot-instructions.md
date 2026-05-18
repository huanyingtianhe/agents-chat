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

- **`app/page.tsx`** — Legacy chat page integration shell. Avoid adding unrelated responsibilities here; extract new UI, state, and helpers into focused files.
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

Keep files focused and prevent large "god files." When a change adds a new responsibility, extract it instead of expanding an already-large file.

Next.js / App Router best practices:
- Prefer **Server Components by default**. Add `"use client"` only for components that need browser APIs, event handlers, local state, refs, effects, or client-only libraries.
- Keep `app/**/page.tsx` and `app/**/layout.tsx` as route composition shells. Move reusable UI into `app/components/`, route-specific components next to the route, and complex client behavior into focused child components.
- Move reusable React state/effects into hooks under `app/hooks/` or a route-local `hooks/` folder.
- Move pure helpers, protocol parsing, persistence helpers, and shared TypeScript types into `lib/` or narrowly scoped files near their consumers.
- Keep API route handlers thin. Route files in `app/api/**/route.ts` should validate HTTP input, call focused server-side helpers, and return responses; place complex business logic in `lib/`.
- Co-locate code that changes together, but split files when responsibilities differ. A file should have one clear reason to change.
- Do not add new functionality to `app/page.tsx` by default. If touching it is unavoidable, keep the edit small and extract any new component, hook, or helper created by the change.
- Prefer named exports for shared components/helpers and explicit TypeScript types at module boundaries.

## Conventions

- **No CSS modules or Tailwind** — all styling is `styled-jsx` inside components or `globals.css`.
- **Page composition** — avoid monolithic route files. Treat existing large files as legacy integration points and extract focused modules when making related changes.
- **Auth**: NextAuth with Azure AD (optional) + local credentials provider. Admin detection via JWT `role` field or `ADMIN_EMAILS` env var.
- **API routes** use Next.js App Router conventions (`app/api/*/route.ts` with named exports `GET`/`POST`).
- **No ORM** — direct `better-sqlite3` usage with raw SQL in `lib/chatStore.ts`.
- **TypeScript strict** — project uses TypeScript with no separate lint/format tooling configured.
- **Environment config** — see `.env.example` for required variables (`NEXTAUTH_SECRET`, optional Azure AD and admin credentials).
