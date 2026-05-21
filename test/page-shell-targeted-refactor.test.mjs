import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pageSource = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../app/features/chat/ChatPageClient.tsx', import.meta.url), 'utf8');
const layoutSource = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
const chatComposer = readFileSync(new URL('../app/features/composer/components/ChatComposer.tsx', import.meta.url), 'utf8');
const chatSidebarList = readFileSync(new URL('../app/features/chat/components/ChatSidebarList.tsx', import.meta.url), 'utf8');
const failedSendControls = readFileSync(new URL('../app/features/chat/components/FailedSendControls.tsx', import.meta.url), 'utf8');
const messageBubble = readFileSync(new URL('../app/features/messages/components/MessageBubble.tsx', import.meta.url), 'utf8');

assert.match(clientSource, /import \{ ChatComposer \} from '\.\.\/composer\/components\/ChatComposer';/);
assert.match(clientSource, /import \{ ChatSidebarList \} from '\.\/components\/ChatSidebarList';/);

// FailedSendActions/FailedSendNotice are used in MessageBubble, not page.tsx
assert.doesNotMatch(pageSource, /import \{[^}]*FailedSendActions[^}]*\} from '\.\/features\/chat\/components\/FailedSendControls'/);
assert.doesNotMatch(pageSource, /import \{[^}]*FailedSendNotice[^}]*\} from '\.\/features\/chat\/components\/FailedSendControls'/);
assert.match(messageBubble, /import \{[^}]*FailedSendActions[^}]*\} from '.*FailedSendControls'/);
assert.match(messageBubble, /import \{[^}]*FailedSendNotice[^}]*\} from '.*FailedSendControls'/);

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

assert.match(clientSource, /import \{ MessageList \} from '\.\.\/messages\/components\/MessageList';/);
assert.doesNotMatch(pageSource, /const mdComponents =/);
assert.doesNotMatch(pageSource, /function linkifyHtmlPaths/);
assert.match(layoutSource, /import '\.\/features\/messages\/components\/MessageList\.css';/);

console.log('page shell targeted refactor checks passed');
