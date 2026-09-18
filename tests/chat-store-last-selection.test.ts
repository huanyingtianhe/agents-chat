import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
async function main() {
  const testDir = await mkdtemp(path.join(tmpdir(), 'agents-chat-last-selection-'));

  try {
    process.chdir(testDir);
    const { deleteChat, getChat, getLastChatId, saveChat, setLastChatId } = await import('../lib/chatStore');
    const chat = { id: 'selected', name: 'Selected', ts: 1, messages: [] };
    await saveChat('alice', chat);
    await saveChat('bob', chat);
    await setLastChatId('alice', chat.id);
    await setLastChatId('bob', chat.id);

    await deleteChat('alice', chat.id);
    assert.equal(await getChat('alice', chat.id), null);
    assert.equal(await getLastChatId('alice'), null, 'deleting the selected chat clears its preference');
    assert.equal(await getLastChatId('bob'), chat.id, 'another user keeps their selection');
    assert.ok(await getChat('bob', chat.id));

    await setLastChatId('alice', 'other-chat');
    await deleteChat('alice', chat.id);
    assert.equal(await getLastChatId('alice'), 'other-chat', 'deleting another chat preserves selection');

    await setLastChatId('alice', 'already-deleted');
    await deleteChat('alice', 'already-deleted');
    assert.equal(await getLastChatId('alice'), null, 'repeated deletion also clears an orphaned preference');
  } finally {
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true });
  }

  console.log('chat store last selection tests passed');
}

void main();
