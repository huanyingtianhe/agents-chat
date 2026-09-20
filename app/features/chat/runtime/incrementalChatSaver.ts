import type { ChatMessage } from '../chatTypes';
import type { ChatOperation } from '@/lib/chatSyncStore';
import type { StoredMessage } from '@/lib/chatStore';
import { ChatSyncError, newOperationId } from '@/lib/chatSyncProtocol';
import { commitOperation, requestJson } from './chatTransferClient';
import { createMemoryChatOutbox, type ChatOutboxEntry, type ChatOutboxStore } from './chatOutboxStore';

type ChatSnapshot = {
  id: string; name: string; ts: number; agentId?: string;
  agentSessions: Record<string, string>; messages: ChatMessage[];
};
type Baseline = { value: string; version: number | null; operationId?: string };
type Options = { userId?: string; outbox?: ChatOutboxStore; onChange?: () => void };

function clientMessage(message: StoredMessage): StoredMessage {
  const { version: _version, serverManaged: _serverManaged, ...rest } = message;
  if (rest.type === 'agent') {
    const { parts: _parts, ...withoutParts } = rest;
    return withoutParts;
  }
  return rest;
}

export async function postChatJson(body: unknown, request: typeof fetch = fetch): Promise<void> {
  await requestJson('/api/chats', body, request);
}

