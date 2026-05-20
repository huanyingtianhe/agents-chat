import assert from 'node:assert/strict';
import { runAgentOnce } from './agentRunner.ts';

assert.equal(typeof runAgentOnce, 'function', 'runAgentOnce should be a function');
console.log('OK: runAgentOnce is a function');
