/**
 * The configuration, migration and ownership half of the durable queue.
 *
 * `queue.spec.ts` covers the delivery path (enqueue, replay, failure classification). This file
 * covers the decisions an application makes *around* it: which services are constructed before
 * replay, what happens to a snapshot from another version or buster, which header carries the
 * idempotency key, and what the queue does when it is told not to degrade.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { HttpTestingController } from '@angular/common/http/testing';
import {
  createEnvironmentInjector,
  EnvironmentInjector,
  ErrorHandler,
  Injectable,
  PLATFORM_ID,
  runInInjectionContext,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  createMutation,
  MutationQueueDisabledError,
  OnlineManager,
  RequestCancelledError,
  type MutationArgsCodec,
  type MutationQueueSnapshot,
  type PersistedMutationEntry,
  type SignalMutation,
} from 'ng-signal-request';
import type { CacheStorage } from 'ng-signal-request/persist';
import {
  MUTATION_QUEUE_VERSION,
  PersistedMutationQueue,
  providePersistedMutationQueue,
  type PersistedMutationQueueOptions,
} from './queue';
import { settle, setup } from '../../testing/testing';

const QUEUE_KEY = 'ng-signal-request:mutation-queue';

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
}

function memoryStorage(initial?: string): MemoryStorage {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(QUEUE_KEY, initial);
  return {
    map,
    refuse: false,
    getItem: (key) => map.get(key) ?? null,
    setItem(key, value) {
      if (this.refuse) throw new Error('storage is full');
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function entry(overrides: Partial<PersistedMutationEntry> = {}): PersistedMutationEntry {
  return {
    id: 'entry-1',
    key: 'todo.create',
    version: 1,
    args: { body: { title: 'stored' } },
    createdAt: 1,
    seq: 1,
    idempotencyKey: 'idem-stored',
    attempts: 0,
    state: 'pending',
    ...overrides,
  };
}

function snapshotWith(entries: readonly PersistedMutationEntry[], buster?: string): string {
  const snapshot: MutationQueueSnapshot = {
    version: MUTATION_QUEUE_VERSION,
    timestamp: 1,
    ...(buster === undefined ? {} : { buster }),
    entries,
  };
  return JSON.stringify(snapshot);
}

function entriesIn(storage: MemoryStorage): readonly PersistedMutationEntry[] {
  const raw = storage.map.get(QUEUE_KEY);
  return raw === undefined ? [] : (JSON.parse(raw) as MutationQueueSnapshot).entries;
}

function queueProviders(
  storage: MemoryStorage,
  options: PersistedMutationQueueOptions = {},
): ReturnType<typeof providePersistedMutationQueue> {
  return providePersistedMutationQueue({ storage, assumeSingleTab: true, ...options });
}

function saveTodo(
  create: <T>(fn: () => T) => T,
  persistence: {
    key: string;
    version?: number;
    codec?: MutationArgsCodec<SaveArgs>;
    idempotencyKey?: (args: SaveArgs) => string;
    idempotencyHeader?: string | false;
    onRestore?: (args: SaveArgs) => void;
  },
): SignalMutation<Todo, SaveArgs, undefined> {
  return create(() =>
    createMutation.post<Todo, SaveArgs>((args) => ({ url: '/todos', body: args.body }), {
      networkMode: 'online',
      persistence,
    }),
  );
}

interface LockRequestOptions {
  readonly mode: 'exclusive';
  readonly ifAvailable?: boolean;
  readonly signal?: AbortSignal;
}

interface FakeLockManager {
  request(
    name: string,
    options: LockRequestOptions,
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>;
  readonly held: Set<string>;
}

/**
 * A Web Locks stand-in that actually queues.
 *
 * jsdom has no `navigator.locks`, and a fake that only answers `ifAvailable` cannot test a handoff:
 * the whole point is that a *waiting* request is granted when the holder goes away. `held` is
 * exposed so a test can assert the lock really moved rather than being re-acquired by accident.
 */
