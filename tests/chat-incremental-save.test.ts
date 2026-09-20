import assert from 'node:assert/strict';
import { createIncrementalChatSaver } from '../app/features/chat/runtime/incrementalChatSaver';
import type { ChatMessage } from '../app/features/chat/chatTypes';

async function main() {
  const requests: { chat: { messages: ChatMessage[]; removedMessageIds?: string[] } }[] = [];
  let failure: 'http' | 'network' | 'json' | null = null;
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const saver = createIncrementalChatSaver(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (gate) await gate;
    if (failure === 'network') throw new TypeError('Network offline');
    if (failure === 'http') return new Response('<h1>413</h1>', { status: 413 });
    if (failure === 'json') return Response.json({ ok: false, error: 'disk full' });
    return Response.json({ ok: true });
  });
  const history: ChatMessage[] = [
    { id: 'old-user', type: 'user', content: 'Old question', ts: 1 },
    {
      id: 'old-agent', type: 'agent', content: 'Old answer', ts: 2,
      parts: [{ kind: 'tool', toolName: 'read', result: 'x'.repeat(5 * 1024 * 1024), done: true }],
    },
  ];
  const metadata = { id: 'chat-1', name: 'Large chat', ts: 1, agentSessions: {} };
  saver.hydrate(metadata.id, history);
  const question: ChatMessage = { id: 'new-user', type: 'user', content: 'Next question', ts: 3 };
  await saver.save({ ...metadata, messages: [...history, question] });
  assert.deepEqual(requests.at(-1)?.chat.messages, [question]);
  assert.ok(Buffer.byteLength(JSON.stringify(requests.at(-1))) < 1024);

  const reply: ChatMessage = { ...history[1], id: 'pending-new', ts: 4, content: 'New reply' };
  await saver.save({ ...metadata, messages: [...history, question, reply] });
  assert.equal(requests.at(-1)?.chat.messages[0].parts, undefined, 'ACP tool output stays server-side');
  assert.ok(Buffer.byteLength(JSON.stringify(requests.at(-1))) < 1024);

  const retry: ChatMessage = { ...question, content: 'Unsaved edit' };
  for (const kind of ['http', 'network', 'json'] as const) {
    failure = kind;
    await assert.rejects(saver.save({ ...metadata, messages: [...history, retry, reply] }),
      kind === 'http' ? /413/ : kind === 'network' ? /Network offline/ : /disk full/);
    assert.equal(requests.at(-1)?.chat.messages[0].content, retry.content);
  }
  failure = null;
  await saver.save({ ...metadata, messages: [...history, retry, reply] });
  assert.equal(requests.at(-1)?.chat.messages[0].content, retry.content, 'failure must not advance baseline');

  gate = new Promise<void>(resolve => { release = resolve; });
  const firstEdit = { ...retry, content: 'First queued edit' };
  const secondEdit = { ...retry, content: 'Second queued edit' };
  const before = requests.length;
  const first = saver.save({ ...metadata, messages: [...history, firstEdit, reply] });
  const second = saver.save({ ...metadata, messages: [...history, secondEdit, reply] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.length, before + 1, 'saves for one chat must be serialized');
  release!();
  await Promise.all([first, second]);
  gate = undefined;
  assert.equal(requests.at(-1)?.chat.messages[0].content, secondEdit.content);

  const many = Array.from({ length: 12 }, (_, index): ChatMessage => ({
    id: `batch-${index}`, type: 'user', content: '文'.repeat(30_000), ts: index + 10,
  }));
  const batchStart = requests.length;
  await saver.save({ ...metadata, messages: [...history, secondEdit, reply, ...many] });
  assert.ok(requests.length > batchStart + 1);
  for (const request of requests.slice(batchStart)) {
    assert.ok(Buffer.byteLength(JSON.stringify(request)) < 1024 * 1024);
  }
  assert.deepEqual(requests.slice(batchStart).flatMap(request => request.chat.messages), many);

  failure = 'http';
  await assert.rejects(saver.save({
    ...metadata, messages: [...history, { ...question, content: 'x'.repeat(1024 * 1024) }],
  }), /413/);
  failure = null;
  const attachmentSizedMessage = { ...question, content: 'x'.repeat(600 * 1024) };
  await saver.save({ ...metadata, messages: [...history, attachmentSizedMessage] });
  assert.equal(requests.at(-1)?.chat.messages[0].content.length, 600 * 1024);
  console.log('incremental chat saver tests passed');
}

void main();
