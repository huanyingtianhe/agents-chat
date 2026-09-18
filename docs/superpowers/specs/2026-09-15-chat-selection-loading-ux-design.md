# Chat Selection Loading UX Design

## Goal

Make Chat selection feel immediate and unambiguous on both mobile and desktop.
Selecting a different Chat must immediately leave the navigation context, hide
the previous Chat, and show a loading state until the selected Chat is ready.

## Current Problem

`ChatPageClient.loadChat()` waits for `runtimeLoadChat()` before closing the
mobile navigation overlay. That operation includes persistence, Chat retrieval,
Agent session resume, and potentially a large history render. On mobile, the
Chats list therefore remains visible after selection. On desktop, the previous
Chat remains visible during the same delay, making the selection appear to have
done nothing.

Files do not have this problem because their mobile navigation closes earlier
in the open flow.

## Interaction Design

### Selection

Selecting a Chat other than the current Chat immediately:

1. marks that Chat as the active selection target;
2. enters a Chat-loading state;
3. closes the Chats navigation overlay on mobile;
4. leaves the desktop Chats sidebar available for another selection; and
5. starts loading the selected Chat in the background.

Selecting the already active Chat closes the mobile navigation as it does
today, without showing a loading state.

### Loading Surface

While a Chat is loading, an opaque `ChatLoadingView` replaces both the message
list and Composer. The previous Chat must not remain visible behind the loading
surface, and sending must be impossible until the selected Chat is ready.

The loading view contains:

- a restrained progress indicator;
- `Loading <chat name>...` when the name is available;
- `role="status"` and `aria-live="polite"`; and
- an `aria-busy` signal on the central Chat region.

The header, status bar, desktop navigation, and unrelated side panels remain
available. No full-page blocking overlay is introduced.

### Focus

On mobile, closing the navigation transfers programmatic focus to the loading
conversation region rather than back to the navigation trigger. When loading
finishes, focus transfers to the new Chat's scroll container without changing
its restored scroll position.

The Composer is not focused automatically, so selecting a Chat does not open
the software keyboard.

### Consecutive Selections

Chat selection follows latest-selection-wins semantics.

Each selection receives a monotonically increasing token. Asynchronous Chat
loading checks whether its token is still current before committing any
selection-specific UI state. An older request may finish its network work, but
it must not:

- replace messages from a newer selection;
- change the selected Chat identity;
- move focus or scroll;
- close the loading view for a newer request; or
- overwrite the latest error state.

The desktop sidebar remains usable during loading. On mobile, users may reopen
Chats and choose another entry.

## Architecture

### Selection Transition Hook

A focused hook under `app/features/chat/` owns:

- the current loading Chat ID and display name;
- the monotonically increasing selection token;
- transition start, current-token checks, success, and failure; and
- refs needed to focus the loading surface and completed conversation.

`ChatPageClient` composes this hook with the existing runtime and mobile overlay
state. It must not absorb the transition state machine directly.

### Persistence Boundary

`chatPersistenceService.loadChat()` accepts an `isCurrentSelection` guard
callback and returns an explicit result:

- `loaded`;
- `failed`; or
- `superseded`.

It checks the guard after asynchronous persistence, retrieval, resume, and
preparation boundaries, before committing target-specific state. Existing
session resume and stale-message reconciliation behavior remains unchanged for
the current selection.

### Loading Component

`ChatLoadingView` is a feature-local component. `ChatPageClient` supplies it as
the central Chat content while a transition is active and omits the Composer.
This masks old content without introducing a second page-level modal or
coupling `ChatSidebarList` to mobile overlay state.

## Error Handling

If the latest Chat load fails:

- the loading state ends;
- the previously displayed Chat is restored;
- the existing explicit load error is shown through the repository's current
  error path; and
- the mobile navigation remains closed.

A failure from a superseded request is ignored by the selection UI because it
no longer represents the user's target.

## Accessibility

- The loading region is keyboard-focusable only programmatically.
- Loading status is announced politely and does not repeatedly announce
  progress animation frames.
- The masked message list and Composer are not interactive or exposed as the
  active content while loading.
- Mobile selection does not summon the software keyboard.
- Reduced-motion preferences disable nonessential loading animation.

## Responsive Behavior

The loading presentation is shared by desktop and mobile. The only
viewport-specific behavior is navigation:

- mobile closes the Chats overlay immediately after selection;
- desktop leaves the Chats sidebar available.

Files, Agents, Nodes, Schedules, and desktop sidebar collapse behavior are out
of scope.

## Test Coverage

Playwright coverage must verify:

1. mobile Chat selection closes the navigation before the held Chat request
   completes;
2. desktop and mobile mask the previous messages and remove or disable the
   Composer while loading;
3. the selected Chat appears when loading completes;
4. the loading view names the selected Chat and exposes accessible busy/status
   semantics;
5. rapidly selecting two Chats leaves the second Chat visible even when the
   first request finishes last;
6. a failed latest request restores the previous Chat and shows an error; and
7. mobile completion focuses the conversation region without focusing the
   Composer or opening the keyboard.

Targeted TypeScript checks and the production build must continue to pass.

## Acceptance Criteria

- Mobile Chats behaves consistently with Files: selecting an item immediately
  returns to its primary content view.
- Desktop never shows the old Chat as if it were the newly selected Chat.
- No message can be sent while a Chat transition is loading.
- Latest-selection-wins is deterministic.
- Existing Chat resume, scroll restoration, stale pending reconciliation, and
  desktop navigation behavior remain intact.
