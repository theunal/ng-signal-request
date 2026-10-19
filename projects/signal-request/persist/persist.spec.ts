import {
  createEnvironmentInjector,
  EnvironmentInjector,
  inject,
  PLATFORM_ID,
  TransferState,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  createRequest,
  provideSignalRequest,
  RESTORE_GATE,
  QueryClient,
  type CachedRequest,
} from 'ng-signal-request';
import {
  CACHE_PERSISTER,
  CACHE_TRANSFER_KEY,
  createPersister,
  dateRevivingCodec,
  dehydrate,
  hydrate,
  indexedDbStorage,
  prefetch,
  provideCacheTransfer,
  providePersistedCache,
  SNAPSHOT_VERSION,
  type CacheSnapshot,
  type CacheStorage,
} from './persist';
import { cache, settle, setup } from '../testing/testing';

interface Row {
  id: number;
  createdAt?: Date;
}

interface TestStorage extends CacheStorage {
  readonly map: Map<string, string>;
  /** Flip to make every write throw, the way a full quota or Safari's private mode does. */
  refuse: boolean;
  writes: number;
}

function memoryStorage(initial: Record<string, string> = {}): TestStorage {
  const map = new Map(Object.entries(initial));
  return {
    map,
    refuse: false,
    writes: 0,
    getItem: (key) => map.get(key) ?? null,
    setItem(key, value) {
      if (this.refuse) throw new Error('QuotaExceededError');
      this.writes++;
      map.set(key, value);
    },
    removeItem: (key) => void map.delete(key),
  };
}

/** The last snapshot actually written, parsed. Asserts the write happened. */
function lastSnapshot(storage: TestStorage, key = 'ng-signal-request'): CacheSnapshot {
  const raw = storage.map.get(key);
  if (raw === undefined) throw new Error(`nothing was written to "${key}"`);
  return JSON.parse(raw) as CacheSnapshot;
}

/** Builds a keyed handle. `staleTime: Infinity` makes only restored data good enough. */
function keyed<T>(
  create: <U>(fn: () => U) => U,
  key: readonly unknown[],
  staleTime = 0,
  url = '/rows',
): CachedRequest<T> {
  return create(() =>
    createRequest<T>(() => ({ url }), { key: () => key, staleTime, debugName: 'rows' }),
  );
}

const rows = (ids: number[]): Row[] => ids.map((id) => ({ id }));

/** A snapshot around one `rows` entry, so every test does not repeat the envelope. */
function snapshotOf(entries: CacheSnapshot['entries']): CacheSnapshot {
  return { version: SNAPSHOT_VERSION, timestamp: 0, entries };
}

describe('dehydrate()', () => {
  it('takes the entries that have data, with the time they were fetched', async () => {
    const { http, create } = setup();
    const first = keyed<Row[]>(create, ['a'], 0, '/a');
    const second = keyed<Row[]>(create, ['b'], 0, '/b');
    await settle();

    http.expectOne('/a').flush(rows([1]));
    http.expectOne('/b').flush(rows([2]));
    await settle();

    const snapshot = dehydrate(cache(), { now: 4242 });

    expect(snapshot.version).toBe(SNAPSHOT_VERSION);
    expect(snapshot.timestamp).toBe(4242);
    expect(snapshot.entries.map((entry) => entry.key)).toEqual([['a'], ['b']]);
    expect(snapshot.entries[0].data).toEqual(rows([1]));
    expect(snapshot.entries[0].dataUpdatedAt).toBeGreaterThan(0);

    first.destroy();
    second.destroy();
  });

  it('skips an entry that exists but has no data yet', async () => {
    const { create } = setup();
    const handle = create(() =>
      createRequest<Row[]>(() => ({ url: '/rows' }), { key: () => ['a'], refetchOnMount: false }),
    );
    await settle();

    expect(cache().all()).toHaveLength(1);
    expect(dehydrate(cache()).entries).toEqual([]);

    handle.destroy();
  });

  it('honours include and exclude, with exclude winning', async () => {
    const { http, create } = setup();
    for (const key of ['users', 'users-draft', 'posts']) keyed<Row[]>(create, [key]);
    await settle();
    http.match('/rows').forEach((request) => request.flush(rows([1])));
    await settle();

    expect(dehydrate(cache(), { include: ['users'] }).entries.map((e) => e.key)).toEqual([
      ['users'],
    ]);

    // `exclude` is a second pass, so it beats `include` rather than merging with it. A caller who
    // names one key in both meant "not this one", never "and this one after all".
    expect(dehydrate(cache(), { include: ['users'], exclude: ['users'] }).entries).toEqual([]);
  });
});

