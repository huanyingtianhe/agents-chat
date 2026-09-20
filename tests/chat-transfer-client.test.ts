import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uploadJson } from '../app/features/chat/runtime/chatTransferClient';
import { MAX_TRANSFER_BYTES, TRANSFER_CHUNK_BYTES } from '../lib/chatSyncProtocol';

test('a client resumes after a chunk acknowledgement is lost without uploading confirmed chunks again', async () => {
  const value = { text: '文'.repeat(360_000) };
  const accepted = new Map<number, Buffer>();
  const attempts: number[] = [];
  let fail = true;
  const request: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.action === 'status') return Response.json({ ok: true, chunks: [...accepted.keys()] });
    attempts.push(body.index);
    accepted.set(body.index, Buffer.from(body.data, 'base64'));
    if (body.index === 1 && fail) {
      fail = false;
      throw new TypeError('Chunk acknowledgement lost');
    }
    return Response.json({ ok: true });
  };
  await assert.rejects(uploadJson(value, 'chat', 'chat', 'same-transfer', request), /acknowledgement lost/);
  await uploadJson(value, 'chat', 'chat', 'same-transfer', request);
  assert.equal(attempts.filter(index => index === 0).length, 1);
  assert.equal(attempts.filter(index => index === 1).length, 1);
  assert.deepEqual(JSON.parse(Buffer.concat([...accepted.values()]).toString()), value);
});

test('the serialized upload limit accepts exactly 64 MiB and rejects one byte more before a request', async () => {
  let requests = 0;
  const request: typeof fetch = async () => {
    requests++;
    return Response.json({ ok: true, chunks: Array.from({ length: MAX_TRANSFER_BYTES / TRANSFER_CHUNK_BYTES }, (_, index) => index) });
  };
  await uploadJson('x'.repeat(MAX_TRANSFER_BYTES - 2), 'chat', 'chat', 'at-limit', request);
  assert.equal(requests, 1);
  await assert.rejects(uploadJson('x'.repeat(MAX_TRANSFER_BYTES - 1), 'chat', 'chat', 'over-limit', request), /64 MiB/);
  assert.equal(requests, 1, 'an over-limit upload must not allocate server storage');
});
