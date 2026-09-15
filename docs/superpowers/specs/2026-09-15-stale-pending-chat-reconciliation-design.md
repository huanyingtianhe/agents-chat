# Stale Pending Chat Reconciliation Design

## Goal

Automatically convert persisted pending Agent messages to an `Interrupted` terminal state when Chat restoration proves that no corresponding live Agent turn exists.

## Problem

An Agent turn can be persisted with `pending: true` and a status such as `Reading shell output`. If the service or Agent exits before finalization, reloading the Chat can leave that status visible indefinitely even though no command or Agent turn is running.

The existing resume flow restores live turns but does not reconcile pending messages when a saved Agent session returns without a live turn.

## Scope

- Reconcile stale pending messages only for the currently loaded Chat.
- Reconcile only messages belonging to an Agent whose resume request succeeded and returned no unfinished active turn.
- Preserve message content, completed tool parts, timestamps, and Agent attribution.
- Do not add a manual cleanup control.
- Do not modify other Chats in the background.

## Reconciliation Behavior

The session resume effect already queries every Agent session saved for the current Chat. Each fulfilled response is handled independently:

1. If the response contains an unfinished `activeTurn`, retain the existing resume and polling behavior. Do not reconcile that Agent's pending messages.
2. If the response succeeds without an unfinished active turn, reconcile pending messages for that Agent in the current Chat.
3. If the resume request rejects, leave pending messages unchanged because the client cannot prove that the turn ended.

For each reconciled message:

- Set `pending` to `false`.
- Clear transient phase data and user-request state.
- Set the terminal status to `Interrupted`.
- Preserve existing non-empty response content.
- Use `⏹ Interrupted` as the content when no response content exists.
- Preserve existing tool parts so completed diagnostic history remains visible.

After all resume responses are processed, persist the Chat only if reconciliation changed at least one message. Preserve the Chat's existing sidebar order during this write.

## UI Result

No new UI control is required. Once reconciliation completes:

- `Reading shell output` and other stale running labels disappear.
- The message visibly communicates that the turn was interrupted.
- The Chat sidebar no longer reports the Chat as running.
- Reloading the page retains the terminal state.

## Error Handling

A failed resume request must not trigger reconciliation. A failed persistence write must not be represented as a successful durable cleanup; it should follow the existing Chat persistence error path. The in-memory state may show the reconciled result for the current page, but a later reload can retry reconciliation.

## Testing

Add focused coverage for:

- A fulfilled resume with no live turn reconciles only stale pending messages belonging to that Agent.
- A fulfilled resume with an unfinished active turn preserves pending state and starts polling.
- A rejected resume preserves pending state.
- Existing message content and tool parts survive reconciliation.
- Empty pending messages receive `⏹ Interrupted`.
- Reconciliation persists once only when messages changed and preserves Chat ordering.
- Playwright loads a persisted stale Chat, observes `Interrupted` instead of `Reading shell output`, reloads, and verifies the terminal state remains.

## Acceptance Criteria

- A stale `Reading shell output` state automatically disappears after the Chat resume check succeeds without a live turn.
- A genuinely live turn is never marked interrupted.
- A resume failure does not destroy uncertain state.
- Historical message and tool output content is preserved.
- The reconciled state survives a page reload.
