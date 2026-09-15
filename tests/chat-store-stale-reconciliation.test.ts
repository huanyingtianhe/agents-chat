import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();

async function main() {
  const testDir = await mkdtemp(path.join(tmpdir(), 'agents-chat-stale-reconciliation-'));
  try {
    process.chdir(testDir);
    const {
      getChat,
      reconcileStalePendingMessagesForAgent,
      saveChat,
    } = await import('../lib/chatStore');

    await saveChat('user-1', {
      id: 'chat-1',
      name: 'Stale chat',
      ts: 1,
      messages: [
        {
          id: 'pending-alpha',
          type: 'agent',
          agentId: 'alpha',
          content: '',
          ts: 1,
          pending: true,
          statusText: 'Reading shell output',
          parts: [{ kind: 'tool', toolName: 'read_shell', done: true }],
        },
        {
          id: 'pending-beta',
          type: 'agent',
          agentId: 'beta',
          content: '',
          ts: 2,
          pending: true,
          statusText: 'Thinking',
        },
      ],
      agentSessions: { alpha: 'session-alpha', beta: 'session-beta' },
    });

    assert.equal(
      await reconcileStalePendingMessagesForAgent('user-1', 'chat-1', 'alpha'),
      true,
    );
    const reconciled = await getChat('user-1', 'chat-1');
    assert.deepEqual(reconciled?.messages[0], {
      id: 'pending-alpha',
      type: 'agent',
      agentId: 'alpha',
      content: '⏹ Interrupted',
      ts: 1,
      pending: false,
      statusText: 'Interrupted',
      parts: [{ kind: 'tool', toolName: 'read_shell', done: true }],
    });
    assert.equal(reconciled?.messages[1].pending, true);
    assert.equal(
      await reconcileStalePendingMessagesForAgent('user-1', 'chat-1', 'alpha'),
      false,
    );
  } finally {
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true });
  }
}

void main().then(() => {
  console.log('chat store stale reconciliation tests passed');
});
