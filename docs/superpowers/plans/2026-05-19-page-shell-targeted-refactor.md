# Page Shell Targeted Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the composer, failed-send controls, and chat sidebar list from `app/page.tsx` into focused client components with adjacent plain CSS files, without changing visible behavior.

**Architecture:** `app/page.tsx` remains the route shell and source of truth for state, refs, persistence, ACP dispatch, and error handling. New presentational components receive data and callbacks through typed props, render existing markup/classes, and use adjacent plain CSS files imported from `app/layout.tsx`.

**Tech Stack:** Next.js App Router, React 19, TypeScript strict, plain global CSS imported from root layout, Playwright E2E, Node source-structure tests.

---

## File Structure

- Create: `app/features/chat/components/FailedSendControls.tsx`
  - Renders the failed-send notice and Retry action. No fetches, ACP calls, or resend routing.
- Create: `app/features/chat/components/FailedSendControls.css`
  - Holds `.userSendFailure*` styles moved out of `app/page.tsx`.
- Create: `app/features/chat/components/ChatSidebarList.tsx`
  - Renders New Chat, chat rows, rename input, status badge, and chat action menu.
- Create: `app/features/chat/components/ChatSidebarList.css`
  - Holds chat history/sidebar list styles moved out of `app/page.tsx`.
- Create: `app/features/composer/components/ChatComposer.tsx`
  - Renders mention dropdown, attachment input/tray, textarea, attach button, target controls slot, and send/stop button.
- Create: `app/features/composer/components/ChatComposer.css`
  - Holds composer styles moved out of `app/page.tsx`.
- Modify: `app/layout.tsx`
  - Import the three component CSS files after `globals.css`.
- Modify: `app/page.tsx`
  - Import and use the new components. Keep state, callbacks, persistence, ACP dispatch, and file workspace code in place.
- Modify: `test/composer-layout.test.mjs`
  - Read `ChatComposer.tsx` and `ChatComposer.css` instead of assuming all composer markup/CSS lives in `page.tsx`.
- Modify: `test/failed-send-actions-layout.test.mjs`
  - Read `FailedSendControls.tsx` and `FailedSendControls.css` instead of assuming all failed-send markup/CSS lives in `page.tsx`.
- Create: `test/page-shell-targeted-refactor.test.mjs`
  - Guard the intended extraction boundaries and CSS import pattern.

---

### Task 1: Add failing structure tests for the extraction

**Files:**
- Modify: `test/composer-layout.test.mjs`
- Modify: `test/failed-send-actions-layout.test.mjs`
- Create: `test/page-shell-targeted-refactor.test.mjs`

- [ ] **Step 1: Replace composer layout source reads**

Replace `test/composer-layout.test.mjs` with:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pageSource = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const composerSource = readFileSync(new URL('../app/features/composer/components/ChatComposer.tsx', import.meta.url), 'utf8');
const composerCss = readFileSync(new URL('../app/features/composer/components/ChatComposer.css', import.meta.url), 'utf8');

const shellStart = composerSource.indexOf('className={`composerShell');
assert.ok(shellStart >= 0, 'composer shell should exist in ChatComposer');
const shellSource = composerSource.slice(shellStart, composerSource.indexOf('</section>', shellStart));

const attachmentIndex = shellSource.indexOf('<AttachmentList');
const textRowIndex = shellSource.indexOf('className="composerTextRow"');
const toolbarIndex = shellSource.indexOf('className="composerToolbar"');
const attachButtonIndex = shellSource.indexOf('className="attachButton"');
const attachIconIndex = shellSource.indexOf('className="attachButtonIcon"');
const targetPillsIndex = shellSource.indexOf('{targetControls}');
const sendActionsIndex = shellSource.indexOf('className="composerActions composerToolbarActions"');

assert.ok(pageSource.includes('<ChatComposer'), 'page.tsx should render ChatComposer');
assert.ok(attachmentIndex >= 0, 'composer should render attachments in the shell');
assert.ok(textRowIndex >= 0, 'composer should have a dedicated text row');
assert.ok(toolbarIndex >= 0, 'composer should have a bottom toolbar');
assert.ok(attachmentIndex < textRowIndex, 'attachments should render above the text input');
assert.ok(textRowIndex < toolbarIndex, 'text input should render above the bottom toolbar');
assert.ok(toolbarIndex < attachButtonIndex, 'file attachment button should live in the bottom toolbar');
assert.ok(attachButtonIndex < attachIconIndex, 'file attachment button should include an icon span');
assert.doesNotMatch(shellSource.slice(attachButtonIndex, targetPillsIndex), /attachButtonLabel|>Files</, 'file attachment button should be icon-only');
assert.ok(toolbarIndex < targetPillsIndex, 'agent/model target controls should live in the bottom toolbar');
assert.ok(toolbarIndex < sendActionsIndex, 'send controls should live in the bottom toolbar');

const textRowSource = shellSource.slice(textRowIndex, toolbarIndex);
assert.doesNotMatch(textRowSource, /attachButton|targetControls|composerActions/, 'text row should contain only the textarea controls, not toolbar controls');

