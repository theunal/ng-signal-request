import { computed as computedSignal, signal, type Signal } from '@angular/core';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createRequest, RequestCancelledError } from '../public-api';
import type { CachedRequest, SignalRequest } from '../public-api';
import { advanceClock, cache, settle, setup } from '../../testing/testing';

interface User {
  id: number;
  name: string;
}

/** Shared across the "disabled" test so the source can be flipped from the test body. */
const enabled = signal(true);

describe('cached request — sharing', () => {
  it('sends ONE request for two components on the same key, and both see the data', async () => {
    // The headline behaviour. Two independent injection scopes, so this is really two components,
    // not one handle read twice.
    const { http, createChild } = setup();
    const a = createChild();
    const b = createChild();

    const usersA = a.create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], initialValue: [] }),
    );
    const usersB = b.create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], initialValue: [] }),
    );

    await settle();

    // One request on the wire, not two — and `expectOne` would have thrown on a second.
    const request = http.expectOne('/users');
    expect(usersA.isFetching()).toBe(true);
    expect(usersB.isFetching()).toBe(true);
    request.flush([{ id: 1, name: 'Ada' }]);
    await settle();

    expect(usersA.response()).toEqual([{ id: 1, name: 'Ada' }]);
    expect(usersB.response()).toEqual([{ id: 1, name: 'Ada' }]);
    // One entry, one fetch, counted once.
    expect(usersA.fetchCount()).toBe(1);
    expect(cache().size).toBe(1);
    http.expectNone(() => true);

    a.destroy();
    b.destroy();
  });

  it('counts subscribers and returns them to zero when the scopes die', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    const b = createChild();

    const one = a.create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], initialValue: [] }),
    );
    const two = b.create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], initialValue: [] }),
    );
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    const entry = cache().peek<User[]>(['users'])!;
    expect(entry.observerCount).toBe(2);

    a.destroy();
    await settle();
    // Still one: the other component is looking at it.
    expect(entry.observerCount).toBe(1);
    expect(entry.data()).toEqual([{ id: 1, name: 'Ada' }]);

    b.destroy();
    await settle();
    expect(entry.observerCount).toBe(0);
  });

  it('joins a fetch that is already in flight rather than opening a second', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    const b = createChild();

    const one = a.create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], initialValue: [] }),
    );
    await settle();
    // The second component arrives while the first is still waiting on the network.
    const two = b.create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], initialValue: [] }),
    );
    await settle();

    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    expect(one.fetchCount()).toBe(1);
    expect(two.fetchCount()).toBe(1);
    expect(two.response()).toEqual([{ id: 1, name: 'Ada' }]);

    a.destroy();
    b.destroy();
  });

  it('treats structurally equal object keys as one key', async () => {
    // The property that makes sharing work at all: two components build `{ page: 1 }` as two
    // different objects, and they still have to land on the same entry.
    const { http, createChild } = setup();
    const a = createChild();
    const b = createChild();

    a.create(() =>
      createRequest<User[]>('/users', { key: () => ['users', { page: 1, size: 10 }] }),
    );
    // Same data, opposite key order.
    b.create(() =>
      createRequest<User[]>('/users', { key: () => ['users', { size: 10, page: 1 }] }),
    );
    await settle();

    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();
    expect(cache().size).toBe(1);

    a.destroy();
    b.destroy();
  });

  it('keeps different keys apart', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    const b = createChild();

    a.create(() => createRequest<User[]>('/users', { key: () => ['users', 1] }));
    b.create(() => createRequest<User[]>('/users', { key: () => ['users', 2] }));
    await settle();

    const [first, second] = http.match('/users');
    first.flush([{ id: 1, name: 'Ada' }]);
    second.flush([{ id: 2, name: 'Grace' }]);
    await settle();

    expect(cache().peek<User[]>(['users', 1])!.data()).toEqual([{ id: 1, name: 'Ada' }]);
    expect(cache().peek<User[]>(['users', 2])!.data()).toEqual([{ id: 2, name: 'Grace' }]);

    a.destroy();
    b.destroy();
  });
});

