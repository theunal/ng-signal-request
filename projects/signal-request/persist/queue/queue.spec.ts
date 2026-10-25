import { HttpErrorResponse } from '@angular/common/http';
import { HttpTestingController } from '@angular/common/http/testing';
import {
  createEnvironmentInjector,
  EnvironmentInjector,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  createMutation,
  MutationDetachedError,
  MutationQueueFullError,
  OnlineManager,
  RESTORE_GATE,
  type MutationArgsCodec,
  type MutationQueueSnapshot,
  type RestoreGate,
} from 'ng-signal-request';
import type { CacheStorage } from 'ng-signal-request/persist';
import {
  MUTATION_QUEUE_VERSION,
  PersistedMutationQueue,
  providePersistedMutationQueue,
  type PersistedMutationQueueOptions,
} from './queue';
import { settle, setup } from '../../testing/testing';

interface Todo {
  id?: number;
  title: string;
}

interface SaveArgs {
  body: Todo;
}

interface MemoryStorage extends CacheStorage {
  readonly map: Map<string, string>;
  refuse: boolean;
  writes: number;
}

function memoryStorage(initial?: string): MemoryStorage {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set('ng-signal-request:mutation-queue', initial);
  return {
    map,
    refuse: false,
    writes: 0,
    getItem(key) {
      return map.get(key) ?? null;
    },
    setItem(key, value) {
      if (this.refuse) throw new Error('storage is full');
      this.writes++;
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

function snapshot(storage: MemoryStorage): MutationQueueSnapshot | null {
  const raw = storage.map.get('ng-signal-request:mutation-queue');
  return raw === undefined ? null : (JSON.parse(raw) as MutationQueueSnapshot);
}

function queueProviders(
  storage: MemoryStorage,
  options: PersistedMutationQueueOptions = {},
): ReturnType<typeof providePersistedMutationQueue> {
  return providePersistedMutationQueue({
    storage,
    assumeSingleTab: true,
    ...options,
  });
}

function saveTodo(
  create: <T>(fn: () => T) => T,
  persistence: {
    key: string;
    codec?: MutationArgsCodec<SaveArgs>;
    onRestore?: (args: SaveArgs) => void;
    isAlreadyApplied?: (e: Error) => boolean;
  },
) {
  return create(() =>
    createMutation.post<Todo, SaveArgs>((args) => ({ url: '/todos', body: args.body }), {
      networkMode: 'online',
      persistence,
    }),
  );
}

describe('persisted mutation queue', () => {
  it('writes the entry before sending, sends the idempotency key and removes on success', async () => {
    const storage = memoryStorage();
    const { http, create } = setup([queueProviders(storage)]);
    const save = saveTodo(create, { key: 'todo.create' });

    const promise = save.run({ body: { title: 'write me' } });
    await settle();

    const stored = snapshot(storage);
    expect(stored?.version).toBe(MUTATION_QUEUE_VERSION);
    expect(stored?.entries).toHaveLength(1);
    expect(stored?.entries[0]).toMatchObject({
      key: 'todo.create',
      args: { body: { title: 'write me' } },
      state: 'pending',
    });

    const request = http.expectOne('/todos');
    expect(request.request.headers.get('Idempotency-Key')).toBe(stored?.entries[0].idempotencyKey);
    request.flush({ id: 7, title: 'write me' });

    await expect(promise).resolves.toEqual({ id: 7, title: 'write me' });
    await settle();
    expect(snapshot(storage)?.entries).toEqual([]);
  });

  it('does not write request headers or onMutate context to storage', async () => {
    const storage = memoryStorage();
    const { create } = setup([queueProviders(storage)]);
    const online = TestBed.inject(OnlineManager);
    online.setOnline(false);

    const save = create(() =>
      createMutation<Todo, SaveArgs, { secret: string }>(
        (args) => ({
          url: '/todos',
          body: args.body,
          headers: { Authorization: 'Bearer secret-token' },
        }),
        {
          networkMode: 'online',
          onMutate: () => ({ secret: 'context-secret' }),
          persistence: { key: 'todo.create' },
        },
      ),
    );
    const pending = save.run({ body: { title: 'no secrets' } });
    await settle();

    const raw = storage.map.get('ng-signal-request:mutation-queue') ?? '';
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('context-secret');
    // The stored shape is the entry contract, not the built request: only these fields can appear.
    expect(Object.keys(snapshot(storage)?.entries[0] ?? {}).sort()).toEqual([
      'args',
      'attempts',
      'createdAt',
      'id',
      'idempotencyKey',
      'key',
      'seq',
      'state',
      'version',
    ]);

    save.destroy();
    await expect(pending).rejects.toBeInstanceOf(MutationDetachedError);
  });

  it('waits while offline and still settles the original promise after reconnect', async () => {
    const storage = memoryStorage();
    const { http, create } = setup([queueProviders(storage)]);
    const online = TestBed.inject(OnlineManager);
    online.setOnline(false);
    const save = saveTodo(create, { key: 'todo.create' });

    const promise = save.run({ body: { title: 'offline' } });
    await settle();
    expect(snapshot(storage)?.entries).toHaveLength(1);
    http.expectNone('/todos');

    online.setOnline(true);
    await settle();
    const request = http.expectOne('/todos');
    request.flush({ id: 1, title: 'offline' });

    await expect(promise).resolves.toEqual({ id: 1, title: 'offline' });
    await settle();
    expect(snapshot(storage)?.entries).toEqual([]);
  });

  it('rejects a destroyed durable call with MutationDetachedError and keeps the entry', async () => {
    const storage = memoryStorage();
    const { http, create } = setup([queueProviders(storage)]);
    const online = TestBed.inject(OnlineManager);
    online.setOnline(false);
    const save = saveTodo(create, { key: 'todo.create' });

    const promise = save.run({ body: { title: 'detach' } });
    await settle();
    save.destroy();

    await expect(promise).rejects.toBeInstanceOf(MutationDetachedError);
    expect(snapshot(storage)?.entries).toHaveLength(1);
    http.expectNone('/todos');
  });

  it('rejects a new call when the queue is full instead of evicting pending work', async () => {
    const storage = memoryStorage();
    const { http, create } = setup([queueProviders(storage, { maxEntries: 1 })]);
    const online = TestBed.inject(OnlineManager);
    online.setOnline(false);
    const save = saveTodo(create, { key: 'todo.create' });

    const first = save.run({ body: { title: 'first' } });
    await settle();
    await expect(save.run({ body: { title: 'second' } })).rejects.toBeInstanceOf(
      MutationQueueFullError,
    );
    expect(snapshot(storage)?.entries).toHaveLength(1);

    save.destroy();
    await expect(first).rejects.toBeInstanceOf(MutationDetachedError);
    http.expectNone('/todos');
  });

  it('hydrates in a new scope, restores optimistically and replays before removing', async () => {
    const storage = memoryStorage();
    setup();
    const parent = TestBed.inject(EnvironmentInjector);
    const online = TestBed.inject(OnlineManager);
    online.setOnline(false);

    const firstScope = createEnvironmentInjector([queueProviders(storage)], parent);
    const first = runInInjectionContext(firstScope, () =>
      saveTodo((fn) => runInInjectionContext(firstScope, fn), { key: 'todo.create' }),
    );
    const pending = first.run({ body: { title: 'across reload' } });
    await settle();
    expect(snapshot(storage)?.entries).toHaveLength(1);
    firstScope.destroy();
    await expect(pending).rejects.toBeInstanceOf(MutationDetachedError);

    online.setOnline(true);
    const restored: SaveArgs[] = [];
    const secondScope = createEnvironmentInjector([queueProviders(storage)], parent);
    const second = runInInjectionContext(secondScope, () =>
      saveTodo((fn) => runInInjectionContext(secondScope, fn), {
        key: 'todo.create',
        onRestore: (args) => restored.push(args),
      }),
    );
    await settle();

    expect(restored).toEqual([{ body: { title: 'across reload' } }]);
    const httpRequest = TestBed.inject(HttpTestingController).expectOne('/todos');
    httpRequest.flush({ id: 2, title: 'across reload' });
    await settle();
    expect(snapshot(storage)?.entries).toEqual([]);

    second.destroy();
    secondScope.destroy();
  });

  it('treats a replay 409 as already applied when the mutation says so', async () => {
    const storage = memoryStorage();
    setup();
    const parent = TestBed.inject(EnvironmentInjector);
    const online = TestBed.inject(OnlineManager);
    online.setOnline(true);

    const firstScope = createEnvironmentInjector([queueProviders(storage)], parent);
    const first = runInInjectionContext(firstScope, () =>
      saveTodo((fn) => runInInjectionContext(firstScope, fn), { key: 'todo.create' }),
    );
    // Seed the entry without a live request by going offline, then destroy the scope.
    online.setOnline(false);
    const pending = first.run({ body: { title: 'already applied' } });
    await settle();
    firstScope.destroy();
    await expect(pending).rejects.toBeInstanceOf(MutationDetachedError);
    online.setOnline(true);

    const secondScope = createEnvironmentInjector([queueProviders(storage)], parent);
    runInInjectionContext(secondScope, () =>
      saveTodo((fn) => runInInjectionContext(secondScope, fn), {
        key: 'todo.create',
        isAlreadyApplied: (error) => (error as HttpErrorResponse).status === 409,
      }),
    );
    await settle();

    const http = TestBed.inject(HttpTestingController);
    http
      .expectOne('/todos')
      .flush({ message: 'duplicate' }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(snapshot(storage)?.entries).toEqual([]);

    secondScope.destroy();
  });

  it('writes durably before an in-flight cache restore finishes', async () => {
    const storage = memoryStorage();
    let release!: () => void;
    const gate: RestoreGate = {
      isRestoring: signal(true),
      restored: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    };
    const { http, create } = setup([
      { provide: RESTORE_GATE, useValue: gate },
      queueProviders(storage),
    ]);
    const online = TestBed.inject(OnlineManager);
    online.setOnline(false);
    const save = saveTodo(create, { key: 'todo.create' });

    const promise = save.run({ body: { title: 'before gate' } });
    await settle();

    // The cache restore gate has not answered, but enqueue did not wait for it.
    expect(snapshot(storage)?.entries).toHaveLength(1);
    http.expectNone('/todos');

    save.destroy();
    await expect(promise).rejects.toBeInstanceOf(MutationDetachedError);
    release();
    await settle();
  });

  it('quarantines stored args that the codec can no longer read', async () => {
    const storage = memoryStorage(
      JSON.stringify({
        version: MUTATION_QUEUE_VERSION,
        timestamp: 0,
        entries: [
          {
            id: 'entry-bad',
            key: 'todo.create',
            version: 1,
            args: { title: 'old shape' },
            createdAt: 0,
            seq: 1,
            idempotencyKey: 'idem-bad',
            attempts: 0,
            state: 'pending',
          },
        ],
      }),
    );
    const { http, create } = setup([queueProviders(storage)]);
    const codec: MutationArgsCodec<SaveArgs> = {
      serialize: (args) => args,
      deserialize(value) {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('body' in value) ||
          typeof (value as { body?: unknown }).body !== 'object'
        ) {
          throw new Error('old args shape');
        }
        return value as SaveArgs;
      },
    };
    const save = saveTodo(create, { key: 'todo.create', codec });
    await settle();

    const queue = TestBed.inject(PersistedMutationQueue);
    expect(queue.entries()[0].state).toBe('quarantined');
    http.expectNone('/todos');
    save.destroy();
  });

  it('classifies retry, auth and permanent failures without deleting the entry', async () => {
    const storage = memoryStorage();
    setup([queueProviders(storage)]);
    const queue = TestBed.inject(PersistedMutationQueue);
    await settle();

    const first = await queue.enqueue({
      key: 'todo.create',
      version: 1,
      args: { title: 'retry' },
      idempotencyKey: 'idem-1',
    });
    expect(first).not.toBeNull();
    const retry = queue.failed(
      first!.entry.id,
      new HttpErrorResponse({ status: 503, statusText: 'Unavailable' }),
      { replay: false, idempotencyHeader: true },
    );
    expect(retry).toBe('retry');
    expect(queue.entries()[0]).toMatchObject({ state: 'pending', attempts: 1 });

    const auth = queue.failed(
      first!.entry.id,
      new HttpErrorResponse({ status: 401, statusText: 'Unauthorized' }),
      { replay: false, idempotencyHeader: true },
    );
    expect(auth).toBe('auth');
    expect(queue.needsAuth()).toBe(true);
    queue.resume();
    expect(queue.needsAuth()).toBe(false);

    const permanent = queue.failed(
      first!.entry.id,
      new HttpErrorResponse({ status: 400, statusText: 'Bad Request' }),
      { replay: false, idempotencyHeader: true },
    );
    expect(permanent).toBe('failed');
    expect(queue.entries()[0].state).toBe('failed');
    expect(snapshot(storage)?.entries).toHaveLength(1);

    queue.retry(first!.entry.id);
    expect(queue.entries()[0].state).toBe('pending');
  });

  it('quarantines a corrupt snapshot instead of deleting it', async () => {
    const raw = '{ not json';
    const storage = memoryStorage(raw);
    setup([queueProviders(storage)]);

    const queue = TestBed.inject(PersistedMutationQueue);
    await settle();
    expect(queue.enabled()).toBe(false);
    expect(queue.export()).toBe(raw);
    expect(storage.map.get('ng-signal-request:mutation-queue')).toBe(raw);
  });

  it('falls back to a non-durable call when storage refuses the first write', async () => {
    const storage = memoryStorage();
    storage.refuse = true;
    const { http, create } = setup([queueProviders(storage)]);
    const save = saveTodo(create, { key: 'todo.create' });

    const promise = save.run({ body: { title: 'no storage' } });
    await settle();
    http.expectOne('/todos').flush({ id: 2, title: 'no storage' });
    await expect(promise).resolves.toEqual({ id: 2, title: 'no storage' });
  });

  it('rejects persistence with switch concurrency in development', () => {
    const { create } = setup([queueProviders(memoryStorage())]);
    expect(() =>
      create(() =>
        createMutation.post<Todo, Todo>(() => '/todos', {
          concurrency: 'switch',
          persistence: { key: 'todo.create' },
        }),
      ),
    ).toThrow(/switch/);
  });

  it('exports and clears the durable snapshot', async () => {
    const storage = memoryStorage();
    setup([queueProviders(storage)]);
    const queue = TestBed.inject(PersistedMutationQueue);
    await settle();

    const entry = await queue.enqueue({
      key: 'todo.create',
      version: 1,
      args: { title: 'export' },
      idempotencyKey: 'idem-2',
    });
    expect(entry).not.toBeNull();
    expect(JSON.parse(queue.export()).entries).toHaveLength(1);

    await queue.clear();
    expect(queue.entries()).toEqual([]);
    expect(snapshot(storage)).toBeNull();
  });

  it('emits a queue-full event and never evicts pending entries', async () => {
    const storage = memoryStorage();
    setup([queueProviders(storage, { maxEntries: 1 })]);
    const queue = TestBed.inject(PersistedMutationQueue);
    const events: string[] = [];
    queue.onEvent((event) => events.push(event.type));
    await settle();

    await queue.enqueue({
      key: 'todo.create',
      version: 1,
      args: {},
      idempotencyKey: 'idem-3',
    });
    await expect(
      queue.enqueue({
        key: 'todo.create',
        version: 1,
        args: {},
        idempotencyKey: 'idem-4',
      }),
    ).rejects.toBeInstanceOf(MutationQueueFullError);
    expect(events).toContain('queue-full');
    expect(queue.entries()).toHaveLength(1);
  });

  it('reports a missing Web Locks API as disabled instead of risking two tabs', async () => {
    const storage = memoryStorage();
    const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    try {
      setup([providePersistedMutationQueue({ storage })]);
      const queue = TestBed.inject(PersistedMutationQueue);
      await settle();
      expect(queue.enabled()).toBe(false);
      expect(queue.owner()).toBe(false);
    } finally {
      if (original === undefined) {
        delete (globalThis.navigator as { locks?: unknown }).locks;
      } else {
        Object.defineProperty(globalThis.navigator, 'locks', original);
      }
    }
  });

  it('keeps failed entries when stopOnFailure is false and lets a retry move them back', async () => {
    const storage = memoryStorage();
    setup([queueProviders(storage, { stopOnFailure: false })]);
    const queue = TestBed.inject(PersistedMutationQueue);
    await settle();

    const entry = await queue.enqueue({
      key: 'todo.create',
      version: 1,
      args: {},
      idempotencyKey: 'idem-5',
    });
    queue.pause();
    expect(
      queue.failed(entry!.entry.id, new Error('boom'), {
        replay: false,
        idempotencyHeader: true,
      }),
    ).toBe('failed');
    expect(queue.entries()[0].state).toBe('failed');

    // `retryAll` is the escape hatch for a batch of permanent failures.
    queue.retryAll();
    expect(queue.entries()[0].state).toBe('pending');
  });

  it('persists an event listener removal and a storage error without throwing', async () => {
    const storage = memoryStorage();
    setup([queueProviders(storage)]);
    const queue = TestBed.inject(PersistedMutationQueue);
    const listener = vi.fn();
    const off = queue.onEvent(listener);
    off();
    await settle();
    storage.refuse = true;
    await queue.enqueue({
      key: 'todo.create',
      version: 1,
      args: {},
      idempotencyKey: 'idem-6',
    });
    expect(listener).not.toHaveBeenCalled();
    expect(queue.enabled()).toBe(false);
  });
});
