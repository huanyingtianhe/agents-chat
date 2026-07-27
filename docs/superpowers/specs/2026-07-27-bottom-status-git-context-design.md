# Bottom Status Git Context Placement — Design

## Goal

Move the existing chat git context controls out of the composer area and into the bottom status bar, placing them adjacent to the `agents configured` status text while preserving the current branch/worktree switching behavior.

## Scope

This change is layout-only.

- Keep the current branch selector and worktree selector behavior.
- Keep the same chat-scoped git context data flow and persistence behavior.
- Remove the duplicated composer-row rendering so git context appears in one place only.
- Do not change API shape, git context validation, or session invalidation logic.

## Recommended Approach

Reuse the existing `ComposerGitContextControls` component as a generic git context control block and render it through the bottom status bar via a new slot prop.

This keeps behavior stable while minimizing code movement:

- `ChatPageClient` continues to build the git context control element from `useChatGitContext`.
- `StatusBar` gets a new optional `gitContextSlot` prop and renders it immediately after the left status group.
- `ChatComposer` no longer renders `gitContextControls`.
- Status bar CSS is updated so the left status group and git context controls sit together on desktop and wrap cleanly on smaller screens.

## Component Changes

### `StatusBar`

Add a new optional `gitContextSlot?: ReactNode | null` prop.

Render order:

1. Left status group (`agents configured`)
2. Git context slot
3. Plan slot, if present
4. Right-side target text (`messages`)

This places branch/worktree controls visually next to the agent status, matching the requested location.

### `ChatPageClient`

Keep constructing the git context control block from the existing `useChatGitContext` hook.

Pass that block into `StatusBar` instead of `ChatComposer`.

### `ChatComposer`

Remove the `gitContextControls` prop and the bottom composer git-context row.

The composer returns to input/tool/target controls only.

## Styling

Update bottom status bar layout to support inline controls:

- Keep the left status group compact.
- Allow the git context controls to sit inline beside it on desktop.
- Allow wrapping on narrower widths without overlapping the plan progress bar.
- Keep existing mobile behavior readable by letting the status bar wrap into multiple rows.

The existing git context control styles can stay mostly unchanged, with only minor adjustments if the status bar spacing needs tighter sizing.

## Validation

Manual validation should confirm:

- Branch and worktree selectors no longer appear below the composer.
- Branch and worktree selectors appear in the bottom status bar beside `agents configured`.
- Branch and worktree switching still works.
- Switching chats still restores each chat's saved git context.
- Bottom status bar remains usable with and without an active workflow plan.

## Risks

The main risk is layout crowding in the status bar when plan progress is also visible.

Mitigation:

- Use flexible wrapping layout in the status bar.
- Keep the git context controls compact rather than introducing new UI patterns.