describe('cached request — staleness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not refetch a fresh entry when a second subscriber arrives', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    const b = createChild();
    const options = { key: () => ['users'], staleTime: 60_000, initialValue: [] as User[] };

    a.create(() => createRequest<User[]>('/users', options));
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    b.create(() => createRequest<User[]>('/users', options));
    await settle();

    // `staleTime` has not elapsed, so mounting again is free.
    http.expectNone('/users');
    expect(cache().peek<User[]>(['users'])!.fetchCount()).toBe(1);

    a.destroy();
    b.destroy();
  });

  it('refetches once staleTime has elapsed', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    const b = createChild();
    const options = { key: () => ['users'], staleTime: 1_000, initialValue: [] as User[] };

    a.create(() => createRequest<User[]>('/users', options));
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    // Staleness is read from the wall clock, so the clock has to move — advancing timers alone
    // would leave the entry looking fresh forever.
    advanceClock(1_500);

    b.create(() => createRequest<User[]>('/users', options));
    await settle();
    http.expectOne('/users').flush([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ]);
    await settle();

    expect(cache().peek<User[]>(['users'])!.fetchCount()).toBe(2);

    a.destroy();
    b.destroy();
  });

  it('refetchOnMount: false never fetches on subscribe', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    const options = {
      key: () => ['users'],
      refetchOnMount: false as const,
      initialValue: [] as User[],
    };

    const users = a.create(() => createRequest<User[]>('/users', options));
    await settle();
    // Even with no data at all: `false` means "this handle never fetches on its own".
    expect(users.status()).toBe('idle');
    http.expectNone('/users');

    // …but `run()` still works, because that is an explicit instruction.
    const pending = users.run();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await expect(pending).resolves.toEqual([{ id: 1, name: 'Ada' }]);
    await settle();

    a.destroy();
  });

  it('refetchOnMount: always refetches even when fresh', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    const b = createChild();
    const options = {
      key: () => ['users'],
      staleTime: 60_000,
      refetchOnMount: 'always' as const,
      initialValue: [] as User[],
    };

    a.create(() => createRequest<User[]>('/users', options));
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    b.create(() => createRequest<User[]>('/users', options));
    await settle();

    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();
    expect(cache().peek<User[]>(['users'])!.fetchCount()).toBe(2);

    a.destroy();
    b.destroy();
  });

  it('reports staleness, and it clears the moment a value lands', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    const users = a.create(() =>
      createRequest<User[]>('/users', {
        key: () => ['users'],
        staleTime: 60_000,
        initialValue: [],
      }),
    );

    // No data yet: always stale.
    expect(users.isStale()).toBe(true);

    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    expect(users.isStale()).toBe(false);
    expect(users.dataUpdatedAt()).toBeGreaterThan(0);

    a.destroy();
  });
});

describe('cached request — gc', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps an unsubscribed entry for gcTime, then drops it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { http, createChild } = setup();
    const a = createChild();

    a.create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], gcTime: 1_000, initialValue: [] }),
    );
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();
    expect(cache().size).toBe(1);

    // Component gone: the data is still worth keeping for the gc window.
    a.destroy();
    await settle();
    expect(cache().size).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(cache().size).toBe(1);

    await vi.advanceTimersByTimeAsync(2);
    expect(cache().size).toBe(0);
  });

  it('clears the countdown when a subscriber comes back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { http, createChild } = setup();
    const a = createChild();
    const b = createChild();
    const options = { key: () => ['users'], gcTime: 1_000, initialValue: [] as User[] };

    a.create(() => createRequest<User[]>('/users', options));
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    a.destroy();
    await vi.advanceTimersByTimeAsync(900);
    // Back before the window closed, so the entry survives.
    const revived = b.create(() => createRequest<User[]>('/users', options));
    await settle();
    expect(revived.response()).toEqual([{ id: 1, name: 'Ada' }]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(cache().size).toBe(1);

    b.destroy();
  });

  it('gcTime: 0 drops the entry the moment the last subscriber leaves', async () => {
    const { http, createChild } = setup();
    const a = createChild();

    a.create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], gcTime: 0, initialValue: [] }),
    );
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();
    expect(cache().size).toBe(1);

    a.destroy();
    await settle();
    expect(cache().size).toBe(0);
  });
});

