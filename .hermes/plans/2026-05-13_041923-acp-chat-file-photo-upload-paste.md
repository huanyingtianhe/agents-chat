# ACP Chat File/Photo Upload and Paste Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Let ACP chat users attach files and photos from an upload button, drag/drop, and clipboard paste, then send them to ACP agents as structured content parts rather than plain text only.

**Architecture:** Add an attachment model shared between frontend chat messages, persisted chat storage, and `/api/acp` send handling. The frontend stores selected/pasted files in local component state, previews/removes them in the composer, and sends them with the user message. The backend validates/normalizes attachment payloads and converts them into ACP `session/prompt` parts: text parts plus image/file resource parts when the agent supports them, with a safe markdown fallback when not.

**Tech Stack:** Next.js App Router, React client component in `app/page.tsx`, TypeScript, `/api/acp` route, SQLite chat storage in `lib/chatStore.ts`, Playwright E2E tests, Node API/source tests.

---

## Current context / discoveries

- Repo is on Windows Q: drive and is accessible in WSL at `/mnt/q/repos/Agents-Chat`.
- Main chat UI is a large client component: `app/page.tsx`.
- Composer is at `app/page.tsx:4745-4856`; current `<textarea>` has no `onPaste`, no hidden file input, and send is disabled when `!input.trim()`.
- Send flow:
  - `handleSend()` at `app/page.tsx:3360` trims text, adds a user `ChatMessage`, clears input, and calls `dispatchParsedPrompt()`.
  - `dispatchParsedPrompt()` routes to one/multiple agents and calls `dispatchToAgent()`.
  - `sendAcpPrompt()` builds body `{ action: 'send', agentId, text, chatId, messageId }` and posts to `/api/acp`.
- Backend ACP route: `app/api/acp/route.ts`.
  - `action === 'send'` at `route.ts:2067` reads `body.text`, validates it, and calls `sendPrompt(...)`.
  - `sendPrompt()` at `route.ts:1125` currently sends only `prompt: [{ type: 'text', text: prompt }]` to `session/prompt` and repeats that text-only shape on recovery retry.
- Chat persistence type is `StoredMessage` in `lib/chatStore.ts:14-29`; it currently has `content`, `parts`, `userRequest`, send failure metadata, but no attachment field.
- User preference/memory: UX changes should include Playwright E2E tests; backend/API changes should include API tests. This feature crosses both frontend and backend, so include both.

## Assumptions to confirm during implementation

- ACP agents accept prompt parts broadly compatible with `type: 'text'`, `type: 'image'`, and `type: 'resource'`/`resource` style parts. Because implementations may differ, the backend should isolate part construction in one helper and include a text fallback that names each attachment.
- First implementation should support moderate attachment sizes inline as `data:` URLs / base64 payloads to avoid adding object storage. Add client and server limits to prevent huge JSON payloads.
- Photos/images are rendered inline in chat bubbles; non-images are shown as file chips with name, MIME, and size.
- Upload button, drag/drop, and paste all feed the same attachment queue.

## Data model

Create one shared conceptual shape; implement in both frontend and backend types:

```ts
type ChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  kind: 'image' | 'file';
};
```

Rules:
- `kind === 'image'` when `mimeType.startsWith('image/')`.
- `dataUrl` must be `data:<mime>;base64,<payload>`.
- Keep per-file and aggregate byte limits in constants. Suggested defaults:
  - `MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024`
  - `MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024`
  - `MAX_ATTACHMENTS = 8`
- Preserve attachment metadata in chat history so sent messages remain visible after reload.

---

## Task 1: Add attachment types and storage metadata

**Objective:** Extend chat/frontend/backend message types so attachments can be represented and persisted.

**Files:**
- Modify: `app/page.tsx` near `ContentPart` / `ChatMessage` types (`:292`, `:386`)
- Modify: `lib/chatStore.ts:14-29`
- Test: no standalone test yet; covered by later E2E/API tests

**Steps:**
1. Add `ChatAttachment` type near `ContentPart` in `app/page.tsx`.
2. Add `attachments?: ChatAttachment[]` to `ChatMessage`.
3. Add exported `StoredAttachment` type in `lib/chatStore.ts` and `attachments?: StoredAttachment[]` to `StoredMessage`.
4. In `app/api/acp/route.ts`, import/use compatible attachment type or define a local `PromptAttachment` type.
5. Run `npx tsc --noEmit` after later tasks; this task alone may expose missing render/use code until completed.

## Task 2: Add frontend file reading helpers with validation

**Objective:** Convert uploaded, dropped, and pasted `File` objects into bounded `ChatAttachment[]`.

**Files:**
- Modify: `app/page.tsx` helper section around `makeId()` / utility functions

**Implementation details:**
Add constants and helpers:

