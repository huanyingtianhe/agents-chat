import assert from 'node:assert/strict';
import { createIncrementalChatSaver } from '../app/features/chat/runtime/incrementalChatSaver';
import { createMemoryChatOutbox } from '../app/features/chat/runtime/chatOutboxStore';
import { requestJson } from '../app/features/chat/runtime/chatTransferClient';
import type { ChatMessage } from '../app/features/chat/chatTypes';
import type { ChatOperation } from '../lib/chatSyncStore';

function server() {
  const calls: ChatOperation[] = [];
  const sizes: number[] = [];
  const transfers = new Map<string, Map<number, Buffer>>();
  const receipts = new Map<string, Record<string, number>>();
  const state: {
    failure: 'http' | 'network' | 'json' | 'lost-response' | null;
    gate?: Promise<void>; failAt?: number;
  } = { failure: null };
  const request: typeof fetch = async (url, init) => {
    sizes.push(Buffer.byteLength(String(init?.body)));
    const body = JSON.parse(String(init?.body));
    if (String(url) === '/api/chat-transfers') {
      if (body.action === 'status') return Response.json({ ok: true, chunks: [...(transfers.get(body.id)?.keys() || [])] });
      if (body.action === 'delete') { transfers.delete(body.id); return Response.json({ ok: true }); }
      const chunks = transfers.get(body.id) || new Map<number, Buffer>();
      chunks.set(body.index, Buffer.from(body.data, 'base64'));
      transfers.set(body.id, chunks);
      return Response.json({ ok: true });
    }
    const operation: ChatOperation = body.operation || JSON.parse(Buffer.concat(
      [...transfers.get(body.transferId)!.entries()].sort(([a], [b]) => a - b).map(([, data]) => data),
    ).toString());
    calls.push(operation);
    if (state.gate) await state.gate;
    if (state.failure === 'network') throw new TypeError('Network offline');
    if (state.failure === 'http') return new Response('<h1>413</h1>', { status: 413 });
    if (state.failure === 'json') return Response.json({ ok: false, error: 'disk full' });
    if (state.failAt === calls.length) return new Response('', { status: 503 });
    const versions = receipts.get(operation.operationId) || Object.fromEntries(operation.chat.messages.map(message =>
      [message.id, (operation.expectedVersions[message.id] || 0) + 1]));
    receipts.set(operation.operationId, versions);
    if (state.failure === 'lost-response') { state.failure = null; throw new TypeError('Response lost after commit'); }
    return Response.json({ ok: true, versions });
  };
  return { calls, sizes, receipts, state, request };
}