export function createIncrementalChatSaver(request: typeof fetch = fetch, options: Options = {}) {
  const userId = options.userId || 'test';
  const outbox = options.outbox || createMemoryChatOutbox(userId);
  const baselines = new Map<string, Map<string, Baseline>>();
  const queues = new Map<string, Promise<void>>();
  let stages = Promise.resolve();
  let initialized: Promise<void> | undefined;
  let sequence = Date.now();
  const owner = newOperationId();
  const blockedChats = new Set<string>();

  function applyStaged(entry: ChatOutboxEntry) {
    const { operation } = entry;
    const baseline = baselines.get(operation.chat.id) || new Map<string, Baseline>();
    for (const message of operation.chat.messages) {
      baseline.set(message.id, {
        value: JSON.stringify(clientMessage(message)), version: (operation.expectedVersions[message.id] || 0) + 1,
        operationId: operation.operationId,
      });
    }
    for (const id of operation.chat.removedMessageIds || []) baseline.delete(id);
    baselines.set(operation.chat.id, baseline);
  }

  function ready() {
    if (!initialized) initialized = outbox.list().then(entries => {
      const pending = new Map(entries.map(entry => [entry.operation.operationId, entry]));
      while (pending.size) {
        const entry = [...pending.values()].find(candidate =>
          !Object.values(candidate.operation.dependencies || {}).some(id => pending.has(id)));
        if (!entry) throw new Error('Local draft dependencies are invalid. Download the drafts before clearing browser storage.');
        sequence = Math.max(sequence, entry.createdAt);
        applyStaged(entry);
        pending.delete(entry.operation.operationId);
      }
    })
      .catch(error => { initialized = undefined; throw error; });
    return initialized;
  }

  function hydrate(chatId: string, messages: ChatMessage[]) {
    const baseline = baselines.get(chatId) || new Map<string, Baseline>();
    for (const message of messages) {
      if (!baseline.has(message.id)) baseline.set(message.id, {
        value: JSON.stringify(clientMessage(message)), version: message.version || 0,
      });
    }
    baselines.set(chatId, baseline);
  }

  async function synchronize(chatId: string, required?: Set<string>): Promise<void> {
    const previous = queues.get(chatId) || Promise.resolve();
    const next = previous.then(async () => {
      if (blockedChats.has(chatId)) throw new ChatSyncError('chat_deleted', 410);
      const entries = (await outbox.list()).filter(entry => entry.operation.chat.id === chatId);
      const waiting = new Map(entries.map(entry => [entry.operation.operationId, entry]));
      let firstError: Error | undefined;
      while (waiting.size) {
        const entry = [...waiting.values()].find(candidate =>
          !Object.values(candidate.operation.dependencies || {}).some(id => waiting.has(id)));
        if (!entry) break;
        const { operation } = entry;
        waiting.delete(operation.operationId);
        if (entry.state !== 'pending') {
          if (!required || required.has(operation.operationId)) firstError ||= new Error(entry.error || 'This chat has an unresolved local draft.');
          continue;
        }
        if (!await outbox.claim(operation.operationId, owner)) {
          if (!required || required.has(operation.operationId)) firstError ||= new Error('Another tab is saving this message. Retry after it finishes.');
          continue;
        }
        let leaseError: Error | undefined;
        const renewal = setInterval(() => {
          void outbox.renew(operation.operationId, owner).then(renewed => {
            if (!renewed) leaseError = new Error('The local save lease expired. Retry safely.');
          }).catch(error => { leaseError = error instanceof Error ? error : new Error(String(error)); });
        }, 15_000);
        try {
          const result = await commitOperation(operation, request);
          if (leaseError) throw leaseError;
          await outbox.complete(operation.operationId, owner);
          const baseline = baselines.get(chatId);
          for (const [id, version] of Object.entries(result.versions)) {
            const previous = baseline?.get(id);
            if (previous?.operationId === operation.operationId) baseline?.set(id, { ...previous, version, operationId: undefined });
          }
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          if (!required || required.has(operation.operationId)) firstError ||= failure;
          const state = failure.message.includes('chat_deleted') ? 'deleted'
            : failure.message.includes('message_conflict') ? 'conflict' : 'pending';
          await outbox.fail(operation.operationId, owner, failure.message, state);
        } finally {
          clearInterval(renewal);
          options.onChange?.();
        }
      }
      if (firstError) throw firstError;
    });
    const settled = next.catch(() => {});
    queues.set(chatId, settled);
    try { await next; }
    finally { if (queues.get(chatId) === settled) queues.delete(chatId); }
  }

  async function save(snapshot: ChatSnapshot, onStaged?: () => void): Promise<void> {
    const { messages, ...metadata } = snapshot;
    const required = new Set<string>();
    const current = messages.filter(message => message.type !== 'system').map(clientMessage);
    const stage = stages.then(async () => {
      await ready();
      if (blockedChats.has(snapshot.id)) throw new ChatSyncError('chat_deleted', 410);
      const baseline = baselines.get(snapshot.id) || new Map<string, Baseline>();
      const changed = current.filter(message => baseline.get(message.id)?.value !== JSON.stringify(message));
      const currentIds = new Set(current.map(message => message.id));
      const removed = [...baseline].filter(([id, old]) =>
        !currentIds.has(id) && (JSON.parse(old.value) as ChatMessage).type !== 'user').map(([id]) => id);
      const batches: StoredMessage[][] = [];
      let batch: StoredMessage[] = [];
      let bytes = 0;
      for (const message of changed) {
        const size = new TextEncoder().encode(JSON.stringify(message)).length;
        if (batch.length && bytes + size > 480 * 1024) { batches.push(batch); batch = []; bytes = 0; }
        batch.push(message);
        bytes += size;
      }
      if (batch.length || removed.length || !baselines.has(snapshot.id)) batches.push(batch);
      for (let index = 0; index < batches.length; index++) {
        const batch = batches[index];
        const removedMessageIds = index === 0 ? removed : [];
        const expectedVersions: Record<string, number | null> = Object.create(null);
        const dependencies: Record<string, string> = Object.create(null);
        for (const id of [...batch.map(message => message.id), ...removedMessageIds]) {
          const previous = baseline.get(id);
          expectedVersions[id] = previous?.version ?? null;
          if (previous?.operationId) dependencies[id] = previous.operationId;
        }
        const operation: ChatOperation = {
          operationId: newOperationId(), userId, expectedVersions, dependencies,
          chat: { ...metadata, messages: batch, removedMessageIds },
        };
        sequence = Math.max(Date.now(), sequence + 1);
        const entry: ChatOutboxEntry = { userId, operation, createdAt: sequence, state: 'pending' };
        await outbox.put(entry);
        required.add(operation.operationId);
        applyStaged(entry);
        options.onChange?.();
      }
    });
    stages = stage.catch(() => {});
    await stage;
    onStaged?.();
    await synchronize(snapshot.id, required.size ? required : undefined);
  }

  async function retryPending() {
    await ready();
    const entries = await outbox.list();
    const errors: Error[] = [];
    for (const id of new Set(entries.filter(entry => entry.state === 'pending').map(entry => entry.operation.chat.id))) {
      try { await synchronize(id); }
      catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
    }
    if (errors.length) throw errors[0];
  }

  async function discard(operationId: string) {
    const entries = await outbox.list();
    const discarded = new Set([operationId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const entry of entries) {
        if (!discarded.has(entry.operation.operationId)
          && Object.values(entry.operation.dependencies || {}).some(id => discarded.has(id))) {
          discarded.add(entry.operation.operationId);
          changed = true;
        }
      }
    }
    for (const entry of entries.filter(entry => discarded.has(entry.operation.operationId))) {
      if (entry.leaseUntil && entry.leaseUntil > Date.now()) throw new Error('A tab is still saving this draft. Wait before discarding it.');
      await outbox.discard(entry.operation.operationId);
      baselines.delete(entry.operation.chat.id);
    }
    for (const entry of await outbox.list()) applyStaged(entry);
    options.onChange?.();
    return entries.filter(entry => discarded.has(entry.operation.operationId));
  }

  async function saveCopy(entry: ChatOutboxEntry, target: Pick<ChatSnapshot, 'id' | 'name' | 'agentSessions'>) {
    const entries = await outbox.list();
    const selected = new Set([entry.operation.operationId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const item of entries) {
        if (!selected.has(item.operation.operationId)
          && Object.values(item.operation.dependencies || {}).some(id => selected.has(id))) {
          selected.add(item.operation.operationId);
          changed = true;
        }
      }
    }
    const latest = new Map<string, StoredMessage>();
    for (const item of entries.filter(item => selected.has(item.operation.operationId))) {
      for (const message of item.operation.chat.messages) if (message.type === 'user') latest.set(message.id, message);
    }
    const messages = [...latest.values()].map(message => ({
      id: newOperationId(), type: 'user' as const, content: message.content, attachments: message.attachments, ts: Date.now(),
      sendStatus: 'failed' as const, sendError: 'Recovered draft saved. Use Retry to explicitly send it to an agent.',
    }));
    if (!messages.length) throw new Error('This draft contains no user messages to copy. Download it before discarding.');
    const operation: ChatOperation = {
      userId, operationId: newOperationId(),
      chat: { ...target, ts: Date.now(), messages },
      expectedVersions: Object.fromEntries(messages.map(message => [message.id, null])),
    };
    sequence = Math.max(Date.now(), sequence + 1);
    await outbox.put({ userId, operation, createdAt: sequence, state: 'pending' });
    applyStaged({ userId, operation, createdAt: sequence, state: 'pending' });
    options.onChange?.();
    await synchronize(target.id, new Set([operation.operationId]));
  }

  async function markDeleted(chatId: string) {
    blockedChats.add(chatId);
    const entries = await outbox.list();
    for (const entry of entries.filter(entry => entry.operation.chat.id === chatId)) {
      if (await outbox.claim(entry.operation.operationId, owner)) await outbox.fail(entry.operation.operationId, owner, 'chat_deleted', 'deleted');
    }
    options.onChange?.();
  }

  function isDurable(chatId: string, messages: ChatMessage[]): boolean {
    const baseline = baselines.get(chatId);
    return !!baseline && messages.filter(message => message.type !== 'system').every(message =>
      baseline.get(message.id)?.value === JSON.stringify(clientMessage(message)));
  }

  return { hydrate, save, saveCopy, ready, retryPending, discard, markDeleted, isDurable, list: () => outbox.list() };
}

export type IncrementalChatSaver = ReturnType<typeof createIncrementalChatSaver>;