```ts
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function getAttachmentKind(mimeType: string): ChatAttachment['kind'] {
  return mimeType.startsWith('image/') ? 'image' : 'file';
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}
```

Add an async `filesToAttachments(files: File[], existing: ChatAttachment[])` helper that:
- rejects/returns a user-visible error when count/size limits are exceeded,
- keeps file name, MIME fallback `application/octet-stream`, byte size,
- returns stable `id: attachment-${makeId()}`.

## Task 3: Add attachment composer state and upload button

**Objective:** Let users select files/photos using a button in the composer.

**Files:**
- Modify: `app/page.tsx:729-866` state/ref area
- Modify: `app/page.tsx:4745-4856` composer JSX
- Modify: `app/page.tsx:6416-6581` composer CSS

**Steps:**
1. Add state:
   ```ts
   const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
   const [attachmentError, setAttachmentError] = useState<string | null>(null);
   const fileInputRef = useRef<HTMLInputElement | null>(null);
   ```
2. Add handlers:
   - `addFilesToComposer(fileList: FileList | File[])`
   - `removeAttachment(id: string)`
   - `clearAttachments()`
3. Add a hidden file input:
   ```tsx
   <input
     ref={fileInputRef}
     type="file"
     multiple
     accept="image/*,.pdf,.txt,.md,.csv,.json,.yaml,.yml,.html,.htm,.js,.ts,.tsx,.py"
     className="srOnlyFileInput"
     onChange={(e) => { void addFilesToComposer(e.currentTarget.files || []); e.currentTarget.value = ''; }}
   />
   ```
4. Add a paperclip/photo button before the textarea or in `.composerActions`:
   - `aria-label="Attach files or photos"`
   - `title="Attach files or photos"`
5. Update send button disabled state to allow attachment-only prompts:
   ```tsx
   disabled={agents.length === 0 || (!input.trim() && attachments.length === 0)}
   ```
6. Add CSS for upload button, hidden input, error text.

## Task 4: Add preview chips/thumbnails and remove controls

**Objective:** Show selected attachments before send and let users remove them.

**Files:**
- Modify: `app/page.tsx` composer JSX/CSS

**Steps:**
1. Above `.composerRow`, render `.attachmentTray` when `attachments.length > 0`.
2. For images, render a thumbnail:
   ```tsx
   <img src={attachment.dataUrl} alt={attachment.name} className="attachmentThumb" />
   ```
3. For non-images, render a file icon + name + human size.
4. Add remove button:
   - `aria-label={`Remove ${attachment.name}`}`
5. Show `attachmentError` in a compact warning line; clear it when files are added/removed successfully.

## Task 5: Support clipboard paste for files/photos

**Objective:** Pasting an image/file from clipboard queues it as an attachment; pasting normal text continues to work.

**Files:**
- Modify: `app/page.tsx:4795-4846` textarea

**Steps:**
1. Add `onPaste` to the composer textarea.
2. In handler:
   - inspect `e.clipboardData.files` first,
   - also inspect `e.clipboardData.items` for `kind === 'file'` and `getAsFile()` (important for screenshots/images on Windows/macOS),
   - if at least one file is found, `preventDefault()` and call `addFilesToComposer(files)`.
   - if no files, do nothing so normal text paste remains native.
3. Consider duplicate files in both `files` and `items`; de-dupe by `name:size:type:lastModified` where available.

## Task 6: Support drag/drop on the composer

**Objective:** Dropping files/photos onto the composer queues them as attachments.

**Files:**
- Modify: `app/page.tsx` composer shell JSX/CSS

**Steps:**
1. Add drag state `isDraggingAttachment`.
2. Add `onDragOver`, `onDragLeave`, `onDrop` to `.composerShell`.
3. Only call `preventDefault()` when `dataTransfer.types` includes `Files`.
4. On drop, call `addFilesToComposer(e.dataTransfer.files)`.
5. Add visual highlight class `composerShell dragOver`.

## Task 7: Render sent message attachments in chat history

**Objective:** Sent attachments remain visible in user message bubbles and persisted chat messages.

**Files:**
- Modify: `app/page.tsx` message rendering section (locate `.message.user` render loop)

**Steps:**
1. Find where `visibleMessages.map(...)` renders `message.content`.
2. Add `renderMessageAttachments(message.attachments)` below text content for user messages (and optionally for system/agent if future data exists).
3. Add CSS `.messageAttachments`, `.messageAttachmentImage`, `.messageAttachmentFile`.
4. Ensure `getMessageCopyText()` remains text-only; attachments should not pollute clipboard copy.

## Task 8: Send attachments through frontend dispatch flow

**Objective:** Include attachments in user message, persistence, ACP API request, resend, and orchestration flows.

**Files:**
- Modify: `app/page.tsx:3278-3387`
- Modify: `app/page.tsx:2682` `sendAcpPrompt()`