describe('hydrate()', () => {
  it('stages entries without creating them', () => {
    const { create } = setup();
    create(() => inject(QueryClient));

    const restored = hydrate(
      cache(),
      snapshotOf([
        { key: ['a'], data: rows([1]), dataUpdatedAt: 100 },
        { key: ['b'], data: rows([2]), dataUpdatedAt: 100 },
      ]),
    );

    expect(restored).toBe(2);
    // The whole reason for seeding: two staged values, zero entries. An entry nobody subscribes to
    // never gets a `gcTime` timer — the cache arms one when the last observer *leaves* — so creating
    // them here would pin them for the life of the injector.
    expect(cache().all()).toHaveLength(0);
    expect(cache().pendingSeeds).toBe(2);
  });

  it('applies a staged value when a handle asks for the key, keeping the original fetch time', async () => {
    const { create } = setup();
    hydrate(cache(), snapshotOf([{ key: ['rows'], data: rows([7]), dataUpdatedAt: 1000 }]));

    const handle = keyed<Row[]>(create, ['rows'], Number.POSITIVE_INFINITY);
    await settle();

    expect(handle.response()).toEqual(rows([7]));
    expect(cache().peek(['rows'])?.dataUpdatedAt()).toBe(1000);
    // Not `local`. Restored data came from the network originally, and saying otherwise would make
    // the devtools panel and `status()` lie about it.
    expect(cache().peek(['rows'])?.local()).toBe(false);
    expect(cache().pendingSeeds).toBe(0);

    handle.destroy();
  });

  it('lets a restored value be stale, and therefore refetch on mount', async () => {
    const { http, create } = setup();
    hydrate(cache(), snapshotOf([{ key: ['rows'], data: rows([7]), dataUpdatedAt: 1000 }]));

    // `staleTime: 0` and a `dataUpdatedAt` far in the past: the entry is ready *and* stale, so
    // mounting refetches. This is what makes restoring an old timestamp worth doing rather than
    // calling `setData`, which would stamp `Date.now()` and make the data look fresh forever.
    const handle = keyed<Row[]>(create, ['rows']);
    await settle();

    http.expectOne('/rows').flush(rows([8]));
    await settle();

    expect(handle.response()).toEqual(rows([8]));
    handle.destroy();
  });

  it('ignores a snapshot from another version rather than guessing', () => {
    const { create } = setup();
    create(() => inject(QueryClient));

    // A snapshot is untrusted input — another build of the application may have written it, since a
    // storage key is global. Reading a stale shape as if it were current is silent data corruption,
    // so an unknown version is dropped.
    const restored = hydrate(cache(), {
      ...snapshotOf([{ key: ['rows'], data: rows([1]), dataUpdatedAt: 1000 }]),
      version: SNAPSHOT_VERSION + 1,
    });

    expect(restored).toBe(0);
    expect(cache().pendingSeeds).toBe(0);
  });

  it('ignores a missing snapshot', () => {
    const { create } = setup();
    create(() => inject(QueryClient));

    expect(hydrate(cache(), null)).toBe(0);
    expect(hydrate(cache(), undefined)).toBe(0);
  });

  it('drops entries past maxAge and keeps the rest', () => {
    const { create } = setup();
    create(() => inject(QueryClient));

    const restored = hydrate(
      cache(),
      snapshotOf([
        { key: ['fresh'], data: rows([1]), dataUpdatedAt: 9_000 },
        { key: ['stale'], data: rows([2]), dataUpdatedAt: 100 },
      ]),
      { maxAge: 5_000, now: 10_000 },
    );

    expect(restored).toBe(1);
    expect(cache().pendingSeeds).toBe(1);
  });

  it('replaces staged values by default, so an older snapshot cannot outlive a newer one', () => {
    const { create } = setup();
    create(() => inject(QueryClient));

    hydrate(cache(), snapshotOf([{ key: ['old'], data: rows([1]), dataUpdatedAt: 1 }]));
    hydrate(cache(), snapshotOf([{ key: ['new'], data: rows([2]), dataUpdatedAt: 2 }]));
    expect(cache().pendingSeeds).toBe(1);

    // `replace: false` is how a caller merges two snapshots instead.
    hydrate(cache(), snapshotOf([{ key: ['third'], data: rows([3]), dataUpdatedAt: 3 }]), {
      replace: false,
    });
    expect(cache().pendingSeeds).toBe(2);
  });

  it('runs values through the codec as the seed is consumed', async () => {
    const { create } = setup();
    hydrate(
      cache(),
      snapshotOf([
        {
          key: ['rows'],
          data: [{ id: 1, createdAt: '2024-01-01T00:00:00.000Z' }],
          dataUpdatedAt: 5,
        },
      ]),
      { codec: dateRevivingCodec },
    );

    const handle = keyed<Row[]>(create, ['rows'], Number.POSITIVE_INFINITY);
    await settle();

    expect(handle.response()![0].createdAt).toBeInstanceOf(Date);
    handle.destroy();
  });
});

describe('hydrate() and maxEntries', () => {
  it('never lets an oversized snapshot past the cap', () => {
    const { create } = setup([provideSignalRequest({ maxEntries: 4 })]);
    create(() => inject(QueryClient));

    const entries = Array.from({ length: 40 }, (_, i) => ({
      key: ['rows', i],
      data: rows([i]),
      dataUpdatedAt: i + 1,
    }));

    // The return value counts what the snapshot *contributed*; the cap is the cache's policy. A
    // snapshot is a hint, not a reservation, so 40 staged values against a cap of 4 keep 4.
    expect(hydrate(cache(), snapshotOf(entries))).toBe(40);
    expect(cache().pendingSeeds).toBe(4);
    expect(cache().size + cache().pendingSeeds).toBeLessThanOrEqual(4);
  });

  it('keeps the freshest values, and turns the rest back into ordinary misses', async () => {
    const { http, create } = setup([provideSignalRequest({ maxEntries: 2 })]);
    hydrate(
      cache(),
      snapshotOf([
        { key: ['rows', 0], data: rows([0]), dataUpdatedAt: 1 },
        { key: ['rows', 1], data: rows([1]), dataUpdatedAt: 2 },
        { key: ['rows', 2], data: rows([2]), dataUpdatedAt: 3 },
      ]),
    );

    // `['rows', 0]` was the oldest fetch, so it was the one dropped. Its handle therefore has no
    // value and no error — it fetches, which is the honest consequence of the cap.
    const handle = keyed<Row[]>(create, ['rows', 0], Number.POSITIVE_INFINITY, '/rows/0');
    await settle();
    expect(handle.response()).toBeUndefined();

    http.expectOne('/rows/0').flush(rows([9]));
    await settle();
    expect(handle.response()).toEqual(rows([9]));
    handle.destroy();
  });

  it('caps a transferred snapshot on the client too', () => {
    // The SSR path goes through the same `hydrate`, so the same bound applies. A server render of a
    // large page cannot hand the browser an unbounded payload.
    const transfer = new TransferState();
    transfer.set(
      CACHE_TRANSFER_KEY,
      snapshotOf(
        Array.from({ length: 20 }, (_, i) => ({
          key: ['t', i],
          data: rows([i]),
          dataUpdatedAt: i,
        })),
      ),
    );

    setup([
      { provide: TransferState, useValue: transfer },
      provideCacheTransfer(),
      provideSignalRequest({ maxEntries: 3 }),
    ]);

    expect(cache().pendingSeeds).toBe(3);
    expect(cache().size + cache().pendingSeeds).toBeLessThanOrEqual(3);
  });
});

describe('dateRevivingCodec', () => {
  it('revives a full ISO instant, at any depth', () => {
    const revived = dateRevivingCodec.deserialize({
      createdAt: '2024-01-01T12:00:00.000Z',
      offset: '2024-01-01T12:00:00+02:00',
      nested: { list: ['2024-06-01T00:00:00Z'] },
    }) as { createdAt: Date; offset: Date; nested: { list: Date[] } };

    expect(revived.createdAt.toISOString()).toBe('2024-01-01T12:00:00.000Z');
    expect(revived.offset).toBeInstanceOf(Date);
    expect(revived.nested.list[0]).toBeInstanceOf(Date);
  });

  it('leaves a bare date-like string alone', () => {
    // `"2024-01-01"` is far more likely to be a slug, an order number or a version than a date, and
    // guessing there corrupts data that never was a date.
    expect(dateRevivingCodec.deserialize('2024-01-01')).toBe('2024-01-01');
    expect(dateRevivingCodec.deserialize({ version: '2024-01-01' })).toEqual({
      version: '2024-01-01',
    });
  });

  it('passes a Date through instead of flattening it to {}', () => {
    // The bug the guard in `reviveDates` exists for: `Object.entries(new Date())` is `[]`, so a
    // snapshot handed over in memory — which `provideCacheTransfer` does — would lose every `Date`.
    const date = new Date('2024-01-01T00:00:00.000Z');
    expect(dateRevivingCodec.deserialize(date)).toBe(date);
    expect(dateRevivingCodec.deserialize({ when: date })).toEqual({ when: date });
  });

  it('leaves primitives and null alone', () => {
    expect(dateRevivingCodec.deserialize(1)).toBe(1);
    expect(dateRevivingCodec.deserialize(null)).toBeNull();
    expect(dateRevivingCodec.deserialize(true)).toBe(true);
    expect(dateRevivingCodec.deserialize(undefined)).toBeUndefined();
  });
});

