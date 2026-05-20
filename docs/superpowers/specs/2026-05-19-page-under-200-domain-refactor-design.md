# Page Under 200 Domain Refactor Design

## Problem

`app/page.tsx` is still 7,797 lines after the targeted composer/sidebar/failed-send extraction. It remains the owner for chat runtime state, message rendering, file workspace/editor UI, file comments, agent/node panels, modal UI, markdown helpers, persistence wiring, and the route composition itself.

The next refactor target is stricter: `app/page.tsx` must become less than 200 lines without creating a new giant replacement file.

## Goal

Make `app/page.tsx` a small route shell that delegates to focused feature modules. Preserve current UI and behavior while reducing merge-conflict risk and making future changes easier to isolate.

Success criteria:

- `app/page.tsx` is less than 200 lines.
- No new giant replacement file is introduced.
- Current chat, composer, file workspace, comment review, agent/node panel, persistence, and ACP session behavior remains unchanged.
- Existing source tests, build, targeted Playwright, and full Playwright pass.

## Chosen approach

Use a domain-by-domain split with size guards.

`app/page.tsx` should only do route-level composition, for example importing global/client CSS dependencies and rendering a top-level chat page client component. The top-level client component must also stay small and delegate to domain modules instead of becoming the new `page.tsx`.

This is intentionally not a one-step move of all code into `ChatApp.tsx`. Moving one large file into another would meet the line-count target but would not improve maintainability.

## Proposed file boundaries

### Route shell

- `app/page.tsx`
  - Server or client route shell under 200 lines.
  - Renders the top-level chat page client component.
  - Does not own chat runtime, file workspace, comment, agent, node, or modal state.

### Top-level client composition

- `app/features/chat/ChatPageClient.tsx`
  - Small client composition component.
  - Wires the major domain hooks/components together.
  - Does not contain large JSX subtrees or runtime algorithms.

### Chat runtime domain

- `app/features/chat/runtime/`
  - Owns chat IDs, chat history, persistence, active runs, ACP dispatch/polling, resend routing, orchestration state, and session resume.
  - Exposes a typed `useChatRuntime` hook.
  - Keeps API calls and error handling in the runtime domain, not in UI components.

### Message rendering domain

- `app/features/messages/`
  - Owns message list, message bubble, markdown rendering, streaming parts, tool-call display, copy/collapse actions, failed-send action placement, and inline agent user request cards.
  - Moves markdown/linkify helpers out of `page.tsx`.
  - Uses typed props from chat runtime and composer/file domains.

### File workspace and comments domain

- `app/features/files/`
  - Owns the Files tab, file tree, editor/preview/live edit/diff/conflict UI, file workspace persistence, comments sidebar, review chat linkage, and selection/comment marker behavior.
  - Existing `fileWorkspaceHelpers.ts` and `fileWorkspaceTypes.ts` remain the home for pure helpers/types; larger UI/state should be split into new focused hooks/components.

### Agent and node panels domain

- `app/features/agents/` and `app/features/nodes/`
  - Own agent list/sidebar, model settings, add-agent flows, remote/relay agent forms, node list/setup/edit flows, and related modal UI.
  - Keep current agent model selection component and extract surrounding panel state/UI.

### Composer domain

- `app/features/composer/`
  - Keep existing `ChatComposer`, attachment helpers/types, and component CSS.
  - Move any remaining composer state helpers from `page.tsx` only when doing so does not change behavior.

### Shared layout/modals

- `app/features/layout/`
  - Own page header, mobile panel controls, theme menu, status bar, share dialog, lightbox, and other reusable shell UI.

## Size guards

Add source-shape tests to prevent accidental re-growth:

- `app/page.tsx` must be less than 200 lines.
- `app/features/chat/ChatPageClient.tsx` must stay under 300 lines.
- New TS/TSX files created by this refactor must stay under 500 lines.
- Any exception must be listed explicitly in the source-shape test with the file path and a short justification.

The guard is about preventing a new giant replacement file, not punishing existing files that predate this refactor.

## Migration plan

Move code in behavior-preserving slices:

1. Extract pure helpers, constants, and local types from `page.tsx`.
2. Extract message rendering and agent user request UI.
3. Extract file workspace/editor/comment UI and state hooks.
4. Extract agent/node panels and related modal UI.
5. Extract chat runtime orchestration into hooks/services.
6. Extract remaining shell UI and reduce `page.tsx` to the route shell.
7. Add/adjust size guard tests and run full verification.

Each slice should compile and pass relevant tests before moving to the next one.

## Data flow

The chat runtime hook is the central state owner for chat/session behavior. UI domains receive typed state snapshots and callbacks from the runtime or their local domain hook.

Domain components should not reach across boundaries through globals. They should use explicit props and typed return values. Pure helpers should be imported from their domain helper files.

## Styling

Continue the existing rule from the previous extraction:

- one adjacent plain CSS file per extracted TSX component or cohesive UI group
- no CSS modules
- no Tailwind
- import plain global CSS from `app/layout.tsx`
- preserve existing class names where Playwright or current styling depends on them

Shared theme variables and truly global base rules stay in `app/globals.css`.

## Error handling

Preserve existing behavior. Do not add broad catches or silent success-shaped fallbacks during extraction.

When moving code, keep existing error surfacing in the same domain:

- chat/API/runtime errors stay in chat runtime
- file workspace errors stay in file workspace
- agent/node form errors stay in agent/node domains

## Testing

Testing must happen at each meaningful slice:

- update or add source-shape tests for extracted boundaries
- run affected `test/*.test.mjs`
- run `npm run build`
- run targeted Playwright tests for the affected domain
- run the full Playwright suite before pushing

Final verification must include:

- all source tests
- `npm run build`
- full Playwright
- `app/page.tsx` line-count check under 200
- clean git status

## Out of scope

- changing ACP protocol behavior
- redesigning the UI
- changing persistence schema unless required by an extracted domain
- introducing a global state library
- creating a single large `ChatApp.tsx` or equivalent replacement file
