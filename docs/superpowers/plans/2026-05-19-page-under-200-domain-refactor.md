# Page Under 200 Domain Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `app/page.tsx` below 200 lines by splitting the chat page into focused domain modules without creating a new giant replacement file.

**Architecture:** Keep `app/page.tsx` as a tiny route shell and add `app/features/chat/ChatPageClient.tsx` as a small composition component. Move runtime orchestration, message rendering, file workspace/comments, agent/node panels, and shared layout into focused modules with explicit typed props and adjacent plain CSS imported from `app/layout.tsx`.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict mode, plain global CSS, Node source-shape tests, Playwright E2E.

---

## Scope check

The approved spec spans multiple domains, so execution must be staged as independently reviewable domain slices. Each committed task keeps the app compiling and behavior unchanged. The final `<200` line-count guard is written first to clarify the target, but it stays uncommitted until the final slice passes.

## Refactor rules

- Do not create a single `ChatApp.tsx`, `LegacyPage.tsx`, `PageImplementation.tsx`, or equivalent giant replacement.
- Preserve existing class names, `data-testid` values, keyboard behavior, persistence keys, ACP request shapes, and error surfacing.
- Move code by copy/paste or editor refactor first, then repair imports and types. Avoid rewriting behavior while moving it.
- Keep new TS/TSX files under 500 lines. If a file approaches that limit, split by responsibility before committing.
- Keep `app/features/chat/ChatPageClient.tsx` under 300 lines.
- Import adjacent plain CSS files from `app/layout.tsx`, not from arbitrary client components.
- Do not commit failing tests. If a step creates a failing guard before implementation, leave it unstaged until the matching implementation passes.

## File structure

### Route and composition

- Modify: `app/page.tsx`
  - Final responsibility: route shell only.
- Create: `app/features/chat/ChatPageClient.tsx`
  - Final responsibility: small client-side composition of runtime hooks and domain components.

### Chat runtime

- Create: `app/features/chat/runtime/chatRuntimeTypes.ts`
  - Shared runtime state/callback contracts used by `ChatPageClient` and domain components.
- Create: `app/features/chat/runtime/chatRunLoop.ts`
  - Pure helpers for ACP turn progress, scheduler/auto mode routing, failed-send state, and run result normalization.
- Create: `app/features/chat/runtime/sessionPersistence.ts`
  - Pure helpers for chat/session persistence payloads and local storage key reads/writes.
- Create: `app/features/chat/runtime/useAgentRegistry.ts`
  - Agent loading, model selection, remembered chat agents, selected agent filter, and agent health/status state.
- Create: `app/features/chat/runtime/useChatRuntime.ts`
  - Chat messages, chat history, current chat selection, send/resend/stop, ACP dispatch, streaming updates, prompt failure handling, and session resume.
- Modify: `app/features/chat/chatTypes.ts`
  - Add or reuse shared exported types only when the type is not runtime-specific.
- Modify: `app/features/chat/chatHelpers.ts`
  - Keep pure chat helpers here; move page-local runtime helpers only if they are reusable.
- Modify: `app/features/chat/chatApi.ts`
  - Keep HTTP wrapper behavior unchanged.

### Messages

- Create: `app/features/messages/messageTypes.ts`
  - UI-only message rendering prop types that are not chat runtime state.
- Create: `app/features/messages/markdownHelpers.tsx`
  - `markdownToHtml`, `stripMarkdownSyntaxForSearch`, HTML file path linkification, and ReactMarkdown component overrides currently in `app/page.tsx`.
- Create: `app/features/messages/components/MessageList.tsx`
  - Message iteration, empty/welcome state wiring, copy/collapse/failure action placement.
- Create: `app/features/messages/components/MessageBubble.tsx`
  - Single message wrapper, avatar/header, action row, collapsed state.
- Create: `app/features/messages/components/MessageContentParts.tsx`
  - Text/image/file/tool content part rendering and streaming content display.
- Create: `app/features/messages/components/AgentUserRequestCard.tsx`
  - Agent user request cards and answer controls.
- Create: `app/features/messages/components/MessageToolCall.tsx`
  - Tool execution summaries currently rendered inside `app/page.tsx`.
- Create: `app/features/messages/components/MessageList.css`
  - Message list, bubble, markdown, action row, request card, and tool-call styles moved from `app/page.tsx`.
- Modify: `app/layout.tsx`
  - Import `./features/messages/components/MessageList.css`.

### Files and comments

- Modify: `app/features/files/fileWorkspaceTypes.ts`
  - Move `FileComment`, `FileCommentReply`, `LiveSelectionDraftAnchor`, `LiveEditorSelectionSnapshot`, `LiveCommentMarker`, and `CommentAddRange` from `app/page.tsx`.
- Modify: `app/features/files/fileWorkspaceHelpers.ts`
  - Move markdown/file editor pure helpers such as live-edit markdown conversion helpers only when they are independent of React state.
- Create: `app/features/files/hooks/useFileWorkspaceState.ts`
  - File workspace state, active file, editor mode, diff/conflict state, tree selection, and workspace persistence.
- Create: `app/features/files/hooks/useFileComments.ts`
  - Comment list, active comment, reply draft, resolve/reopen/queue/process actions, review chat linkage, and comment persistence.
- Create: `app/features/files/hooks/useLiveEditorSelection.ts`
  - Live editor text selection, selection anchor measurement, comment marker positioning, and selection cleanup.
- Create: `app/features/files/components/FileWorkspacePanel.tsx`
  - Files tab composition and bridge to file hooks.
- Create: `app/features/files/components/FileTreePanel.tsx`
  - File tree/search/action list UI.
- Create: `app/features/files/components/FileEditorPanel.tsx`
  - Editor/preview/live-edit/diff/conflict UI.
- Create: `app/features/files/components/FileCommentSidebar.tsx`
  - Comment sidebar, comment cards, reply forms, and review action controls.