**Steps:**
1. Extend `DispatchToAgentOptions` or function parameters to carry `attachments?: ChatAttachment[]`.
2. Update `dispatchParsedPrompt(...)` signature to accept `attachments` and pass through to every `dispatchToAgent`/orchestration start.
3. Update `dispatchToAgent(...)` signature to pass attachments to `sendAcpPrompt`.
4. Update `sendAcpPrompt(...)` to add `attachments` to `sendBody` only when non-empty.
5. In `handleSend()`:
   - allow send if `text || attachments.length`.
   - copy `const sendAttachments = attachments;`
   - create user message `{ type: 'user', content: text, attachments: sendAttachments }`.
   - clear both `input` and `attachments` after adding message.
6. For attachment-only messages, set effective text fallback such as:
   ```ts
   const textForAgent = text || 'Please review the attached file(s).';
   ```
7. Update send failure/resend metadata:
   - Add `resendAttachments?: ChatAttachment[]` to `ChatMessage` if needed, or reuse `attachments` on failed user message.
   - `resendFailedUserMessage()` should pass original attachments again.
8. Orchestration: every mentioned agent should receive the same attachments for the initial user task. Scheduler should receive text-only if possible; if attachment-only, include a textual summary of attachment names to decide routing.

## Task 9: Backend validate attachments and build ACP prompt parts

**Objective:** `/api/acp` accepts attachments safely and sends structured prompt parts to ACP.

**Files:**
- Modify: `app/api/acp/route.ts`
- Test: create API/source test in Task 11

**Implementation details:**
1. Add backend constants matching frontend limits.
2. Add local type:
   ```ts
   type PromptAttachment = {
     id?: string;
     name: string;
     mimeType: string;
     size: number;
     dataUrl: string;
     kind?: 'image' | 'file';
   };
   ```
3. Add `normalizePromptAttachments(raw: unknown): PromptAttachment[]`:
   - require array,
   - cap count/total/per-file size,
   - verify `dataUrl` prefix and base64 shape,
   - reject invalid items with `400` and clear error messages like `invalid_attachments`, `attachment_too_large`, `too_many_attachments`.
4. Add `buildPromptParts(text: string, attachments: PromptAttachment[])` helper. Suggested shape:
   ```ts
   type AcpPromptPart =
     | { type: 'text'; text: string }
     | { type: 'image'; mimeType: string; data: string; name?: string }
     | { type: 'resource'; mimeType: string; data: string; name: string };
   ```
   Extract `data` as base64 payload from `dataUrl`.
5. Include a text part listing attachments before structured parts:
   ```ts
   const attachmentSummary = attachments.map(a => `- ${a.name} (${a.mimeType}, ${formatBytes(a.size)})`).join('\n');
   ```
   This helps agents that ignore binary/resource parts still see context.
6. Change `sendPrompt()` signature from `prompt: string` to `prompt: string, attachments?: PromptAttachment[]` and use `buildPromptParts(prompt, attachments)` in both initial send and recovery retry.
7. In recovery context injection, append attachment summary and reuse the same structured parts.
8. In `action === 'send'`, allow `text` to be empty if attachments exist:
   ```ts
   const attachments = normalizePromptAttachments(body?.attachments);
   if (!text && attachments.length === 0) return ...missing_text...
   ```

## Task 10: Persist attachments with chat messages and active turn recovery

**Objective:** Attachments survive reload and do not break chat history serialization.

**Files:**
- Modify: `lib/chatStore.ts`
- Modify: `app/page.tsx` save/persist helpers if they filter fields
- Modify: `app/api/acp/route.ts` only if agent turn snapshots should refer to attachments (usually no)

**Steps:**
1. Verify `saveChatToHistory()` in `app/page.tsx` serializes full `ChatMessage` objects. If it maps fields manually, add `attachments`.
2. Verify `getPersistableMessages()` does not strip attachment fields; currently it filters only transient system messages.
3. Keep agent turn snapshots attachment-free unless future agent messages include generated files.
4. Ensure share page (`app/share/[id]/page.tsx`) either ignores or renders attachments; at minimum it must not crash when shared messages contain `attachments`.

## Task 11: Add backend/API regression tests

**Objective:** Guard `/api/acp` attachment behavior and prompt part construction.

**Files:**
- Create: `test/acp-attachments-api.test.mjs`
- Optionally modify: package scripts if a test script is later added

**Preferred test shape:** If a lightweight real route harness exists, use it. If not, add a focused source-level test now and note follow-up to create real API harness.

Assertions:
- `route.ts` defines `normalizePromptAttachments` and size/count constants.
- `action === 'send'` reads `body.attachments` and allows attachment-only messages.
- `sendPrompt` receives attachments.
- both initial `session/prompt` and retry `session/prompt` call `buildPromptParts(...)`, not raw `[{ type: 'text', text: ... }]`.
- invalid attachments return 400 with explicit errors.

