import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';
import type {
  ChatOutboxEntry, ChatOutboxStore, createIndexedDbChatOutbox, createMemoryChatOutbox,
} from '../app/features/chat/runtime/chatOutboxStore';

declare global {
  interface Window {
    chatOutboxTest: {
      createIndexedDbChatOutbox: typeof createIndexedDbChatOutbox;
      createMemoryChatOutbox: typeof createMemoryChatOutbox;
    };
  }
}

// Load the actual adapter, not a copy of its logic or a production-only test endpoint.
const source = readFileSync(path.resolve('app/features/chat/runtime/chatOutboxStore.ts'), 'utf8');
const browserModule = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const adapterScript = `(function () {
  const exports = {};
  ${browserModule}
  window.chatOutboxTest = exports;
})();`;

function entry(operationId: string, userId = 'alice', createdAt = 1): ChatOutboxEntry {
  return {
    userId, createdAt, state: 'pending',
    operation: {
      operationId,
      chat: {
        id: 'outbox-chat', name: 'Outbox contract', ts: 1, agentSessions: {},
        messages: [{ id: 'question', type: 'user', content: 'Keep this question', ts: 1 }],
      },
      expectedVersions: { question: null },
    },
  };
}

async function loadAdapter(page: Page) {
  await page.goto('/__chat-outbox-contract');
  await page.addScriptTag({ content: adapterScript });
}

