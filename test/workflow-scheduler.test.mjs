import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlanPrompt,
  buildReplanPrompt,
  parseSchedulerPlanResponse,
} from '../lib/workflow/scheduler.mjs';

test('plan prompt includes user message and agent list', () => {
  const p = buildPlanPrompt({
    userMessage: 'fix bug X',
    agents: [
      { id: 'coder', description: 'writes code' },
      { id: 'tester', description: 'tests' },
    ],
  });
  assert.match(p, /fix bug X/);
  assert.match(p, /coder.*writes code/);
  assert.match(p, /tester.*tests/);
  assert.match(p, /JSON/i);
});

test('replan prompt includes original, failed node, and completed outputs', () => {
  const p = buildReplanPrompt({
    userMessage: 'review pr',
    agents: [{ id: 'r', description: 'reviewer' }],
    originalPlan: {
      version: 1,
      nodes: [{ id: 'a', agent: 'r', instruction: 'go', dependsOn: [] }],
    },
    failedNodeId: 'a',
    failureMessage: 'agent timeout',
    completedOutputs: { x: 'done earlier' },
  });
  assert.match(p, /review pr/);
  assert.match(p, /a/);
  assert.match(p, /agent timeout/);
  assert.match(p, /done earlier/);
});

test('parses scheduler response wrapped in code fences', () => {
  const raw =
    'Sure!\n```json\n{"version":1,"nodes":[{"id":"a","agent":"x","instruction":"i","dependsOn":[]}]}\n```\nlet me know.';
  const res = parseSchedulerPlanResponse(raw);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.plan.nodes.length, 1);
});

test('parses bare JSON response', () => {
  const raw =
    '{"version":1,"nodes":[{"id":"a","agent":"x","instruction":"i","dependsOn":[]}]}';
  const res = parseSchedulerPlanResponse(raw);
  assert.equal(res.ok, true);
});

test('returns error on invalid JSON', () => {
  const res = parseSchedulerPlanResponse('not json at all');
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /parse/i);
});

test('returns error on invalid plan shape', () => {
  const res = parseSchedulerPlanResponse('{"version":1,"nodes":[]}');
  assert.equal(res.ok, false);
});
