import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recoverInterruptedOrchestration,
  RELOAD_RECOVERY_PROMPT,
  isTerminalStatus,
} from '../lib/workflow/recoverInterrupted.mjs';

const plan = {
  version: 1,
  nodes: [
    { id: 'a', agent: 'x', instruction: 'A', dependsOn: [] },
    { id: 'b', agent: 'x', instruction: 'B uses {{a.output}}', dependsOn: ['a'] },
    { id: 'c', agent: 'x', instruction: 'C uses {{b.output}}', dependsOn: ['b'] },
  ],
};

function baseState(overrides = {}) {
  return {
    id: 'orch-1',
    mode: 'workflow',
    sourceChatId: 'chat-1',
    workflowPlan: plan,
    nodeStatuses: { a: 'ok', b: 'running', c: 'pending' },
    results: { a: 'A done' },
    summaryStarted: false,
    ...overrides,
  };
}

test('running node is converted to awaiting-input with synthetic prompt', () => {
  const before = baseState();
  const after = recoverInterruptedOrchestration(before);

  assert.equal(after.nodeStatuses.b, 'awaiting-input',
    'node that was running is now awaiting user input');
  assert.equal(after.results.b, RELOAD_RECOVERY_PROMPT,
    'synthetic prompt explains the interruption');
  assert.equal(after.nodeStatuses.a, 'ok', 'completed node unchanged');
  assert.equal(after.nodeStatuses.c, 'pending', 'pending node unchanged');
});

test('does not mutate the input state', () => {
  const before = baseState();
  const snapshot = JSON.parse(JSON.stringify(before));
  recoverInterruptedOrchestration(before);
  assert.deepEqual(before, snapshot, 'input is unchanged');
});

test('existing result is preserved (no overwrite of partial output)', () => {
  const before = baseState({
    nodeStatuses: { a: 'ok', b: 'running', c: 'pending' },
    results: { a: 'A done', b: 'partial output before crash' },
  });
  const after = recoverInterruptedOrchestration(before);
  assert.equal(after.nodeStatuses.b, 'awaiting-input');
  assert.equal(after.results.b, 'partial output before crash',
    'pre-existing result is kept; synthetic prompt only fills if empty');
});

test('non-running statuses are untouched', () => {
  for (const status of ['pending', 'awaiting-input', 'ok', 'failed', 'skipped']) {
    const before = baseState({
      nodeStatuses: { a: 'ok', b: status, c: 'pending' },
    });
    const after = recoverInterruptedOrchestration(before);
    assert.equal(after.nodeStatuses.b, status,
      `status '${status}' is preserved across recovery`);
  }
});

test('summaryStarted recomputed: all nodes terminal -> true', () => {
  const before = baseState({
    nodeStatuses: { a: 'ok', b: 'ok', c: 'failed' },
    summaryStarted: false,
  });
  const after = recoverInterruptedOrchestration(before);
  assert.equal(after.summaryStarted, true, 'all-terminal -> summaryStarted true');
});

test('summaryStarted recomputed: any non-terminal -> false', () => {
  const before = baseState({
    nodeStatuses: { a: 'ok', b: 'awaiting-input', c: 'pending' },
    summaryStarted: true,
  });
  const after = recoverInterruptedOrchestration(before);
  assert.equal(after.summaryStarted, false, 'awaiting-input is non-terminal');
});

test('after recovery, state is shaped for the existing resume path to retry', () => {
  // The resume path in useChatRuntime.sendWorkflowFollowUpReply / handleSend
  // looks for nodes with status === 'awaiting-input' that belong to a workflow
  // orchestration in the current chat. It re-dispatches them on user reply.
  const before = baseState();
  const after = recoverInterruptedOrchestration(before);

  const awaiting = Object.entries(after.nodeStatuses)
    .filter(([, s]) => s === 'awaiting-input')
    .map(([id]) => id);

  assert.deepEqual(awaiting, ['b'],
    'exactly one node is awaiting input -> resume path will target it');
  assert.equal(after.mode, 'workflow', 'mode preserved -> resume routing applies');
  assert.equal(after.sourceChatId, 'chat-1', 'chat scoping preserved');
});

test('isTerminalStatus matches the documented terminal set', () => {
  assert.equal(isTerminalStatus('ok'), true);
  assert.equal(isTerminalStatus('failed'), true);
  assert.equal(isTerminalStatus('skipped'), true);
  assert.equal(isTerminalStatus('stopped'), true);
  assert.equal(isTerminalStatus('pending'), false);
  assert.equal(isTerminalStatus('running'), false);
  assert.equal(isTerminalStatus('awaiting-input'), false);
});