describe('cached request — abort', () => {
  it('aborts an in-flight request when the last subscriber goes away', async () => {
    const { http, createChild } = setup();
    const a = createChild();

    const users = a.create(() => createRequest<User[]>('/users', { key: () => ['users'] }));
    await settle(); // the mount fetch is started by the subscription effect
    const pending = users.run();
    const request = http.expectOne('/users');
    expect(users.isFetching()).toBe(true);

    a.destroy();
    await settle();

    // The network call was really cancelled…
    expect(request.cancelled).toBe(true);
    expect(users.isFetching()).toBe(false);
    // …and the promise `run()` handed out settled rather than hanging forever.
    await expect(pending).rejects.toBeTruthy();
  });

  it('does NOT abort when another subscriber is still watching', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    const b = createChild();
    const options = { key: () => ['users'], initialValue: [] as User[] };

    const one = a.create(() => createRequest<User[]>('/users', options));
    const two = b.create(() => createRequest<User[]>('/users', options));
    await settle();
    const request = http.expectOne('/users');

    a.destroy();
    await settle();

    expect(request.cancelled).toBe(false);
    request.flush([{ id: 1, name: 'Ada' }]);
    await settle();
    expect(two.response()).toEqual([{ id: 1, name: 'Ada' }]);

    b.destroy();
  });

  it('cancels even when destroyed before its subscription effect ever ran', async () => {
    // The scheduler had not flushed the mount effect, so the entry never gained a subscriber and
    // there was no refcount to drop. The request must not outlive the handle that made it.
    const { http, createChild } = setup();
    const a = createChild();

    const users = a.create(() => createRequest<User[]>('/users', { key: () => ['users'] }));
    const pending = users.run();
    const request = http.expectOne('/users');

    a.destroy();
    await settle();

    expect(request.cancelled).toBe(true);
    await expect(pending).rejects.toBeTruthy();
  });

  it('cancel() stops the shared fetch for every subscriber', async () => {
    // Documented as a difference from the uncached handle: one request per key means one cancel.
    const { http, createChild } = setup();
    const a = createChild();
    const b = createChild();
    const options = { key: () => ['users'], initialValue: [] as User[] };

    const one = a.create(() => createRequest<User[]>('/users', options));
    const two = b.create(() => createRequest<User[]>('/users', options));
    await settle();
    const request = http.expectOne('/users');

    one.cancel();
    await settle();

    expect(request.cancelled).toBe(true);
    expect(one.isFetching()).toBe(false);
    expect(two.isFetching()).toBe(false);

    a.destroy();
    b.destroy();
  });
});

describe('cached request — structural sharing', () => {
  it('keeps the previous reference when nothing changed, so consumers are not notified', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    const users = a.create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], initialValue: [], staleTime: 0 }),
    );
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    const first = users.response();
    const reads: number[] = [];
    const computed = a.create(() => computedSignal(() => users.response().length));
    reads.push(computed());

    // A brand new array object with identical contents.
    users.reload();
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    expect(users.response()).toEqual([{ id: 1, name: 'Ada' }]);
    // Structural sharing returned `previous`, so the data signal was never written.
    expect(users.response()).toBe(first);
    expect(reads).toEqual([1]);

    a.destroy();
  });

  it('reuses unchanged rows when only one changed', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    const users = a.create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], initialValue: [], staleTime: 0 }),
    );
    await settle();
    http.expectOne('/users').flush([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ]);
    await settle();

    const before = users.response();

    users.reload();
    await settle();
    http.expectOne('/users').flush([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace II' },
    ]);
    await settle();

    const after = users.response();
    expect(after).not.toBe(before);
    // The new array and the changed element are new; the untouched row kept its identity, which
    // is what stops `@for (row of rows; track row.id)` rows from being torn down.
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);

    a.destroy();
  });

  it('honours a custom structuralSharing function', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    const users = a.create(() =>
      createRequest<{ rows: User[]; fetchedAt: number }>('/users', {
        key: () => ['users'],
        initialValue: { rows: [], fetchedAt: 0 },
        staleTime: 0,
        structuralSharing: (previous, next) => ({
          rows: next.rows,
          fetchedAt: previous?.fetchedAt ?? next.fetchedAt,
        }),
      }),
    );
    await settle();
    http.expectOne('/users').flush({ rows: [{ id: 1, name: 'Ada' }], fetchedAt: 100 });
    await settle();
    expect(users.response().fetchedAt).toBe(100);

    users.reload();
    await settle();
    http.expectOne('/users').flush({ rows: [{ id: 1, name: 'Ada' }], fetchedAt: 200 });
    await settle();

    // The server said 200; the sharing function kept the old one on purpose.
    expect(users.response().fetchedAt).toBe(100);

    a.destroy();
  });

  it('composes with `equal` as a short-circuit', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    let equalCalls = 0;
    const users = a.create(() =>
      createRequest<User[]>('/users', {
        key: () => ['users'],
        initialValue: [],
        staleTime: 0,
        equal: (a2, b2) => {
          equalCalls += 1;
          return JSON.stringify(a2) === JSON.stringify(b2);
        },
      }),
    );
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    const before = users.response();
    users.reload();
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    expect(equalCalls).toBeGreaterThan(0);
    expect(users.response()).toBe(before);

    a.destroy();
  });
});