async function main() {
  const mock = server();
  const outbox = createMemoryChatOutbox();
  const saver = createIncrementalChatSaver(mock.request, { outbox });
  const history: ChatMessage[] = [
    { id: 'old-user', type: 'user', content: 'Old question', ts: 1 },
    { id: 'old-agent', type: 'agent', content: 'Old answer', ts: 2,
      parts: [{ kind: 'tool', toolName: 'read', result: 'x'.repeat(5 * 1024 * 1024), done: true }] },
  ];
  const metadata = { id: 'chat-1', name: 'Large chat', ts: 1, agentSessions: {} };
  saver.hydrate(metadata.id, history);
  const question: ChatMessage = { id: 'new-user', type: 'user', content: 'Next question', ts: 3 };
  await saver.save({ ...metadata, messages: [...history, question] });
  assert.deepEqual(mock.calls.at(-1)?.chat.messages, [question]);
  assert.equal(mock.calls.at(-1)?.expectedVersions[question.id], null);
  assert.ok(mock.sizes.at(-1)! < 1024);
  const reply: ChatMessage = { ...history[1], id: 'reply', ts: 4, content: 'New reply' };
  await saver.save({ ...metadata, messages: [...history, question, reply] });
  assert.equal(mock.calls.at(-1)?.chat.messages[0].parts, undefined);

  const edit = { ...question, content: 'Unsaved edit' };
  let retryId = '';
  for (const failure of ['http', 'network', 'json'] as const) {
    mock.state.failure = failure;
    await assert.rejects(saver.save({ ...metadata, messages: [...history, edit, reply] }),
      failure === 'http' ? /413/ : failure === 'network' ? /Network offline/ : /disk full/);
    const pending = await outbox.list();
    assert.equal(pending.length, 1);
    if (retryId) assert.equal(pending[0].operation.operationId, retryId);
    retryId = pending[0].operation.operationId;
  }
  mock.state.failure = null;
  await saver.save({ ...metadata, messages: [...history, edit, reply] });
  assert.equal((await outbox.list()).length, 0);

  let release!: () => void;
  mock.state.gate = new Promise<void>(resolve => { release = resolve; });
  const firstEdit = { ...edit, content: 'First queued edit' };
  const secondEdit = { ...edit, content: 'Second queued edit' };
  const before = mock.calls.length;
  const first = saver.save({ ...metadata, messages: [...history, firstEdit, reply] });
  const second = saver.save({ ...metadata, messages: [...history, secondEdit, reply] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(mock.calls.length, before + 1);
  assert.equal((await outbox.list()).length, 2, 'queued saves must be durable before the network finishes');
  release();
  await Promise.all([first, second]);
  mock.state.gate = undefined;
  assert.equal(mock.calls.at(-1)?.chat.messages[0].content, secondEdit.content);
  assert.equal(mock.calls.at(-1)?.dependencies?.[question.id], mock.calls.at(-2)?.operationId);

  const many = Array.from({ length: 12 }, (_, index): ChatMessage => ({
    id: `batch-${index}`, type: 'user', content: '文'.repeat(30_000), ts: index + 10,
  }));
  const batchStart = mock.calls.length;
  await saver.save({ ...metadata, messages: [...history, secondEdit, reply, ...many] });
  assert.ok(mock.calls.length > batchStart + 1);
  assert.deepEqual(mock.calls.slice(batchStart).flatMap(operation => operation.chat.messages), many);

  const huge = { ...question, content: '文'.repeat(450_000), attachments: [{
    id: 'file', name: 'large.txt', mimeType: 'text/plain', kind: 'file' as const,
    size: 900_000, dataUrl: `data:text/plain;base64,${Buffer.alloc(900_000, 65).toString('base64')}`,
  }] };
  await saver.save({ ...metadata, messages: [...history, huge, reply, ...many] });
  assert.deepEqual(mock.calls.at(-1)?.chat.messages, [huge]);
  assert.ok(Math.max(...mock.sizes) < 1024 * 1024, 'all request bodies, including a single Unicode message and attachments, fit the proxy');

  mock.state.failure = 'lost-response';
  const lost = { ...huge, content: 'Committed but response lost' };
  await assert.rejects(saver.save({ ...metadata, messages: [...history, lost, reply, ...many] }), /Response lost/);
  const receiptCount = mock.receipts.size;
  const restarted = createIncrementalChatSaver(mock.request, { outbox });
  await restarted.retryPending();
  assert.equal(mock.receipts.size, receiptCount, 'refresh must reuse the original operation');
  assert.equal((await outbox.list()).length, 0);

  await assert.rejects(requestJson('/api/chats', {}, () => new Promise(() => {}), 5), /timed out/);
  const partial = server();
  partial.state.failAt = 2;
  const partialSaver = createIncrementalChatSaver(partial.request);
  await assert.rejects(partialSaver.save({ ...metadata, messages: many }), /503/);
  const confirmed = new Set([...partial.receipts.keys()]);
  partial.state.failAt = undefined;
  const retryStart = partial.calls.length;
  await partialSaver.save({ ...metadata, messages: many });
  assert.equal(partial.calls.slice(retryStart).some(operation => confirmed.has(operation.operationId)), false);
  console.log('incremental chat saver tests passed');
}
void main();
