import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../app/features/chat/runtime/chatPersistenceService.ts', import.meta.url),
  'utf8',
);

assert.match(source, /export type LoadChatResult = 'loaded' \| 'failed' \| 'superseded'/);
assert.match(source, /isCurrentSelection: \(\) => boolean/);
assert.match(source, /if \(!isCurrentSelection\(\)\) return 'superseded'/);

console.log('chat selection load guard tests passed');