describe('createPersister()', () => {
  it('follows responses, not the appearance of entries', async () => {
    const storage = memoryStorage();
    const { http, create } = setup();
    const persister = create(() => createPersister({ storage, debounce: 0 }));

    const handle = keyed<Row[]>(create, ['rows']);
    await settle();

    // The entry exists and is empty. This is the snapshot a `subscribeChanges`-only persister would
    // write, and then never correct, because creating an entry is the only event it hears.
    expect(lastSnapshot(storage).entries).toEqual([]);

    http.expectOne('/rows').flush(rows([1]));
    await settle();

    const written = lastSnapshot(storage);
    expect(written.entries).toHaveLength(1);
    expect(written.entries[0].data).toEqual(rows([1]));
    expect(written.entries[0].dataUpdatedAt).toBeGreaterThan(0);

    handle.destroy();
    persister.destroy();
  });

  it('restores on hydrate, so the first read after a reload has data', async () => {
    const storage = memoryStorage({
      'ng-signal-request': JSON.stringify(
        snapshotOf([{ key: ['rows'], data: rows([7]), dataUpdatedAt: 1000 }]),
      ),
    });
    const { create } = setup();
    const persister = create(() => createPersister({ storage }));

    expect(persister.hydrate()).toBe(1);

    const handle = keyed<Row[]>(create, ['rows'], Number.POSITIVE_INFINITY);
    await settle();
    expect(handle.response()).toEqual(rows([7]));

    handle.destroy();
    persister.destroy();
  });

  it('reports 0 for a first visit, which is not a failure', () => {
    const { create } = setup();
    const persister = create(() => createPersister({ storage: memoryStorage() }));

    expect(persister.enabled()).toBe(true);
    expect(persister.hydrate()).toBe(0);
    expect(persister.storageKey).toBe('ng-signal-request');

    persister.destroy();
  });

  it('is disabled, and silent, with no storage at all', async () => {
    const { http, create } = setup();
    const persister = create(() => createPersister({ storage: null }));

    expect(persister.enabled()).toBe(false);
    expect(persister.hydrate()).toBe(0);

    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush(rows([1]));
    await settle();

    expect(persister.enabled()).toBe(false);
    handle.destroy();
    persister.destroy();
  });

  it('disables itself when storage refuses a write, instead of throwing into a settle path', async () => {
    const storage = memoryStorage();
    storage.refuse = true;
    const { http, create } = setup();
    const persister = create(() => createPersister({ storage, debounce: 0 }));

    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush(rows([1]));
    await settle();

    // A `QuotaExceededError` escaping here would surface inside a fetch's settle listener, which is
    // a broken application, not a full disk.
    expect(persister.enabled()).toBe(false);

    handle.destroy();
    persister.destroy();
  });

  it('drops an unparseable value rather than failing every load forever', () => {
    const storage = memoryStorage({ 'ng-signal-request': 'not json{' });
    const { create } = setup();
    const persister = create(() => createPersister({ storage }));

    expect(persister.hydrate()).toBe(0);
    expect(storage.map.has('ng-signal-request')).toBe(false);

    persister.destroy();
  });

  it('survives storage that throws on read', async () => {
    const hostile: CacheStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    const { create } = setup();
    const persister = create(() => createPersister({ storage: hostile }));

    expect(persister.hydrate()).toBe(0);
    // One microtask later, because `enabled` is written off the call stack — see `disable`.
    await settle();
    expect(persister.enabled()).toBe(false);

    persister.destroy();
  });

  it('clear() removes the stored snapshot and leaves the cache alone', async () => {
    const storage = memoryStorage();
    const { http, create } = setup();
    const persister = create(() => createPersister({ storage, debounce: 0 }));

    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush(rows([1]));
    await settle();

    persister.clear();
    expect(storage.map.has('ng-signal-request')).toBe(false);
    expect(handle.response()).toEqual(rows([1]));

    handle.destroy();
    persister.destroy();
  });

  it('stops writing once destroyed', async () => {
    const storage = memoryStorage();
    const { http, create } = setup();
    const persister = create(() => createPersister({ storage, debounce: 0 }));

    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush(rows([1]));
    await settle();
    const before = storage.writes;

    persister.destroy();
    create(() => inject(QueryClient)).invalidate(['rows']);
    await settle();
    http.expectOne('/rows').flush(rows([2]));
    await settle();

    expect(storage.writes).toBe(before);
    handle.destroy();
  });

  it('coalesces a burst, and writes on demand', async () => {
    const storage = memoryStorage();
    const { http, create } = setup();
    const persister = create(() => createPersister({ storage, debounce: 10_000 }));

    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush(rows([1]));
    await settle();

    // The debounce window is still open, so nothing has been written. `persist()` is the escape
    // hatch, and it is also what the injector-destroy flush is built from.
    expect(storage.writes).toBe(0);
    persister.persist();
    expect(storage.writes).toBe(1);
    expect(lastSnapshot(storage).entries).toHaveLength(1);

    handle.destroy();
    persister.destroy();
  });

  it('honours include', async () => {
    const storage = memoryStorage();
    const { http, create } = setup();
    const persister = create(() => createPersister({ storage, debounce: 0, include: ['users'] }));

    const users = keyed<Row[]>(create, ['users']);
    const posts = keyed<Row[]>(create, ['posts']);
    await settle();
    http.match('/rows').forEach((request) => request.flush(rows([1])));
    await settle();

    expect(lastSnapshot(storage).entries.map((entry) => entry.key)).toEqual([['users']]);

    users.destroy();
    posts.destroy();
    persister.destroy();
  });
});