function fakeLockManager(): FakeLockManager {
  const held = new Set<string>();
  const waiting: Array<{ name: string; start: () => void }> = [];

  const run = (name: string, callback: (lock: unknown) => unknown): Promise<unknown> => {
    held.add(name);
    return Promise.resolve(callback({ name })).then(() => {
      held.delete(name);
      const index = waiting.findIndex((candidate) => candidate.name === name);
      if (index === -1) return;
      const [next] = waiting.splice(index, 1);
      next.start();
    });
  };

  return {
    held,
    request(name, options, callback) {
      if (options.ifAvailable) {
        return held.has(name) ? Promise.resolve(callback(null)) : run(name, callback);
      }
      if (!held.has(name)) return run(name, callback);
      return new Promise((resolve, reject) => {
        const entry = {
          name,
          start: () => {
            resolve(run(name, callback));
          },
        };
        waiting.push(entry);
        options.signal?.addEventListener(
          'abort',
          () => {
            const index = waiting.indexOf(entry);
            if (index !== -1) waiting.splice(index, 1);
            reject(new Error('AbortError'));
          },
          { once: true },
        );
      });
    },
  };
}

interface FakeSyncRegistration {
  readonly sync?: { readonly register: (tag: string) => Promise<void> };
}

/**
 * Installs a fake `navigator.serviceWorker` for one test.
 *
 * `null` means "this browser has no service worker at all", which is what jsdom actually is and
 * what the unsupported-browser path must handle. The descriptor is restored afterwards because the
 * queue reads `navigator` lazily, and leaking a worker into the next test would hide that path.
 */
async function withServiceWorker(
  registration: FakeSyncRegistration | null,
  run: () => Promise<void>,
): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'serviceWorker');
  Object.defineProperty(globalThis.navigator, 'serviceWorker', {
    configurable: true,
    value: registration === null ? undefined : { ready: Promise.resolve(registration) },
  });
  try {
    await run();
  } finally {
    if (descriptor === undefined) {
      delete (globalThis.navigator as { serviceWorker?: unknown }).serviceWorker;
    } else {
      Object.defineProperty(globalThis.navigator, 'serviceWorker', descriptor);
    }
  }
}

/** Installs a fake lock manager for one test and restores the descriptor afterwards. */
async function withFakeLocks(run: (locks: FakeLockManager) => Promise<void>): Promise<void> {
  const locks = fakeLockManager();
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
  Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: locks });
  try {
    await run(locks);
  } finally {
    if (original === undefined) {
      delete (globalThis.navigator as { locks?: unknown }).locks;
    } else {
      Object.defineProperty(globalThis.navigator, 'locks', original);
    }
  }
}

