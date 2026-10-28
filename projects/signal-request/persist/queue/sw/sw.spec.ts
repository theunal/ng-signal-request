import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersistedMutationEntry } from 'ng-signal-request';
import {
  MUTATION_QUEUE_SYNC_TAG,
  MUTATION_QUEUE_SYNC_VERSION,
  drainMutationQueue,
  indexedDbQueueStorage,
  registerMutationQueueSync,
  type MutationQueueSyncHandler,
  type MutationQueueSyncStorage,
} from './sw';

interface MemoryStorage extends MutationQueueSyncStorage {
  readonly map: Map<string, string>;
  failRead: boolean;
  failWrite: boolean;
}

function memoryStorage(initial?: string): MemoryStorage {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(MUTATION_QUEUE_SYNC_TAG, initial);
  return {
    map,
    failRead: false,
    failWrite: false,
    getItem(key) {
      if (this.failRead) throw new Error('read failed');
      return map.get(key) ?? null;
    },
    setItem(key, value) {
      if (this.failWrite) throw new Error('write failed');
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

function entry(overrides: Partial<PersistedMutationEntry> = {}): PersistedMutationEntry {
  return {
    id: 'entry-1',
    key: 'todos.add',
    version: 1,
    args: { title: 'stored' },
    createdAt: 1,
    seq: 1,
    idempotencyKey: 'idem-1',
    attempts: 0,
    state: 'pending',
    ...overrides,
  };
}

function snapshot(entries: readonly PersistedMutationEntry[], buster?: string): string {
  return JSON.stringify({
    version: MUTATION_QUEUE_SYNC_VERSION,
    timestamp: 1,
    ...(buster === undefined ? {} : { buster }),
    entries,
  });
}

function stored(storage: MemoryStorage): readonly PersistedMutationEntry[] {
  const raw = storage.map.get(MUTATION_QUEUE_SYNC_TAG);
  return raw === undefined
    ? []
    : (JSON.parse(raw) as { entries: PersistedMutationEntry[] }).entries;
}

function handler(
  replay: MutationQueueSyncHandler['replay'],
  overrides: Partial<MutationQueueSyncHandler> = {},
): MutationQueueSyncHandler {
  return { key: 'todos.add', replay, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('service-worker queue drain', () => {
  it('reports an empty queue without writing', async () => {
    const storage = memoryStorage();
    const result = await drainMutationQueue({ storage, handlers: [], lock: false });
    expect(result).toEqual({ status: 'empty', replayed: 0, remaining: 0 });
    expect(storage.map.size).toBe(0);
  });

  it('replays in seq order, reuses the stored key and removes each entry', async () => {
    const storage = memoryStorage(
      snapshot([
        entry({ id: 'b', seq: 2, args: { title: 'second' }, idempotencyKey: 'idem-b' }),
        entry({ id: 'a', seq: 1, args: { title: 'first' }, idempotencyKey: 'idem-a' }),
      ]),
    );
    const seen: string[] = [];
    const keys: string[] = [];
    const result = await drainMutationQueue({
      storage,
      lock: false,
      handlers: [
        handler(async (args, context) => {
          seen.push((args as { title: string }).title);
          keys.push(context.idempotencyKey);
        }),
      ],
    });

    expect(result).toEqual({ status: 'done', replayed: 2, remaining: 0 });
    expect(seen).toEqual(['first', 'second']);
    expect(keys).toEqual(['idem-a', 'idem-b']);
    expect(stored(storage)).toEqual([]);
  });

  it('passes the custom header and the opt-out to the handler', async () => {
    const storage = memoryStorage(snapshot([entry()]));
    const headers: Array<string | false> = [];
    await drainMutationQueue({
      storage,
      lock: false,
      handlers: [
        handler(
          async (_args, context) => {
            headers.push(context.idempotencyHeader);
          },
          { idempotencyHeader: 'X-Idempotency-Key' },
        ),
      ],
    });
    expect(headers).toEqual(['X-Idempotency-Key']);

    const optOut = memoryStorage(snapshot([entry()]));
    await drainMutationQueue({
      storage: optOut,
      lock: false,
      handlers: [
        handler(
          async (_args, context) => {
            headers.push(context.idempotencyHeader);
          },
          { idempotencyHeader: false },
        ),
      ],
    });
    expect(headers).toEqual(['X-Idempotency-Key', false]);
  });

  it('marks a permanent 4xx failed and stops by default', async () => {
    const storage = memoryStorage(snapshot([entry(), entry({ id: 'later', seq: 2 })]));
    const result = await drainMutationQueue({
      storage,
      lock: false,
      handlers: [
        handler(async () => {
          throw Object.assign(new Error('bad request'), { status: 400 });
        }),
      ],
    });

    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('failed');
    expect(result.remaining).toBe(2);
    expect(stored(storage)[0]).toMatchObject({
      state: 'failed',
      attempts: 1,
      lastError: { kind: 'http', status: 400 },
    });
  });

  it('keeps a retryable failure pending with backoff', async () => {
    const storage = memoryStorage(snapshot([entry()]));
    const result = await drainMutationQueue({
      storage,
      lock: false,
      now: () => 1_000,
      handlers: [
        handler(async () => {
          throw Object.assign(new Error('timeout'), { kind: 'timeout' });
        }),
      ],
    });

    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('backoff');
    const [pending] = stored(storage);
    expect(pending).toMatchObject({ state: 'pending', attempts: 1, lastAttemptAt: 1_000 });
    expect(pending.nextAttemptAt).toBeGreaterThan(1_000);
  });

  it('marks an entry failed when maxAttempts is exhausted', async () => {
    const storage = memoryStorage(snapshot([entry({ attempts: 1 })]));
    const result = await drainMutationQueue({
      storage,
      lock: false,
      retry: { maxAttempts: 2 },
      handlers: [
        handler(async () => {
          throw Object.assign(new Error('timeout'), { kind: 'timeout' });
        }),
      ],
    });

    expect(result.reason).toBe('failed');
    expect(stored(storage)[0]).toMatchObject({ state: 'failed', attempts: 2 });
  });

  it('marks a timeout failed when the mutation sends no idempotency header', async () => {
    const storage = memoryStorage(snapshot([entry()]));
    await drainMutationQueue({
      storage,
      lock: false,
      handlers: [
        handler(
          async () => {
            throw Object.assign(new Error('timeout'), { kind: 'timeout' });
          },
          { idempotencyHeader: false },
        ),
      ],
    });
    expect(stored(storage)[0]).toMatchObject({ state: 'failed', attempts: 1 });
  });

  it('stops on 401 and leaves the entry pending', async () => {
    const storage = memoryStorage(snapshot([entry()]));
    const result = await drainMutationQueue({
      storage,
      lock: false,
      handlers: [
        handler(async () => {
          throw Object.assign(new Error('unauthorized'), { status: 401 });
        }),
      ],
    });
    expect(result.reason).toBe('auth');
    expect(stored(storage)[0]).toMatchObject({ state: 'pending', attempts: 1 });
  });

  it('blocks on a missing handler without touching the entry', async () => {
    const storage = memoryStorage(snapshot([entry()]));
    const before = storage.map.get(MUTATION_QUEUE_SYNC_TAG);
    const result = await drainMutationQueue({ storage, handlers: [], lock: false });
    expect(result.reason).toBe('no-handler');
    expect(storage.map.get(MUTATION_QUEUE_SYNC_TAG)).toBe(before);
  });

  it('migrates an old entry and blocks when there is no migration', async () => {
    const blockedStorage = memoryStorage(snapshot([entry({ version: 2 })]));
    const blocked = await drainMutationQueue({
      storage: blockedStorage,
      lock: false,
      handlers: [handler(async () => undefined, { version: 3 })],
    });
    expect(blocked.reason).toBe('version');
    expect(stored(blockedStorage)[0].version).toBe(2);

    const migratedStorage = memoryStorage(snapshot([entry({ version: 2 })]));
    const migrated = await drainMutationQueue({
      storage: migratedStorage,
      lock: false,
      handlers: [
        handler(async () => undefined, {
          version: 3,
          migrate: (old) => ({ ...old, args: { title: 'upgraded' } }),
        }),
      ],
    });
    expect(migrated.status).toBe('done');
    expect(stored(migratedStorage)).toEqual([]);
  });

  it('never overwrites a corrupt or mismatched snapshot', async () => {
    for (const raw of [
      '{not json',
      JSON.stringify({ version: 99, entries: [] }),
      JSON.stringify({ version: 1, entries: [{ id: 'bad' }] }),
    ]) {
      const storage = memoryStorage(raw);
      const result = await drainMutationQueue({ storage, handlers: [], lock: false });
      expect(result.status).toBe('blocked');
      expect(storage.map.get(MUTATION_QUEUE_SYNC_TAG)).toBe(raw);
    }

    const storage = memoryStorage(snapshot([entry()], 'v1'));
    const result = await drainMutationQueue({
      storage,
      buster: 'v2',
      handlers: [handler(async () => undefined)],
      lock: false,
    });
    expect(result.reason).toBe('version');
  });

  it('does not drain while another tab holds the lock', async () => {
    const storage = memoryStorage(snapshot([entry()]));
    const register = vi.fn();
    vi.stubGlobal('navigator', {
      onLine: true,
      locks: {
        request: (
          _name: string,
          _options: unknown,
          callback: (lock: unknown) => unknown,
        ): Promise<unknown> => Promise.resolve(callback(null)),
      },
    });

    const result = await drainMutationQueue({
      storage,
      handlers: [handler(register)],
    });
    expect(result).toEqual({
      status: 'blocked',
      replayed: 0,
      reason: 'locked',
    });
    expect(register).not.toHaveBeenCalled();
  });

  it('drains when it acquires the lock', async () => {
    const storage = memoryStorage(snapshot([entry()]));
    const register = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', {
      onLine: true,
      locks: {
        request: (
          _name: string,
          _options: unknown,
          callback: (lock: unknown) => unknown,
        ): Promise<unknown> => Promise.resolve(callback({ name: 'queue' })),
      },
    });

    const result = await drainMutationQueue({
      storage,
      handlers: [handler(register)],
    });
    expect(result.status).toBe('done');
    expect(register).toHaveBeenCalledOnce();
  });

  it('reports a storage write failure without throwing', async () => {
    const storage = memoryStorage(snapshot([entry()]));
    storage.failWrite = true;
    const result = await drainMutationQueue({
      storage,
      lock: false,
      handlers: [handler(async () => undefined)],
    });
    expect(result.reason).toBe('storage');
    // The entry is still in storage: a successful send is not lost by a failed cleanup write.
    expect(stored(storage)).toHaveLength(1);
  });

  it('skips a failed entry when stopOnFailure is false', async () => {
    const storage = memoryStorage(
      snapshot([
        entry({ id: 'failed', seq: 1, state: 'failed' }),
        entry({ id: 'later', seq: 2, args: { title: 'later' } }),
      ]),
    );
    const seen: string[] = [];
    const result = await drainMutationQueue({
      storage,
      lock: false,
      stopOnFailure: false,
      handlers: [
        handler(async (args) => {
          seen.push((args as { title: string }).title);
        }),
      ],
    });
    expect(result).toMatchObject({ status: 'done', replayed: 1, remaining: 1 });
    expect(seen).toEqual(['later']);
  });

  it('quarantines an entry whose args cannot be deserialized', async () => {
    const storage = memoryStorage(snapshot([entry()]));
    const result = await drainMutationQueue({
      storage,
      lock: false,
      handlers: [
        handler(async () => undefined, {
          deserialize: () => {
            throw new Error('bad shape');
          },
        }),
      ],
    });
    expect(result.reason).toBe('quarantined');
    expect(stored(storage)[0]).toMatchObject({
      state: 'quarantined',
      lastError: { kind: 'deserialize' },
    });
  });

  it('does not send while the browser reports offline', async () => {
    const storage = memoryStorage(snapshot([entry()]));
    vi.stubGlobal('navigator', { onLine: false });
    const register = vi.fn();
    const result = await drainMutationQueue({
      storage,
      lock: false,
      handlers: [handler(register)],
    });
    expect(result.reason).toBe('offline');
    expect(register).not.toHaveBeenCalled();
  });

  it('honours Retry-After for a 429', async () => {
    const storage = memoryStorage(snapshot([entry()]));
    const result = await drainMutationQueue({
      storage,
      lock: false,
      now: () => 10_000,
      handlers: [
        handler(async () => {
          throw Object.assign(new Error('slow down'), {
            status: 429,
            headers: { get: (name: string) => (name === 'Retry-After' ? '3' : null) },
          });
        }),
      ],
    });
    expect(result.reason).toBe('backoff');
    expect(stored(storage)[0].nextAttemptAt).toBe(13_000);
  });

  it('keeps the first handler when two definitions share a key', async () => {
    const storage = memoryStorage(snapshot([entry()]));
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    await drainMutationQueue({
      storage,
      lock: false,
      handlers: [handler(first), handler(second)],
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it('emits events for a successful replay', async () => {
    const storage = memoryStorage(snapshot([entry()]));
    const events: string[] = [];
    await drainMutationQueue({
      storage,
      lock: false,
      handlers: [handler(async () => undefined)],
      onEvent: (event) => events.push(event.type),
    });
    expect(events).toEqual(['succeeded', 'removed']);
  });

  it('reports a storage read failure', async () => {
    const storage = memoryStorage();
    storage.failRead = true;
    const result = await drainMutationQueue({ storage, handlers: [], lock: false });
    expect(result.reason).toBe('storage');
  });
});

describe('registerMutationQueueSync', () => {
  it('returns false when the browser has no SyncManager', async () => {
    const registration = {} as ServiceWorkerRegistration;
    await expect(registerMutationQueueSync(registration)).resolves.toBe(false);
  });

  it('registers the default tag', async () => {
    const register = vi.fn(async () => undefined);
    const registration = { sync: { register } } as unknown as ServiceWorkerRegistration;
    await expect(registerMutationQueueSync(registration)).resolves.toBe(true);
    expect(register).toHaveBeenCalledWith(MUTATION_QUEUE_SYNC_TAG);
  });

  it('registers a custom tag and propagates a rejection', async () => {
    const register = vi.fn(async () => {
      throw new Error('quota');
    });
    const registration = { sync: { register } } as unknown as ServiceWorkerRegistration;
    await expect(registerMutationQueueSync(registration, { tag: 'custom' })).rejects.toThrow(
      'quota',
    );
    expect(register).toHaveBeenCalledWith('custom');
  });
});

describe('indexedDbQueueStorage', () => {
  it('rejects when IndexedDB is not available', async () => {
    const original = globalThis.indexedDB;
    // jsdom has no IndexedDB; the cast keeps the test independent of the DOM lib's optionality.
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = undefined;
    try {
      await expect(indexedDbQueueStorage().getItem('key')).rejects.toThrow('IndexedDB');
    } finally {
      (globalThis as { indexedDB?: IDBFactory }).indexedDB = original;
    }
  });
});