describe('providePersistedCache()', () => {
  it('has the stored snapshot staged before a handle can resolve', async () => {
    const storage = memoryStorage({
      'ng-signal-request': JSON.stringify(
        snapshotOf([{ key: ['rows'], data: rows([7]), dataUpdatedAt: 1000 }]),
      ),
    });
    const { create } = setup([providePersistedCache({ storage })]);
    create(() => inject(CACHE_PERSISTER));

    // No `hydrate()` call anywhere in this test: the provider did it during injector creation,
    // which happens before any component exists and therefore before any request can resolve.
    const handle = keyed<Row[]>(create, ['rows'], Number.POSITIVE_INFINITY);
    await settle();

    expect(handle.response()).toEqual(rows([7]));
    handle.destroy();
  });

  it('flushes an open debounce window when the injector goes away', async () => {
    const storage = memoryStorage();
    const { http, create } = setup();
    const parent = TestBed.inject(EnvironmentInjector);
    const child = createEnvironmentInjector(
      [providePersistedCache({ storage, debounce: 10_000 })],
      parent,
    );

    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush(rows([1]));
    await settle();
    expect(storage.writes).toBe(0);

    child.destroy();
    await settle();

    expect(storage.writes).toBe(1);
    expect(lastSnapshot(storage).entries).toHaveLength(1);

    handle.destroy();
  });
});

describe('provideCacheTransfer()', () => {
  it('reads the transferred state on the client, and a handle sees it', async () => {
    const transfer = new TransferState();
    transfer.set(
      CACHE_TRANSFER_KEY,
      snapshotOf([{ key: ['rows'], data: rows([1]), dataUpdatedAt: 1000 }]),
    );

    // The state has to be in place before the root injector exists, because that is when the
    // initializer reads it — which is exactly the timing the provider exists to guarantee.
    const { create } = setup([
      { provide: TransferState, useValue: transfer },
      provideCacheTransfer(),
    ]);

    const handle = keyed<Row[]>(create, ['rows'], Number.POSITIVE_INFINITY);
    await settle();

    expect(handle.response()).toEqual(rows([1]));
    // Read once: leaving it behind would keep a second copy of the data in the document for nothing.
    expect(transfer.get(CACHE_TRANSFER_KEY, null)).toBeNull();
    handle.destroy();
  });

  it('writes the snapshot when a server render is torn down', async () => {
    const { http, create } = setup();
    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush(rows([1]));
    await settle();

    // A child injector stands in for the server request: the initializer registers its teardown
    // there, `QueryCache` and `TransferState` resolve to the shared root instances.
    const child = createEnvironmentInjector(
      [{ provide: PLATFORM_ID, useValue: 'server' }, provideCacheTransfer()],
      TestBed.inject(EnvironmentInjector),
    );
    child.destroy();
    await settle();

    const snapshot = TestBed.inject(TransferState).get(CACHE_TRANSFER_KEY, null);
    expect(snapshot?.entries.map((entry) => entry.key)).toEqual([['rows']]);
    expect(snapshot?.entries[0].data).toEqual(rows([1]));
    handle.destroy();
  });

  it('does not write anything on the browser side', async () => {
    const { create } = setup([provideCacheTransfer()]);
    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    expect(TestBed.inject(TransferState).get(CACHE_TRANSFER_KEY, null)).toBeNull();
    handle.destroy();
  });
});

describe('prefetch()', () => {
  it('runs every handle, reports the failures, and never rejects', async () => {
    const { http, create } = setup();
    const good = keyed<Row[]>(create, ['a']);
    const bad = keyed<Row[]>(create, ['b']);

    const pending = prefetch([good, bad]);
    await settle();

    const requests = http.match('/rows');
    expect(requests).toHaveLength(2);
    requests[0].flush(rows([1]));
    requests[1].flush({ message: 'down' }, { status: 500, statusText: 'Error' });
    await settle();

    const report = await pending;
    // A `Promise.all` here would reject and turn a render into a 500, even though the other endpoint
    // answered and the page would have rendered fine with one empty panel.
    expect(report.ok).toBe(1);
    expect(report.failures).toHaveLength(1);

    good.destroy();
    bad.destroy();
  });

  it('resolves immediately for no handles', async () => {
    expect(await prefetch([])).toEqual({ ok: 0, failures: [] });
  });
});

/* -------------------------------------------------------------------------- */
/*  Asynchronous storage                                                      */
/* -------------------------------------------------------------------------- */

interface AsyncStorage extends CacheStorage {
  readonly map: Map<string, string>;
  /** Flip to make every write reject, the way a full quota or a blocked database does. */
  refuse: boolean;
  /** Flip to make reads reject, the way a closed connection or a private-mode database does. */
  refuseReads: boolean;
  /** How many `setItem` calls have completed. */
  writes: number;
  /** The most writes that were ever in flight together. */
  peak: number;
  /** Stops every `getItem` from answering until `releaseReads()`. */
  holdReads(): void;
  releaseReads(): void;
}

/**
 * A storage whose three methods return promises, with the read under the test's control.
 *
 * `holdReads` is the seam the hold tests need: an IndexedDB read is indistinguishable from a
 * `localStorage` one except that it has not answered yet, and a test cannot observe *that* — the
 * interesting state — without being able to stop it answering.
 */
function asyncStorage(initial: Record<string, string> = {}): AsyncStorage {
  const map = new Map(Object.entries(initial));
  const waiting: Array<() => void> = [];
  let held = false;
  let inFlight = 0;

  return {
    map,
    refuse: false,
    refuseReads: false,
    writes: 0,
    peak: 0,
    holdReads: () => {
      held = true;
    },
    releaseReads: () => {
      held = false;
      for (const deliver of waiting.splice(0)) deliver();
    },
    async getItem(key: string): Promise<string | null> {
      // A promise that is genuinely outstanding, not one that resolved before anyone looked.
      await new Promise<void>((resolve) => (held ? waiting.push(resolve) : resolve()));
      if (this.refuseReads) throw new Error('the database could not be read');
      return map.get(key) ?? null;
    },
    async setItem(key: string, value: string): Promise<void> {
      if (this.refuse) throw new Error('QuotaExceededError');
      // Counted across a real suspension point, so an un-serialized pair of writes would show
      // `peak: 2` here rather than the `1` a chain produces.
      inFlight++;
      this.peak = Math.max(this.peak, inFlight);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      this.writes++;
      map.set(key, value);
      inFlight--;
    },
    async removeItem(key: string): Promise<void> {
      map.delete(key);
    },
  };
}