describe('persisted mutation queue configuration', () => {
  it('constructs eager services so their handler exists before automatic replay', async () => {
    const storage = memoryStorage(snapshotWith([entry()]));

    @Injectable()
    class TodoApi {
      readonly save = createMutation.post<Todo, SaveArgs>(
        (args) => ({ url: '/todos', body: args.body }),
        { networkMode: 'online', persistence: { key: 'todo.create' } },
      );
    }

    // `TodoApi` is never injected by this test: the provider's `eager` list is what constructs it.
    const { http } = setup([TodoApi, queueProviders(storage, { eager: [TodoApi] })]);
    await settle();

    const request = http.expectOne('/todos');
    expect(request.request.body).toEqual({ title: 'stored' });
    expect(request.request.headers.get('Idempotency-Key')).toBe('idem-stored');
    request.flush({ id: 3, title: 'stored' });
    await settle();

    expect(entriesIn(storage)).toEqual([]);
  });

  it('keeps an entry pending and warns when no handler is registered', async () => {
    const storage = memoryStorage(snapshotWith([entry({ key: 'unknown.mutation' })]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      setup([queueProviders(storage, { noHandlerWarnAfterMs: 0 })]);
      const queue = TestBed.inject(PersistedMutationQueue);
      await settle();

      expect(queue.entries()[0].state).toBe('pending');
      expect(queue.pendingCount()).toBe(1);
      expect(queue.enabled()).toBe(true);
      expect(warn.mock.calls.flat().join(' ')).toContain('no registered handler');
    } finally {
      warn.mockRestore();
    }
  });

  it('migrates an older envelope instead of dropping it', async () => {
    const storage = memoryStorage(JSON.stringify({ version: 0, timestamp: 1, entries: [entry()] }));
    const migrate = vi.fn((snapshot: unknown): MutationQueueSnapshot => ({
      version: MUTATION_QUEUE_VERSION,
      timestamp: 1,
      entries: (snapshot as { entries: readonly PersistedMutationEntry[] }).entries,
    }));
    const { http, create } = setup([queueProviders(storage, { migrate })]);
    saveTodo(create, { key: 'todo.create' });
    await settle();

    expect(migrate).toHaveBeenCalledWith(expect.objectContaining({ version: 0 }), 0);
    const request = http.expectOne('/todos');
    expect(request.request.headers.get('Idempotency-Key')).toBe('idem-stored');
    request.flush({ id: 4, title: 'stored' });
    await settle();
    expect(entriesIn(storage)).toEqual([]);
  });

  it('quarantines an envelope whose migration returns null', async () => {
    const raw = JSON.stringify({ version: 0, timestamp: 1, entries: [entry()] });
    const storage = memoryStorage(raw);
    setup([queueProviders(storage, { migrate: () => null })]);

    const queue = TestBed.inject(PersistedMutationQueue);
    await settle();
    expect(queue.enabled()).toBe(false);
    expect(queue.export()).toBe(raw);
    expect(storage.map.get(QUEUE_KEY)).toBe(raw);
  });

  it('quarantines a snapshot from another buster without rewriting it', async () => {
    const raw = snapshotWith([entry()], 'old-build');
    const storage = memoryStorage(raw);
    setup([queueProviders(storage, { buster: 'new-build' })]);

    const queue = TestBed.inject(PersistedMutationQueue);
    await settle();
    expect(queue.enabled()).toBe(false);
    expect(queue.export()).toBe(raw);
    expect(storage.map.get(QUEUE_KEY)).toBe(raw);
  });

  it('migrates an entry from the version its args were stored with', async () => {
    const storage = memoryStorage(
      snapshotWith([entry({ version: 3, args: { body: { title: 'v3' } } })]),
    );
    const migrateEntry = vi.fn((stored: PersistedMutationEntry) => ({
      ...stored,
      args: { body: { title: 'migrated' } },
    }));
    const { http, create } = setup([queueProviders(storage, { migrateEntry })]);
    saveTodo(create, { key: 'todo.create' });
    await settle();

    expect(migrateEntry).toHaveBeenCalledWith(expect.objectContaining({ version: 3 }), 3);
    const request = http.expectOne('/todos');
    expect(request.request.body).toEqual({ title: 'migrated' });
    request.flush({ id: 5, title: 'migrated' });
    await settle();
    expect(entriesIn(storage)).toEqual([]);
  });

  it('quarantines an entry whose version has no migration', async () => {
    const storage = memoryStorage(snapshotWith([entry({ version: 3 })]));
    const { http, create } = setup([queueProviders(storage)]);
    saveTodo(create, { key: 'todo.create' });
    await settle();

    const queue = TestBed.inject(PersistedMutationQueue);
    expect(queue.entries()[0].state).toBe('quarantined');
    http.expectNone('/todos');
  });

  it('sends the idempotency key in the configured header', async () => {
    const storage = memoryStorage();
    const { http, create } = setup([queueProviders(storage)]);
    const save = saveTodo(create, {
      key: 'todo.create',
      idempotencyHeader: 'X-Idempotency-Key',
    });

    void save.run({ body: { title: 'custom header' } });
    await settle();

    const storedKey = entriesIn(storage)[0].idempotencyKey;
    const request = http.expectOne('/todos');
    expect(request.request.headers.get('X-Idempotency-Key')).toBe(storedKey);
    expect(request.request.headers.get('Idempotency-Key')).toBeNull();
    request.flush({ id: 6, title: 'custom header' });
    await settle();
  });

  it('keeps an idempotency key the builder already set', async () => {
    const storage = memoryStorage();
    const { http, create } = setup([queueProviders(storage)]);
    const save = create(() =>
      createMutation.post<Todo, SaveArgs>(
        (args) => ({
          url: '/todos',
          body: args.body,
          headers: { 'Idempotency-Key': 'server-issued' },
        }),
        { networkMode: 'online', persistence: { key: 'todo.create' } },
      ),
    );

    void save.run({ body: { title: 'server key' } });
    await settle();

    expect(entriesIn(storage)[0].idempotencyKey).toBe('server-issued');
    const request = http.expectOne('/todos');
    expect(request.request.headers.get('Idempotency-Key')).toBe('server-issued');
    request.flush({ id: 7, title: 'server key' });
    await settle();
  });

  it('sends no header and does not retry a 5xx when the header is disabled', async () => {
    const storage = memoryStorage();
    const { http, create } = setup([queueProviders(storage)]);
    const save = saveTodo(create, { key: 'todo.create', idempotencyHeader: false });

    const promise = save.run({ body: { title: 'no header' } });
    promise.catch(() => undefined);
    await settle();

    const request = http.expectOne('/todos');
    expect(request.request.headers.get('Idempotency-Key')).toBeNull();
    request.flush({ message: 'down' }, { status: 503, statusText: 'Unavailable' });
    await settle();

    await expect(promise).rejects.toBeInstanceOf(HttpErrorResponse);
    // Without a header a retry could duplicate an applied write, so it parks as failed instead.
    expect(entriesIn(storage)[0].state).toBe('failed');
    expect(entriesIn(storage)[0].attempts).toBe(1);
  });

  it('removes the durable entry when the call is cancelled', async () => {
    const storage = memoryStorage();
    const { http, create } = setup([queueProviders(storage)]);
    const online = TestBed.inject(OnlineManager);
    online.setOnline(false);
    const save = saveTodo(create, { key: 'todo.create' });

    const promise = save.run({ body: { title: 'cancel me' } });
    await settle();
    expect(entriesIn(storage)).toHaveLength(1);

    save.cancel();
    await expect(promise).rejects.toBeInstanceOf(RequestCancelledError);
    await settle();
    expect(entriesIn(storage)).toEqual([]);
    http.expectNone('/todos');
  });

  it('persists nothing when onMutate rejects', async () => {
    const storage = memoryStorage();
    const { http, create } = setup([queueProviders(storage)]);
    const save = create(() =>
      createMutation.post<Todo, SaveArgs>((args) => ({ url: '/todos', body: args.body }), {
        networkMode: 'online',
        onMutate: () => {
          throw new Error('onMutate refused');
        },
        persistence: { key: 'todo.create' },
      }),
    );

    await expect(save.run({ body: { title: 'never sent' } })).rejects.toThrow('onMutate refused');
    await settle();
    expect(storage.map.get(QUEUE_KEY)).toBeUndefined();
    http.expectNone('/todos');
  });

  it('persists nothing when the codec cannot serialize the args', async () => {
    const storage = memoryStorage();
    const { http, create } = setup([queueProviders(storage)]);
    const codec: MutationArgsCodec<SaveArgs> = {
      serialize: () => {
        throw new Error('codec refused');
      },
      deserialize: (value) => value as SaveArgs,
    };
    const save = saveTodo(create, { key: 'todo.create', codec });

    await expect(save.run({ body: { title: 'not serializable' } })).rejects.toThrow(
      'codec refused',
    );
    await settle();
    expect(storage.map.get(QUEUE_KEY)).toBeUndefined();
    http.expectNone('/todos');
  });

  it('replays with context undefined, meta.replayed and no second onMutate', async () => {
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
    firstScope.destroy();
    await expect(pending).rejects.toBeTruthy();

    online.setOnline(true);
    const onMutate = vi.fn();
    const settled: Array<{ context: unknown; meta: unknown }> = [];
    const secondScope = createEnvironmentInjector([queueProviders(storage)], parent);
    runInInjectionContext(secondScope, () =>
      createMutation.post<Todo, SaveArgs>((args) => ({ url: '/todos', body: args.body }), {
        networkMode: 'online',
        persistence: { key: 'todo.create' },
        onMutate: () => {
          onMutate();
          return undefined;
        },
        onSuccess: (_todo, _args, context, meta) => {
          settled.push({ context, meta });
        },
        onSettled: (_args, context, meta) => {
          settled.push({ context, meta });
        },
      }),
    );
    await settle();

    TestBed.inject(HttpTestingController)
      .expectOne('/todos')
      .flush({ id: 8, title: 'across reload' });
    await settle();

    expect(onMutate).not.toHaveBeenCalled();
    expect(settled).toEqual([
      { context: undefined, meta: { replayed: true } },
      { context: undefined, meta: { replayed: true } },
    ]);
    expect(entriesIn(storage)).toEqual([]);
    secondScope.destroy();
  });

  it('stops later entries after a permanent failure by default', async () => {
    const storage = memoryStorage();
    const { http, create } = setup([queueProviders(storage)]);
    const online = TestBed.inject(OnlineManager);
    online.setOnline(false);

    const first = create(() =>
      createMutation.post<Todo, SaveArgs>((args) => ({ url: '/first', body: args.body }), {
        networkMode: 'online',
        persistence: { key: 'first' },
      }),
    );
    const second = create(() =>
      createMutation.post<Todo, SaveArgs>((args) => ({ url: '/second', body: args.body }), {
        networkMode: 'online',
        persistence: { key: 'second' },
      }),
    );

    const firstCall = first.run({ body: { title: 'a' } });
    firstCall.catch(() => undefined);
    await settle();
    const secondCall = second.run({ body: { title: 'b' } });
    secondCall.catch(() => undefined);
    await settle();
    expect(entriesIn(storage)).toHaveLength(2);

    online.setOnline(true);
    await settle();
    http.expectOne('/first').flush({ message: 'bad' }, { status: 400, statusText: 'Bad Request' });
    await settle();

    await expect(firstCall).rejects.toBeInstanceOf(HttpErrorResponse);
    // A dependent write must not overtake the failed one it may depend on.
    http.expectNone('/second');
    const queue = TestBed.inject(PersistedMutationQueue);
    expect(queue.entries().map((candidate) => candidate.state)).toEqual(['failed', 'pending']);
    expect(queue.failedCount()).toBe(1);
  });

  it('rejects before sending when onStorageError is fail', async () => {
    const storage = memoryStorage();
    storage.refuse = true;
    const { http, create } = setup([queueProviders(storage, { onStorageError: 'fail' })]);
    const save = saveTodo(create, { key: 'todo.create' });

    await expect(save.run({ body: { title: 'no durability' } })).rejects.toBeInstanceOf(
      MutationQueueDisabledError,
    );
    http.expectNone('/todos');
  });

  it('keeps the backoff deadline instead of retrying immediately', async () => {
    const storage = memoryStorage();
    setup([queueProviders(storage)]);
    const queue = TestBed.inject(PersistedMutationQueue);
    await settle();

    const result = await queue.enqueue({
      key: 'todo.create',
      version: 1,
      args: { body: { title: 'retry later' } },
      idempotencyKey: 'idem-backoff',
    });
    if (result === null) throw new Error('the queue refused the entry');

    const decision = queue.failed(
      result.entry.id,
      new HttpErrorResponse({ status: 503, statusText: 'Unavailable' }),
      { replay: false, idempotencyHeader: true },
    );
    expect(decision).toBe('retry');

    const stored = queue.entries()[0];
    expect(stored.attempts).toBe(1);
    expect(stored.nextAttemptAt).toBeGreaterThan(Date.now());
    TestBed.inject(HttpTestingController).expectNone('/todos');
  });

  it('does not touch storage or replay on the server', async () => {
    const storage = memoryStorage(snapshotWith([entry()]));
    const { http, create } = setup([
      { provide: PLATFORM_ID, useValue: 'server' },
      queueProviders(storage),
    ]);
    const queue = TestBed.inject(PersistedMutationQueue);
    await settle();

    expect(queue.enabled()).toBe(false);
    expect(queue.owner()).toBe(false);
    expect(queue.entries()).toEqual([]);
    expect(storage.map.get(QUEUE_KEY)).toBe(snapshotWith([entry()]));

    // A persisted mutation on the server is simply a normal call: no durability, no warning.
    const save = saveTodo(create, { key: 'todo.create' });
    void save.run({ body: { title: 'server' } });
    await settle();
    http.expectOne('/todos').flush({ id: 9, title: 'server' });
    await settle();
  });

  it('quarantines a bad entry instead of the whole queue', async () => {
    const storage = memoryStorage(
      snapshotWith([
        entry({ id: 'first', seq: 1 }),
        // A duplicate seq and an unknown state are entry-level damage, not a corrupt snapshot.
        entry({ id: 'second', seq: 1, state: 'nonsense' as PersistedMutationEntry['state'] }),
      ]),
    );
    setup([queueProviders(storage)]);
    const queue = TestBed.inject(PersistedMutationQueue);
    await settle();

    expect(queue.enabled()).toBe(true);
    expect(queue.entries().map((candidate) => candidate.state)).toEqual(['pending', 'quarantined']);
    expect(queue.entries()[1].lastError?.kind).toBe('corrupt');
  });

  it('quarantines the whole snapshot when an entry cannot even be named', async () => {
    const raw = JSON.stringify({
      version: MUTATION_QUEUE_VERSION,
      timestamp: 1,
      entries: [{ key: 'todo.create', seq: 1, state: 'pending' }],
    });
    const storage = memoryStorage(raw);
    setup([queueProviders(storage)]);
    const queue = TestBed.inject(PersistedMutationQueue);
    await settle();

    expect(queue.enabled()).toBe(false);
    expect(queue.export()).toBe(raw);
    expect(storage.map.get(QUEUE_KEY)).toBe(raw);
  });

  it('takes the Web Lock and reports a second tab as a non-owner', async () => {
    const storage = memoryStorage();
    await withFakeLocks(async (locks) => {
      setup([providePersistedMutationQueue({ storage })]);
      const first = TestBed.inject(PersistedMutationQueue);
      await settle();
      expect(first.owner()).toBe(true);
      expect(first.enabled()).toBe(true);
      expect(locks.held.size).toBe(1);

      const parent = TestBed.inject(EnvironmentInjector);
      const secondScope = createEnvironmentInjector(
        [providePersistedMutationQueue({ storage })],
        parent,
      );
      const second = secondScope.get(PersistedMutationQueue);
      await settle();
      expect(second.owner()).toBe(false);
      expect(second.enabled()).toBe(false);
      secondScope.destroy();
    });
  });

  it('hands the queue to a waiting tab when the owner goes away', async () => {
    const storage = memoryStorage();
    await withFakeLocks(async (locks) => {
      setup();
      const parent = TestBed.inject(EnvironmentInjector);
      const online = TestBed.inject(OnlineManager);

      // Tab A owns the queue and accepts a write while offline.
      const tabA = createEnvironmentInjector([providePersistedMutationQueue({ storage })], parent);
      const queueA = tabA.get(PersistedMutationQueue);
      await settle();
      expect(queueA.owner()).toBe(true);

      online.setOnline(false);
      const saveA = runInInjectionContext(tabA, () =>
        createMutation.post<Todo, SaveArgs>((args) => ({ url: '/todos', body: args.body }), {
          networkMode: 'online',
          persistence: { key: 'todo.create' },
        }),
      );
      const pending = saveA.run({ body: { title: 'handover' } });
      pending.catch(() => undefined);
      await settle();
      expect(entriesIn(storage)).toHaveLength(1);

      // Tab B is a non-owner, and is queued behind A's lock rather than merely refused.
      const tabB = createEnvironmentInjector([providePersistedMutationQueue({ storage })], parent);
      const queueB = tabB.get(PersistedMutationQueue);
      runInInjectionContext(tabB, () =>
        createMutation.post<Todo, SaveArgs>((args) => ({ url: '/todos', body: args.body }), {
          networkMode: 'online',
          persistence: { key: 'todo.create' },
        }),
      );
      await settle();
      expect(queueB.owner()).toBe(false);
      expect(queueB.enabled()).toBe(false);
      expect(queueB.pendingCount()).toBe(0);

      // A closes. The browser grants the queued request, so delivery moves instead of dying.
      tabA.destroy();
      await settle();
      expect(queueB.owner()).toBe(true);
      expect(queueB.enabled()).toBe(true);
      expect(queueB.pendingCount()).toBe(1);

      online.setOnline(true);
      await settle();
      TestBed.inject(HttpTestingController)
        .expectOne('/todos')
        .flush({ id: 11, title: 'handover' });
      await settle();

      expect(queueB.pendingCount()).toBe(0);
      expect(entriesIn(storage)).toEqual([]);
      tabB.destroy();
      await settle();
      expect(locks.held.size).toBe(0);
    });
  });
});

describe('persisted mutation queue background sync', () => {
  it('registers the sync tag after initialization and again after an enqueue', async () => {
    const storage = memoryStorage();
    const register = vi.fn(async (_tag: string) => undefined);

    await withServiceWorker({ sync: { register } }, async () => {
      const { http, create } = setup([queueProviders(storage, { backgroundSync: true })]);
      await settle();

      // Initialization is enough: a snapshot left by a previous page must wake the worker even
      // before this page enqueues anything.
      expect(register).toHaveBeenCalledTimes(1);
      expect(register).toHaveBeenLastCalledWith('ng-signal-request:mutation-queue');

      const save = saveTodo(create, { key: 'todo.create' });
      const pending = save.run({ body: { title: 'wake the worker' } });
      pending.catch(() => undefined);
      await settle();

      expect(register).toHaveBeenCalledTimes(2);
      expect(register).toHaveBeenLastCalledWith('ng-signal-request:mutation-queue');
      http.match('/todos').forEach((request) => request.flush({ id: 1, title: 'wake the worker' }));
      await settle();
    });
  });

  it('registers a custom tag when one is configured', async () => {
    const storage = memoryStorage();
    const register = vi.fn(async (_tag: string) => undefined);

    await withServiceWorker({ sync: { register } }, async () => {
      setup([queueProviders(storage, { backgroundSync: { tag: 'todos-sync' } })]);
      await settle();

      expect(register).toHaveBeenCalledWith('todos-sync');
    });
  });

  it('warns once and keeps the queue enabled when the browser has no service worker', async () => {
    const storage = memoryStorage();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await withServiceWorker(null, async () => {
        const { http, create } = setup([queueProviders(storage, { backgroundSync: true })]);
        await settle();

        const queue = TestBed.inject(PersistedMutationQueue);
        expect(queue.enabled()).toBe(true);
        expect(warn.mock.calls.flat().join(' ')).toContain('Background Sync is unavailable');

        const save = saveTodo(create, { key: 'todo.create' });
        const pending = save.run({ body: { title: 'still durable' } });
        pending.catch(() => undefined);
        await settle();

        // A second registration attempt on enqueue must not repeat the warning.
        const warnings = warn.mock.calls.filter((call) =>
          String(call[0]).includes('Background Sync is unavailable'),
        );
        expect(warnings).toHaveLength(1);
        expect(entriesIn(storage)).toHaveLength(1);

        http.match('/todos').forEach((request) => request.flush({ id: 2, title: 'still durable' }));
        await settle();
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('reports a rejected registration to ErrorHandler without disabling the queue', async () => {
    const storage = memoryStorage();
    const register = vi.fn(async () => {
      throw new Error('permission denied');
    });
    const errors: unknown[] = [];

    await withServiceWorker({ sync: { register } }, async () => {
      setup([
        queueProviders(storage, { backgroundSync: true }),
        {
          provide: ErrorHandler,
          useValue: { handleError: (error: unknown) => errors.push(error) },
        },
      ]);
      await settle();

      expect(register).toHaveBeenCalledOnce();
      expect(errors.map((error) => (error as Error).message)).toContain('permission denied');
      expect(TestBed.inject(PersistedMutationQueue).enabled()).toBe(true);
    });
  });
});
