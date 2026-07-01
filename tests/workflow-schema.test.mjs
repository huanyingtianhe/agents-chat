import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflowPlan } from '../lib/workflow/workflowSchema.mjs';

test('accepts a valid 2-node plan', () => {
  const res = validateWorkflowPlan({
    version: 1,
    nodes: [
      { id: 'a', agent: 'x', instruction: 'do', dependsOn: [] },
      { id: 'b', agent: 'y', instruction: 'use {{a.output}}', dependsOn: ['a'] },
    ],
  });
  assert.equal(res.ok, true);
});

test('rejects non-object input', () => {
  const res = validateWorkflowPlan('hello');
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'not_object');
});

test('rejects empty nodes array', () => {
  const res = validateWorkflowPlan({ version: 1, nodes: [] });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'empty_nodes');
});

test('rejects duplicate node ids', () => {
  const res = validateWorkflowPlan({
    version: 1,
    nodes: [
      { id: 'a', agent: 'x', instruction: 'i', dependsOn: [] },
      { id: 'a', agent: 'y', instruction: 'j', dependsOn: [] },
    ],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'duplicate_node_id');
});

test('rejects unknown dependency', () => {
  const res = validateWorkflowPlan({
    version: 1,
    nodes: [{ id: 'a', agent: 'x', instruction: 'i', dependsOn: ['ghost'] }],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'unknown_dependency');
});

test('rejects cycles', () => {
  const res = validateWorkflowPlan({
    version: 1,
    nodes: [
      { id: 'a', agent: 'x', instruction: 'i', dependsOn: ['b'] },
      { id: 'b', agent: 'y', instruction: 'j', dependsOn: ['a'] },
    ],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'cycle');
});

test('rejects template references to nodes that are not transitive deps', () => {
  const res = validateWorkflowPlan({
    version: 1,
    nodes: [
      { id: 'a', agent: 'x', instruction: 'i', dependsOn: [] },
      { id: 'b', agent: 'y', instruction: 'use {{a.output}}', dependsOn: [] },
    ],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'unknown_template_ref');
});

test('accepts {{input}} reference without it being a dependency', () => {
  const res = validateWorkflowPlan({
    version: 1,
    nodes: [{ id: 'a', agent: 'x', instruction: 'hi {{input}}', dependsOn: [] }],
  });
  assert.equal(res.ok, true);
});
