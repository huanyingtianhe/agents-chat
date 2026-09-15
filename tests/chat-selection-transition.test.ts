import assert from 'node:assert/strict';
import { createChatSelectionToken } from '../app/features/chat/hooks/chatSelectionTransitionHelpers';

const sequence = { current: 0 };
const first = createChatSelectionToken(sequence, 'chat-a');
assert.equal(first.chatId, 'chat-a');
assert.equal(first.isCurrent(), true);

const second = createChatSelectionToken(sequence, 'chat-b');
assert.equal(first.isCurrent(), false);
assert.equal(second.isCurrent(), true);

second.invalidate();
assert.equal(second.isCurrent(), false);

console.log('chat selection transition tests passed');
