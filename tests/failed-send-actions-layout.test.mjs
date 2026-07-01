import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const messageBubbleSource = readFileSync(new URL('../app/features/messages/components/MessageBubble.tsx', import.meta.url), 'utf8');
const messageListCss = readFileSync(new URL('../app/features/messages/components/MessageList.css', import.meta.url), 'utf8');
const failedSendSource = readFileSync(new URL('../app/features/chat/components/FailedSendControls.tsx', import.meta.url), 'utf8');
const failedSendCss = readFileSync(new URL('../app/features/chat/components/FailedSendControls.css', import.meta.url), 'utf8');

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = failedSendCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected CSS block for ${selector}`);
  return match[1];
}

assert.match(
  messageBubbleSource,
  /<FailedSendNotice failure=\{failedSend\} \/>[\s\S]*<FailedSendActions message=\{message\} failure=\{failedSend\}/,
  'MessageBubble.tsx should render FailedSendNotice and FailedSendActions components with failedSend prop',
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
  messageListCss,
  /\.messageActionsWithFailure\s*\{[^}]*justify-content:\s*flex-end;/,
  'failed send actions should align to the right when they are the only action row controls',
);

assert.match(
  messageListCss,
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