assert.match(composerCss, /\.composerToolbar\s*\{[\s\S]*?display:\s*flex;[\s\S]*?justify-content:\s*space-between;/, 'bottom toolbar should lay out controls horizontally');
assert.match(composerCss, /\.composerTextRow\s*\{[\s\S]*?display:\s*flex;/, 'text row should have its own layout block');
assert.match(composerCss, /\.attachmentTray\s*\{[\s\S]*?padding:\s*0 0 2px;/, 'attachment tray should sit as the compact top strip');
assert.match(composerCss, /\.attachButton\s*\{[\s\S]*?width:\s*32px;[\s\S]*?border-radius:\s*999px;/, 'file attachment button should use a compact rounded icon-button shape');
assert.doesNotMatch(composerCss, /\.attachButtonLabel\s*\{/, 'file attachment button should not include visible label styles');

console.log('composer layout checks passed');
```

- [ ] **Step 2: Replace failed-send layout source reads**

Replace `test/failed-send-actions-layout.test.mjs` with:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pageSource = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const failedSendSource = readFileSync(new URL('../app/features/chat/components/FailedSendControls.tsx', import.meta.url), 'utf8');
const failedSendCss = readFileSync(new URL('../app/features/chat/components/FailedSendControls.css', import.meta.url), 'utf8');

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = failedSendCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected CSS block for ${selector}`);
  return match[1];
}

assert.match(
  pageSource,
  /const userSendFailure = getUserSendFailureState\(message\);[\s\S]*<FailedSendNotice failure=\{userSendFailure\} \/>[\s\S]*<FailedSendActions/,
  'page.tsx should calculate failed-send state once and render extracted failed-send components',
);

assert.match(
  failedSendSource,
  /className="userSendFailure userSendFailureNotice"[\s\S]*className="userSendFailureCard"[\s\S]*className="userSendFailureActions"/,
  'failed send UI should render a right-aligned notice card and separate action row',
);

assert.match(
  failedSendSource,
  /<span className="userSendFailureStatus">[\s\S]*Failed to send:\s*\{failure\.error\}[\s\S]*<\/span>/,
  'failed send notice should show the failure label and detail on one line',
);

assert.doesNotMatch(
  failedSendSource,
  /userSendFailureHeader|userSendFailureMessage/,
  'failed send notice should not split the failure into two lines',
);

assert.match(
  failedSendSource,
  /className="userSendFailureButton"[\s\S]*Retry[\s\r\n]*<\/button>/,
  'failed send action row should show a Retry button',
);

assert.doesNotMatch(
  failedSendCss,
  /userSendFailureButton::before/,
  'retry action should be text-only without a pseudo icon',
);

assert.doesNotMatch(
  failedSendSource,
  /userSendFailureDelete|Delete failed send/,
  'failed send layout should not include a delete action',
);

assert.match(
  pageSource,
  /\.messageActionsWithFailure\s*\{[^}]*justify-content:\s*flex-end;/,
  'failed send actions should align to the right when they are the only action row controls',
);

assert.match(
  pageSource,
  /\.messageActionsWithFailure:has\(\.collapseToggle\)\s*\{[^}]*justify-content:\s*space-between;/,
  'failed send actions should stay right-aligned while long-message collapse remains on the left',
);

const noticeCss = cssBlock('.userSendFailureNotice');
assert.match(noticeCss, /justify-content:\s*flex-start;/, 'failed send notice should align to the left of the message text');
assert.match(noticeCss, /margin-bottom:\s*8px;/, 'failed send notice should sit above the message text');

assert.match(
  cssBlock('.userSendFailureStatus'),
  /white-space:\s*nowrap;/,
  'failed send notice should stay on one line',
);

const cardCss = cssBlock('.userSendFailureCard');
assert.match(cardCss, /background:\s*transparent;/, 'failed send notice should not show a card background');
assert.match(cardCss, /box-shadow:\s*none;/, 'failed send notice should not show a card box-shadow');

assert.match(
  cssBlock('.userSendFailureActions'),
  /justify-content:\s*flex-end;/,
  'retry action row should align right below the failure card',
);

assert.match(
  cssBlock('.userSendFailureButton:hover'),
  /transform:\s*translateY\(-1px\);/,
  'resend button should have a tactile hover lift',
);

assert.match(
  cssBlock('.userSendFailureButton:disabled:hover'),
  /transform:\s*none;/,
  'disabled resend button should not lift on hover',
);

console.log('failed send action layout checks passed');
```

- [ ] **Step 3: Add extraction boundary test**

Create `test/page-shell-targeted-refactor.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pageSource = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const layoutSource = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
const chatComposer = readFileSync(new URL('../app/features/composer/components/ChatComposer.tsx', import.meta.url), 'utf8');
const chatSidebarList = readFileSync(new URL('../app/features/chat/components/ChatSidebarList.tsx', import.meta.url), 'utf8');
const failedSendControls = readFileSync(new URL('../app/features/chat/components/FailedSendControls.tsx', import.meta.url), 'utf8');

assert.match(pageSource, /import \{ ChatComposer \} from '\.\/features\/composer\/components\/ChatComposer';/);
assert.match(pageSource, /import \{ ChatSidebarList \} from '\.\/features\/chat\/components\/ChatSidebarList';/);
assert.match(pageSource, /import \{ FailedSendActions, FailedSendNotice \} from '\.\/features\/chat\/components\/FailedSendControls';/);

assert.match(layoutSource, /import '\.\/features\/composer\/components\/ChatComposer\.css';/);
assert.match(layoutSource, /import '\.\/features\/chat\/components\/ChatSidebarList\.css';/);
assert.match(layoutSource, /import '\.\/features\/chat\/components\/FailedSendControls\.css';/);

assert.doesNotMatch(pageSource, /function renderUserSendFailureNotice/);
assert.doesNotMatch(pageSource, /function renderUserSendFailureActions/);
assert.doesNotMatch(pageSource, /className=\{`composerShell/);
assert.doesNotMatch(pageSource, /className=\{`chatHistoryRow/);

assert.match(chatComposer, /export function ChatComposer/);
assert.match(chatSidebarList, /export function ChatSidebarList/);
assert.match(failedSendControls, /export function FailedSendNotice/);
assert.match(failedSendControls, /export function FailedSendActions/);

console.log('page shell targeted refactor checks passed');
```

- [ ] **Step 4: Run source tests to verify they fail**

Run:

```powershell
Set-Location Q:\Repos\Agents-Chat\.worktrees\layered-refactor-impl
node .\test\composer-layout.test.mjs
```

Expected: FAIL because `app/features/composer/components/ChatComposer.tsx` does not exist yet.

Run:

```powershell
node .\test\failed-send-actions-layout.test.mjs
```

Expected: FAIL because `app/features/chat/components/FailedSendControls.tsx` does not exist yet.

Run:

```powershell
node .\test\page-shell-targeted-refactor.test.mjs
```

Expected: FAIL because the extracted components and CSS imports do not exist yet.

- [ ] **Step 5: Keep failing tests uncommitted**

Do not commit these tests yet. Commit each test with the component extraction that makes it pass so the branch never has a commit where committed tests fail.

---

### Task 2: Extract failed-send controls

**Files:**
- Create: `app/features/chat/components/FailedSendControls.tsx`
- Create: `app/features/chat/components/FailedSendControls.css`
- Modify: `app/layout.tsx`
- Modify: `app/page.tsx`

- [ ] **Step 1: Create failed-send component**

Create `app/features/chat/components/FailedSendControls.tsx`:

```tsx
'use client';

import type { ChatMessage } from '../chatTypes';

export type FailedSendState = {
  error: string;
  resendDisabled: boolean;
  waitingForAgents: boolean;
};

type FailedSendNoticeProps = {
  failure: FailedSendState | null;
};

type FailedSendActionsProps = {
  message: ChatMessage;
  failure: FailedSendState | null;
  onResend: (message: ChatMessage) => void;
};

export function FailedSendNotice({ failure }: FailedSendNoticeProps) {
  if (!failure) return null;

  return (
    <div className="userSendFailure userSendFailureNotice">
      <div className="userSendFailureCard" role="status" aria-label={`Failed to send: ${failure.error}`} title={failure.error}>
        <span className="userSendFailureStatus">
          Failed to send: {failure.error}
        </span>
      </div>
    </div>
  );
}

export function FailedSendActions({ message, failure, onResend }: FailedSendActionsProps) {
  if (!failure) return null;

  return (
    <div className="userSendFailureActions">
      <button
        type="button"
        className="userSendFailureButton"
        disabled={failure.resendDisabled}
        title={failure.waitingForAgents ? 'Waiting for agents to load' : 'Retry sending this message'}
        onClick={() => onResend(message)}
      >
        Retry
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Create failed-send CSS**

Create `app/features/chat/components/FailedSendControls.css` by moving these selectors out of `app/page.tsx` unchanged except for removing `:global(...)` wrappers:

> **Note:** `.messageActionsWithFailure` and `.messageActionsWithFailure:has(.collapseToggle)` are parent message-action row rules applied by `page.tsx` and must remain in `app/page.tsx`. Do **not** move them into `FailedSendControls.css`.

```css
.userSendFailure {
  display: flex;
  justify-content: flex-end;
  margin-top: 0;
}

.userSendFailureNotice {
  display: flex;
  justify-content: flex-start;
  margin-bottom: 8px;
}

.userSendFailureCard {
  width: fit-content;
  max-width: min(100%, 260px);
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.userSendFailureStatus {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--danger);
  letter-spacing: 0;
  cursor: help;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.userSendFailureStatus::before {
  content: '⚠';
  font-size: 12px;
  line-height: 1;
  flex: 0 0 auto;
}

.userSendFailureActions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding-right: 6px;
}

.userSendFailureButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  padding: 0 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--danger);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  transition: background 160ms ease, color 160ms ease, transform 160ms ease;
}

.userSendFailureButton:hover {
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  transform: translateY(-1px);
}

.userSendFailureButton:focus-visible {
  outline: 2px solid var(--danger);
  outline-offset: -2px;
}

.userSendFailureButton:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.userSendFailureButton:disabled:hover {
  background: transparent;
  transform: none;
}
```

- [ ] **Step 3: Import failed-send CSS from layout**

Modify the top of `app/layout.tsx`:

```tsx
import './globals.css';
import './features/chat/components/FailedSendControls.css';
import type { Metadata } from 'next';
```

- [ ] **Step 4: Wire failed-send component into page**

Add the import in `app/page.tsx`:

```tsx
import { FailedSendActions, FailedSendNotice, type FailedSendState } from './features/chat/components/FailedSendControls';
```

Change `getUserSendFailureState` to return the shared type:

```tsx
function getUserSendFailureState(message: ChatMessage): FailedSendState | null {
  if (message.type !== 'user' || message.sendStatus !== 'failed') return null;
  const chatId = currentChatIdRef.current;
  const waitingForAgents = !message.resendAgentIds?.length && (agentsLoading || agents.length === 0);
  const resendDisabled = isChatRunning(chatId) || waitingForAgents;
  const error = message.sendError || 'Failed to send prompt to agent';
  return { error, resendDisabled, waitingForAgents };
}
```

Delete `renderUserSendFailureNotice` and `renderUserSendFailureActions` from `app/page.tsx`.

In the message rendering block, replace:

```tsx
const userSendFailureNotice = renderUserSendFailureNotice(message);
const userSendFailureActions = renderUserSendFailureActions(message);
const messageActionsClassName = `messageActions ${userSendFailureActions ? 'messageActionsWithFailure' : ''}`;
```

with:

```tsx
const userSendFailure = getUserSendFailureState(message);
const messageActionsClassName = `messageActions ${userSendFailure ? 'messageActionsWithFailure' : ''}`;
```

Replace every `{userSendFailureNotice}` with:

```tsx
<FailedSendNotice failure={userSendFailure} />
```

Replace every `{userSendFailureActions}` with:

```tsx
<FailedSendActions message={message} failure={userSendFailure} onResend={resendFailedUserMessage} />
```

Remove the moved `.userSendFailure*` CSS blocks from the `app/page.tsx` styled-jsx block. Keep `.messageActionsWithFailure` and `.messageActionsWithFailure:has(.collapseToggle)` in `app/page.tsx`.

- [ ] **Step 5: Run failed-send checks**

Run:

```powershell
node .\test\failed-send-actions-layout.test.mjs
npx playwright test --config .\test\playwright.config.ts test-ui.spec.ts --grep "failed send status|failed message resend|failed send controls|resend"
```

Expected: source test passes; Playwright failed-send tests pass.

- [ ] **Step 6: Commit failed-send extraction**

```powershell
git add app\layout.tsx app\page.tsx app\features\chat\components\FailedSendControls.tsx app\features\chat\components\FailedSendControls.css test\failed-send-actions-layout.test.mjs
git commit -m "refactor: extract failed send controls" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Extract chat sidebar list

**Files:**
- Create: `app/features/chat/components/ChatSidebarList.tsx`
- Create: `app/features/chat/components/ChatSidebarList.css`
- Modify: `app/layout.tsx`
- Modify: `app/page.tsx`

- [ ] **Step 1: Create chat sidebar component**

Create `app/features/chat/components/ChatSidebarList.tsx`:

```tsx
'use client';

import { createPortal } from 'react-dom';
import type { CSSProperties, MutableRefObject } from 'react';
import type { Agent } from '../../agents/agentTypes';
import type { ChatHistoryEntry } from '../chatTypes';
import { normalizeChatHistory } from '../chatHelpers';

export type ChatSidebarStatus = {
  label: string;
  kind: 'running' | 'done' | 'error';
};

type ChatSidebarListProps = {
  chatHistory: ChatHistoryEntry[];
  currentChatId: string;
  activeSidebarChatId: string;
  chatName: string;
  chatAgentFilter: string | null;
  chatFilterAgents: Agent[];
  mounted: boolean;
  openChatMenuId: string | null;
  renamingChatId: string | null;
  renameValue: string;
  themeStyle: CSSProperties;
  chatMenuButtonRefs: MutableRefObject<Map<string, HTMLButtonElement>>;
  actionMenuWidth: number;
  actionMenuHeight: number;
  getChatSidebarStatus: (chatId: string) => ChatSidebarStatus | null;
  getStatusDisplayText: (label: string | undefined, fallback: string) => string;
  getSidebarStatusDisplayLabel: (label: string) => string;
  onCreateChat: () => void;
  onLoadChat: (chatId: string) => void;
  onOpenChatMenu: (chatId: string | null) => void;
  onRenameValueChange: (value: string) => void;
  onStartRename: (chat: ChatHistoryEntry, isCurrent: boolean) => void;
  onRenameChat: (chatId: string, value: string) => void;
  onShareChat: (chatId: string) => void;
  onDeleteChat: (chatId: string) => void;
};

export function ChatSidebarList({
  chatHistory,
  currentChatId,
  activeSidebarChatId,
  chatName,
  chatAgentFilter,
  chatFilterAgents,
  mounted,
  openChatMenuId,
  renamingChatId,
  renameValue,
  themeStyle,
  chatMenuButtonRefs,
  actionMenuWidth,
  actionMenuHeight,
  getChatSidebarStatus,
  getStatusDisplayText,
  getSidebarStatusDisplayLabel,
  onCreateChat,
  onLoadChat,
  onOpenChatMenu,
  onRenameValueChange,
  onStartRename,
  onRenameChat,
  onShareChat,
  onDeleteChat,
}: ChatSidebarListProps) {
  const allChats = (currentChatId && !chatHistory.some((chat) => chat.id === currentChatId))
    ? [{ id: currentChatId, name: chatName, ts: chatHistory[0]?.ts ? chatHistory[0].ts + 1 : Date.now() }, ...chatHistory]
    : chatHistory;
  const uniqueChats = normalizeChatHistory(allChats);
  const filteredChats = chatAgentFilter
    ? uniqueChats.filter((chat) => chat.agentId === chatAgentFilter || (!chat.agentId && chat.id === currentChatId))
    : uniqueChats;
  const selectedAgentName = chatAgentFilter
    ? chatFilterAgents.find((agent) => agent.id === chatAgentFilter)?.name || chatAgentFilter
    : '';

  return (
    <>
      <div className="newChatRow">
        <button className="newChatButton" onClick={onCreateChat}>
          + New Chat{chatAgentFilter ? ` (${selectedAgentName})` : ''}
        </button>
      </div>
      {filteredChats.map((chat) => {
        const isCurrent = chat.id === currentChatId;
        const isActive = chat.id === activeSidebarChatId;
        const sidebarStatus = getChatSidebarStatus(chat.id);
        const isRenaming = renamingChatId === chat.id;
        return (
          <div key={chat.id} className={`chatHistoryRow ${isActive ? 'active' : ''}`}>
            {isRenaming ? (
              <div className="chatRenameWrap">
                <input
                  className="chatRenameInput"
                  autoFocus
                  value={renameValue}
                  onChange={(event) => onRenameValueChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onRenameChat(chat.id, renameValue);
                    if (event.key === 'Escape') {
                      onOpenChatMenu(null);
                      onRenameValueChange('');
                    }
                  }}
                  onBlur={() => onRenameChat(chat.id, renameValue)}
                />
              </div>
            ) : (
              <button className={`chatHistoryItem ${isActive ? 'active' : ''}`} title={chat.name} onClick={() => { if (!isCurrent) onLoadChat(chat.id); }}>
                <span className="chatHistoryIcon">{isActive ? '💬' : '📝'}</span>
                <span className="chatHistoryText">
                  <span className="chatHistoryName">{isCurrent ? chatName : chat.name}</span>
                  <span className="chatHistoryMetaRow">
                    <span className="chatHistoryMeta" suppressHydrationWarning>
                      {mounted ? new Date(chat.ts).toLocaleDateString() : ''}
                    </span>
                    {sidebarStatus ? (
                      <span className={`chatStatusBadge ${sidebarStatus.kind}`} title={getStatusDisplayText(sidebarStatus.label, 'Running')}>
                        {getSidebarStatusDisplayLabel(sidebarStatus.label)}
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
            )}
            <div className="chatActionsWrap">
              <button
                type="button"
                ref={(node) => {
                  if (node) chatMenuButtonRefs.current.set(chat.id, node);
                  else chatMenuButtonRefs.current.delete(chat.id);
                }}
                className={`chatMoreBtn ${openChatMenuId === chat.id ? 'active' : ''}`}
                title="Chat actions"
                aria-haspopup="menu"
                aria-expanded={openChatMenuId === chat.id}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenChatMenu(openChatMenuId === chat.id ? null : chat.id);
                }}
              >
                ...
              </button>
              {openChatMenuId === chat.id ? (() => {
                const rect = chatMenuButtonRefs.current.get(chat.id)?.getBoundingClientRect();
                if (!rect) return null;
                const left = Math.max(8, Math.min(rect.right - actionMenuWidth, window.innerWidth - actionMenuWidth - 8));
                const top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - actionMenuHeight - 8));
                return createPortal(
                  <div className="chatActionsMenu" role="menu" style={{ ...themeStyle, position: 'fixed', top, left, right: 'auto', width: actionMenuWidth, zIndex: 9999 }}>
                    <button
                      type="button"
                      className="chatActionItem"
                      role="menuitem"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenChatMenu(null);
                        onStartRename(chat, isCurrent);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="chatActionItem"
                      role="menuitem"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenChatMenu(null);
                        onShareChat(chat.id);
                      }}
                    >
                      Share
                    </button>
                    <button
                      type="button"
                      className="chatActionItem danger"
                      role="menuitem"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteChat(chat.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>,
                  document.body,
                );
              })() : null}
            </div>
          </div>
        );
      })}
    </>
  );
}
```

- [ ] **Step 2: Create chat sidebar CSS**

Create `app/features/chat/components/ChatSidebarList.css` with:

```css
.newChatRow {
  display: flex;
  gap: 6px;
}

.newChatButton {
  flex: 1;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px dashed var(--border-strong);
  background: transparent;
  color: var(--text-soft);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.15s;
}

.newChatButton:hover {
  color: var(--accent);
  background: var(--accent-soft);
}

.newChatButton:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.chatRenameWrap {
  flex: 1;
  padding: 6px 12px;
}

.chatRenameInput {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  outline: none;
}

.chatHistoryItem {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-soft);
  cursor: pointer;
  transition: all 0.12s ease;
}

.chatHistoryItem:hover,
.chatHistoryItem.active {
  color: var(--text);
}

.chatHistoryIcon {
  font-size: 16px;
  flex: 0 0 auto;
}

.chatHistoryText {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 1px;
}

.chatHistoryName {
  font-size: 13px;
  font-weight: 600;
  color: inherit;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.chatHistoryMetaRow {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.chatHistoryMeta {
  font-size: 11px;
  color: var(--muted);
}

.chatStatusBadge {
  display: inline-flex;
  align-items: center;
  max-width: 96px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chatStatusBadge.running {
  color: var(--accent);
  background: var(--accent-soft);
}

.chatStatusBadge.done {
  color: var(--success);
  background: rgba(134, 239, 172, 0.12);
}

.chatStatusBadge.error {
  color: var(--danger);
  background: rgba(239, 68, 68, 0.12);
}

.chatHistoryRow {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: 14px;
  border: 1px solid transparent;
  position: relative;
  min-width: 0;
  transition: all 0.12s ease;
}

.chatHistoryRow .chatHistoryItem {
  flex: 1;
  min-width: 0;
}

.chatHistoryRow:hover,
.chatHistoryRow:focus-within {
  background: var(--panel-soft);
  border-color: var(--border);
  color: var(--text);
}

.chatHistoryRow.active {
  background: var(--panel-soft);
  border-color: var(--border-strong);
  box-shadow: inset 0 0 0 1px var(--accent-soft);
  border-radius: 14px;
}

.chatHistoryRow:hover .chatHistoryItem,
.chatHistoryRow:focus-within .chatHistoryItem,
.chatHistoryRow.active .chatHistoryItem {
  border-color: transparent;
  box-shadow: none;
  background: transparent;
}

.chatActionsWrap {
  flex: 0 0 auto;
  position: relative;
  margin-right: 4px;
}

.chatMoreBtn {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
  font-weight: 700;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s ease;
  opacity: 0;
  pointer-events: none;
}

.chatHistoryRow:hover .chatMoreBtn,
.chatHistoryRow:focus-within .chatMoreBtn,
.chatMoreBtn.active {
  opacity: 1;
  pointer-events: auto;
}

.chatMoreBtn:hover,
.chatMoreBtn.active {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--border);
}

.chatActionsMenu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 132px;
  padding: 6px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel-bg);
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.18);
  z-index: 30;
}