test.beforeEach(async ({ context, page }) => {
  await context.route('**/__chat-outbox-contract', route =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Outbox contract</title>' }));
  await loadAdapter(page);
});

for (const kind of ['createIndexedDbChatOutbox', 'createMemoryChatOutbox'] as const) {
  test(`${kind}: immutable operations, deterministic ordering, and user isolation`, async ({ page }) => {
    const result = await page.evaluate(async ({ kind, first, second, foreign }) => {
      const create = window.chatOutboxTest[kind];
      const alice = create('alice');
      const bob = create('bob');
      await alice.put(second);
      await alice.put(first);
      await bob.put(foreign);
      await alice.put({ ...first, createdAt: 99, state: 'conflict', error: 'must not replace' });
      let immutableError = '';
      let identityError = '';
      try {
        await alice.put({
          ...first, operation: { ...first.operation, expectedVersions: { question: 4 } },
        });
      } catch (error) { immutableError = String(error); }
      try { await alice.put(foreign); } catch (error) { identityError = String(error); }
      const before = await alice.list();
      await alice.discard(first.operation.operationId);
      return { before, alice: await alice.list(), bob: await bob.list(), immutableError, identityError };
    }, { kind, first: entry('a'), second: entry('b'), foreign: entry('a', 'bob') });
    expect(result.before).toEqual([entry('a'), entry('b')]);
    expect(result.alice).toEqual([entry('b')]);
    expect(result.bob).toEqual([entry('a', 'bob')]);
    expect(result.immutableError).toMatch(/operation.*a.*(different|immutable|reused)/i);
    expect(result.identityError).toMatch(/user/i);
  });

  test(`${kind}: lease ownership protects completion, failure, and renewal`, async ({ page }) => {
    const result = await page.evaluate(async ({ kind, record }) => {
      const store = window.chatOutboxTest[kind]('alice');
      await store.put(record);
      const claimed = await store.claim('leased', 'tab-a');
      const competitor = await store.claim('leased', 'tab-b');
      const wrongRenew = await store.renew('leased', 'tab-b');
      await store.complete('leased', 'tab-b');
      await store.fail('leased', 'tab-b', 'wrong owner', 'deleted');
      const unchanged = await store.list();
      const renewed = await store.renew('leased', 'tab-a');
      await store.fail('leased', 'tab-a', 'offline', 'pending');
      const failed = await store.list();
      const reclaimed = await store.claim('leased', 'tab-b');
      await store.complete('leased', 'tab-a');
      const protectedRows = await store.list();
      await store.complete('leased', 'tab-b');
      return {
        claimed, competitor, wrongRenew, unchanged, renewed, failed, reclaimed,
        protectedRows, remaining: await store.list(),
      };
    }, { kind, record: entry('leased') });
    expect(result.claimed).toBe(true);
    expect(result.competitor).toBe(false);
    expect(result.wrongRenew).toBe(false);
    expect(result.unchanged).toHaveLength(1);
    expect(result.unchanged[0]).toMatchObject({ state: 'pending', leaseOwner: 'tab-a' });
    expect(result.unchanged[0].error).toBeUndefined();
    expect(result.renewed).toBe(true);
    expect(result.failed).toEqual([{ ...entry('leased'), error: 'offline' }]);
    expect(result.reclaimed).toBe(true);
    expect(result.protectedRows).toHaveLength(1);
    expect(result.remaining).toEqual([]);
  });

  test(`${kind}: leases expire after sixty seconds and stale owners cannot alter reclaimed work`, async ({ page }) => {
    const result = await page.evaluate(async ({ kind, record }) => {
      const store = window.chatOutboxTest[kind]('alice');
      const now = Date.now;
      let time = 1_000;
      Date.now = () => time;
      try {
        await store.put(record);
        await store.claim('expiry', 'old-tab');
        const initial = await store.list();
        time += 59_999;
        const tooEarly = await store.claim('expiry', 'new-tab');
        time++;
        const expiredRenewal = await store.renew('expiry', 'old-tab');
        const reclaimed = await store.claim('expiry', 'new-tab');
        await store.complete('expiry', 'old-tab');
        await store.fail('expiry', 'old-tab', 'stale error', 'deleted');
        return { initial, tooEarly, expiredRenewal, reclaimed, rows: await store.list() };
      } finally { Date.now = now; }
    }, { kind, record: entry('expiry') });
    expect(result.initial[0].leaseUntil).toBe(61_000);
    expect(result.tooEarly).toBe(false);
    expect(result.expiredRenewal).toBe(false);
    expect(result.reclaimed).toBe(true);
    expect(result.rows[0]).toMatchObject({ leaseOwner: 'new-tab', leaseUntil: 121_000, state: 'pending' });
    expect(result.rows[0].error).toBeUndefined();
  });

  test(`${kind}: unresolved conflict and deletion records cannot be claimed`, async ({ page }) => {
    const result = await page.evaluate(async ({ kind, record }) => {
      const store: ChatOutboxStore = window.chatOutboxTest[kind]('alice');
      await store.put(record);
      await store.claim('conflict', 'tab');
      await store.fail('conflict', 'tab', 'message_conflict', 'conflict');
      const conflict = await store.claim('conflict', 'other');
      await store.put({ ...record, operation: { ...record.operation, operationId: 'deleted' } });
      await store.claim('deleted', 'tab');
      await store.fail('deleted', 'tab', 'chat_deleted', 'deleted');
      const deleted = await store.claim('deleted', 'other');
      const absent = await store.claim('missing', 'tab');
      await store.discard('conflict');
      return { conflict, deleted, absent, rows: await store.list() };
    }, { kind, record: entry('conflict') });
    expect(result.conflict).toBe(false);
    expect(result.deleted).toBe(false);
    expect(result.absent).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ state: 'deleted', error: 'chat_deleted' });
  });

  test(`${kind}: discard rejects active leases and permits removal exactly at expiry`, async ({ page }) => {
    const result = await page.evaluate(async ({ kind, record }) => {
      const store = window.chatOutboxTest[kind]('alice');
      const now = Date.now;
      let time = 1_000;
      Date.now = () => time;
      try {
        await store.put(record);
        await store.claim('discard-lease', 'saving-tab');
        const before = await store.list();
        let error = '';
        try { await store.discard('discard-lease'); } catch (reason) { error = String(reason); }
        const protectedRows = await store.list();
        time = 61_000;
        await store.discard('discard-lease');
        await store.discard('missing');
        await store.put({
          ...record, operation: { ...record.operation, operationId: 'ownerless' }, leaseUntil: time + 60_000,
        });
        await store.discard('ownerless');
        return { before, error, protectedRows, remaining: await store.list() };
      } finally { Date.now = now; }
    }, { kind, record: entry('discard-lease') });
    expect(result.error).toMatch(/active lease/i);
    expect(result.protectedRows).toEqual(result.before);
    expect(result.remaining).toEqual([]);
  });

  test(`${kind}: recovery mapping survives completion and grouped discard is atomic`, async ({ page }) => {
    const result = await page.evaluate(async ({ kind, source, candidate }) => {
      const store = window.chatOutboxTest[kind]('alice');
      await store.put(source);
      const first = await store.prepareCopy(source.operation.operationId, candidate);
      await store.claim(first.operation.operationId, 'copy-tab');
      let discardError = '';
      try { await store.discard([source.operation.operationId, first.operation.operationId]); }
      catch (error) { discardError = String(error); }
      const protectedRows = await store.list();
      await store.complete(first.operation.operationId, 'copy-tab');
      const retried = await store.prepareCopy(source.operation.operationId, {
        ...candidate, operation: { ...candidate.operation, operationId: 'different-copy' },
      });
      await store.discard([source.operation.operationId, first.operation.operationId]);
      return { first, retried, protectedRows, discardError, remaining: await store.list() };
    }, { kind, source: entry('source-copy'), candidate: entry('stable-copy') });
    expect(result.first.operation.operationId).toBe('stable-copy');
    expect(result.retried.operation).toEqual(result.first.operation);
    expect(result.discardError).toMatch(/active lease/i);
    expect(result.protectedRows).toHaveLength(2);
    expect(result.remaining).toEqual([]);
  });
}

