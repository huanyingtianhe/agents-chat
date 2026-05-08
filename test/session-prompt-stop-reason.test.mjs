import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const routeSource = readFileSync(new URL('../app/api/acp/route.ts', import.meta.url), 'utf8');

assert.match(
  routeSource,
  /function\s+finishTurnAfterPromptResult\s*\([\s\S]*?stopReason[\s\S]*?turn\.fullText\.trim\(\)[\s\S]*?Agent stopped without a response/,
  'route.ts should convert a non-end_turn prompt result with no text into a visible turn error',
);

assert.match(
  routeSource,
  /stopReason\s*!==\s*['"]end_turn['"]/,
  'route.ts should explicitly check for stopReason !== end_turn',
);

const helperCalls = routeSource.match(/finishTurnAfterPromptResult\(/g) || [];
assert.ok(
  helperCalls.length >= 3,
  'both initial prompt and retry prompt completions should use finishTurnAfterPromptResult',
);

console.log('session prompt stopReason checks passed');