.chatActionItem {
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  transition: all 0.12s ease;
}

.chatActionItem:hover,
.chatActionItem:focus-visible {
  background: var(--accent-soft);
  color: var(--accent);
  outline: none;
}

.chatActionItem.danger {
  color: #d53f3f;
}

.chatActionItem.danger:hover,
.chatActionItem.danger:focus-visible {
  color: #e53e3e;
  background: rgba(229, 62, 62, 0.1);
}
```

- [ ] **Step 3: Import chat sidebar CSS from layout**

Modify `app/layout.tsx`:

```tsx
import './globals.css';
import './features/chat/components/FailedSendControls.css';
import './features/chat/components/ChatSidebarList.css';
import type { Metadata } from 'next';
```

- [ ] **Step 4: Wire chat sidebar component into page**

Add the import in `app/page.tsx`:

```tsx
import { ChatSidebarList } from './features/chat/components/ChatSidebarList';
```

Remove the `createPortal` import from `app/page.tsx` only if no other code still uses it.

Replace the inline New Chat row and chat history map inside the Chats tab with:

```tsx
<ChatSidebarList
  chatHistory={chatHistory}
  currentChatId={currentChatId}
  activeSidebarChatId={activeSidebarChatId}
  chatName={chatName}
  chatAgentFilter={chatAgentFilter}
  chatFilterAgents={chatFilterAgents}
  mounted={mounted}
  openChatMenuId={openChatMenuId}
  renamingChatId={renamingChatId}
  renameValue={renameValue}
  themeStyle={themeStyle}
  chatMenuButtonRefs={chatMenuButtonRefs}
  actionMenuWidth={CHAT_ACTION_MENU_WIDTH}
  actionMenuHeight={CHAT_ACTION_MENU_HEIGHT}
  getChatSidebarStatus={getChatSidebarStatus}
  getStatusDisplayText={getStatusDisplayText}
  getSidebarStatusDisplayLabel={getSidebarStatusDisplayLabel}
  onCreateChat={() => void createNewChat()}
  onLoadChat={(chatId) => void loadChat(chatId)}
  onOpenChatMenu={setOpenChatMenuId}
  onRenameValueChange={setRenameValue}
  onStartRename={(chat, isCurrent) => {
    setRenameValue(isCurrent ? chatName : chat.name);
    setRenamingChatId(chat.id);
  }}
  onRenameChat={(chatId, value) => void renameChatById(chatId, value)}
  onShareChat={(chatId) => void shareCurrentChat(chatId)}
  onDeleteChat={(chatId) => void deleteChatById(chatId)}
