import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderInstruction } from '../lib/workflow/templating.mjs';

test('substitutes {{input}}', () => {
  const out = renderInstruction('hi {{input}}', 'hello', {}, []);
  assert.equal(out, 'hi hello');
});

test('substitutes {{node.output}} when provided', () => {
  const out = renderInstruction('use {{a.output}}', '', { a: 'foo' }, ['a']);
  assert.equal(out, 'use foo');
});

test('throws on unknown template variable', () => {
  assert.throws(
    () => renderInstruction('hi {{ghost.output}}', '', {}, []),
    /unknown template/i,
  );
});

test('auto-appends upstream outputs when instruction has no {{}}', () => {
  const out = renderInstruction(
    'summarize',
    'orig',
    { a: 'first', b: 'second' },
    ['a', 'b'],
  );
  assert.match(out, /summarize/);
  assert.match(out, /--- a\.output ---\nfirst/);
  assert.match(out, /--- b\.output ---\nsecond/);
});

test('does not auto-append when instruction has {{}}', () => {
  const out = renderInstruction(
    'use just {{a.output}}',
    '',
    { a: 'A', b: 'B' },
    ['a', 'b'],
  );
  assert.equal(out, 'use just A');
  assert.doesNotMatch(out, /---/);
});

test('handles multiple substitutions of same var', () => {
  const out = renderInstruction('{{a.output}} and {{a.output}}', '', { a: 'X' }, ['a']);
  assert.equal(out, 'X and X');
});