- Create: `app/features/files/components/FileWorkspacePanel.css`
  - File workspace, editor, diff, comment sidebar, live marker, and review styles moved from `app/page.tsx`.
- Modify: `app/layout.tsx`
  - Import `./features/files/components/FileWorkspacePanel.css`.

### Agents and nodes

- Create: `app/features/agents/hooks/useAgentPanelState.ts`
  - Add-agent form, remote/relay fields, model settings panel state, and validation/error state.
- Create: `app/features/agents/components/AgentsPanel.tsx`
  - Agent list panel, add-agent modal/content, remote agent form, relay agent form, and model settings surface.
- Create: `app/features/agents/components/AgentsPanel.css`
  - Agent panel styles moved from `app/page.tsx`.
- Create: `app/features/nodes/hooks/useNodePanelState.ts`
  - Node list/setup/edit form state and node API action wiring.
- Create: `app/features/nodes/components/NodesPanel.tsx`
  - Nodes panel, setup/edit modal content, and node status UI.
- Create: `app/features/nodes/components/NodesPanel.css`
  - Node panel styles moved from `app/page.tsx`.
- Modify: `app/layout.tsx`
  - Import agent and node panel CSS.

### Layout and modals

- Create: `app/features/layout/components/ChatShell.tsx`
  - Overall shell markup: sidebars, main panel, right panel slots, mobile panel state wiring, and composer slot.
- Create: `app/features/layout/components/PageHeader.tsx`
  - Header actions, auth display, sign-out button, chat title display, and share entry point.
- Create: `app/features/layout/components/StatusBar.tsx`
  - Runtime status, pty phase text, active target summary, and compact status display.
- Create: `app/features/layout/components/ThemeMenu.tsx`
  - Theme menu UI using existing theme IDs and labels.
- Create: `app/features/layout/components/ShareDialog.tsx`
  - Share dialog UI and copied-link state.
- Create: `app/features/layout/components/ImageLightbox.tsx`
  - Image preview lightbox.
- Create: `app/features/layout/components/ChatShell.css`
  - Shell, header, panels, status bar, mobile overlay, theme menu, share dialog, and lightbox styles moved from `app/page.tsx`.
- Modify: `app/layout.tsx`
  - Import `./features/layout/components/ChatShell.css`.

### Tests

- Create: `test/page-under-200-domain-refactor.test.mjs`
  - Final source-shape guard.
- Modify: existing source tests when imports move:
  - `test/page-shell-targeted-refactor.test.mjs`
  - `test/composer-layout.test.mjs`
  - `test/failed-send-actions-layout.test.mjs`
  - `test/layered-refactor-structure.test.mjs`

---

### Task 1: Add the final source-shape guard, but do not commit it yet

**Files:**
- Create: `test/page-under-200-domain-refactor.test.mjs`

- [ ] **Step 1: Write the failing source-shape test**

Create `test/page-under-200-domain-refactor.test.mjs` with this content:

```js
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function lineCount(relativePath) {
  return read(relativePath).split(/\r?\n/).length;
}

function listFiles(relativeDir, predicate) {
  const dir = join(root, relativeDir);
  const results = [];
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    const relative = join(relativeDir, entry).replaceAll('\\', '/');
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      results.push(...listFiles(relative, predicate));
    } else if (predicate(relative)) {
      results.push(relative);
    }
  }
  return results;
}

const pageSource = read('app/page.tsx');
const layoutSource = read('app/layout.tsx');
const clientPath = 'app/features/chat/ChatPageClient.tsx';

assert.ok(lineCount('app/page.tsx') < 200, `app/page.tsx must stay below 200 lines; found ${lineCount('app/page.tsx')}`);
assert.ok(existsSync(join(root, clientPath)), 'ChatPageClient.tsx must exist as the top-level client composition component');
assert.ok(lineCount(clientPath) < 300, `ChatPageClient.tsx must stay below 300 lines; found ${lineCount(clientPath)}`);

assert.match(pageSource, /import \{ ChatPageClient \} from '\.\/features\/chat\/ChatPageClient';/);
assert.match(pageSource, /<ChatPageClient \/>/);
assert.doesNotMatch(pageSource, /useState|useEffect|useCallback|useMemo|ReactMarkdown|TurndownService|acpApi|ChatComposer|ChatSidebarList|FailedSendActions/);

const forbiddenReplacementNames = [
  'app/features/chat/ChatApp.tsx',
  'app/features/chat/LegacyPage.tsx',
  'app/features/chat/PageImplementation.tsx',
  'app/features/chat/ChatPageImplementation.tsx',
];

for (const relativePath of forbiddenReplacementNames) {
  assert.equal(existsSync(join(root, relativePath)), false, `${relativePath} would be a giant replacement anti-pattern`);
}

const guardedNewCodeFiles = [
  'app/features/chat/ChatPageClient.tsx',
  'app/features/chat/runtime/chatRuntimeTypes.ts',
  'app/features/chat/runtime/chatRunLoop.ts',
  'app/features/chat/runtime/sessionPersistence.ts',
  'app/features/chat/runtime/useAgentRegistry.ts',
  'app/features/chat/runtime/useChatRuntime.ts',
  'app/features/messages/messageTypes.ts',
  'app/features/messages/markdownHelpers.tsx',
  'app/features/messages/components/AgentUserRequestCard.tsx',
  'app/features/messages/components/MessageBubble.tsx',
  'app/features/messages/components/MessageContentParts.tsx',
  'app/features/messages/components/MessageList.tsx',
  'app/features/messages/components/MessageToolCall.tsx',
  'app/features/files/hooks/useFileWorkspaceState.ts',
  'app/features/files/hooks/useFileComments.ts',
  'app/features/files/hooks/useLiveEditorSelection.ts',
  'app/features/files/components/FileWorkspacePanel.tsx',
  'app/features/files/components/FileTreePanel.tsx',
  'app/features/files/components/FileEditorPanel.tsx',
  'app/features/files/components/FileCommentSidebar.tsx',
  'app/features/agents/hooks/useAgentPanelState.ts',
  'app/features/agents/components/AgentsPanel.tsx',
  'app/features/nodes/hooks/useNodePanelState.ts',
  'app/features/nodes/components/NodesPanel.tsx',
  'app/features/layout/components/ChatShell.tsx',
  'app/features/layout/components/PageHeader.tsx',
  'app/features/layout/components/StatusBar.tsx',
  'app/features/layout/components/ThemeMenu.tsx',
  'app/features/layout/components/ShareDialog.tsx',
  'app/features/layout/components/ImageLightbox.tsx',
];

for (const relativePath of guardedNewCodeFiles) {
  assert.ok(existsSync(join(root, relativePath)), `${relativePath} must exist`);
  assert.ok(lineCount(relativePath) <= 500, `${relativePath} must stay at or below 500 lines; found ${lineCount(relativePath)}`);
}

const allNewFeatureCode = [
  ...listFiles('app/features/chat/runtime', (path) => /\.(ts|tsx)$/.test(path)),
  ...listFiles('app/features/messages', (path) => /\.(ts|tsx)$/.test(path)),
  ...listFiles('app/features/files/hooks', (path) => /\.(ts|tsx)$/.test(path)),
  ...listFiles('app/features/files/components', (path) => /\.(ts|tsx)$/.test(path)),
  ...listFiles('app/features/layout/components', (path) => /\.(ts|tsx)$/.test(path)),
  ...listFiles('app/features/agents/hooks', (path) => /\.(ts|tsx)$/.test(path)),
  ...listFiles('app/features/nodes/hooks', (path) => /\.(ts|tsx)$/.test(path)),
];

for (const relativePath of allNewFeatureCode) {
  assert.ok(lineCount(relativePath) <= 500, `${relativePath} must stay at or below 500 lines`);
}

assert.match(layoutSource, /import '\.\/features\/messages\/components\/MessageList\.css';/);
assert.match(layoutSource, /import '\.\/features\/files\/components\/FileWorkspacePanel\.css';/);
assert.match(layoutSource, /import '\.\/features\/agents\/components\/AgentsPanel\.css';/);
assert.match(layoutSource, /import '\.\/features\/nodes\/components\/NodesPanel\.css';/);
assert.match(layoutSource, /import '\.\/features\/layout\/components\/ChatShell\.css';/);

console.log('page under 200 domain refactor checks passed');
```

