import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../lib/workflow/executor.mjs';

const plan2parallel1join = {
  version: 1,
  nodes: [
    { id: 'a', agent: 'x', instruction: 'A', dependsOn: [] },
    { id: 'b', agent: 'x', instruction: 'B', dependsOn: [] },
    { id: 'c', agent: 'x', instruction: 'C uses {{a.output}} {{b.output}}', dependsOn: ['a', 'b'] },
  ],
};

test('runs nodes in topological order; parallel layer dispatched concurrently', async () => {
  const dispatched = [];
  let inFlight = 0;
  let maxParallel = 0;
  const dispatcher = async (node) => {
    inFlight++;
    maxParallel = Math.max(maxParallel, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    dispatched.push(node.id);
    return `out-${node.id}`;
  };
  const state = await runWorkflow(plan2parallel1join, 'orig', dispatcher);
  assert.equal(state.nodeStatuses.a, 'ok');
  assert.equal(state.nodeStatuses.b, 'ok');
  assert.equal(state.nodeStatuses.c, 'ok');
  assert.equal(state.nodeOutputs.c, 'out-c');
  assert.deepEqual(dispatched.slice(-1), ['c']);
  assert.equal(maxParallel, 2, 'a and b should run concurrently');
});

test('skips downstream when upstream fails', async () => {
  const dispatcher = async (node) => {
    if (node.id === 'a') throw new Error('A blew up');
    return `out-${node.id}`;
  };
  const state = await runWorkflow(plan2parallel1join, 'orig', dispatcher);
  assert.equal(state.nodeStatuses.a, 'failed');
  assert.equal(state.nodeStatuses.b, 'ok');
  assert.equal(state.nodeStatuses.c, 'skipped');
});

test('substitutes templates with upstream outputs in dispatched instruction', async () => {
  const seen = {};
  const dispatcher = async (node, rendered) => {
    seen[node.id] = rendered;
    return `out-${node.id}`;
  };
  await runWorkflow(plan2parallel1join, 'orig', dispatcher);
  assert.equal(seen.c, 'C uses out-a out-b');
});

test('emits status callback for each transition', async () => {
  const events = [];
  const dispatcher = async (node) => `out-${node.id}`;
  await runWorkflow(plan2parallel1join, 'orig', dispatcher, {
    onStatusChange: (nodeId, status) => events.push(`${nodeId}=${status}`),
  });
  for (const id of ['a', 'b', 'c']) {
    assert.ok(events.includes(`${id}=running`), `expected ${id}=running`);
    assert.ok(events.includes(`${id}=ok`), `expected ${id}=ok`);
  }
});

test('substitutes {{input}}', async () => {
  const seen = {};
  const plan = {
    version: 1,
    nodes: [{ id: 'a', agent: 'x', instruction: 'hi {{input}}', dependsOn: [] }],
  };
  await runWorkflow(plan, 'world', async (node, rendered) => {
    seen[node.id] = rendered;
    return 'out';
  });
  assert.equal(seen.a, 'hi world');
});