Command:
```bash
node test/acp-attachments-api.test.mjs
```

Expected: prints `acp attachment checks passed`.

## Task 12: Add Playwright E2E for upload and paste

**Objective:** Verify the user-facing file/photo workflows.

**Files:**
- Modify: `test/test-ui.spec.ts`

**Test 1: upload button queues and sends image attachment**
1. Route `/api/acp`:
   - `list-agents` returns one fake agent.
   - `send` captures request body and returns `{ ok: true, sessionId: 's1', turn: { id: 't1' } }` or compatible minimal turn.
   - `poll` returns done response.
2. Use `setInputFiles` on hidden file input or button-triggered chooser with a small generated PNG buffer.
3. Assert thumbnail/chip appears with file name.
4. Type text and click Send.
5. Assert user message contains attachment preview.
6. Assert captured `/api/acp` body has `attachments[0]` with `mimeType: 'image/png'`, `dataUrl` beginning `data:image/png;base64,`.

**Test 2: paste screenshot queues attachment without pasting text**
1. Focus `textarea[placeholder="Message Agents Chat"]`.
2. Dispatch a synthetic `ClipboardEvent('paste')` with a `DataTransfer` containing an image `File`.
3. Assert attachment chip/thumbnail appears.
4. Assert textarea text remains unchanged unless explicit text was also provided.

**Test 3: attachment-only send is allowed**
1. Queue one attachment.
2. Assert send button is enabled while textarea is empty.
3. Send and assert request text is fallback (`Please review the attached file(s).`) and attachments are present.

Command:
```bash
PLAYWRIGHT_BASE_URL=https://localhost:3010 NODE_TLS_REJECT_UNAUTHORIZED=0 \
  npx playwright test --config test/playwright.config.ts test/test-ui.spec.ts --grep "attachment|paste" --reporter=line
```

## Task 13: Type/build validation

**Objective:** Ensure no TypeScript/build regressions.

**Files:** all changed files

**Commands:**
```bash
npx tsc --noEmit
npm run build
git diff --check -- app/page.tsx app/api/acp/route.ts lib/chatStore.ts test/test-ui.spec.ts test/acp-attachments-api.test.mjs
```

Expected:
- TypeScript passes.
- Build passes.
- Diff check has no whitespace errors.

## Task 14: Manual smoke test on Windows-hosted repo

**Objective:** Verify browser behavior in the actual Windows Q: repo environment.

**Steps:**
1. Start dev server from WSL in `/mnt/q/repos/Agents-Chat`:
   ```bash
   NEXT_PUBLIC_E2E_TESTS=1 npm run dev
   ```
2. Open `https://localhost:3010`.
3. Test upload button with:
   - a PNG/JPG photo,
   - a small text/markdown file.
4. Test Windows clipboard paste:
   - Snipping Tool screenshot copied to clipboard,
   - copied file from Explorer if browser exposes it.
5. Test drag/drop from Windows Explorer into composer.
6. Send to a known image-capable agent and verify it receives/mentions the attachment.

## Risks / tradeoffs

- **ACP part schema variance:** Different ACP implementations may expect different binary part names (`image`, `resource`, `blob`, or `content`). Mitigation: isolate in `buildPromptParts()` and include a text summary fallback.
- **Large payloads:** Inline base64 increases JSON size. Mitigation: strict limits now; future improvement can add server-side attachment storage and references.
- **Clipboard browser differences:** Pasted files may appear in `clipboardData.items` but not `.files`. Handle both.
- **Persistence bloat:** Storing data URLs in SQLite can grow quickly. Current limits reduce risk. Future improvement: store attachments under `.data/attachments/` and persist URLs/ids.
- **Orchestration with attachments:** Scheduler may not need binary data. Initial plan sends attachments to real worker agents and text summaries to routing-only scheduler where practical.
- **Share/export behavior:** Shared chats may expose embedded base64 files. Review privacy expectations before expanding share rendering.

## Verification checklist

- [ ] Upload button selects multiple files/photos.
- [ ] Pasted screenshot queues as image attachment.
- [ ] Drag/drop queues files/photos.
- [ ] Text paste still works normally.
- [ ] Attachment-only send is allowed.
- [ ] User message previews attachments before and after reload.
- [ ] `/api/acp` receives and validates attachments.
- [ ] ACP `session/prompt` uses structured prompt parts for images/files.
- [ ] Failed-send retry preserves attachments.
- [ ] Playwright E2E covers upload/paste/attachment-only send.
- [ ] Backend/API regression covers prompt part construction and validation.
- [ ] `npx tsc --noEmit`, `npm run build`, and `git diff --check` pass.
