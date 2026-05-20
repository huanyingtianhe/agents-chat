# Layered Refactor Design

## Problem

`app/page.tsx` and `app/api/acp/route.ts` have accumulated many unrelated responsibilities:

- `app/page.tsx` is about 9,800 lines and contains route composition, feature state, data fetching, chat orchestration, file editing, comment review UI, agent/node management, attachment handling, and styled-jsx.
- `app/api/acp/route.ts` is about 3,000 lines and contains HTTP action routing, ACP process lifecycle, NDJSON-RPC transport, terminal/file tool handlers, attachment normalization, session persistence, model sync, turn polling, user-request handling, and recovery logic.

The current shape makes feature work risky because unrelated behavior is coupled through large files and local state. The goal is a behavior-preserving refactor that creates clear layers and vertical slices without changing UX, API contracts, storage keys, or ACP protocol behavior.

## Goals

- Start from latest `origin/main`.
- Keep the first implementation PR behavior-preserving.
- Reduce `app/page.tsx` and `app/api/acp/route.ts` by extracting code into focused modules.
- Prefer vertical feature slices for frontend code, with shared components/helpers only where genuinely cross-cutting.
- Make the ACP route a thin HTTP dispatcher over focused backend services and action handlers.
- Preserve existing auth, persistence, global runtime caches, session reuse, local-agent warmup, setup ZIP behavior, and E2E-visible UI behavior.

## Non-goals

- No UI redesign.
- No API response shape changes.
- No storage schema changes.
- No new ACP protocol behavior.
- No CSS architecture migration unless a component extraction requires moving the colocated styled-jsx that belongs to that component.

## Frontend architecture

`app/page.tsx` should become a route composition shell that wires feature slices together. Feature-owned components, hooks, types, and helpers should live together so code that changes together stays together.

Proposed frontend structure:

```text
app/
  page.tsx
  components/
    shared presentational components only
  features/
    chat/
      components/
      hooks/
      chatTypes.ts
      chatApi.ts
      chatHelpers.ts
    composer/
      components/
      hooks/
      attachmentHelpers.ts
    agents/
      components/
      hooks/
      agentTypes.ts
      agentApi.ts
    nodes/
      components/
      hooks/
      nodeApi.ts
    files/
      components/
      hooks/
      fileWorkspaceTypes.ts
      fileWorkspaceHelpers.ts
    comments/
      components/
      hooks/
      commentTypes.ts
      commentHelpers.ts
    theme/
      themeTypes.ts
      themes.ts
```

Initial extraction candidates:

- Chat/composer: message types, chat history normalization, mention parsing, send failure helpers, attachment helpers, attachment list UI, user-request card UI, and model selection UI.
- Agents: list/model/settings/access/create/delete state and components.
- Nodes: node registry state, setup ZIP download, relay-agent creation, and node label editing.
- Files: file tree helpers, markdown/html editor state, file conflict handling, workspace persistence, and file editor components.
- Comments: file comment state, review chat dispatch, markers, sidebar layout, replies, and status transitions.
- Theme/UI preferences: localStorage-backed preferences, menu dismissal, sidebar collapsed state, and theme selection.

Cross-slice communication should happen through explicit props/callbacks from `Page` or a small route-level coordinator hook. Feature slices should not import each other directly except for shared types/helpers that are intentionally placed in a shared location.

## Backend architecture

`app/api/acp/route.ts` should keep only App Router exports, HTTP parsing/auth context setup, and action dispatch. ACP runtime behavior should move to `lib/acp/` modules with explicit dependencies where practical.

Proposed backend structure:

```text
lib/acp/
  types.ts
  attachments.ts
  rpc.ts
  terminalTools.ts
  fsTools.ts
  runtimeState.ts
  agentProcesses.ts
  sessions.ts
  models.ts
  turns.ts
  userRequests.ts
  recovery.ts
  actions/
    index.ts
    agents.ts
    runtime.ts
    sessions.ts
    userRequests.ts
```

