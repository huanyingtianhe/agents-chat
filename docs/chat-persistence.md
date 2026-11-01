# Chat persistence

How the browser saves chat history and recovers unsaved messages. For the short
operator/user summary, see "Chat persistence" in the README.

The browser saves only new or changed messages. Small updates are batched below
512 KiB; individually larger messages, attachments, and ACP prompt/context
payloads use resumable 256 KiB binary chunks (about 350 KiB per JSON request).
The final save/send request contains a small upload reference. Nginx's default
1 MiB request limit therefore does not require increasing. ACP tool and thinking
parts remain server-owned and are not uploaded back by the browser.

Before clearing the composer, saves enter an IndexedDB outbox scoped to the
authenticated user and application chat ID, not the rotating ACP session ID.
User messages must also be confirmed by the server before agent dispatch.
Network requests time out after 30 seconds; retries reuse the same immutable
operation ID. Successful commits and their receipts are atomic, so a lost
acknowledgement does not duplicate messages. Refresh/online recovery retries
pending saves, **never agent execution**. Use the message's **Retry** action
explicitly when you want to send a recovered question to an agent.
Interrupted sends retain a pending-confirmation state even in chats with existing
agent sessions; recovery exposes Retry with a warning to check existing replies.
This includes replies sent from the workflow follow-up card.
Only the submitted composer revision and attachments are cleared after local
staging, so typing the next message while storage is busy does not erase it.
Navigation cancels active save requests without discarding unconfirmed drafts.
Recovery adopts newer server revisions and ignores stale reads that would move
the confirmed message version backwards.

The local drafts panel provides server/local comparison, JSON download (including
attachments), discard, and **Save as new message**.
Recovery copies reuse a durable operation associated with the source draft,
including when their acknowledgement is lost. Attachment-only copies retain
their retry prompt and original agent selection.
Switching accounts isolates both drafts and recovery error/busy state; delayed
callbacks from the previous account cannot consume drafts or replace the current
conversation with their response.
Different message IDs merge; conflicting edits to the same ID are retained locally rather than silently
overwriting another device. Deleted chats have persistent tombstones: delayed
saves cannot resurrect them, and recovered copies use a new chat ID. Same-browser
tabs coordinate uploads with renewable 60-second IndexedDB leases; server version
checks and idempotency remain authoritative across devices.

Each serialized upload is limited to 64 MiB; existing attachment limits still
apply (8 files, 10 MiB each, 25 MiB total before Base64 encoding). Incomplete
uploads expire after 24 hours, with at most 128 uploads / 256 MiB reserved per user.
Successful clients release uploads after acknowledgement. Browser storage
availability/quota failures are explicit: keep the tab open and copy/download
the message if local storage is unavailable. Clearing browser data also deletes
unsynced drafts. HTTPS or localhost is required for browser cryptographic upload
checksums. This change does not recover messages already missing from the database.