test('IndexedDB preserves records through reload and uses composite user/operation keys', async ({ page }) => {
  await page.evaluate(async records => {
    for (const record of records) await window.chatOutboxTest.createIndexedDbChatOutbox(record.userId).put(record);
  }, [entry('same-id'), entry('same-id', 'bob'), entry('earlier', 'alice', 0)]);
  await page.reload();
  await page.addScriptTag({ content: adapterScript });
  const rows = await page.evaluate(() => window.chatOutboxTest.createIndexedDbChatOutbox('alice').list());
  expect(rows).toEqual([entry('earlier', 'alice', 0), entry('same-id')]);
  const layout = await page.evaluate(() => new Promise<{ keyPath: string | string[] | null; count: number }>((resolve, reject) => {
    const request = indexedDB.open('agents-chat-outbox', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('operations', 'readonly');
      const store = transaction.objectStore('operations');
      const count = store.count();
      transaction.oncomplete = () => { resolve({ keyPath: store.keyPath, count: count.result }); db.close(); };
      transaction.onabort = () => { reject(transaction.error); db.close(); };
    };
  }));
  expect(layout).toEqual({ keyPath: ['userId', 'operationId'], count: 3 });
});

test('IndexedDB claims are atomic across tabs and never claim another user’s record', async ({ page, context }) => {
  await page.evaluate(record => window.chatOutboxTest.createIndexedDbChatOutbox('alice').put(record), entry('race'));
  const other = await context.newPage();
  await loadAdapter(other);
  const claim = (tab: Page, owner: string) => tab.evaluate(
    owner => window.chatOutboxTest.createIndexedDbChatOutbox('alice').claim('race', owner), owner,
  );
  const results = await Promise.all([claim(page, 'one'), claim(other, 'two')]);
  expect(results.filter(Boolean)).toHaveLength(1);
  await expect(other.evaluate(() =>
    window.chatOutboxTest.createIndexedDbChatOutbox('alice').discard('race'))).rejects.toThrow(/active lease/i);
  expect(await other.evaluate(() => window.chatOutboxTest.createIndexedDbChatOutbox('bob').claim('race', 'three'))).toBe(false);
  await other.evaluate(() => window.chatOutboxTest.createIndexedDbChatOutbox('bob').discard('race'));
  expect(await page.evaluate(() => window.chatOutboxTest.createIndexedDbChatOutbox('alice').list())).toHaveLength(1);
});

test('IndexedDB assigns only one recovery operation when two tabs copy the same source', async ({ page, context }) => {
  await page.evaluate(record => window.chatOutboxTest.createIndexedDbChatOutbox('alice').put(record), entry('source-copy'));
  const other = await context.newPage();
  await loadAdapter(other);
  const prepare = (tab: Page, record: ChatOutboxEntry) => tab.evaluate(record =>
    window.chatOutboxTest.createIndexedDbChatOutbox('alice').prepareCopy('source-copy', record), record);
  const [first, second] = await Promise.all([prepare(page, entry('copy-a')), prepare(other, entry('copy-b'))]);
  expect(first.operation).toEqual(second.operation);
  expect(await page.evaluate(() => window.chatOutboxTest.createIndexedDbChatOutbox('alice').list())).toHaveLength(2);
});