const stored = (snapshot: CacheSnapshot): Record<string, string> => ({
  'ng-signal-request': JSON.stringify(snapshot),
});

describe('an asynchronous storage', () => {
  it('holds the first fetch until the read lands, and then needs no fetch at all', async () => {
    const storage = asyncStorage(
      stored(snapshotOf([{ key: ['rows'], data: rows([7]), dataUpdatedAt: Date.now() }])),
    );
    storage.holdReads();
    const { http, create } = setup([providePersistedCache({ storage })]);
    create(() => inject(CACHE_PERSISTER));

    const handle = keyed<Row[]>(create, ['rows'], Number.POSITIVE_INFINITY);
    await settle();

    // The snapshot is still in flight and the network has not been asked: this is the race the
    // gate exists for, and the assertion is that it is *not* happening.
    http.expectNone(() => true);
    expect(handle.response()).toBeUndefined();

    storage.releaseReads();
    await settle();

    // The seed landed and made the entry fresh, so the released fetch decision resolves to "no
    // fetch". One round trip saved, and the value on screen came from storage.
    expect(handle.response()).toEqual(rows([7]));
    expect(handle.fetchCount()).toBe(0);
    http.expectNone(() => true);

    handle.destroy();
  });

  it('reports the persister as the restore gate, so the core reads the real thing', () => {
    const storage = asyncStorage();
    const { create } = setup([providePersistedCache({ storage })]);

    expect(create(() => inject(RESTORE_GATE))).toBe(create(() => inject(CACHE_PERSISTER)));
  });

  it('returns a promise from hydrate(), and is "restoring" before it settles', async () => {
    const storage = asyncStorage(
      stored(snapshotOf([{ key: ['rows'], data: rows([7]), dataUpdatedAt: 5 }])),
    );
    storage.holdReads();
    const { create } = setup();
    const persister = create(() => createPersister({ storage }));

    const restoring = persister.hydrate();
    // Synchronously, before anything has been awaited: the property the core depends on, because a
    // handle created on the next line has to see it.
    expect(persister.isRestoring()).toBe(true);
    expect(restoring).toBeInstanceOf(Promise);
    let settled = false;
    void persister.restored().then(() => (settled = true));

    storage.releaseReads();
    await settle();

    expect(await restoring).toBe(1);
    expect(persister.isRestoring()).toBe(false);
    await persister.restored();
    expect(settled).toBe(true);
    expect(cache().pendingSeeds).toBe(1);

    persister.destroy();
  });

  it('opens the gate when the bound elapses, and a late snapshot never clobbers the answer', async () => {
    vi.useFakeTimers();
    try {
      const storage = asyncStorage(
        stored(snapshotOf([{ key: ['rows'], data: rows([7]), dataUpdatedAt: 5 }])),
      );
      storage.holdReads();
      const { http, create } = setup([providePersistedCache({ storage })]);
      create(() => inject(CACHE_PERSISTER));

      const handle = keyed<Row[]>(create, ['rows']);
      await settle();
      http.expectNone('/rows');

      // The whole point of the bound: a storage that never answers must not hold the first render.
      vi.advanceTimersByTime(2000);
      await settle();

      http.expectOne('/rows').flush(rows([9]));
      await settle();
      expect(handle.response()).toEqual(rows([9]));
      expect(handle.fetchCount()).toBe(1);

      // The read finally answers, carrying data older than the answer already on screen. Restoring
      // it would be the cache going back in time.
      storage.releaseReads();
      await settle();
      expect(handle.response()).toEqual(rows([9]));
      expect(cache().peek(['rows'])?.dataUpdatedAt()).not.toBe(5);

      handle.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes writes, so two of them are never in flight together', async () => {
    const storage = asyncStorage();
    const { http, create } = setup();
    const persister = create(() => createPersister({ storage, debounce: 0 }));

    const first = keyed<Row[]>(create, ['a'], 0, '/a');
    const second = keyed<Row[]>(create, ['b'], 0, '/b');
    await settle();
    // Two responses in the same tick: without a chain both writes start before either finishes, and
    // a storage that resolves out of order would then be free to land the older one last.
    http.match('/a').forEach((request) => request.flush(rows([1])));
    http.match('/b').forEach((request) => request.flush(rows([2])));
    await settle();

    // Every activity event is its own write with the debounce off; what matters is the overlap.
    expect(storage.writes).toBeGreaterThanOrEqual(2);
    expect(storage.peak).toBe(1);
    expect(lastSnapshot(storage).entries).toHaveLength(2);

    first.destroy();
    second.destroy();
    persister.destroy();
  });

  it('disables itself when an asynchronous write rejects', async () => {
    const storage = asyncStorage();
    storage.refuse = true;
    const { http, create } = setup();
    const persister = create(() => createPersister({ storage, debounce: 0 }));

    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush(rows([1]));
    await settle();

    expect(persister.enabled()).toBe(false);

    handle.destroy();
    persister.destroy();
  });

  it('disables itself when an asynchronous read rejects, and still fetches', async () => {
    const storage = asyncStorage();
    storage.refuseReads = true;
    const { http, create } = setup();
    const persister = create(() => createPersister({ storage }));

    expect(await persister.hydrate()).toBe(0);
    // The gate has to open on a failed read, or every request would wait out the full bound.
    expect(persister.isRestoring()).toBe(false);

    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush(rows([1]));
    await settle();
    expect(handle.response()).toEqual(rows([1]));

    handle.destroy();
    persister.destroy();
  });

  it('clear() survives an asynchronous removeItem, and persist() flushes through the chain', async () => {
    const storage = asyncStorage();
    const { http, create } = setup();
    const persister = create(() => createPersister({ storage, debounce: 10_000 }));

    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush(rows([1]));
    await settle();

    persister.persist();
    await settle();
    expect(storage.writes).toBe(1);

    persister.clear();
    await settle();
    expect(storage.map.has('ng-signal-request')).toBe(false);

    handle.destroy();
    persister.destroy();
  });

  it('opens the gate on a first visit, with nothing stored to read', async () => {
    const storage = asyncStorage();
    const { http, create } = setup([providePersistedCache({ storage })]);
    create(() => inject(CACHE_PERSISTER));

    const handle = keyed<Row[]>(create, ['rows']);
    await settle();

    // The read answered `null`, which is a first visit rather than a failure: the gate must be
    // open, or every request would wait out the bound for a snapshot that does not exist.
    expect(create(() => inject(CACHE_PERSISTER)).isRestoring()).toBe(false);
    http.expectOne('/rows').flush(rows([1]));
    await settle();
    expect(handle.response()).toEqual(rows([1]));

    handle.destroy();
  });

  it('drops an unparseable value through an asynchronous removeItem', async () => {
    const storage = asyncStorage({ 'ng-signal-request': 'not json{' });
    const { create } = setup();
    const persister = create(() => createPersister({ storage }));

    expect(await persister.hydrate()).toBe(0);
    expect(storage.map.has('ng-signal-request')).toBe(false);

    persister.destroy();
  });

  it('still holds a later restore after one timed out', async () => {
    vi.useFakeTimers();
    try {
      const storage = asyncStorage();
      storage.holdReads();
      const { create } = setup();
      const persister = create(() => createPersister({ storage, restoreTimeout: 2000 }));

      void persister.hydrate();
      vi.advanceTimersByTime(2000);
      await settle();
      expect(persister.isRestoring()).toBe(false);

      // The read of the first restore is still outstanding: the timer released its hold, and that
      // release is counted once. A count that drifted negative here would leave every *later*
      // restore unheld — the mechanism failing silently, which is the one outcome worth a test.
      storage.releaseReads();
      await settle();
      expect(persister.isRestoring()).toBe(false);

      storage.holdReads();
      const second = persister.hydrate();
      expect(persister.isRestoring()).toBe(true);

      storage.releaseReads();
      await second;
      expect(persister.isRestoring()).toBe(false);

      persister.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('arms no timer on the server, because a pending one holds stability', async () => {
    vi.useFakeTimers();
    try {
      const storage = asyncStorage(
        stored(snapshotOf([{ key: ['rows'], data: rows([7]), dataUpdatedAt: 5 }])),
      );
      const { create } = setup([
        { provide: PLATFORM_ID, useValue: 'server' },
        providePersistedCache({ storage }),
      ]);
      const persister = create(() => inject(CACHE_PERSISTER));

      // Nothing is waiting on the read — no timer is even armed — and the seeds land when it
      // answers. A `setTimeout` here would be the one thing on the server that holds the event loop
      // for its whole duration.
      expect(vi.getTimerCount()).toBe(0);
      await settle();
      expect(persister.isRestoring()).toBe(false);
      expect(cache().pendingSeeds).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never holds a fetch when the bound is switched off entirely', async () => {
    const storage = asyncStorage(
      stored(snapshotOf([{ key: ['rows'], data: rows([7]), dataUpdatedAt: Date.now() }])),
    );
    storage.holdReads();
    const { http, create } = setup([providePersistedCache({ storage, restoreTimeout: 0 })]);

    const handle = keyed<Row[]>(create, ['rows'], Number.POSITIVE_INFINITY);
    await settle();

    // `restoreTimeout: 0` is the global form of "do not hold anything": the read still happens and
    // its value still lands, but nothing waits for it.
    http.expectOne('/rows').flush(rows([9]));
    await settle();
    expect(handle.response()).toEqual(rows([9]));

    storage.releaseReads();
    await settle();
    // The seed arrives late and loses to the newer answer, which is rule (a) doing its job.
    expect(handle.response()).toEqual(rows([9]));

    handle.destroy();
  });
});

/* -------------------------------------------------------------------------- */
/*  indexedDbStorage                                                          */
/* -------------------------------------------------------------------------- */

type FakeHandler = (() => void) | null;

interface FakeRequest {
  result: unknown;
  error: Error | null;
  onsuccess: FakeHandler;
  onerror: FakeHandler;
  onupgradeneeded: FakeHandler;
  onblocked: FakeHandler;
}

interface FakeTransaction {
  mode: IDBTransactionMode;
  error: Error | null;
  onabort: FakeHandler;
  objectStore(): IDBObjectStore;
}

interface FakeIdb {
  readonly factory: IDBFactory;
  /** The one object store, keyed the way `indexedDbStorage` reads and writes it. */
  readonly rows: Map<string, unknown>;
  /** How many times `open` was called, so connection reuse is provable. */
  opens: number;
  /** Makes `open` report itself blocked by another tab, as a stale open connection does. */
  blocked: boolean;
  /** Makes `open` fail outright. */
  fails: boolean;
  /** Makes every write abort its transaction, the shape a quota refusal really takes. */
  abortWrites: boolean;
  /** Makes every write fail at the request, without aborting. */
  refuseWrites: boolean;
  /** Hands back no `error` object at all, which a browser is allowed to do. */
  errorless: boolean;
  /** Stops delivering results until `resume()`. */
  pause(): void;
  resume(): void;
}

/**
 * A hand-written, in-memory `IDBFactory`.
 *
 * Hand-written rather than a library double because there is no third-party dependency budget here,
 * and because the parts that matter are small and specific: requests are never answered inline (a
 * browser cannot), schema upgrades create the store, and a suspended request can be held open so a
 * test can observe the state that only exists *while* a read is outstanding.
 */
function fakeIdb(): FakeIdb {
  const rows = new Map<string, unknown>();
  const stores = new Set<string>();
  const held: Array<() => void> = [];
  let paused = false;

  const fake = {
    rows,
    opens: 0,
    blocked: false,
    fails: false,
    abortWrites: false,
    refuseWrites: false,
    errorless: false,
    /**
     * Built here, in the same object the test flips flags on. A spread copy would leave the factory
     * reading the original — a double that ignores its own controls looks exactly like a passing
     * test until the assertion that matters.
     */
    factory: {
      open: (_name: string, _version?: number): IDBOpenDBRequest => {
        fake.opens++;
        const pending = request();
        answer(() => {
          if (fake.fails) {
            reject(pending, fake.errorless ? null : new Error('the database could not be opened'));
            return;
          }
          if (fake.blocked) {
            pending.onblocked?.();
            return;
          }
          pending.result = database();
          // Upgrade first, as a browser does: this is where the store is created.
          pending.onupgradeneeded?.();
          pending.onsuccess?.();
        });
        return pending as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      for (const deliver of held.splice(0)) deliver();
    },
  };

  const answer = (deliver: () => void): void => {
    queueMicrotask(() => {
      if (paused) held.push(deliver);
      else deliver();
    });
  };

  const request = (): FakeRequest => ({
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
    onblocked: null,
  });

  const reject = (pending: FakeRequest, error: Error | null): void => {
    pending.error = error;
    pending.onerror?.();
  };

  const objectStore = (transaction?: FakeTransaction): IDBObjectStore =>
    ({
      get: (key: string) => {
        const pending = request();
        answer(() => {
          pending.result = rows.get(key);
          pending.onsuccess?.();
        });
        return pending as unknown as IDBRequest<unknown>;
      },
      put: (value: unknown, key: string) => {
        const pending = request();
        answer(() => {
          // A quota refusal in a real browser reaches the caller as a transaction abort; whether it
          // also fires the request's own `error` first is a browser detail, so both are simulated.
          if (fake.abortWrites && transaction !== undefined) {
            transaction.error = fake.errorless ? null : new Error('QuotaExceededError');
            transaction.onabort?.();
            return;
          }
          if (fake.refuseWrites) {
            reject(pending, fake.errorless ? null : new Error('QuotaExceededError'));
            return;
          }
          rows.set(key, value);
          pending.result = key;
          pending.onsuccess?.();
        });
        return pending as unknown as IDBRequest<IDBValidKey>;
      },
      delete: (key: string) => {
        const pending = request();
        answer(() => {
          rows.delete(key);
          pending.onsuccess?.();
        });
        return pending as unknown as IDBRequest<undefined>;
      },
    }) as unknown as IDBObjectStore;

  const database = (): IDBDatabase =>
    ({
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore: (name: string) => {
        stores.add(name);
        return objectStore();
      },
      transaction: (name: string, mode: IDBTransactionMode) => {
        // A real database has no transaction to offer for a store it does not have, which is what
        // makes the `upgradeneeded` handler load-bearing rather than decoration.
        if (!stores.has(name)) throw new Error(`NotFoundError: no store named "${name}"`);
        const transaction: FakeTransaction = {
          mode,
          error: null,
          onabort: null,
          objectStore: () => objectStore(transaction),
        };
        return transaction as unknown as IDBTransaction;
      },
      close: () => {},
      onclose: null,
      onversionchange: null,
    }) as unknown as IDBDatabase;

  return fake;
}

describe('indexedDbStorage()', () => {
  it('round-trips a value, creating the store on upgrade and reusing one connection', async () => {
    const idb = fakeIdb();
    const storage = indexedDbStorage({ factory: idb.factory });

    // A missing key is `null`, not `undefined`: the interface promises the same answer
    // `localStorage` gives, so a persister cannot tell the two storages apart.
    await expect(storage.getItem('ng-signal-request')).resolves.toBeNull();

    await storage.setItem('ng-signal-request', '{"version":1}');
    expect(idb.rows.get('ng-signal-request')).toBe('{"version":1}');
    await expect(storage.getItem('ng-signal-request')).resolves.toBe('{"version":1}');

    await storage.removeItem('ng-signal-request');
    await expect(storage.getItem('ng-signal-request')).resolves.toBeNull();

    // A missing key, a write, a read and a delete: one connection, opened lazily by the first of
    // them and never closed.
    expect(idb.opens).toBe(1);
  });

  it('rejects when there is no IndexedDB at all, which is the server and a blocked sandbox', async () => {
    const storage = indexedDbStorage();

    // jsdom implements none of it; the persister turns this rejection into a disabled persister
    // rather than an exception, so nothing here has to be caught by the application.
    await expect(storage.getItem('ng-signal-request')).rejects.toThrow(
      /IndexedDB is not available/,
    );
  });

  it('rejects a blocked upgrade, and retries on the next call once the other tab is gone', async () => {
    const idb = fakeIdb();
    idb.blocked = true;
    const storage = indexedDbStorage({ factory: idb.factory });

    await expect(storage.getItem('ng-signal-request')).rejects.toThrow(/blocked/);

    // The failure is not cached: a blocked upgrade is a moment in time, not a permanent state.
    idb.blocked = false;
    await expect(storage.getItem('ng-signal-request')).resolves.toBeNull();
    expect(idb.opens).toBe(2);
  });

  it('rejects a refused write, so the persister disables instead of throwing into a settle path', async () => {
    const idb = fakeIdb();
    idb.refuseWrites = true;
    const storage = indexedDbStorage({ factory: idb.factory });

    await expect(storage.setItem('ng-signal-request', 'x')).rejects.toThrow(/QuotaExceededError/);
  });

  it('surfaces a transaction abort, which is the shape a quota refusal really takes', async () => {
    const idb = fakeIdb();
    idb.abortWrites = true;
    const storage = indexedDbStorage({ factory: idb.factory });

    // The request never errors in this simulation: the transaction is what aborts, and a caller
    // that only watched the request would hang forever.
    await expect(storage.setItem('ng-signal-request', 'x')).rejects.toThrow(/QuotaExceededError/);
  });

  it('falls back to its own message when the browser hands back no error at all', async () => {
    const idb = fakeIdb();
    idb.errorless = true;
    const storage = indexedDbStorage({ factory: idb.factory });

    // `IDBRequest.error` and `IDBTransaction.error` are both nullable, and a message is what the
    // `enabled` signal's diagnosis is worth — "undefined was rejected" reports nothing.
    idb.fails = true;
    await expect(storage.getItem('ng-signal-request')).rejects.toThrow(
      /refused to open the database/,
    );

    idb.fails = false;
    idb.refuseWrites = true;
    await expect(storage.setItem('ng-signal-request', 'x')).rejects.toThrow(/refused the request/);

    idb.refuseWrites = false;
    idb.abortWrites = true;
    await expect(storage.setItem('ng-signal-request', 'x')).rejects.toThrow(
      /aborted the transaction/,
    );
  });

  it('uses the browser global when no factory is passed', async () => {
    const idb = fakeIdb();
    vi.stubGlobal('indexedDB', idb.factory);
    try {
      const storage = indexedDbStorage();
      await storage.setItem('ng-signal-request', '{"version":1}');

      // The default path most applications take, and the one jsdom cannot exercise on its own: the
      // `factory` option exists for tests, and this proves it is really optional.
      await expect(storage.getItem('ng-signal-request')).resolves.toBe('{"version":1}');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects an open that fails outright', async () => {
    const idb = fakeIdb();
    idb.fails = true;
    const storage = indexedDbStorage({ factory: idb.factory });

    await expect(storage.getItem('ng-signal-request')).rejects.toThrow(/could not be opened/);
  });

  it('holds the first fetch for an IndexedDB-backed persister, then needs no fetch', async () => {
    const idb = fakeIdb();
    idb.rows.set(
      'ng-signal-request',
      JSON.stringify(snapshotOf([{ key: ['rows'], data: rows([7]), dataUpdatedAt: Date.now() }])),
    );
    idb.pause();

    // The end-to-end shape of Phase 3: a provider, a database, and a handle that must not fetch
    // while the read is outstanding.
    const { http, create } = setup([
      providePersistedCache({ storage: indexedDbStorage({ factory: idb.factory }) }),
    ]);
    const handle = keyed<Row[]>(create, ['rows'], Number.POSITIVE_INFINITY);
    await settle();
    http.expectNone(() => true);

    idb.resume();
    await settle();

    expect(handle.response()).toEqual(rows([7]));
    expect(handle.fetchCount()).toBe(0);
    http.expectNone(() => true);

    handle.destroy();
  });
});

/* -------------------------------------------------------------------------- */
/*  Versioning: buster and migrate                                            */
/* -------------------------------------------------------------------------- */

describe('a snapshot from another version', () => {
  const current = (): CacheSnapshot =>
    snapshotOf([{ key: ['rows'], data: rows([7]), dataUpdatedAt: 1000 }]);

  it('is handed to migrate() with the version it came from', () => {
    const { create } = setup();
    create(() => inject(QueryClient));
    const seen: number[] = [];

    const restored = hydrate(
      cache(),
      { ...current(), version: 0 },
      {
        migrate: (snapshot, fromVersion) => {
          seen.push(fromVersion);
          return { ...snapshot, version: SNAPSHOT_VERSION };
        },
      },
    );

    expect(seen).toEqual([0]);
    expect(restored).toBe(1);
  });

  it('is dropped when there is no migrate to read it', () => {
    const { create } = setup();
    create(() => inject(QueryClient));

    expect(hydrate(cache(), { ...current(), version: 0 })).toBe(0);
    expect(cache().pendingSeeds).toBe(0);
  });

  it('is dropped when migrate() returns null, and does not throw', () => {
    const { create } = setup();
    create(() => inject(QueryClient));

    expect(hydrate(cache(), { ...current(), version: 2 }, { migrate: () => null })).toBe(0);
    expect(cache().pendingSeeds).toBe(0);
  });

  it('is dropped when migrate() throws, because bootstrap must not be the failure', () => {
    const { create } = setup();
    create(() => inject(QueryClient));

    const restored = hydrate(
      cache(),
      { ...current(), version: 2 },
      {
        migrate: () => {
          throw new Error('a migration with a bug in it');
        },
      },
    );

    // A cold first paint, not a broken application: the code that would report the error has not
    // started yet.
    expect(restored).toBe(0);
  });

  it('is dropped when migrate() hands back a version it still does not understand', () => {
    const { create } = setup();
    create(() => inject(QueryClient));

    // Returning the snapshot unchanged is the easy mistake, and reading it as current would put the
    // shape check back where it started.
    expect(hydrate(cache(), { ...current(), version: 2 }, { migrate: (s) => s })).toBe(0);
  });

  it('is not run through migrate() when the version already matches', () => {
    const { create } = setup();
    create(() => inject(QueryClient));
    let called = false;

    const restored = hydrate(cache(), current(), {
      migrate: () => {
        called = true;
        return null;
      },
    });

    // A payload already in this shape has nothing to migrate, and a hook that fired anyway would be
    // doing work on every load for nothing.
    expect(called).toBe(false);
    expect(restored).toBe(1);
  });
});

describe('buster', () => {
  it('is written by dehydrate(), and a mismatch drops the snapshot', () => {
    const { create } = setup();
    create(() => inject(QueryClient));

    const snapshot = dehydrate(cache(), { buster: 'posts-v2' });
    expect(snapshot.buster).toBe('posts-v2');

    // The cheap version bump: change the string, and every stored snapshot from before it is
    // discarded on the next load.
    expect(
      hydrate(cache(), snapshotOf([{ key: ['rows'], data: rows([1]), dataUpdatedAt: 5 }]), {
        buster: 'posts-v2',
      }),
    ).toBe(0);
  });

  it('is ignored when the application configures none, so 0.1.0 payloads still read', () => {
    const { create } = setup();
    create(() => inject(QueryClient));

    expect(
      hydrate(cache(), snapshotOf([{ key: ['rows'], data: rows([1]), dataUpdatedAt: 5 }]), {
        buster: 'anything',
      }),
    ).toBe(0);
    expect(cache().pendingSeeds).toBe(0);

    const restored = hydrate(
      cache(),
      snapshotOf([{ key: ['rows'], data: rows([1]), dataUpdatedAt: 5 }]),
    );
    expect(restored).toBe(1);
  });

  it('is checked after migrate(), so an upgraded payload is still dropped for the wrong contents', () => {
    const { create } = setup();
    create(() => inject(QueryClient));

    const restored = hydrate(
      cache(),
      { ...snapshotOf([{ key: ['rows'], data: rows([1]), dataUpdatedAt: 5 }]), version: 0 },
      { buster: 'v2', migrate: (snapshot) => ({ ...snapshot, version: SNAPSHOT_VERSION }) },
    );

    // The shape was migrated, and the *contents* are still from the other deployment. A migration
    // knows nothing about that, which is why the buster check comes second.
    expect(restored).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  dehydrateFilter                                                           */
/* -------------------------------------------------------------------------- */

describe('the default dehydrate filter', () => {
  it('excludes an entry whose refetch is in flight', async () => {
    const { http, create } = setup();
    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush(rows([1]));
    await settle();

    create(() => inject(QueryClient)).invalidate(['rows']);
    await settle();
    // Mid-refetch: the signals are a half-state, and what lands in storage would depend on the
    // order the snapshot and the response ran in.
    expect(cache().peek(['rows'])?.isFetching()).toBe(true);
    expect(dehydrate(cache()).entries).toEqual([]);

    http.expectOne('/rows').flush(rows([2]));
    await settle();
    handle.destroy();
  });

  it('excludes an entry that still holds its value after a failed refetch', async () => {
    const { http, create } = setup();
    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush(rows([1]));
    await settle();

    create(() => inject(QueryClient)).invalidate(['rows']);
    await settle();
    http.expectOne('/rows').flush({ message: 'down' }, { status: 500, statusText: 'Error' });
    await settle();

    // The value is still there, and the server has just refused to confirm it. Storing it would put
    // stale truth on the next load with no error to go with it — and would overwrite the previous
    // good write with the failed state.
    expect(cache().peek(['rows'])?.data()).toEqual(rows([1]));
    expect(dehydrate(cache()).entries).toEqual([]);

    handle.destroy();
  });

  it('is overridable, and receives the entry', async () => {
    const { http, create } = setup();
    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush(rows([1]));
    await settle();

    // The escape hatch for an application that wants the failed entry kept: the filter is a
    // predicate, so the policy is one expression rather than a new option per case.
    const snapshot = dehydrate(cache(), {
      dehydrateFilter: (entry) => entry.hasData(),
    });

    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].data).toEqual(rows([1]));
    handle.destroy();
  });
});