describe('cached request — reactive key', () => {
  it('re-points the handle when a signal in the key changes', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    const page = signal(1);
    const users = a.create(() =>
      createRequest<User[]>(() => ({ url: '/users', params: { page: page() } }), {
        key: () => ['users', { page: page() }],
        initialValue: [],
      }),
    );
    await settle();
    http.expectOne('/users?page=1').flush([{ id: 1, name: 'Ada' }]);
    await settle();
    expect(users.response()).toEqual([{ id: 1, name: 'Ada' }]);

    page.set(2);
    await settle();
    http.expectOne('/users?page=2').flush([{ id: 2, name: 'Grace' }]);
    await settle();

    expect(users.response()).toEqual([{ id: 2, name: 'Grace' }]);
    expect(cache().size).toBe(2);

    a.destroy();
  });

  it('goes idle when disabled, without fetching', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    const users = a.create(() =>
      createRequest<User[]>(() => (enabled() ? '/users' : undefined), {
        key: () => ['users'],
        initialValue: [],
      }),
    );
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    enabled.set(false);
    await settle();
    expect(users.status()).toBe('idle');
    expect(users.isFetching()).toBe(false);

    // A background focus event must not override a deliberate disable either.
    window.dispatchEvent(new Event('focus'));
    await settle();
    http.expectNone('/users');

    a.destroy();
  });
});

describe('cached handle — types', () => {
  it('a keyed handle is a CachedRequest, an unkeyed one is a SignalRequest', () => {
    const { create } = setup();

    const cached = create(() => createRequest<User[]>('/users', { key: () => ['users'] }));
    const plain = create(() => createRequest<User[]>('/users'));

    expectTypeOf(cached).toEqualTypeOf<CachedRequest<User[], User[] | undefined, void>>();
    expectTypeOf(cached.isStale).toEqualTypeOf<() => boolean>();
    expectTypeOf(cached.fetchCount).toEqualTypeOf<import('@angular/core').Signal<number>>();

    expectTypeOf(plain).toEqualTypeOf<SignalRequest<User[], User[] | undefined, void>>();
    // @ts-expect-error — freshness only means something against a shared entry.
    plain.isStale;
    // @ts-expect-error — a cached request has no `httpResource` behind it.
    cached.resource;
  });

  it('keeps the initialValue narrowing on both paths', () => {
    const { create } = setup();
    const cached = create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], initialValue: [] }),
    );
    const plain = create(() => createRequest<User[]>('/users', { initialValue: [] }));
    expectTypeOf(cached.response).toEqualTypeOf<import('@angular/core').Signal<User[]>>();
    expectTypeOf(plain.response).toEqualTypeOf<import('@angular/core').Signal<User[]>>();
  });

  it('still requires a params option when TParams is declared, keyed or not', () => {
    const { create } = setup();
    interface Query {
      page: number;
    }
    const source = { key: () => ['users'], initialValue: [] };
    // @ts-expect-error — a params option is required once TParams is declared.
    const missing = () => createRequest<User[], Query>('/users', source);
    expectTypeOf(missing).toBeFunction();
  });
});

