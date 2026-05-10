# Path-scoped comment review chats

## Problem

Approving a file comment currently creates a linked comment chat, but the frontend dispatches the agent request into the current user chat. The agent can finish in that normal chat while the comment remains linked to a different chat, so the comment can stay in `processing`.

The desired behavior is to keep normal user conversations separate from file review work. All approved comments for the same file path should appear in one dedicated review chat and reuse that chat's normal ACP session. Comments are handled one by one, not in parallel.

## Approved approach

Use one normal review chat per file path. Treat approved comments as normal user messages in that chat.

- The visible review chat is keyed by file path, not by the user's current chat.
- The chat name is stable and readable, such as `Review: app/page.tsx`.
- Approving a comment appends a new user prompt to that path's review chat.
- Approve is the processing trigger. There is no separate "Process all" action in this design.
- The comment is linked to the path review chat for navigation.
- Agent execution uses the review chat's normal ACP session, stored in `chats.agent_sessions`.
- The user can open the review chat and continue talking with the agent in the same session.
- A review chat processes only one active turn at a time. If a comment is already processing for that file, additional approvals become queued and are sent automatically when earlier work finishes.

## Data model

File comments already have `linked_chat_id`. Keep it as the path review chat id.

No separate job table or per-comment ACP session storage is needed. The review chat uses the existing `chats.agent_sessions` storage, the same as normal chats.

Comment `status` uses `active`, `queued`, `processing`, and `resolved`.

- `active`: waiting for user action.
- `queued`: approved, linked to the review chat, waiting for the chat/session to become idle.
- `processing`: currently sent to the agent in the review chat.
- `resolved`: finished or rejected.

The review chat id is deterministic from the file path so repeated approvals for the same path reuse the same chat. The key is path-only, matching the approved behavior. If two agents expose the same file path, their approved comments share the same review chat.

## Approval flow

1. User clicks Approve on a comment.
2. `/api/comments/approve` loads the comment and builds the prompt from the comment plus nearby file context.
3. The server gets or creates the path review chat for `comment.filePath`.
4. The server sets `linked_chat_id` to the path review chat id.
5. If the review chat is idle, the server appends the prompt as a user message in that review chat and marks the comment `processing`.
6. If the review chat is busy, the server marks the comment `queued`. The prompt is appended later when the queued comment starts, so chat message order stays natural.
7. The frontend refreshes/patches the chat list. For `processing` approvals, it dispatches the agent request into the returned path review chat id, not the current user chat.
8. When the agent run finishes for that review chat, the frontend updates the currently processing comment for that review chat from `processing` to `resolved`.
9. After resolving a processing comment, the frontend or API starts the oldest queued comment for that same review chat: append its prompt, change it to `processing`, and dispatch it into the same ACP session.
10. Manual user messages in the review chat use the same chat/session and do not change comment status unless there is a linked processing comment. If a manual turn is active, queued comments wait until it finishes.

## Processing model

The review chat intentionally does not support parallel comment processing. It behaves like a normal chat: one active agent turn per chat/session.

- If no turn is active in the review chat, approving a comment immediately sends it to the agent.
- If a turn is active in the review chat, approving another comment queues it.
- Queued comments are processed oldest-first within the review chat.
- Because only one comment can be `processing` for a review chat at a time, completion can resolve the processing comment linked to that review chat.

## Error handling

- If approval cannot create or update the review chat, return an explicit API error and leave the comment `active`.
- If dispatch fails, show the agent error in the review chat and return the comment to `active` so the user can retry.
- If polling times out or loses connection, mark the processing comment back to `active` and append a visible error message to the review chat; do not resolve it silently.
- If starting the next queued comment fails, leave that comment `queued` and show a visible error message in the review chat/sidebar.
- Clicking a queued or processing comment switches to Chats and opens the path review chat.

## Testing

Add API coverage for approving two comments on the same file path:

- both approvals return the same review chat id
- after the first comment is resolved, the second approval appends another user prompt to the same review chat

Add API or UI coverage for same-file queuing:

- the second approval becomes `queued` while another comment in that review chat is processing
- when the first comment finishes, the queued comment becomes `processing`

Add UI coverage for the stuck-processing regression:

- approve a comment while another normal chat is current
- verify the agent dispatch targets the returned review chat instead of the current chat
- simulate run completion and verify the processing comment resolves

Add UI coverage for same-file reuse:

- approve a second comment while the first is processing
- verify both comment prompts are in the same review chat

## Out of scope

- Cross-file review chats.
- Parallel comment processing.
- Merging or deduplicating comments with identical text.
- Automatically applying code changes from the review chat.
- Production build verification for this change.
