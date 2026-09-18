import assert from 'node:assert/strict';
import { mergeStoredMessages, type StoredMessage } from '../lib/chatStore';

const userMessage: StoredMessage = {
  id: 'user-1',
  type: 'user',
  content: 'Continue',
  ts: 1,
};
const interruptedMessage: StoredMessage = {
  id: 'agent-1',
  type: 'agent',
  agentId: 'alpha',
  content: 'Partial output',
  ts: 2,
  pending: false,
  statusText: 'Interrupted',
};
const stalePendingMessage: StoredMessage = {
  ...interruptedMessage,
  pending: true,
  statusText: 'Reading shell output',
};

assert.deepEqual(
  mergeStoredMessages(
    [userMessage, interruptedMessage],
    [userMessage, stalePendingMessage],
  ),
  [userMessage, interruptedMessage],
);

const updatedCompletedMessage = {
  ...interruptedMessage,
  content: 'Completed output',
  statusText: undefined,
};
assert.deepEqual(
  mergeStoredMessages(
    [userMessage, interruptedMessage],
    [userMessage, updatedCompletedMessage],
  ),
  [userMessage, updatedCompletedMessage],
);

console.log('chat store message merge tests passed');
