import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRepoWorkflows } from '../lib/workflow/repoWorkflows.mjs';

test('loads the demo code-review workflow', async () => {
  const list = await loadRepoWorkflows();
  const cr = list.find((w) => w.name === 'code-review');
  assert.ok(cr, 'code-review workflow should be loaded');
  assert.equal(cr.source, 'repo');
  assert.equal(cr.plan.nodes.length, 3);
});

test('returns an array (even if no workflows exist)', async () => {
  const list = await loadRepoWorkflows();
  assert.ok(Array.isArray(list));
});