Responsibilities:

- `attachments.ts`: attachment validation, MIME inference, data URL rewriting, prompt part building.
- `rpc.ts`: local NDJSON-RPC and Azure Relay NDJSON-RPC transport creation.
- `terminalTools.ts` / `fsTools.ts`: ACP server-side tool handlers.
- `runtimeState.ts`: all `globalThis` singleton caches, including process maps, user sessions, boot promises, replay buffers, pending user-request responders, terminals, and cleanup timer.
- `agentProcesses.ts`: agent config lookup, process booting, warmup, RPC notification/request wiring.
- `sessions.ts` / `models.ts`: session parameter building, MCP server loading, saved session loading, session model sync and validation.
- `turns.ts`: turn persistence, serialization, release scheduling, send prompt, and poll-facing state updates.
- `userRequests.ts`: ACP user-request normalization, synthetic question parsing, pending request queueing/responding/cleanup, and permission memory.
- `recovery.ts`: chat/message comparison and recovery helpers.
- `actions/*`: HTTP action handlers called by the thin route dispatcher.

Stateful boundaries must preserve existing global cache names and semantics so Next.js hot reload and server process reuse continue working. Extracting state must not create a second process/session registry.

## Data flow

Frontend:

1. UI components call feature hook actions.
2. Feature hooks call existing API endpoints through small typed API wrappers.
3. `Page` coordinates cross-feature state through props/callbacks.
4. Existing localStorage keys remain unchanged.
5. Existing chat/message state shape remains compatible with persisted SQLite records.

Backend:

1. `POST(req)` parses JSON, resolves auth token/email/admin state, and builds a request context.
2. A typed action dispatcher validates action names and delegates to focused handlers.
3. Handlers call ACP runtime services, config store, chat store, and auth helpers.
4. Handlers return the same `NextResponse` payloads and status codes as today.

## Error handling and compatibility

- Preserve existing error codes, status codes, and logs unless a change is explicitly called out in a later implementation plan.
- Keep missing/invalid input behavior the same for API actions.
- Keep ACP process boot, session load/new fallback, prompt cancellation, polling, pending user-request, and turn cleanup behavior unchanged.
- Keep setup ZIP and node/agent management behavior unchanged.
- Keep direct user-visible UI text unchanged unless moving text into a component requires exact reuse.

## Testing strategy

- Update source-shape tests so they assert module exports and behavior rather than requiring all logic to live in `page.tsx` or `route.ts`.
- Add module-level Node tests for extracted pure helpers where possible.
- Keep Playwright coverage focused on behavior most likely to regress:
  - send/resume/poll flows,
  - attachment paste/drag/drop and previews,
  - model selection,
  - file editor live/review/conflict flows,
  - file comment review flow,
  - agent and node management panels.
- Run `node test\agent-user-request-route.test.mjs`, relevant focused Node source tests, and `npm run build` at each milestone.

## Implementation approach

Use vertical slices, but keep each commit reviewable and behavior-preserving:

1. Create the branch from latest `origin/main`.
2. Extract pure frontend helpers and types into feature folders.
3. Extract small frontend components that require minimal props.
4. Extract focused frontend hooks for grouped state/effects.
5. Extract backend pure helpers and tool handlers.
6. Extract backend runtime state and process/session services.
7. Extract ACP action handlers and leave `route.ts` as a thin dispatcher.
8. Update tests after each extraction to avoid brittle assumptions about old file locations.

This ordering reduces risk by moving pure code before stateful code and by keeping the original page/route orchestration intact until the new module boundaries are proven.

## Success criteria

- `app/page.tsx` and `app/api/acp/route.ts` are materially smaller and primarily orchestrate imported feature modules.
- The app builds successfully.
- Existing source and Playwright tests that cover affected behavior pass or are intentionally updated to equivalent behavior checks.
- No UX, API, persistence, auth, or ACP protocol behavior changes are introduced.
- Future changes can land in feature-specific files without expanding the two large legacy integration files.
