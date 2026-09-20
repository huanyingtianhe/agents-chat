import type { ChatOperation, ChatCommitResult } from '@/lib/chatSyncStore';

export type { ChatCommitResult };

export type ChatOutboxEntry = {
  userId: string;
  operation: ChatOperation;
  createdAt: number;
  error?: string;
  state: 'pending' | 'conflict' | 'deleted';
  leaseOwner?: string;
  leaseUntil?: number;
  recovery?: { operation: ChatOperation; createdAt: number };
  recoveryOf?: string;
};

export interface ChatOutboxStore {
  put(entry: ChatOutboxEntry): Promise<void>;
  prepareCopy(sourceOperationId: string, candidate: ChatOutboxEntry): Promise<ChatOutboxEntry>;
  list(): Promise<ChatOutboxEntry[]>;
  claim(operationId: string, owner: string): Promise<boolean>;
  renew(operationId: string, owner: string): Promise<boolean>;
  complete(operationId: string, owner: string): Promise<void>;
  fail(operationId: string, owner: string, error: string, state: ChatOutboxEntry['state']): Promise<void>;
  discard(operationId: string | string[]): Promise<void>;
}

type StoredEntry = ChatOutboxEntry & { operationId: string };
const databaseName = 'agents-chat-outbox';
const storeName = 'operations';
const leaseDuration = 60_000;

function storageError(action: string, cause: unknown): Error {
  const reason = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return new Error(`Chat outbox ${action} failed: ${reason}`, { cause });
}

function validateUser(userId: string) {
  if (!userId) throw new Error('Chat outbox requires a user ID');
}

function validateEntry(userId: string, entry: ChatOutboxEntry) {
  if (entry.userId !== userId) throw new Error('Chat outbox entry belongs to a different user');
  if (!entry.operation.operationId) throw new Error('Chat outbox requires an operation ID');
}

function operationValue(operation: ChatOperation): string {
  return JSON.stringify(operation, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
      : value);
}

function assertSameOperation(existing: ChatOutboxEntry, incoming: ChatOutboxEntry) {
  if (operationValue(existing.operation) !== operationValue(incoming.operation)) {
    throw new Error(`Chat outbox operation ${incoming.operation.operationId} is immutable; different payload rejected`);
  }
}

function orderEntries(entries: ChatOutboxEntry[]): ChatOutboxEntry[] {
  return entries.sort((left, right) =>
    left.createdAt - right.createdAt
    || (left.operation.operationId < right.operation.operationId ? -1 : left.operation.operationId > right.operation.operationId ? 1 : 0));
}

function fromStored({ operationId: _operationId, ...entry }: StoredEntry): ChatOutboxEntry {
  return entry;
}

function canClaim(entry: ChatOutboxEntry | undefined, owner: string, now: number): entry is ChatOutboxEntry {
  return !!owner && !!entry && entry.state === 'pending'
    && (!entry.leaseOwner || (entry.leaseUntil ?? 0) <= now || entry.leaseOwner === owner);
}

function canRenew(entry: ChatOutboxEntry | undefined, owner: string, now: number): entry is ChatOutboxEntry {
  return !!owner && !!entry && entry.state === 'pending'
    && entry.leaseOwner === owner && (entry.leaseUntil ?? 0) > now;
}

function owns(entry: ChatOutboxEntry | undefined, owner: string): entry is ChatOutboxEntry {
  return !!owner && !!entry && entry.leaseOwner === owner;
}

function assertDiscardable(entry: ChatOutboxEntry | undefined) {
  if (entry?.leaseOwner && (entry.leaseUntil ?? 0) > Date.now()) {
    throw new Error(`Chat outbox operation ${entry.operation.operationId} has an active lease and cannot be discarded`);
  }
}

function recoveryCopy(source: ChatOutboxEntry | undefined, candidate: ChatOutboxEntry): ChatOutboxEntry {
  if (!source) throw new Error('The source draft is no longer available. Refresh the local drafts panel.');
  assertDiscardable(source);
  const recovery = source.recovery || { operation: candidate.operation, createdAt: candidate.createdAt };
  return structuredClone({
    userId: source.userId, operation: recovery.operation, createdAt: recovery.createdAt,
    state: 'pending', recoveryOf: source.operation.operationId,
  });
}