- [ ] **Step 2: Run the guard and verify it fails for the current page**

Run:

```powershell
node .\test\page-under-200-domain-refactor.test.mjs
```

Expected: FAIL with a message that `app/page.tsx` is over 200 lines or `ChatPageClient.tsx` is missing.

- [ ] **Step 3: Keep the failing guard out of commits until Task 8**

Run:

```powershell
git --no-pager status --short
```

Expected: `?? test/page-under-200-domain-refactor.test.mjs` is visible. Do not include it in commits for Tasks 2 through 7.

### Task 2: Extract pure helpers, storage keys, and shared local types

**Files:**
- Create: `app/features/messages/markdownHelpers.tsx`
- Modify: `app/features/files/fileWorkspaceTypes.ts`
- Create: `app/features/chat/runtime/sessionPersistence.ts`
- Create: `app/features/chat/runtime/chatRunLoop.ts`
- Modify: `app/page.tsx`

- [ ] **Step 1: Move markdown helpers from `app/page.tsx`**

Create `app/features/messages/markdownHelpers.tsx` by moving the current `mdProcessor`, `markdownToHtml`, `stripMarkdownSyntaxForSearch`, `HTML_FILE_RE`, `linkifyHtmlPaths`, and `mdComponents` implementation from the helper section at the top of `app/page.tsx`. Export these names:

```ts
export function markdownToHtml(md: string): string;
export function stripMarkdownSyntaxForSearch(text: string): string;
export function linkifyHtmlPaths(text: string): Array<string | { href: string; label: string }>;
export const mdComponents: {
  code: (props: unknown) => JSX.Element;
  p: (props: unknown) => JSX.Element;
};
```

Keep the current `remark`, `remark-gfm`, `remark-rehype`, `rehype-stringify`, and ReactMarkdown component behavior unchanged. Keep `HTML_FILE_RE.lastIndex = 0` resets where they exist now.

- [ ] **Step 2: Move file comment and live-selection types**

Move these exact type definitions from `app/page.tsx` into `app/features/files/fileWorkspaceTypes.ts` and export them:

```ts
export type FileComment = {
  id: string;
  agentId: string;
  filePath: string;
  rangeStartLine: number | null;
  rangeEndLine: number | null;
  rangeStartChar: number | null;
  rangeEndChar: number | null;
  content: string;
  authorType: 'agent' | 'user';
  authorName: string | null;
  status: 'active' | 'queued' | 'processing' | 'resolved';
  linkedChatId: string | null;
  createdAt: string;
  updatedAt: string;
  replies: FileCommentReply[];
};

export type FileCommentReply = {
  id: string;
  commentId: string;
  content: string;
  authorType: 'agent' | 'user';
  authorName: string | null;
  createdAt: string;
};

export type LiveSelectionDraftAnchor = {
  rects: { left: number; top: number; width: number; height: number }[];
};

export type LiveEditorSelectionSnapshot = {
  start: number;
  end: number;
};

export type LiveCommentMarker = {
  lineNum: number;
  commentIds: string[];
  top: number;
  left: number;
  color: string;
  selected: boolean;
  label: string;
  title: string;
  count: number;
};

export type CommentAddRange = {
  startLine: number;
  endLine: number;
  startChar?: number;
  endChar?: number;
};
```

- [ ] **Step 3: Move storage keys and small pure runtime helpers**

Create `app/features/chat/runtime/sessionPersistence.ts` with the exported storage keys currently declared in `app/page.tsx`:

```ts
export const STORAGE_CHAT_INPUT = 'acp_chat_input_v1';
export const STORAGE_SIDEBAR_COLLAPSED = 'acp_chat_sidebar_collapsed_v1';
export const STORAGE_INPUT_HISTORY = 'acp_input_history_v2';
export const STORAGE_THEME = 'acp_chat_theme_v1';
export const STORAGE_AGENT_FILTER = 'acp_agent_filter_v1';
export const STORAGE_FILE_WORKSPACE = 'acp_file_workspace_v1';
export const STORAGE_REMEMBERED_CHAT_AGENTS = 'acp_remembered_chat_agents_v1';
```

Create `app/features/chat/runtime/chatRunLoop.ts` with the page-local runtime constants/helpers:

```ts
export type PtyPhase = 'booting' | 'loading-environment' | 'idle-ready' | 'thinking' | 'replying';

export const AUTO_MAX_STEPS = 5;

export class PromptSendFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptSendFailedError';
  }
}

export function mapTurnPhase(phase: string): PtyPhase | undefined {
  switch (phase) {
    case 'booting':
      return 'loading-environment';
    case 'thinking':
      return 'thinking';
    case 'tool_exec':
      return 'thinking';
    case 'replying':
      return 'replying';
    case 'done':
      return 'idle-ready';
    default:
      return undefined;
  }
}

export function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
```

- [ ] **Step 4: Update `app/page.tsx` imports and remove local duplicates**

Replace local definitions with imports from the new files. Do not change call sites except to repair import names.

- [ ] **Step 5: Run affected source tests and build**

Run:

```powershell
node .\test\page-shell-targeted-refactor.test.mjs
npm run build
```

Expected: source test passes and production build completes.

- [ ] **Step 6: Commit helper extraction**

Run:

```powershell
git add .\app\page.tsx .\app\features\messages\markdownHelpers.tsx .\app\features\files\fileWorkspaceTypes.ts .\app\features\chat\runtime\sessionPersistence.ts .\app\features\chat\runtime\chatRunLoop.ts
git commit -m "refactor: extract page helpers and shared types"
```

### Task 3: Extract message rendering domain

**Files:**
- Create: `app/features/messages/messageTypes.ts`
- Create: `app/features/messages/components/MessageList.tsx`
- Create: `app/features/messages/components/MessageBubble.tsx`
- Create: `app/features/messages/components/MessageContentParts.tsx`
- Create: `app/features/messages/components/AgentUserRequestCard.tsx`
- Create: `app/features/messages/components/MessageToolCall.tsx`
- Create: `app/features/messages/components/MessageList.css`
- Modify: `app/layout.tsx`
- Modify: `app/page.tsx`
- Modify: `test/page-shell-targeted-refactor.test.mjs`

- [ ] **Step 1: Define message rendering contracts**

Create `app/features/messages/messageTypes.ts` with narrow UI contracts used by message components:

```ts
import type { AgentUserRequestAnswer, ChatMessage, ContentPart } from '../chat/chatTypes';
import type { FailedSendState } from '../chat/components/FailedSendControls';

export type MessageActionHandlers = {
  onCopyMessage: (message: ChatMessage) => void;
  onToggleExpanded: (messageId: string) => void;
  onRetryFailedSend: (messageId: string) => void;
};

export type AgentRequestHandlers = {
  onAnswerAgentUserRequest: (requestId: string, answer: AgentUserRequestAnswer) => void;
  onDismissAgentUserRequest: (requestId: string) => void;
};

export type MessageContentRenderContext = {
  onOpenImage: (src: string) => void;
  onOpenFilePath: (path: string) => void;
};

export type RenderableContentPart = ContentPart;

export type FailedSendByMessageId = Record<string, FailedSendState | undefined>;
```

Adjust names to match existing exported chat types if TypeScript reports a mismatch; do not introduce `any`.

- [ ] **Step 2: Move agent request card rendering**

Create `AgentUserRequestCard.tsx` by moving the existing agent user request JSX and helper logic from `app/page.tsx`. Export:

```ts
export function AgentUserRequestCard(props: {
  request: AgentUserRequest;
  disabled: boolean;
  onAnswer: (requestId: string, answer: AgentUserRequestAnswer) => void;
  onDismiss: (requestId: string) => void;
}): JSX.Element;
```

Keep option labels from `getAgentUserRequestOptionLabel` and preserve current button text, disabled behavior, and class names.

- [ ] **Step 3: Move content part and tool-call rendering**

Create `MessageContentParts.tsx` and `MessageToolCall.tsx` by moving the current text/image/file/tool rendering branches from `app/page.tsx`. Use `markdownHelpers.mdComponents` for markdown rendering. Preserve `ReactMarkdown` + `remarkGfm` behavior and existing link/image/file preview classes.

- [ ] **Step 4: Move message bubble and list rendering**

Create `MessageBubble.tsx` and `MessageList.tsx` by moving the current message map, action row, collapsed state, failed-send notice/actions placement, and scroll anchor markup out of `app/page.tsx`. Keep `FailedSendNotice` and `FailedSendActions` imported from `app/features/chat/components/FailedSendControls`.

- [ ] **Step 5: Move message CSS**

Move only the selectors used by the extracted message markup from `app/page.tsx` styled JSX into `app/features/messages/components/MessageList.css`. Preserve selector names. Add this import to `app/layout.tsx`:

```ts
import './features/messages/components/MessageList.css';
```

- [ ] **Step 6: Replace message JSX in `app/page.tsx`**

Replace the inline message rendering block in `app/page.tsx` with:

```tsx
<MessageList
  messages={messages}
  agents={agents}
  expandedMessages={expandedMessages}
  failedSendByMessageId={failedSendByMessageId}
  runVersion={runVersion}
  onCopyMessage={copyMessage}
  onToggleExpanded={toggleMessageExpanded}
  onRetryFailedSend={retryFailedSend}
  onOpenImage={setLightboxImage}
  onAnswerAgentUserRequest={answerAgentUserRequest}
  onDismissAgentUserRequest={dismissAgentUserRequest}
/>
```