test('IndexedDB surfaces unavailable storage and quota failures with their original cause', async ({ page }) => {
  const errors = await page.evaluate(async record => {
    const messages: { message: string; cause: string }[] = [];
    const store = window.chatOutboxTest.createIndexedDbChatOutbox('alice');
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function () { throw new DOMException('Storage permission denied', 'SecurityError'); };
    try { await store.list(); } catch (error) {
      messages.push({ message: String(error), cause: String((error as Error).cause) });
    } finally { IDBFactory.prototype.open = open; }
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function () { throw new DOMException('Disk is full', 'QuotaExceededError'); };
    try { await store.put(record); } catch (error) {
      messages.push({ message: String(error), cause: String((error as Error).cause) });
    } finally { IDBObjectStore.prototype.add = add; }
    return { messages, rows: await store.list() };
  }, entry('quota'));
  expect(errors.messages).toHaveLength(2);
  expect(errors.messages[0].message).toContain('Storage permission denied');
  expect(errors.messages[0].cause).toContain('SecurityError');
  expect(errors.messages[1].message).toContain('Disk is full');
  expect(errors.messages[1].cause).toContain('QuotaExceededError');
  expect(errors.rows).toEqual([]);
});

test('IndexedDB rejects transaction aborts instead of acknowledging a non-durable put', async ({ page }) => {
  const result = await page.evaluate(async record => {
    const store = window.chatOutboxTest.createIndexedDbChatOutbox('alice');
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (value, key) {
      const request = key === undefined ? add.call(this, value) : add.call(this, value, key);
      request.onsuccess = () => this.transaction.abort();
      return request;
    };
    let error = '';
    try { await store.put(record); } catch (reason) { error = String(reason); }
    finally { IDBObjectStore.prototype.add = add; }
    return { error, rows: await store.list() };
  }, entry('aborted'));
  expect(result.error).toMatch(/outbox put failed.*abort/i);
  expect(result.rows).toEqual([]);
});

test('IndexedDB reports blocked opens and closes a connection that succeeds after rejection', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const open = IDBFactory.prototype.open;
    let closed = false;
    const blockedRequest = {
      onblocked: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      result: { close() { closed = true; } },
    };
    IDBFactory.prototype.open = function () {
      queueMicrotask(() => blockedRequest.onblocked?.());
      return blockedRequest as unknown as IDBOpenDBRequest;
    };
    let error = '';
    try { await window.chatOutboxTest.createIndexedDbChatOutbox('alice').list(); }
    catch (reason) { error = String(reason); }
    finally { IDBFactory.prototype.open = open; }
    blockedRequest.onsuccess?.();
    return { error, closed };
  });
  expect(result.error).toMatch(/outbox list failed.*blocked/i);
  expect(result.closed).toBe(true);
});

test('authenticated pending outbox survives a failed save and reload without dispatching', async ({ page }) => {
  const fixture = await installMobileChatFixture(page);
  await loginMobileFixture(page);
  await page.route('**/api/chats**', route =>
    route.request().method() === 'POST' ? route.abort('connectionrefused') : route.fallback());
  const text = 'Keep this outbox question through reload';
  const composer = page.locator('textarea.composerTextarea');
  await composer.fill(text);
  await composer.press('Enter');
  await expect(page.getByTestId('chat-outbox')).toBeVisible();
  const pendingRecords = () => page.evaluate(() => new Promise<ChatOutboxEntry[]>((resolve, reject) => {
    const request = indexedDB.open('agents-chat-outbox', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('operations', 'readonly');
      const rows = transaction.objectStore('operations').getAll();
      transaction.oncomplete = () => { resolve(rows.result as ChatOutboxEntry[]); database.close(); };
      transaction.onabort = () => { reject(transaction.error); database.close(); };
    };
  }));
  const matchingRecords = async () => (await pendingRecords()).filter(record =>
    record.operation.chat.messages.some(message => message.content === text));
  await expect.poll(async () => (await matchingRecords()).length).toBeGreaterThan(0);
  await expect.poll(async () => (await matchingRecords()).every(record =>
    !record.leaseOwner && Boolean(record.error))).toBe(true);
  const before = await matchingRecords();
  expect(before.every(record => record.state === 'pending')).toBe(true);
  expect(fixture.acpRequests.filter(request => request.action === 'send')).toHaveLength(0);
  await page.reload();
  await expect(page.getByTestId('chat-outbox')).toBeVisible();
  const after = await matchingRecords();
  expect(after.map(record => record.operation)).toEqual(before.map(record => record.operation));
  expect(after.map(record => record.userId)).toEqual(before.map(record => record.userId));
  expect(fixture.acpRequests.filter(request => request.action === 'send')).toHaveLength(0);
});
