import type { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import {
  createMutation,
  type MutationArgsCodec,
  type MutationQueueSnapshot,
} from 'ng-signal-request';
import type { CacheStorage } from 'ng-signal-request/persist';
import { drainMutationQueue } from './sw/sw';
import type { MutationQueueSyncContext, MutationQueueSyncOptions } from './sw/sw';
import {
  MUTATION_QUEUE_VERSION,
  PersistedMutationQueue,
  providePersistedMutationQueue,
  type PersistedMutationQueueOptions,
} from './queue';
import { settle, setup } from '../../testing/testing';

/**
 * The client half of the idempotency contract.
 *
 * The library cannot verify that a server deduplicates `Idempotency-Key`; what it can do is make
 * the key **stable** across every path that can send the same write twice - a same-page retry, a
 * replay after a reload, a replay from another tab and a replay from the service worker. Every
 * assertion here is one of those paths, and the value asserted is the same value the server is
 * expected to remember. `docs/idempotency-contract.md` is the other half.
 */

interface Todo {
  id?: number;
  title: string;
}

interface SaveArgs {
  body: Todo;
}

const STORAGE_KEY = 'ng-signal-request:mutation-queue';

interface MemoryStorage extends CacheStorage {
  readonly map: Map<string, string>;
}

function memoryStorage(initial?: string): MemoryStorage {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(STORAGE_KEY, initial);
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function snapshotOf(storage: MemoryStorage): MutationQueueSnapshot {
  return JSON.parse(
    storage.map.get(STORAGE_KEY) ?? '{"version":1,"entries":[]}',
  ) as MutationQueueSnapshot;
}

function storedSnapshot(entries: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    version: MUTATION_QUEUE_VERSION,
    timestamp: Date.now(),
    entries,
  });
}

function queueProviders(
  storage: MemoryStorage,
  options: PersistedMutationQueueOptions = {},
): ReturnType<typeof providePersistedMutationQueue> {
  return providePersistedMutationQueue({
    storage,
    assumeSingleTab: true,
    retry: { baseDelay: 10, maxDelay: 10 },
    ...options,
  });
}

function saveTodo(
  create: <T>(fn: () => T) => T,
  persistence: {
    key: string;
    codec?: MutationArgsCodec<SaveArgs>;
    idempotencyKey?: (args: SaveArgs) => string;
    idempotencyHeader?: string | false;
  },
) {
  return create(() =>
    createMutation.post<Todo, SaveArgs>((args) => ({ url: '/todos', body: args.body }), {
      networkMode: 'online',
      persistence,
    }),
  );
}