Use the actual existing handler names from `app/page.tsx`; if a handler is currently inline, lift it into a named `useCallback` before passing it.

- [ ] **Step 7: Update source tests for moved message boundaries**

Extend `test/page-shell-targeted-refactor.test.mjs` with assertions that `MessageList` is imported from the message domain and message-only helpers no longer live in `app/page.tsx`:

```js
assert.match(pageSource, /import \{ MessageList \} from '\.\/features\/messages\/components\/MessageList';/);
assert.doesNotMatch(pageSource, /const mdComponents =/);
assert.doesNotMatch(pageSource, /function linkifyHtmlPaths/);
assert.match(layoutSource, /import '\.\/features\/messages\/components\/MessageList\.css';/);
```

- [ ] **Step 8: Run affected checks**

Run:

```powershell
node .\test\page-shell-targeted-refactor.test.mjs
npm run build
npx playwright test --config test/playwright.config.ts test/test-ui.spec.ts -g "Chat UI should"
```

Expected: source test and build pass; targeted Playwright chat UI tests pass.

- [ ] **Step 9: Commit message extraction**

Run:

```powershell
git add .\app\page.tsx .\app\layout.tsx .\app\features\messages .\test\page-shell-targeted-refactor.test.mjs
git commit -m "refactor: extract message rendering domain"
```

### Task 4: Extract shared layout, header, dialogs, and shell UI

**Files:**
- Create: `app/features/layout/components/ChatShell.tsx`
- Create: `app/features/layout/components/PageHeader.tsx`
- Create: `app/features/layout/components/StatusBar.tsx`
- Create: `app/features/layout/components/ThemeMenu.tsx`
- Create: `app/features/layout/components/ShareDialog.tsx`
- Create: `app/features/layout/components/ImageLightbox.tsx`
- Create: `app/features/layout/components/ChatShell.css`
- Modify: `app/layout.tsx`
- Modify: `app/page.tsx`

- [ ] **Step 1: Extract header and status components**

Move the current header/title/auth/sign-out/share/theme controls into `PageHeader.tsx` and runtime status display into `StatusBar.tsx`. Use typed props rather than importing runtime state directly:

```ts
export type PageHeaderProps = {
  chatName: string;
  authLabel: string;
  isAdmin: boolean;
  onSignOut: () => void;
  onOpenShare: () => void;
  themeMenu: JSX.Element;
};

export type StatusBarProps = {
  statusText: string;
  targetText: string;
  isRunning: boolean;
};
```

Keep the current visual text and classes.

- [ ] **Step 2: Extract theme menu, share dialog, and image lightbox**

Move the current theme menu JSX into `ThemeMenu.tsx`, share modal JSX into `ShareDialog.tsx`, and image preview modal into `ImageLightbox.tsx`. Preserve current close buttons, copied-link text, keyboard/mouse behavior, and class names.

- [ ] **Step 3: Extract shell layout**

Create `ChatShell.tsx` as the layout component that accepts already-rendered slots:

```ts
export type ChatShellProps = {
  sidebar: JSX.Element;
  header: JSX.Element;
  messages: JSX.Element;
  composer: JSX.Element;
  rightPanel: JSX.Element | null;
  statusBar: JSX.Element;
  shareDialog: JSX.Element | null;
  imageLightbox: JSX.Element | null;
  mobilePanel: 'chat' | 'files' | 'agents' | 'nodes';
  onMobilePanelChange: (panel: ChatShellProps['mobilePanel']) => void;
};
```

Move only shell markup into this component. State remains in `app/page.tsx` until runtime extraction.

- [ ] **Step 4: Move layout CSS**

Move shell/header/status/theme/share/lightbox/mobile selectors from `app/page.tsx` styled JSX into `app/features/layout/components/ChatShell.css`. Add this import to `app/layout.tsx`:

```ts
import './features/layout/components/ChatShell.css';
```

- [ ] **Step 5: Replace shell JSX in `app/page.tsx`**

Use `ChatShell` in `app/page.tsx` with explicit slots. Keep `ChatSidebarList`, `MessageList`, `ChatComposer`, and right-panel content as slot values.

- [ ] **Step 6: Run affected checks**

Run:

```powershell
npm run build
npx playwright test --config test/playwright.config.ts test/test-ui.spec.ts -g "theme|share|lightbox|mobile"
```

Expected: build passes; targeted tests pass if matching tests exist. If no tests match the grep, run `npx playwright test --config test/playwright.config.ts test/test-ui.spec.ts`.

- [ ] **Step 7: Commit layout extraction**

Run:

```powershell
git add .\app\page.tsx .\app\layout.tsx .\app\features\layout
git commit -m "refactor: extract chat page layout components"
```

### Task 5: Extract agent and node panels

**Files:**
- Create: `app/features/agents/hooks/useAgentPanelState.ts`
- Create: `app/features/agents/components/AgentsPanel.tsx`
- Create: `app/features/agents/components/AgentsPanel.css`
- Create: `app/features/nodes/hooks/useNodePanelState.ts`
- Create: `app/features/nodes/components/NodesPanel.tsx`
- Create: `app/features/nodes/components/NodesPanel.css`
- Modify: `app/layout.tsx`
- Modify: `app/page.tsx`

- [ ] **Step 1: Extract agent panel state**

Move add-agent, remote-agent, relay-agent, model-settings, form field, form error, and agent action state from `app/page.tsx` into `useAgentPanelState.ts`. Export a hook with this shape:

```ts
export type AgentPanelState = {
  showAgentsPanel: boolean;
  setShowAgentsPanel: (value: boolean) => void;
  selectedAgentFilter: string | null;
  setSelectedAgentFilter: (agentId: string | null) => void;
  formValues: Record<string, string>;
  formError: string | null;
  isSubmitting: boolean;
};

export type AgentPanelActions = {
  openAddAgent: () => void;
  closeAddAgent: () => void;
  submitAddAgent: () => Promise<void>;
  openModelSettings: (agentId: string) => void;
  closeModelSettings: () => void;
};
```

