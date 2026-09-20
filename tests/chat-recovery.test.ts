import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIncrementalChatSaver } from '../app/features/chat/runtime/incrementalChatSaver';
import { createMemoryChatOutbox, type ChatOutboxEntry } from '../app/features/chat/runtime/chatOutboxStore';
import { migrateFailedSendWarnings } from '../app/features/chat/chatHelpers';
import { isStoredChatDelta } from '../lib/chatDeltaValidation';
import type { ChatOperation } from '../lib/chatSyncStore';

const metadata = { id: 'source', name: 'Recovery', ts: 1, agentSessions: {} };
const target = { id: 'recovered', name: 'Recovered drafts', agentSessions: {} };

function sourceDraft(): ChatOutboxEntry {
  return {
    userId: 'test', createdAt: 1, state: 'conflict', error: 'message_conflict:question',
    operation: {
      operationId: 'source-operation', expectedVersions: { question: null },
      chat: {
        ...metadata,
        messages: [{
          id: 'question', type: 'user', content: '', ts: 1,
          attachments: [{ id: 'file', name: 'note.txt', mimeType: 'text/plain', size: 1, kind: 'file', dataUrl: 'data:text/plain;base64,YQ==' }],
          resendAgentIds: ['alpha'], resendMessage: 'Please review the attached file(s).', sendStatus: 'failed',
        }],
      },
    },
  };
}

function receiptServer() {
  const receipts = new Map<string, { operation: ChatOperation; versions: Record<string, number> }>();
  let loseResponse = false;
  const request: typeof fetch = async (_url, init) => {
    const operation: ChatOperation = JSON.parse(String(init?.body)).operation;
    let receipt = receipts.get(operation.operationId);
    if (!receipt) {
      receipt = {
        operation,
        versions: Object.fromEntries(operation.chat.messages.map(message => [message.id, 1])),
      };
      receipts.set(operation.operationId, receipt);
    } else assert.deepEqual(operation, receipt.operation, 'a replay must keep its original payload');
    if (loseResponse) {
      loseResponse = false;
      throw new TypeError('Committed copy response lost');
    }
    return Response.json({ ok: true, versions: receipt.versions });
  };
  return { request, receipts, loseNextResponse() { loseResponse = true; } };
}

test('a recovery copy reuses its operation after a lost acknowledgement and saver restart', async () => {
  const source = sourceDraft();
  const outbox = createMemoryChatOutbox();
  const server = receiptServer();
  await outbox.put(source);
  server.loseNextResponse();
  await assert.rejects(createIncrementalChatSaver(server.request, { outbox }).saveCopy(source, target), /response lost/);
  const restarted = createIncrementalChatSaver(server.request, { outbox });
  await restarted.ready();
  await restarted.saveCopy(source, { ...target, id: 'another-recovery-id' });
  assert.equal(server.receipts.size, 1, 'retry must not create a second message or a second recovered chat');
  assert.equal([...server.receipts.values()][0].operation.chat.id, target.id);
});

test('a copy remains idempotent when background recovery commits it before the next click', async () => {
  const source = sourceDraft();
  const outbox = createMemoryChatOutbox();
  const server = receiptServer();
  await outbox.put(source);
  server.loseNextResponse();
  const saver = createIncrementalChatSaver(server.request, { outbox });
  await assert.rejects(saver.saveCopy(source, target), /response lost/);
  await saver.retryPending();
  await saver.saveCopy(source, target);
  assert.equal(server.receipts.size, 1);
});

for (const legacy of [false, true]) test(`attachment-only recovery preserves the retry prompt and selected agent (legacy: ${legacy})`, async () => {
  const source = sourceDraft();
  if (legacy) delete source.operation.chat.messages[0].resendMessage;
  const outbox = createMemoryChatOutbox();
  const server = receiptServer();
  await outbox.put(source);
  await createIncrementalChatSaver(server.request, { outbox }).saveCopy(source, target);
  const copy = [...server.receipts.values()][0].operation.chat.messages[0];
  assert.equal(copy.content, '');
  assert.equal(copy.resendMessage, 'Please review the attached file(s).');
  assert.deepEqual(copy.resendAgentIds, ['alpha']);
  assert.deepEqual(copy.attachments, source.operation.chat.messages[0].attachments);
});

test('pending dispatch state survives validation and becomes retryable with an existing agent session', () => {
  const draft = {
    ...metadata, agentSessions: { alpha: 'existing-session' },
    messages: [{ id: 'question', type: 'user', ts: 1, content: 'Interrupted send', sendStatus: 'pending' }],
  };
  assert.ok(isStoredChatDelta(draft), 'pending dispatch is a persisted state, not inferred from the absence of sessions');
  const recovered = migrateFailedSendWarnings(JSON.parse(JSON.stringify(draft.messages)), draft.agentSessions);
  assert.equal(recovered.messages[0].sendStatus, 'failed');
  assert.match(recovered.messages[0].sendError || '', /confirm|interrupt/i);
});