/** Waits for a request to appear; a queued retry is dispatched from a timer, not this stack. */
async function nextRequest(
  http: HttpTestingController,
  url: string,
): Promise<ReturnType<HttpTestingController['match']>[number]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const matches = http.match(url);
    if (matches.length > 0) return matches[0];
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no request was made for ${url}`);
}

const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('idempotency contract, client half', () => {
  it('mints the key before the first send and reuses it verbatim on every retry', async () => {
    const storage = memoryStorage();
    const { http, create } = setup([queueProviders(storage)]);
    const save = saveTodo(create, { key: 'todo.create' });

    const promise = save.run({ body: { title: 'retry me' } });
    await settle();

    const first = await nextRequest(http, '/todos');
    const key = first.request.headers.get('Idempotency-Key');
    expect(key).toMatch(KEY_PATTERN);
    // The stored entry *is* the key: a reload replays from this value, not from memory.
    expect(snapshotOf(storage).entries[0].idempotencyKey).toBe(key);

    first.flush({ message: 'later' }, { status: 503, statusText: 'Service Unavailable' });
    await settle();

    const second = await nextRequest(http, '/todos');
    expect(second.request.headers.get('Idempotency-Key')).toBe(key);
    second.flush({ message: 'later' }, { status: 503, statusText: 'Service Unavailable' });
    await settle();

    const third = await nextRequest(http, '/todos');
    expect(third.request.headers.get('Idempotency-Key')).toBe(key);
    third.flush({ id: 1, title: 'retry me' });

    await expect(promise).resolves.toEqual({ id: 1, title: 'retry me' });
    await settle();
    // Three attempts, one effect: the server only ever has to remember one key.
    expect(snapshotOf(storage).entries).toEqual([]);
  });

  it('replays a hydrated entry with the key that was stored with it', async () => {
    const storage = memoryStorage(
      storedSnapshot([
        {
          id: 'entry-1',
          key: 'todo.create',
          version: 1,
          args: { body: { title: 'from a previous page' } },
          createdAt: 1,
          seq: 1,
          idempotencyKey: 'idem-from-the-first-page',
          attempts: 0,
          state: 'pending',
        },
      ]),
    );
    const { http, create } = setup([queueProviders(storage)]);
    saveTodo(create, { key: 'todo.create' });

    const request = await nextRequest(http, '/todos');
    expect(request.request.headers.get('Idempotency-Key')).toBe('idem-from-the-first-page');
    request.flush({ id: 2, title: 'from a previous page' });
    await settle();
  });

  it('lets the application mint the key so two separate calls deduplicate', async () => {
    const storage = memoryStorage();
    const { http, create } = setup([queueProviders(storage)]);
    // The payload is the identity: a user who presses "save" twice, or a retry the application
    // starts itself, is the same write to the server.
    const save = saveTodo(create, {
      key: 'todo.create',
      idempotencyKey: (args) => `todo:${args.body.title}`,
    });

    const first = save.run({ body: { title: 'same payload' } });
    await settle();
    const firstRequest = await nextRequest(http, '/todos');
    expect(firstRequest.request.headers.get('Idempotency-Key')).toBe('todo:same payload');
    firstRequest.flush({ id: 3, title: 'same payload' });
    await expect(first).resolves.toEqual({ id: 3, title: 'same payload' });
    await settle();

    const second = save.run({ body: { title: 'same payload' } });
    await settle();
    const secondRequest = await nextRequest(http, '/todos');
    expect(secondRequest.request.headers.get('Idempotency-Key')).toBe('todo:same payload');
    secondRequest.flush({ id: 3, title: 'same payload' });
    await settle();
    expect(secondRequest.request.headers.get('Idempotency-Key')).toBe(
      firstRequest.request.headers.get('Idempotency-Key'),
    );
    await expect(second).resolves.toEqual({ id: 3, title: 'same payload' });
  });

  it('honours a caller-supplied key instead of minting one', async () => {
    const storage = memoryStorage();
    const { http, create } = setup([queueProviders(storage)]);
    const save = create(() =>
      createMutation.post<Todo, SaveArgs>((args) => ({ url: '/todos', body: args.body }), {
        networkMode: 'online',
        headers: { 'Idempotency-Key': 'from-the-form' },
        persistence: { key: 'todo.create' },
      }),
    );

    const promise = save.run({ body: { title: 'typed twice' } });
    await settle();
    const request = await nextRequest(http, '/todos');
    expect(request.request.headers.get('Idempotency-Key')).toBe('from-the-form');
    expect(snapshotOf(storage).entries[0].idempotencyKey).toBe('from-the-form');
    request.flush({ id: 4, title: 'typed twice' });
    await expect(promise).resolves.toEqual({ id: 4, title: 'typed twice' });
  });

  it('does not retry an ambiguous failure when the mutation opted out of the header', async () => {
    const storage = memoryStorage();
    const { http, create } = setup([queueProviders(storage)]);
    const save = saveTodo(create, { key: 'todo.create', idempotencyHeader: false });

    const promise = save.run({ body: { title: 'no header' } });
    await settle();
    const request = await nextRequest(http, '/todos');
    expect(request.request.headers.has('Idempotency-Key')).toBe(false);
    request.flush({ message: 'boom' }, { status: 503, statusText: 'Service Unavailable' });
    await settle();

    // Without a key a 503 is ambiguous: retrying it could apply the write twice.
    await expect(promise).rejects.toBeTruthy();
    expect(http.match('/todos')).toHaveLength(0);
    expect(snapshotOf(storage).entries[0].state).toBe('failed');
    expect(snapshotOf(storage).entries[0].idempotencyKey).not.toBe('');
  });

  it('gives the service worker the same stored key, and the same one again after a retry', async () => {
    const storage = memoryStorage(
      storedSnapshot([
        {
          id: 'entry-worker',
          key: 'todo.create',
          version: 1,
          args: { body: { title: 'worker replay' } },
          createdAt: 1,
          seq: 1,
          idempotencyKey: 'idem-for-the-worker',
          attempts: 0,
          state: 'pending',
        },
      ]),
    );
    const seen: string[] = [];
    const options: MutationQueueSyncOptions = {
      storage,
      lock: false,
      now: () => Date.now(),
      handlers: [
        {
          key: 'todo.create',
          replay: (_args: unknown, context: MutationQueueSyncContext) => {
            seen.push(context.idempotencyKey);
            return Promise.reject(Object.assign(new Error('try again'), { status: 503 }));
          },
        },
      ],
    };

    await drainMutationQueue(options);
    expect(seen).toEqual(['idem-for-the-worker']);
    // The retry is stored, not forgotten: the next drain - another tab, or the next sync event -
    // sends the identical key.
    const stored = JSON.parse(storage.map.get(STORAGE_KEY) ?? '{}') as MutationQueueSnapshot;
    expect(stored.entries[0].idempotencyKey).toBe('idem-for-the-worker');
    expect(stored.entries[0].attempts).toBe(1);

    await drainMutationQueue({ ...options, now: () => Date.now() + 60_000 });
    expect(seen).toEqual(['idem-for-the-worker', 'idem-for-the-worker']);
  });

  it('exposes the entry the key belongs to, so a support bundle can be matched to a request', async () => {
    const storage = memoryStorage();
    setup([queueProviders(storage)]);
    const queue = TestBed.inject(PersistedMutationQueue);
    await settle();

    const result = await queue.enqueue({
      key: 'todo.create',
      version: 1,
      args: { body: { title: 'bundle' } },
      idempotencyKey: 'idem-in-the-bundle',
    });
    expect(result?.entry.idempotencyKey).toBe('idem-in-the-bundle');
    expect(queue.export()).toContain('idem-in-the-bundle');
  });
});