describe('cached request — the rest of the surface', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries a keyed request through the shared entry, and clears the attempt on success', async () => {
    // `setInterval` as well as `setTimeout`: rxjs' async scheduler drives a delayed retry through an
    // interval, so faking only `setTimeout` would leave the retry sitting on a real timer.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const { http, create } = setup();
    const users = create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], retry: { count: 1, delay: 100 } }),
    );
    await settle();

    http.expectOne('/users').flush({}, { status: 503, statusText: 'Unavailable' });
    await settle();

    // The keyed path has its own fetch loop, so the retry has to be proved here rather than assumed
    // from the uncached one. While a retry is pending the failure is masked: `status()` is still
    // loading and `error()` is empty, which is the difference between "trying again" and "failed".
    expect(users.retryAttempt()).toBe(1);
    expect(users.error()).toBeUndefined();
    expect(users.status()).toBe('loading');

    await vi.advanceTimersByTimeAsync(100);
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    expect(users.response()).toEqual([{ id: 1, name: 'Ada' }]);
    expect(users.retryAttempt()).toBe(0);
    users.destroy();
  });

  it('fails the call when parse throws, and still reports the status line', async () => {
    const { http, create } = setup();
    const users = create(() =>
      createRequest<User[]>('/users', {
        key: () => ['users'],
        retry: 0,
        parse: () => {
          throw new Error('bad shape');
        },
      }),
    );
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    // A 200 with an unusable body is a failure, not a success with `undefined` in it.
    expect(users.status()).toBe('error');
    expect(users.error()?.message).toContain('bad shape');
    // The status code was recorded from the response before the parse ran, so the UI can still say
    // "200, but the body did not fit" instead of losing that.
    expect(users.statusCode()).toBe(200);
    users.destroy();
  });

  it('seed() writes straight into an entry that already exists', async () => {
    const { http, create } = setup();
    const users = create(() =>
      createRequest<User[]>('/users', {
        key: () => ['users'],
        staleTime: Number.POSITIVE_INFINITY,
      }),
    );
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    cache().seed(['users'], [{ id: 2, name: 'Grace' }], 1234);

    expect(users.response()).toEqual([{ id: 2, name: 'Grace' }]);
    // The original fetch time comes with the value, so `staleTime` measures real age rather than
    // treating a restore as a fresh response.
    expect(cache().peek(['users'])?.dataUpdatedAt()).toBe(1234);
    // And it is not a *local* write: nothing calls this a user edit.
    expect(cache().peek(['users'])?.local()).toBe(false);
    http.expectNone(() => true);
    users.destroy();
  });

  it('clear() empties the cache', async () => {
    const { http, create } = setup();
    const users = create(() => createRequest<User[]>('/users', { key: () => ['users'] }));
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();
    expect(cache().size).toBe(1);

    cache().clear();

    expect(cache().size).toBe(0);
    expect(cache().peek(['users'])).toBeUndefined();
    users.destroy();
  });

  it('markInvalidated() marks without fetching, and a mount refetches the marked entry', async () => {
    const { http, create } = setup();
    const options = { key: () => ['users'], staleTime: 60_000 };
    const first = create(() => createRequest<User[]>('/users', options));
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();
    expect(first.isStale()).toBe(false);

    expect(cache().markInvalidated(['users'])).toBe(1);

    // Marking is deliberately not fetching: batching the refetches is `QueryClient`'s job, and the
    // store has no idea when a refetch is due.
    http.expectNone(() => true);
    expect(first.isStale()).toBe(true);
    expect(cache().markInvalidated(['nowhere'])).toBe(0);

    // A handle arriving now is what drives the fetch.
    const second = create(() => createRequest<User[]>('/users', options));
    await settle();
    http.expectOne('/users').flush([{ id: 2, name: 'Grace' }]);
    await settle();

    expect(second.response()).toEqual([{ id: 2, name: 'Grace' }]);
    first.destroy();
    second.destroy();
  });
});

