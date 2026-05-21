# Page Shell Targeted Refactor Design

## Problem

`app/page.tsx` is still the primary integration shell for the chat UI and is about 8.5k lines. It mixes route composition, chat state, composer rendering, failed-send controls, sidebar chat history, ACP dispatch, persistence, and file workspace UI. This makes conflict resolution and UI changes harder than necessary.

## Goal

Reduce `app/page.tsx` by extracting high-value, low-risk UI seams while preserving behavior. The refactor should make the page easier to maintain without changing chat, composer, resend, persistence, or file workspace behavior.

## Recommended approach

Use a targeted extraction. Keep `app/page.tsx` as the route-level owner of state, refs, side effects, persistence, and ACP dispatch. Move presentational rendering into typed client components that receive all data and callbacks through explicit props.

This avoids a large state-management rewrite during an active PR while creating better boundaries for future extractions.

## Components

### `app/features/composer/components/ChatComposer.tsx`

Owns composer markup only:

- attachment tray placement
- textarea layout
- attach button
- model picker row
- send/stop controls
- composer hints

It receives refs, input handlers, attachment handlers, model picker elements, send state, and action callbacks from `page.tsx`. It does not send messages or mutate chat state directly.

### `app/features/chat/components/FailedSendControls.tsx`

Owns failed user-message status and resend action UI:

- single-line "Failed to send" status
- right-aligned resend button
- disabled/waiting state text
- accessibility labels

It receives the normalized failure display data and `onResend` callback from `page.tsx`. Resend routing and error handling remain in `page.tsx`.

### `app/features/chat/components/ChatSidebarList.tsx`

Owns chat history list rendering:

- "New Chat" button
- filtered chat rows
- active chat highlighting
- chat status/metadata text
- row menu trigger placement

It receives computed chat rows, current chat identity, menu state, and callbacks for create, load, rename menu, and delete actions from `page.tsx`.

## Data flow

`page.tsx` remains the source of truth for:

- `currentChatId`, `activeSidebarChatId`, `chatHistory`, and `chatName`
- composer refs and input synchronization
- attachments and paste/drop/file handling
- failed-send migration, retry routing, and active-run checks
- chat persistence and `lastChatId`

Extracted components render props and invoke callbacks. They do not fetch, persist, dispatch ACP prompts, or manage cross-chat state.

## Styling

Use one adjacent plain CSS file for each extracted TSX component. Do not use CSS modules or Tailwind.

Add `ChatComposer.css`, `FailedSendControls.css`, and `ChatSidebarList.css` next to their matching TSX files. Because these are plain global CSS files in the Next.js App Router, import them from `app/layout.tsx` rather than from the components. Preserve existing class names where Playwright or current CSS depends on them. Shared theme variables, broad layout rules, and rules used across multiple unrelated page areas stay in existing global/page styling for this pass.

## Error handling

No new broad catches or silent fallbacks are introduced. Existing error behavior stays in `page.tsx`; components render the error or disabled state they are given.

## Testing

After extraction:

- run existing source tests
- run `npm run build`
- run targeted Playwright coverage for attachments, failed-send resend controls, chat creation/switching, and chat sidebar behavior
- run the full Playwright suite if targeted tests pass

No behavior changes are intended, so existing assertions should remain valid except for imports or selector-preserving markup movement.

## Out of scope

- splitting ACP runtime or persistence logic
- extracting the file workspace/editor UI
- changing chat state management architecture
- changing visible composer, failed-send, or sidebar behavior