Use exact field names from the existing page where practical. Preserve existing error text and API calls.

- [ ] **Step 2: Extract agent panel UI**

Move the agent list/sidebar modal sections into `AgentsPanel.tsx`. Keep `AgentModelSelect` imported from `app/features/agents/components/AgentModelSelect`. Props must include `agents`, `selectedAgentModels`, `ensuringAgentModels`, and callbacks currently owned by `app/page.tsx`.

- [ ] **Step 3: Extract node panel state and UI**

Move node list/setup/edit form state into `useNodePanelState.ts` and node panel JSX into `NodesPanel.tsx`. Preserve current node API calls, status labels, validation messages, and setup/edit modal behavior.

- [ ] **Step 4: Move agent/node CSS**

Move agent and node panel selectors from `app/page.tsx` styled JSX into adjacent CSS files. Add imports:

```ts
import './features/agents/components/AgentsPanel.css';
import './features/nodes/components/NodesPanel.css';
```

- [ ] **Step 5: Replace panel JSX in `app/page.tsx`**

Render `AgentsPanel` and `NodesPanel` in the right-panel slot or mobile panel slot where the existing page currently renders their inline JSX.

- [ ] **Step 6: Run affected checks**

Run:

```powershell
npm run build
npx playwright test --config test/playwright.config.ts test/test-ui.spec.ts -g "agent|node|model"
```

Expected: build passes; targeted tests pass if matching tests exist. If no tests match the grep, run `npx playwright test --config test/playwright.config.ts test/test-ui.spec.ts`.

- [ ] **Step 7: Commit panel extraction**

Run:

```powershell
git add .\app\page.tsx .\app\layout.tsx .\app\features\agents .\app\features\nodes
git commit -m "refactor: extract agent and node panels"
```

### Task 6: Extract file workspace, editor, and comments

**Files:**
- Create: `app/features/files/hooks/useFileWorkspaceState.ts`
- Create: `app/features/files/hooks/useFileComments.ts`
- Create: `app/features/files/hooks/useLiveEditorSelection.ts`
- Create: `app/features/files/components/FileWorkspacePanel.tsx`
- Create: `app/features/files/components/FileTreePanel.tsx`
- Create: `app/features/files/components/FileEditorPanel.tsx`
- Create: `app/features/files/components/FileCommentSidebar.tsx`
- Create: `app/features/files/components/FileWorkspacePanel.css`
- Modify: `app/features/files/fileWorkspaceHelpers.ts`
- Modify: `app/features/files/fileWorkspaceTypes.ts`
- Modify: `app/layout.tsx`
- Modify: `app/page.tsx`

- [ ] **Step 1: Extract file workspace state**

Move file workspace state and actions into `useFileWorkspaceState.ts`: workspace parsing/persistence, file tree, active file, file content loading, markdown/editor mode, simple diff, conflict state, selected line/range, and file open/save/preview handlers. Export:

```ts
export type FileWorkspaceController = {
  workspace: FileWorkspaceState;
  activeFilePath: string | null;
  activeFileContent: string;
  editorMode: MdEditorMode;
  diffLines: DiffLine[];
  conflictState: MdConflictState | null;
  setActiveFilePath: (path: string | null) => void;
  setEditorMode: (mode: MdEditorMode) => void;
  openFilePath: (path: string) => Promise<void>;
  saveActiveFile: () => Promise<void>;
};
```

Use existing `FileWorkspaceState`, `DiffLine`, `MdEditorMode`, and `MdConflictState` types from `fileWorkspaceTypes.ts`. Keep current local storage behavior using `STORAGE_FILE_WORKSPACE`.

- [ ] **Step 2: Extract comments state**

Move file comment state and review-chat linkage into `useFileComments.ts`. Export:

```ts
export type FileCommentsController = {
  comments: FileComment[];
  activeCommentId: string | null;
  replyDraftByCommentId: Record<string, string>;
  setActiveCommentId: (commentId: string | null) => void;
  setReplyDraft: (commentId: string, value: string) => void;
  addComment: (range: CommentAddRange, content: string) => Promise<void>;
  addReply: (commentId: string) => Promise<void>;
  resolveComment: (commentId: string) => Promise<void>;
  reopenComment: (commentId: string) => Promise<void>;
  startReviewChat: (commentId: string) => Promise<void>;
};
```

Preserve existing comment status transitions and linked chat behavior.

- [ ] **Step 3: Extract live editor selection**

Move live editor selection refs, selection snapshot handling, anchor measurement, marker calculation, and cleanup into `useLiveEditorSelection.ts`. Export callbacks consumed by `FileEditorPanel` and `FileCommentSidebar`.

- [ ] **Step 4: Extract file workspace UI**

Move file tree markup into `FileTreePanel.tsx`, editor/preview/diff/conflict markup into `FileEditorPanel.tsx`, comment markup into `FileCommentSidebar.tsx`, and compose them in `FileWorkspacePanel.tsx`. Use controller props from the hooks instead of reading global state.

- [ ] **Step 5: Move file workspace CSS**

Move file workspace, editor, markdown preview, diff/conflict, comments, live selection, and review-chat selectors from `app/page.tsx` styled JSX into `FileWorkspacePanel.css`. Add import:

```ts
import './features/files/components/FileWorkspacePanel.css';
```

- [ ] **Step 6: Replace file workspace JSX in `app/page.tsx`**

Replace the inline files tab/right-panel content with:

```tsx
<FileWorkspacePanel
  workspace={fileWorkspaceController}
  comments={fileCommentsController}
  selection={liveEditorSelectionController}
/>
```

Use the actual controller variable names returned by the new hooks.

- [ ] **Step 7: Run affected checks**

Run:

```powershell
npm run build
npx playwright test --config test/playwright.config.ts test/test-ui.spec.ts -g "file|comment|editor|review"
```