describe('cached request — options and the disabled state', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('applies timeout and headers to the shared request', async () => {
    const { http, create } = setup();
    const users = create(() =>
      createRequest<User[]>('/users', {
        key: () => ['users'],
        headers: { 'X-Token': 'abc' },
        timeout: 4_000,
      }),
    );
    await settle();

    const request = http.expectOne('/users');
    // Per-request headers still win, and they are on the one request every subscriber shares.
    expect(request.request.headers.get('X-Token')).toBe('abc');
    request.flush([{ id: 1, name: 'Ada' }]);
    await settle();

    expect(users.response()).toEqual([{ id: 1, name: 'Ada' }]);
    users.destroy();
  });

  it('is disabled — not merely idle — when its params are cleared', async () => {
    const { http, create } = setup();
    const users = create(() =>
      createRequest<User[], string>((name) => `/users/${name}`, {
        key: () => ['users'],
        params: 'core',
        initialValue: [],
      }),
    );
    await settle();
    http.expectOne('/users/core').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    users.params.set(undefined as unknown as string);
    await settle();

    // "Disabled" is a distinct answer from "loading": nothing is on the wire, and the caller is
    // told so rather than being handed a promise that never settles.
    http.expectNone(() => true);
    expect(users.status()).toBe('idle');
    expect(users.response()).toEqual([]);
    await expect(users.run()).rejects.toBeInstanceOf(RequestCancelledError);
    expect((await users.tryRun()).ok).toBe(false);
    expect(users.reload()).toBe(false);

    // And it comes back to life when the params do.
    users.params.set('core');
    await settle();
    http.expectOne('/users/core').flush([{ id: 2, name: 'Grace' }]);
    await settle();
    expect(users.response()).toEqual([{ id: 2, name: 'Grace' }]);

    users.destroy();
  });

  it('reports a normalized requestError, and success/loading agree with the status', async () => {
    const { http, create } = setup();
    const users = create(() => createRequest<User[]>('/users', { key: () => ['users'], retry: 0 }));
    await settle();

    expect(users.initialLoading()).toBe(true);
    expect(users.loading()).toBe(true);
    expect(users.success()).toBe(false);

    http.expectOne('/users').flush({}, { status: 404, statusText: 'Not Found' });
    await settle();

    expect(users.status()).toBe('error');
    expect(users.requestError()?.kind).toBe('http');
    expect(users.loading()).toBe(false);
    expect(users.initialLoading()).toBe(false);
    expect(users.success()).toBe(false);
    users.destroy();
  });

  it('refetches on the same entry when only the request changed', async () => {
    const page = signal(1);
    const { http, create } = setup();
    const users = create(() =>
      createRequest<User[]>(() => `/users?page=${page()}`, {
        key: () => ['users'],
        // Fresh, so only a changed *request* can be what causes the refetch.
        staleTime: Number.POSITIVE_INFINITY,
      }),
    );
    await settle();
    http.expectOne('/users?page=1').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    page.set(2);
    await settle();

    http.expectOne('/users?page=2').flush([{ id: 2, name: 'Grace' }]);
    await settle();

    expect(users.response()).toEqual([{ id: 2, name: 'Grace' }]);
    users.destroy();
  });

  it('routes a throwing hook to the error handler instead of failing the fetch', async () => {
    const onConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { http, create } = setup();
    const users = create(() =>
      createRequest<User[]>('/users', {
        key: () => ['users'],
        onSuccess: () => {
          throw new Error('hook blew up');
        },
      }),
    );
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    // A broken hook is reported through Angular's `ErrorHandler`, not by rejecting the request:
    // the data arrived, and the component should get it.
    expect(onConsoleError).toHaveBeenCalled();
    expect(users.response()).toEqual([{ id: 1, name: 'Ada' }]);
    expect(users.status()).toBe('resolved');
    users.destroy();
  });

  it('set() and update() write through to the shared entry', async () => {
    const before = [{ id: 1, name: 'Ada' }];
    const { http, create } = setup();
    const users = create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], initialValue: [] as User[] }),
    );
    await settle();
    http.expectOne('/users').flush(before);
    await settle();

    users.set([{ id: 2, name: 'Grace' }]);
    expect(users.response()).toEqual([{ id: 2, name: 'Grace' }]);
    // A local write is what makes a mutation's optimistic update visible before the server answers,
    // so `status()` has to say so rather than claiming a resolved fetch.
    expect(users.status()).toBe('local');

    users.update((current) => [...current, { id: 3, name: 'Alan' }]);
    expect(users.response()).toHaveLength(2);
    users.destroy();
  });

  it('refetches when the window regains focus', async () => {
    const { http, create } = setup();
    const users = create(() =>
      createRequest<User[]>('/users', {
        key: () => ['users'],
        refetchOnWindowFocus: true,
        staleTime: Number.POSITIVE_INFINITY,
      }),
    );
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    window.dispatchEvent(new Event('focus'));
    await settle();

    http.expectOne('/users').flush([{ id: 2, name: 'Grace' }]);
    await settle();

    expect(users.response()).toEqual([{ id: 2, name: 'Grace' }]);
    users.destroy();
  });

  it('re-arms its poll timer after every settle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { http, create } = setup();
    const users = create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], pollInterval: 1_000 }),
    );
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    http.expectOne('/users').flush([{ id: 2, name: 'Grace' }]);
    await settle();

    expect(users.response()).toEqual([{ id: 2, name: 'Grace' }]);
    users.destroy();
  });

  it('ctx.chain() fails fast, because a cached request has no httpResource to chain against', async () => {
    const { create } = setup();
    interface ParamsContext {
      chain: (resource: unknown) => unknown;
    }
    let captured: ParamsContext | undefined;
    const users = create(() =>
      createRequest<string[], void>(
        (_params, ctx) => {
          captured = ctx as unknown as ParamsContext;
          return '/users';
        },
        { key: () => ['users'] },
      ),
    );
    await settle();

    // A cached entry is shared and outlives the handle, so chaining it to one component's resource
    // is not merely unimplemented - it would be wrong. The message says which, and why.
    expect(() => captured!.chain(undefined)).toThrowError(
      /ctx\.chain\(\) is not available on a cached request/,
    );
    users.destroy();
  });
});