/>
```

Remove the moved chat sidebar CSS blocks from `app/page.tsx`.

- [ ] **Step 5: Run chat sidebar checks**

Run:

```powershell
node .\test\page-shell-targeted-refactor.test.mjs
npx playwright test --config .\test\playwright.config.ts test-ui.spec.ts --grep "should create a new chat|should switch between chats|should delete a chat|should switch lastChatId|should rename a chat"
```

Expected: source boundary test still fails until ChatComposer is extracted; selected Playwright chat/sidebar tests pass.

- [ ] **Step 6: Commit chat sidebar extraction**

```powershell
git add app\layout.tsx app\page.tsx app\features\chat\components\ChatSidebarList.tsx app\features\chat\components\ChatSidebarList.css
git commit -m "refactor: extract chat sidebar list" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Extract chat composer

**Files:**
- Create: `app/features/composer/components/ChatComposer.tsx`
- Create: `app/features/composer/components/ChatComposer.css`
- Modify: `app/layout.tsx`
- Modify: `app/page.tsx`
- Modify: `test/composer-layout.test.mjs`

- [ ] **Step 1: Create composer component**

Create `app/features/composer/components/ChatComposer.tsx`:

```tsx
'use client';

import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import type { Agent } from '../../agents/agentTypes';
import type { ChatAttachment } from '../attachmentTypes';
import { ATTACHMENT_ACCEPT } from '../attachmentHelpers';
import { AttachmentList } from './AttachmentList';

type ChatComposerProps = {
  composerRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  input: string;
  attachments: ChatAttachment[];
  attachmentError: string | null;
  isDraggingAttachment: boolean;
  mentionAgents: Agent[];
  mentionSelectedIndex: number;
  targetControls: ReactNode;
  isSending: boolean;
  sendDisabled: boolean;
  onMentionSelect: (agentId: string) => void;
  onFilesSelected: (files: FileList) => void;
  onRemoveAttachment: (id: string) => void;
  onPreviewAttachment: (dataUrl: string) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onInput: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onSend: () => void;
  onStop: () => void;
};

export function ChatComposer({
  composerRef,
  fileInputRef,
  input,
  attachments,
  attachmentError,
  isDraggingAttachment,
  mentionAgents,
  mentionSelectedIndex,
  targetControls,
  isSending,
  sendDisabled,
  onMentionSelect,
  onFilesSelected,
  onRemoveAttachment,
  onPreviewAttachment,
  onPaste,
  onKeyDown,
  onInput,
  onDragOver,
  onDragLeave,
  onDrop,
  onSend,
  onStop,
}: ChatComposerProps) {
  return (
    <section className="chatInputDock">
      <div className="composerStack">
        {mentionAgents.length > 0 && (
          <div className="mentionDropdown">
            {mentionAgents.map((agent, index) => (
              <button key={agent.id} className={`mentionItem ${mentionSelectedIndex === index ? 'selected' : ''}`} onClick={() => onMentionSelect(agent.id)}>
                <span className="mentionId">@{agent.id}</span>
                <span className="mentionDesc">{agent.name || ''}</span>
              </button>
            ))}
          </div>
        )}
        <div className="inputArea">
          <div
            className={`composerShell ${isDraggingAttachment ? 'dragOver' : ''}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              className="srOnlyFileInput"
              onChange={(event) => {
                const files = event.currentTarget.files;
                if (files && files.length > 0) onFilesSelected(files);
                event.currentTarget.value = '';
              }}
            />
            <AttachmentList attachments={attachments} mode="composer" onRemove={onRemoveAttachment} onPreview={onPreviewAttachment} />
            {attachmentError ? <div className="attachmentError" role="alert">{attachmentError}</div> : null}
            <div className="composerTextRow">
              <textarea
                ref={composerRef}
                className="composerTextarea"
                defaultValue={input}
                onPaste={onPaste}
                onKeyDown={onKeyDown}
                placeholder="Message Agents Chat"
                rows={1}
                spellCheck={false}
                onInput={onInput}
              />
            </div>
            <div className="composerToolbar">
              <div className="composerToolbarLeft">
                <button
                  type="button"
                  className="attachButton"
                  aria-label="Attach files or photos"
                  title="Attach files or photos"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <span className="attachButtonIcon" aria-hidden="true">
                    <svg viewBox="0 0 16 16" focusable="false">
                      <path d="M5.2 8.9l4.4-4.4a2.1 2.1 0 0 1 3 3l-5.3 5.3a3.4 3.4 0 0 1-4.8-4.8l5.6-5.6a.8.8 0 1 1 1.1 1.1L3.6 9.1a1.8 1.8 0 0 0 2.6 2.6l5.3-5.3a.5.5 0 0 0-.7-.7L6.3 10.1a.8.8 0 1 1-1.1-1.2z" />
                    </svg>
                  </span>
                </button>
                {targetControls}
              </div>
              <div className="composerActions composerToolbarActions">
                {isSending ? (
                  <button className="sendButton stopButton" onClick={onStop} aria-label="Stop generation">⏹</button>
                ) : (
                  <button className="sendButton" onClick={onSend} disabled={sendDisabled} aria-label="Send message">
                    <span className="sendButtonIcon">↑</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Confirm no browser-only `DataTransfer` fallback is used**

Run:

```powershell
rg "new DataTransfer" app\features\composer\components\ChatComposer.tsx
```

Expected: no matches. The file input handler should skip empty selections rather than constructing a browser-only object.

- [ ] **Step 3: Create composer CSS**

Create `app/features/composer/components/ChatComposer.css` with:

```css
.attachmentTray {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 0;
  padding: 0 0 2px;
}

.attachmentChip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(100%, 340px);
  border-radius: 8px;
  border: 1px solid var(--border);
  overflow: hidden;
  position: relative;
  min-height: 26px;
  padding: 4px 28px 4px 8px;
  background: color-mix(in srgb, var(--panel-strong) 88%, var(--accent-soft));
}

.attachmentThumb {
  width: 16px;
  height: 16px;
  object-fit: cover;
  border-radius: 3px;
  border: 1px solid var(--border);
  background: var(--panel-soft);
  flex: 0 0 auto;
}

.attachmentFileIcon {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
  background: transparent;
  border: 0;
  color: var(--accent);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 8px;
  font-weight: 800;
  line-height: 1;
  flex: 0 0 auto;
}

.attachmentFileIconLabel {
  display: block;
  max-width: 16px;
  overflow: hidden;
  text-align: center;
  letter-spacing: 0;
  text-transform: uppercase;
}

.attachmentMeta {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  gap: 2px;
}

.attachmentName {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-size: 13px;
  font-weight: 700;
}

.attachmentChip .attachmentName {
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
}

.attachmentRemoveButton {
  position: absolute;
  top: 50%;
  right: 5px;
  width: 18px;
  height: 18px;
  min-width: 18px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid transparent;
  background: color-mix(in srgb, var(--panel-soft) 82%, transparent);
  color: var(--text-soft);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
  transform: translateY(-50%);
}

.attachmentRemoveButton:hover,
.attachmentRemoveButton:focus-visible {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
}

.attachmentError {
  color: var(--danger);
  font-size: 12px;
  padding: 0 4px;
}

.composerStack {
  position: relative;
  width: 100%;
}

.mentionDropdown {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 10px);
  background: var(--panel-strong);
  border: 1px solid var(--border);
  border-radius: 18px;
  overflow: hidden;
  box-shadow: var(--shadow);
}

.mentionItem {
  width: 100%;
  text-align: left;
  padding: 11px 14px;
  border-radius: 0;
  border: 0;
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 10px;
  background: var(--panel-strong);
}

.mentionItem.selected {
  background: var(--accent-soft);
  outline: none;
}

.mentionItem:last-child {
  border-bottom: 0;
}

.mentionId {
  color: var(--accent);
  font-weight: 700;
}

.mentionDesc {
  color: var(--muted);
}

.inputArea {
  display: block;
}

.composerShell {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 8px;
  background: var(--panel-soft);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.06);
  transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
}

.composerShell:focus-within {
  border-color: var(--border-strong);
  box-shadow: 0 0 0 1px var(--accent-soft), 0 14px 30px rgba(0, 0, 0, 0.08);
  transform: translateY(-1px);
}

.composerShell.dragOver {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft), 0 14px 30px rgba(0, 0, 0, 0.1);
}

.srOnlyFileInput {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.orchPill {
  cursor: pointer;
  border-color: var(--border);
  background: transparent;
  color: var(--muted);
  transition: all 180ms cubic-bezier(0.4, 0, 0.2, 1);
}

.orchPill:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.orchPill.orchPillActive {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #fff;
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 22%, transparent);
}

.orchPill.orchPillActive:hover {
  filter: brightness(1.08);
}

.orchRoundsSelect {
  padding: 4px 20px 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: all 160ms ease;
  outline: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2345d7ff' opacity='0.7'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 7px center;
  background-size: 8px 5px;
}

.orchRoundsSelect:hover {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.orchRoundsSelect:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft), 0 4px 12px color-mix(in srgb, var(--accent) 18%, transparent);
  background-color: color-mix(in srgb, var(--accent-soft) 60%, var(--panel-soft));
}

.orchRoundsSelect option {
  background: var(--panel-strong);
  color: var(--fg);
  padding: 6px 10px;
  font-weight: 600;
}

.composerTextRow {
  display: flex;
  min-width: 0;
}

.composerToolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 34px;
}

.composerToolbarLeft {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
  flex-wrap: wrap;
}

.composerTextarea {
  flex: 1;
  width: 100%;
  min-height: 28px;
  max-height: 300px;
  resize: none;
  overflow-y: hidden;
  padding: 4px 0 6px;
  margin: 0;
  background: transparent;
  border: 0;
  color: var(--text);
  outline: none;
  line-height: 1.5;
  font-size: 15px;
  font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
}

.composerTextarea::placeholder {
  color: var(--muted);
}

.targetPills {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.composerActions {
  margin-left: auto;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
}

.composerToolbarActions {
  align-self: center;
}

.targetPill {
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  line-height: 1;
  font-weight: 700;
}

.rememberedAgentPill {
  gap: 6px;
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: color-mix(in srgb, var(--accent-soft) 70%, var(--panel-soft));
}

.rememberedAgentRemove {
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  line-height: 1;
  opacity: 0;
  transform: scale(0.9);
  transition: opacity 140ms ease, transform 140ms ease, background 140ms ease;
}

.rememberedAgentRemove::before {
  content: 'x';
}

.rememberedAgentPill:hover .rememberedAgentRemove,
.rememberedAgentRemove:focus-visible {
  opacity: 1;
  transform: scale(1);
}

.rememberedAgentRemove:hover {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}

.composerHint {
  display: none;
}

.attachButton {
  width: 32px;
  min-width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel-soft);
  color: var(--text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: center;
  line-height: 1;
  transition: background 160ms ease, border-color 160ms ease, color 160ms ease, transform 160ms ease;
}

.attachButtonIcon {
  width: 15px;
  height: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
}

.attachButtonIcon svg {
  width: 15px;
  height: 15px;
  display: block;
  fill: currentColor;
}

.attachButton:hover {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 38%, var(--border));
  background: var(--accent-soft);
  transform: translateY(-1px);
}

.attachButton:hover .attachButtonIcon {
  color: var(--accent);
}

.sendButton {
  width: 38px;
  min-width: 38px;
  height: 38px;
  padding: 0 !important;
  border-radius: 999px !important;
  border: 1px solid var(--send-button-border, color-mix(in srgb, var(--accent) 30%, transparent)) !important;
  background: var(--send-button-bg, linear-gradient(135deg, var(--accent), var(--accent-2))) !important;
  color: var(--send-button-color, white) !important;
  box-shadow: var(--send-button-shadow, 0 8px 18px color-mix(in srgb, var(--accent) 18%, transparent), inset 0 1px 0 rgba(255,255,255,0.22));
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: center;
}

.sendButton:hover:not(:disabled) {
  transform: translateY(-1px);
  filter: saturate(1.04) brightness(1.03);
}

.sendButton:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  box-shadow: none;
  filter: grayscale(0.08);
}

.sendButtonIcon {
  font-size: 18px;
  line-height: 1;
}

.stopButton {
  background: linear-gradient(135deg, var(--danger), color-mix(in srgb, var(--danger) 76%, black 24%)) !important;
  border-color: color-mix(in srgb, var(--danger) 58%, transparent) !important;
  color: #fff !important;
}

.stopButton:hover {
  filter: brightness(1.08);
}
```

- [ ] **Step 4: Import composer CSS from layout**

Modify `app/layout.tsx`:

```tsx
import './globals.css';
import './features/composer/components/ChatComposer.css';
import './features/chat/components/FailedSendControls.css';
import './features/chat/components/ChatSidebarList.css';
import type { Metadata } from 'next';
```

- [ ] **Step 5: Add target-controls helper in page**

In `app/page.tsx`, add this helper near `renderAgentModelSelect`:

```tsx
function renderComposerTargetControls() {
  if (mentionedAgentIds.length > 0) {
    return (
      <div className="targetPills">
        {mentionedAgentIds.map((agentId) => (
          <span key={agentId} className="targetPill modelTargetPill">
            <span>@{agentId}</span>
            {renderAgentModelSelect(agentId)}
          </span>
        ))}
        {orchestrationEnabled && (
          <>
            <button
              type="button"
              className={`targetPill orchPill ${orchestrationMode === 'auto' ? 'orchPillActive' : ''}`}
              onClick={() => setOrchestrationMode('auto')}
              title="Auto: a scheduler decides which agent to call next based on results"
            >
              🧠 Auto
            </button>
            <button
              type="button"
              className={`targetPill orchPill ${orchestrationMode === 'pipeline' ? 'orchPillActive' : ''}`}
              onClick={() => setOrchestrationMode('pipeline')}
              title="Pipeline: agents run sequentially, each receives the previous agent's output"
            >
              🔀 Pipeline
            </button>
            <button
              type="button"
              className={`targetPill orchPill ${orchestrationMode === 'discussion' ? 'orchPillActive' : ''}`}
              onClick={() => setOrchestrationMode('discussion')}
              title="Discussion: agents run in parallel, then a summary is generated"
            >
              💬 Discussion
            </button>
            {orchestrationMode === 'discussion' && (
              <select
                className="orchRoundsSelect"
                value={discussionRounds}
                onChange={(event) => setDiscussionRounds(Number(event.target.value))}
                title="Number of discussion rounds"
              >
                {[1, 2, 3, 4, 5].map((round) => (
                  <option key={round} value={round}>{round} {round === 1 ? 'round' : 'rounds'}</option>
                ))}
              </select>
            )}
          </>
        )}
      </div>
    );
  }

  if (!effectiveComposerAgentId) return null;

  return (
    <div className="targetPills">
      <span className="targetPill rememberedAgentPill modelTargetPill">
        <span>@{effectiveComposerAgentId}</span>
        {renderAgentModelSelect(effectiveComposerAgentId)}
        {rememberedComposerAgentId ? (
          <button
            type="button"
            className="rememberedAgentRemove"
            aria-label={`Remove remembered agent ${effectiveComposerAgentId}`}
            title="Use the chat primary/default agent instead"
            onClick={() => clearRememberedChatAgent(currentChatId)}
          />
        ) : null}
      </span>
    </div>
  );
}
```

- [ ] **Step 6: Add textarea key handler in page**

Move the existing inline textarea `onKeyDown` body into this function in `app/page.tsx`:

```tsx
function handleComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
  if (filteredAgents.length > 0) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setMentionSelectedIndex((p) => (p + 1) % filteredAgents.length); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setMentionSelectedIndex((p) => (p - 1 + filteredAgents.length) % filteredAgents.length); return; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const sel = filteredAgents[mentionSelectedIndex] || filteredAgents[0];
      if (sel) selectMention(sel.id);
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); setInputProgrammatic(inputRef.current.replace(/@(\S*)$/, '')); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (isCurrentChatSending) { void handleStop(); } else { void handleSend(); } }
  if (filteredAgents.length === 0) {
    const caretStart = e.currentTarget.selectionStart ?? 0;
    const caretEnd = e.currentTarget.selectionEnd ?? 0;
    const currentVal = e.currentTarget.value;
    const singleLine = !currentVal.includes('\n');
    if (e.key === 'ArrowUp' && singleLine && caretStart === 0 && caretEnd === 0) {
      e.preventDefault();
      const hist = inputHistoryRef.current[currentChatIdRef.current] || [];
      if (hist.length === 0) return;
      if (inputHistoryIndexRef.current === -1) inputDraftRef.current = currentVal;
      const newIdx = inputHistoryIndexRef.current === -1 ? hist.length - 1 : Math.max(0, inputHistoryIndexRef.current - 1);
      inputHistoryIndexRef.current = newIdx;
      setInputProgrammatic(hist[newIdx]);
      return;
    }
    if (e.key === 'ArrowDown' && singleLine && caretStart === currentVal.length && caretEnd === currentVal.length) {
      e.preventDefault();
      const hist = inputHistoryRef.current[currentChatIdRef.current] || [];
      if (inputHistoryIndexRef.current === -1) return;
      const newIdx = inputHistoryIndexRef.current + 1;
      if (newIdx >= hist.length) {
        inputHistoryIndexRef.current = -1;
        setInputProgrammatic(inputDraftRef.current);
      } else {
        inputHistoryIndexRef.current = newIdx;
        setInputProgrammatic(hist[newIdx]);
      }
    }
  }
}
```

If `React.KeyboardEvent` is unavailable because only specific React types are imported, add `type KeyboardEvent` to the existing React import and use `KeyboardEvent<HTMLTextAreaElement>`.

- [ ] **Step 7: Wire composer component into page**

Add the import in `app/page.tsx`:

```tsx
import { ChatComposer } from './features/composer/components/ChatComposer';
```

Replace the full inline `<section className="chatInputDock">...</section>` composer block with:

```tsx
<ChatComposer
  composerRef={composerRef}
  fileInputRef={fileInputRef}
  input={input}
  attachments={attachments}
  attachmentError={attachmentError}
  isDraggingAttachment={isDraggingAttachment}
  mentionAgents={filteredAgents}
  mentionSelectedIndex={mentionSelectedIndex}
  targetControls={renderComposerTargetControls()}
  isSending={isCurrentChatSending}
  sendDisabled={agents.length === 0}
  onMentionSelect={selectMention}
  onFilesSelected={(files) => { void addFilesToComposer(files); }}
  onRemoveAttachment={removeAttachment}
  onPreviewAttachment={setLightboxImage}
  onPaste={handleAttachmentPaste}
  onKeyDown={handleComposerKeyDown}
  onInput={composerInputHandler}
  onDragOver={handleComposerDragOver}
  onDragLeave={handleComposerDragLeave}
  onDrop={handleComposerDrop}
  onSend={() => void handleSend()}
  onStop={() => void handleStop()}
/>
```

Remove `ATTACHMENT_ACCEPT` from `app/page.tsx` imports if it is no longer used there.

Remove composer and attachment-tray CSS blocks moved into `ChatComposer.css` from `app/page.tsx`.

- [ ] **Step 8: Run composer checks**

Run:

```powershell
node .\test\composer-layout.test.mjs
node .\test\page-shell-targeted-refactor.test.mjs
npx playwright test --config .\test\playwright.config.ts test-ui.spec.ts --grep "ACP attachments|should display chat input|should create a new chat|should send a message"
npx playwright test --config .\test\playwright.config.ts agent-composer-default-model.spec.ts agent-composer-ensure-models.spec.ts agent-model-selection-video.spec.ts
```

Expected: source tests pass; composer, attachment, and model picker Playwright tests pass.

- [ ] **Step 9: Commit composer extraction**

```powershell
git add app\layout.tsx app\page.tsx app\features\composer\components\ChatComposer.tsx app\features\composer\components\ChatComposer.css test\composer-layout.test.mjs test\page-shell-targeted-refactor.test.mjs
git commit -m "refactor: extract chat composer" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Final cleanup and verification

**Files:**
- Modify only files touched by Tasks 1-4 if verification exposes import, type, or selector issues.

- [ ] **Step 1: Check for stale imports and duplicate CSS**

Run:

```powershell
rg "renderUserSendFailureNotice|renderUserSendFailureActions|className=\\{`composerShell|className=\\{`chatHistoryRow|ATTACHMENT_ACCEPT" app\page.tsx
```

Expected:

- no matches for the deleted render functions
- no matches for inline composer shell or chat history row markup
- `ATTACHMENT_ACCEPT` only appears outside `app/page.tsx`

- [ ] **Step 2: Run all source tests**

Run:

```powershell
Set-Location Q:\Repos\Agents-Chat\.worktrees\layered-refactor-impl
foreach ($f in Get-ChildItem .\test -Filter *.test.mjs | Sort-Object Name) {
  Write-Host "Running $($f.Name)"
  node $f.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: every `*.test.mjs` prints its pass message and the command exits `0`.

- [ ] **Step 3: Run production build**

Run:

```powershell
npm run build
```

Expected: build exits `0`. Existing Next.js workspace-root, deprecated middleware, or Turbopack tracing warnings are acceptable if the build succeeds.

- [ ] **Step 4: Run full Playwright suite**

Run:

```powershell
$env:PLAYWRIGHT_BASE_URL='https://localhost:3010'
npx playwright test --config .\test\playwright.config.ts --reporter=line
```

Expected: full suite passes with the existing skipped tests only.

- [ ] **Step 5: Inspect page size and final status**

Run:

```powershell
(Get-Content .\app\page.tsx | Measure-Object -Line).Lines
git --no-pager status --short
```

Expected: `app/page.tsx` line count is lower than the pre-refactor count of `8550`, and `git status --short` is clean after the final commit.

- [ ] **Step 6: Commit verification fixes if needed**

If Step 1-4 required any fixes, commit them:

```powershell
git add app\layout.tsx app\page.tsx app\features\composer\components app\features\chat\components test
git commit -m "fix: stabilize page shell extraction" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If no fixes were needed, do not create an empty commit.