Expected: build passes; targeted Playwright file/comment tests pass.

- [ ] **Step 8: Commit file workspace extraction**

Run:

```powershell
git add .\app\page.tsx .\app\layout.tsx .\app\features\files
git commit -m "refactor: extract file workspace domain"
```

### Task 7: Extract chat runtime and agent registry hooks

**Files:**
- Create: `app/features/chat/runtime/chatRuntimeTypes.ts`
- Create: `app/features/chat/runtime/useAgentRegistry.ts`
- Create: `app/features/chat/runtime/useChatRuntime.ts`
- Modify: `app/page.tsx`
- Modify: `app/features/chat/chatTypes.ts`
- Modify: `app/features/chat/chatHelpers.ts`

- [ ] **Step 1: Define runtime contracts**

Create `chatRuntimeTypes.ts` with state bundles consumed by `ChatPageClient`:

```ts
import type { RefObject } from 'react';
import type { Agent, AgentModel } from '../../agents/agentTypes';
import type { ChatAttachment } from '../../composer/attachmentTypes';
import type { ChatHistoryEntry, ChatMessage, OrchestrationMode, ShareDialog } from '../chatTypes';
import type { PtyPhase } from './chatRunLoop';

export type ComposerRuntime = {
  input: string;
  inputRef: RefObject<string>;
  attachments: ChatAttachment[];
  attachmentError: string | null;
  isDraggingAttachment: boolean;
  mentionSelectedIndex: number;
  setInput: (value: string) => void;
  setInputProgrammatic: (value: string) => void;
  setAttachments: (attachments: ChatAttachment[]) => void;
};

export type ChatRuntime = {
  messages: ChatMessage[];
  chatHistory: ChatHistoryEntry[];
  currentChatId: string;
  activeSidebarChatId: string;
  chatName: string;
  isRunning: boolean;
  ptyPhase: PtyPhase;
  runVersion: number;
  shareDialog: ShareDialog | null;
  sendMessage: () => Promise<void>;
  stopRun: () => Promise<void>;
  retryFailedSend: (messageId: string) => Promise<void>;
  createNewChat: () => Promise<void>;
  loadChat: (chatId: string) => Promise<void>;
};

export type AgentRegistry = {
  agents: Agent[];
  agentsLoading: boolean;
  selectedAgentFilter: string | null;
  selectedAgentModels: Record<string, string>;
  ensuringAgentModels: Record<string, boolean>;
  setSelectedAgentFilter: (agentId: string | null) => void;
  setSelectedAgentModels: (models: Record<string, string>) => void;
  reloadAgents: () => Promise<void>;
};

export type OrchestrationRuntime = {
  orchestrationMode: OrchestrationMode;
  discussionRounds: number;
  setOrchestrationMode: (mode: OrchestrationMode) => void;
  setDiscussionRounds: (rounds: number) => void;
};
```

Refine the contract during implementation to use existing concrete types. Keep callback return types truthful.

- [ ] **Step 2: Extract agent loading and model state**

Move agent loading, `parseAgents`, default-agent selection, remembered chat agents, selected agent filter, model selection, and model ensure state from `app/page.tsx` into `useAgentRegistry.ts`. The hook receives `userId` and the `acp` wrapper and returns `AgentRegistry`.

- [ ] **Step 3: Extract chat runtime state**

Move messages, input history, current chat ID, active sidebar chat ID, chat history, chat name/counter, share dialog, pty phase, run version, expanded message state, failed-send map, and session resume state into `useChatRuntime.ts`. Keep `acpApi` calls behind the injected `acp` callback.

- [ ] **Step 4: Extract send/resend/stop orchestration**

Move `sendMessage`, `dispatchToAgent`, scheduler/auto/manual mode routing, stream update handling, failed prompt handling, resend handling, and stop behavior into `useChatRuntime.ts`. Use helpers from `chatRunLoop.ts` for `PromptSendFailedError`, `AUTO_MAX_STEPS`, `mapTurnPhase`, and `makeId`.

- [ ] **Step 5: Preserve persistence timing**

Keep the current previous-chat persistence ordering that fixed the `lastChatId` race. Any async persistence call that was intentionally awaited must remain awaited in the same relative order.

- [ ] **Step 6: Replace runtime state in `app/page.tsx`**

Instantiate `useAgentRegistry` and `useChatRuntime` in `app/page.tsx` and pass their returned state into existing extracted UI components. At this stage `app/page.tsx` can still compose the page; Task 8 moves that composition into `ChatPageClient`.

- [ ] **Step 7: Run affected checks**

Run:

```powershell
npm run build
npx playwright test --config test/playwright.config.ts test/test-ui.spec.ts -g "send|resend|chat history|session|agent"
```

Expected: build passes; targeted Playwright chat/session tests pass.

- [ ] **Step 8: Commit runtime extraction**

Run:

```powershell
git add .\app\page.tsx .\app\features\chat
git commit -m "refactor: extract chat runtime hooks"
```

### Task 8: Create `ChatPageClient` and reduce `app/page.tsx` below 200 lines

**Files:**
- Create: `app/features/chat/ChatPageClient.tsx`
- Modify: `app/page.tsx`
- Modify: `test/page-under-200-domain-refactor.test.mjs`
- Modify: existing source-shape tests if import locations changed.

- [ ] **Step 1: Move page composition into `ChatPageClient.tsx`**

Create `app/features/chat/ChatPageClient.tsx` with the client directive and composition currently left in `app/page.tsx`:

```tsx
'use client';

import { useCallback, useMemo, useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { ChatComposer } from '../composer/components/ChatComposer';
import { ChatSidebarList } from './components/ChatSidebarList';
import { MessageList } from '../messages/components/MessageList';
import { FileWorkspacePanel } from '../files/components/FileWorkspacePanel';
import { AgentsPanel } from '../agents/components/AgentsPanel';
import { NodesPanel } from '../nodes/components/NodesPanel';
import { ChatShell } from '../layout/components/ChatShell';
import { ImageLightbox } from '../layout/components/ImageLightbox';
import { PageHeader } from '../layout/components/PageHeader';
import { ShareDialog } from '../layout/components/ShareDialog';
import { StatusBar } from '../layout/components/StatusBar';
import { ThemeMenu } from '../layout/components/ThemeMenu';
import { acpApi } from './chatApi';
import { useAgentRegistry } from './runtime/useAgentRegistry';
import { useChatRuntime } from './runtime/useChatRuntime';

export function ChatPageClient() {
  const { data: session } = useSession();
  const isAdmin = (session?.user as { role?: string } | undefined)?.role === 'admin';
  const userId = (session?.user as { email?: string; name?: string } | undefined)?.email
    || (session?.user as { email?: string; name?: string } | undefined)?.name
    || 'anonymous';

  const acp = useCallback((body: Record<string, unknown>) => acpApi({ ...body, userId }), [userId]);
  const agents = useAgentRegistry({ userId, acp });
  const chat = useChatRuntime({ userId, acp, agents });

  return (
    <ChatShell
      sidebar={<ChatSidebarList {...chat.sidebarProps} />}
      header={
        <PageHeader
          chatName={chat.chatName}
          authLabel={userId}
          isAdmin={isAdmin}
          onSignOut={() => signOut()}
          onOpenShare={chat.openShareDialog}
          themeMenu={<ThemeMenu {...chat.themeMenuProps} />}
        />
      }
      messages={<MessageList {...chat.messageListProps} />}
      composer={<ChatComposer {...chat.composerProps} />}
      rightPanel={chat.rightPanel}
      statusBar={<StatusBar {...chat.statusBarProps} />}
      shareDialog={chat.shareDialog ? <ShareDialog {...chat.shareDialogProps} /> : null}
      imageLightbox={chat.lightboxImage ? <ImageLightbox src={chat.lightboxImage} onClose={chat.closeLightbox} /> : null}
      mobilePanel={chat.mobilePanel}
      onMobilePanelChange={chat.setMobilePanel}
    />
  );
}
```

The snippet shows the final shape, not a mandate to add prop bags named exactly this way. During implementation, keep `ChatPageClient.tsx` under 300 lines by moving prop-bag construction into runtime/layout hooks if the component grows.

- [ ] **Step 2: Reduce `app/page.tsx` to the route shell**

Replace `app/page.tsx` with:

```tsx
import { ChatPageClient } from './features/chat/ChatPageClient';

export default function Page() {
  return <ChatPageClient />;
}
```

- [ ] **Step 3: Tighten and update the source-shape guard**

If implementation file names differ from Task 1, update `guardedNewCodeFiles` in `test/page-under-200-domain-refactor.test.mjs` to match the actual focused files. Do not remove the `app/page.tsx < 200`, `ChatPageClient.tsx < 300`, or no-giant-replacement assertions.

- [ ] **Step 4: Run source-shape checks**

Run:

```powershell
node .\test\page-under-200-domain-refactor.test.mjs
node .\test\page-shell-targeted-refactor.test.mjs
node .\test\composer-layout.test.mjs
node .\test\failed-send-actions-layout.test.mjs
node .\test\layered-refactor-structure.test.mjs
```

Expected: all source-shape tests pass.

- [ ] **Step 5: Run build**

Run:

```powershell
npm run build
```

Expected: production build completes with only known pre-existing warnings.

- [ ] **Step 6: Commit final shell reduction and guard**

Run:

```powershell
git add .\app\page.tsx .\app\features\chat\ChatPageClient.tsx .\test\page-under-200-domain-refactor.test.mjs .\test\page-shell-targeted-refactor.test.mjs .\test\composer-layout.test.mjs .\test\failed-send-actions-layout.test.mjs .\test\layered-refactor-structure.test.mjs
git commit -m "refactor: reduce page route shell below 200 lines"
```

### Task 9: Final verification and PR update

**Files:**
- Modify only if verification finds a real regression directly caused by this refactor.

- [ ] **Step 1: Run all source tests**

Run:

```powershell
Get-ChildItem .\test -Filter *.test.mjs | ForEach-Object { node $_.FullName }
```

Expected: every source test prints its pass message and exits successfully.

- [ ] **Step 2: Run build**

Run:

```powershell
npm run build
```

Expected: production build completes.

- [ ] **Step 3: Run full Playwright**

Ensure the app is running on the expected test URL, then run:

```powershell
npx playwright test --config test/playwright.config.ts
```

Expected: full suite passes with the existing skipped tests only.

- [ ] **Step 4: Verify line counts and git status**

Run:

```powershell
(Get-Content -LiteralPath .\app\page.tsx | Measure-Object -Line).Lines
(Get-Content -LiteralPath .\app\features\chat\ChatPageClient.tsx | Measure-Object -Line).Lines
git --no-pager status --short
```

Expected: `app/page.tsx` is below 200 lines, `ChatPageClient.tsx` is below 300 lines, and git status is clean.

- [ ] **Step 5: Push branch and update PR**

Run:

```powershell
git push origin feature/layered-refactor-impl
gh pr edit 42 --body-file .\docs\superpowers\plans\2026-05-19-page-under-200-domain-refactor.md
```

Expected: branch pushes successfully and PR #42 reflects the new refactor summary. If replacing the whole PR body is not desired at execution time, update the PR body with a concise summary instead of using the plan file directly.

## Self-review notes

- Spec coverage: The plan covers route shell, client composition, runtime, messages, files/comments, agents/nodes, layout/modals, CSS import rules, size guards, and final verification.
- Placeholder scan: The plan avoids deferred implementation markers. Mechanical extraction steps name the exact current source symbols and target files because the current source is the behavior-preserving reference.
- Type consistency: Runtime contracts use existing domain types from `chatTypes`, `agentTypes`, `attachmentTypes`, and `fileWorkspaceTypes`; tasks require preserving concrete callback return types during implementation.