/**
 * Entry-level branches the coverage audit found untaken.
 *
 * Each is a guard the code depends on, reachable only through a particular interleaving or through
 * the exported `CacheEntry` itself: an entry destroyed between a handle's plan and its fetch, a
 * `refetch()` on an entry nobody watches any more, a release called twice. They are tested rather
 * than left uncovered because a guard nobody has run is a guard that can be inverted unnoticed —
 * and because the last observer leaving is exactly when the cache is most interesting.
 */
describe('cached request — entry lifecycle edges', () => {
  it('fetch() on a destroyed entry rejects instead of opening a request', async () => {
    const { http, create } = setup();
    create(() => createRequest<User[]>('/users', { key: () => ['users'], refetchOnMount: false }));
    await settle();

    const entry = cache().peek<User[]>(['users'])!;
    entry.destroy();

    // A removal during a load has to surface as a rejection rather than a promise that never
    // settles: `run()` is the caller's handle on the answer.
    await expect(
      entry.fetch({
        request: { url: '/users' },
        structuralSharing: (_previous, next) => next,
        retry: undefined,
        parse: undefined,
        responseType: 'json',
      }),
    ).rejects.toBeInstanceOf(RequestCancelledError);
    http.expectNone(() => true);
  });

  it('subscribe() on a destroyed entry returns a no-op release', async () => {
    const { create } = setup();
    const handle = create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], refetchOnMount: false }),
    );
    await settle();
    handle.destroy();
    await settle();

    const entry = cache().peek<User[]>(['users'])!;
    entry.destroy();

    // The entry was evicted between a handle building its plan and its subscription effect running,
    // which `maxEntries` makes ordinary. The handle must not refcount an entry that is gone.
    const release = entry.subscribe(60_000);
    expect(entry.observerCount).toBe(0);
    release();
    expect(entry.observerCount).toBe(0);
  });

  it('is idempotent: a double release, a double destroy and an evict after destroy', () => {
    setup();
    const entry = cache().resolve(['x']);

    const release = entry.subscribe(60_000);
    release();
    // Documented: a handle hands this to a `DestroyRef` without tracking whether it already ran.
    release();
    expect(entry.observerCount).toBe(0);

    entry.destroy();
    entry.destroy();
    // `evict` is the same teardown without the signal writes, and is reachable here if the cache
    // ever selected an entry that had already been destroyed.
    entry.evict();
    expect(entry.isDestroyed).toBe(true);
  });

  it('refetch() without a subscriber is undefined rather than a guess', async () => {
    const { http, create } = setup();
    const handle = create(() => createRequest<User[]>('/users', { key: () => ['users'] }));
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    const entry = cache().peek<User[]>(['users'])!;
    expect(entry.hasPlan).toBe(true);

    handle.destroy();
    await settle();

    // The last observer left, and with it the only description of what a refetch should send.
    // Guessing would send something the user never asked for, so the answer is `undefined`.
    expect(entry.hasPlan).toBe(false);
    expect(entry.refetch()).toBeUndefined();
    http.expectNone(() => true);
  });
});