function markFailed(entry: ChatOutboxEntry, error: string, state: ChatOutboxEntry['state']) {
  entry.error = error;
  entry.state = state;
  delete entry.leaseOwner;
  delete entry.leaseUntil;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    let rejected = false;
    const fail = (error: unknown) => { rejected = true; reject(error); };
    request.onerror = () => fail(request.error ?? new Error('IndexedDB could not open the outbox'));
    request.onblocked = () => fail(new Error('IndexedDB outbox upgrade is blocked by another open tab'));
    request.onupgradeneeded = () => {
      if (rejected) {
        request.transaction?.abort();
        return;
      }
      try {
        request.result.createObjectStore(storeName, { keyPath: ['userId', 'operationId'] });
      } catch (error) {
        fail(error);
        request.transaction?.abort();
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (rejected) {
        database.close();
        return;
      }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

type TransactionWork<T> = (
  store: IDBObjectStore,
  finish: (value: T) => void,
  guard: (work: () => void) => void,
) => void;

async function transact<T>(action: string, mode: IDBTransactionMode, work: TransactionWork<T>): Promise<T> {
  let database: IDBDatabase;
  try {
    database = await openDatabase();
  } catch (error) {
    throw storageError(action, error);
  }
  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(storeName, mode);
    } catch (error) {
      database.close();
      reject(storageError(action, error));
      return;
    }
    let result: T;
    let failure: unknown;
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onabort = () => {
      database.close();
      reject(storageError(action, failure ?? transaction.error ?? new Error('IndexedDB transaction aborted')));
    };
    transaction.onerror = event => {
      failure ??= (event.target as IDBRequest | null)?.error ?? transaction.error;
    };
    const guard = (callback: () => void) => {
      try {
        callback();
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    guard(() => work(transaction.objectStore(storeName), value => { result = value; }, guard));
  });
}

export function createIndexedDbChatOutbox(userId: string): ChatOutboxStore {
  validateUser(userId);
  const key = (operationId: string): IDBValidKey => [userId, operationId];
  const update = <T>(
    action: string,
    operationId: string,
    change: (entry: StoredEntry | undefined, store: IDBObjectStore) => T,
  ) => transact<T>(action, 'readwrite', (store, finish, guard) => {
    const request = store.get(key(operationId));
    // Queue writes directly in onsuccess so the read/check/write remains one active transaction.
    request.onsuccess = () => guard(() => finish(change(request.result as StoredEntry | undefined, store)));
  });

  return {
    async put(entry) {
      validateEntry(userId, entry);
      let snapshot: ChatOutboxEntry;
      try {
        snapshot = structuredClone(entry);
      } catch (error) {
        throw storageError('put', error);
      }
      await update('put', snapshot.operation.operationId, (existing, store) => {
        if (existing) assertSameOperation(existing, snapshot);
        else store.add({ ...snapshot, operationId: snapshot.operation.operationId } satisfies StoredEntry);
      });
    },
    async prepareCopy(sourceOperationId, candidate) {
      validateEntry(userId, candidate);
      return transact<ChatOutboxEntry>('prepare recovery', 'readwrite', (store, finish, guard) => {
        const readSource = store.get(key(sourceOperationId));
        readSource.onsuccess = () => guard(() => {
          const source = readSource.result as StoredEntry | undefined;
          const copy = recoveryCopy(source, candidate);
          const readCopy = store.get(key(copy.operation.operationId));
          readCopy.onsuccess = () => guard(() => {
            const existing = readCopy.result as StoredEntry | undefined;
            if (existing) assertSameOperation(existing, copy);
            else store.add({ ...copy, operationId: copy.operation.operationId } satisfies StoredEntry);
            if (source && !source.recovery) {
              store.put({ ...source, recovery: { operation: copy.operation, createdAt: copy.createdAt } } satisfies StoredEntry);
            }
            finish(copy);
          });
        });
      });
    },
    list() {
      return transact<ChatOutboxEntry[]>('list', 'readonly', (store, finish, guard) => {
        const entries: ChatOutboxEntry[] = [];
        const request = store.openCursor(IDBKeyRange.bound([userId], [userId, []], false, true));
        request.onsuccess = () => guard(() => {
          const cursor = request.result;
          if (!cursor) {
            finish(orderEntries(entries));
            return;
          }
          entries.push(fromStored(cursor.value as StoredEntry));
          cursor.continue();
        });
      });
    },
    claim(operationId, owner) {
      return update('claim', operationId, (entry, store) => {
        const now = Date.now();
        if (!canClaim(entry, owner, now)) return false;
        store.put({ ...entry, leaseOwner: owner, leaseUntil: now + leaseDuration });
        return true;
      });
    },
    renew(operationId, owner) {
      return update('renew', operationId, (entry, store) => {
        const now = Date.now();
        if (!canRenew(entry, owner, now)) return false;
        store.put({ ...entry, leaseUntil: now + leaseDuration });
        return true;
      });
    },
    complete(operationId, owner) {
      return update('complete', operationId, (entry, store) => {
        if (owns(entry, owner)) store.delete(key(operationId));
      });
    },
    fail(operationId, owner, error, state) {
      return update('fail', operationId, (entry, store) => {
        if (!owns(entry, owner)) return;
        markFailed(entry, error, state);
        store.put(entry);
      });
    },
    discard(operationIds) {
      const ids = Array.isArray(operationIds) ? operationIds : [operationIds];
      return transact<void>('discard', 'readwrite', (store, finish, guard) => {
        for (const id of ids) {
          const request = store.get(key(id));
          request.onsuccess = () => guard(() => {
            assertDiscardable(request.result as StoredEntry | undefined);
            store.delete(key(id));
          });
        }
        finish(undefined);
      });
    },
  };
}

export function createMemoryChatOutbox(userId = 'test'): ChatOutboxStore {
  validateUser(userId);
  const entries = new Map<string, ChatOutboxEntry>();
  return {
    async put(entry) {
      validateEntry(userId, entry);
      const existing = entries.get(entry.operation.operationId);
      if (existing) assertSameOperation(existing, entry);
      else entries.set(entry.operation.operationId, structuredClone(entry));
    },
    async prepareCopy(sourceOperationId, candidate) {
      validateEntry(userId, candidate);
      const source = entries.get(sourceOperationId);
      const copy = recoveryCopy(source, candidate);
      const existing = entries.get(copy.operation.operationId);
      if (existing) assertSameOperation(existing, copy);
      else entries.set(copy.operation.operationId, structuredClone(copy));
      if (source && !source.recovery) source.recovery = structuredClone({ operation: copy.operation, createdAt: copy.createdAt });
      return copy;
    },
    async list() {
      return orderEntries(structuredClone([...entries.values()]));
    },
    async claim(operationId, owner) {
      const entry = entries.get(operationId);
      const now = Date.now();
      if (!canClaim(entry, owner, now)) return false;
      entry.leaseOwner = owner;
      entry.leaseUntil = now + leaseDuration;
      return true;
    },
    async renew(operationId, owner) {
      const entry = entries.get(operationId);
      const now = Date.now();
      if (!canRenew(entry, owner, now)) return false;
      entry.leaseUntil = now + leaseDuration;
      return true;
    },
    async complete(operationId, owner) {
      if (owns(entries.get(operationId), owner)) entries.delete(operationId);
    },
    async fail(operationId, owner, error, state) {
      const entry = entries.get(operationId);
      if (owns(entry, owner)) markFailed(entry, error, state);
    },
    async discard(operationIds) {
      const ids = Array.isArray(operationIds) ? operationIds : [operationIds];
      for (const id of ids) assertDiscardable(entries.get(id));
      for (const id of ids) entries.delete(id);
    },
  };
}
