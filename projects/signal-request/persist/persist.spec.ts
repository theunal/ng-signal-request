import {
  createEnvironmentInjector,
  EnvironmentInjector,
  inject,
  PLATFORM_ID,
  TransferState,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { createRequest, provideSignalRequest, QueryClient, type CachedRequest } from 'ng-signal-request';
import {
  CACHE_PERSISTER,
  CACHE_TRANSFER_KEY,
  createPersister,
  dateRevivingCodec,
  dehydrate,
  hydrate,
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
    hydrate(
      cache(),
      snapshotOf([{ key: ['third'], data: rows([3]), dataUpdatedAt: 3 }]),
      { replace: false },
    );
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
