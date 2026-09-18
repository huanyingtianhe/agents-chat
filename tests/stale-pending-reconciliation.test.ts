import assert from 'node:assert/strict';
import type { ChatMessage } from '../app/features/chat/chatTypes';
import {
  collectInterruptedAgentIds,
  reconcileStalePendingMessages,
  toAgentResumeOutcome,
  type AgentResumeOutcome,
} from '../app/features/chat/runtime/reconcileStalePendingMessages';

const messages: ChatMessage[] = [
  {
    id: 'stale-with-content',
    type: 'agent',
    agentId: 'alpha',
    content: 'Partial answer',
    ts: 1,
    pending: true,
    statusText: 'Reading shell output',
    ptyPhase: 'thinking',
    parts: [{ kind: 'tool', toolName: 'Reading shell output', done: true, result: 'partial result' }],
  },
  {
    id: 'stale-empty',
    type: 'agent',
    agentId: 'alpha',
    content: '',
    ts: 2,
    pending: true,
    statusText: 'Thinking',
  },
  {
    id: 'other-agent',
    type: 'agent',
    agentId: 'beta',
    content: '',
    ts: 3,
    pending: true,
    statusText: 'Running',
  },
  {
    id: 'completed',
    type: 'agent',
    agentId: 'alpha',
    content: 'Done',
    ts: 4,
    pending: false,
  },
];

const result = reconcileStalePendingMessages(messages, new Set(['alpha']));
assert.equal(result.changed, true);
assert.notEqual(result.messages, messages);
assert.deepEqual(result.messages[0], {
  ...messages[0],
  pending: false,
  statusText: 'Interrupted',
  ptyPhase: undefined,
  userRequest: undefined,
});
assert.equal(result.messages[0].parts, messages[0].parts);
assert.equal(result.messages[1].content, '⏹ Interrupted');
assert.equal(result.messages[1].pending, false);
assert.equal(result.messages[1].statusText, 'Interrupted');
assert.equal(result.messages[2], messages[2]);
assert.equal(result.messages[3], messages[3]);

const unchanged = reconcileStalePendingMessages(messages, new Set());
assert.equal(unchanged.changed, false);
assert.equal(unchanged.messages, messages);

const outcomes: AgentResumeOutcome[] = [
  { agentId: 'no-turn', status: 'fulfilled', activeTurn: null },
  { agentId: 'done-turn', status: 'fulfilled', activeTurn: { done: true } },
  { agentId: 'live-turn', status: 'fulfilled', activeTurn: { done: false } },
  { agentId: 'failed-resume', status: 'rejected' },
];

assert.deepEqual(
  [...collectInterruptedAgentIds(outcomes)],
  ['no-turn', 'done-turn'],
);

assert.deepEqual(
  toAgentResumeOutcome('failed', {
    status: 'fulfilled',
    value: { ok: false, activeTurn: null },
  }),
  { agentId: 'failed', status: 'rejected' },
);
assert.deepEqual(
  toAgentResumeOutcome('successful', {
    status: 'fulfilled',
    value: { ok: true, activeTurn: null },
  }),
  { agentId: 'successful', status: 'fulfilled', activeTurn: null },
);

console.log('stale pending reconciliation tests passed');
